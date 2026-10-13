'use server';
import { refresh } from 'next/cache';
import { redirect } from 'next/navigation';
import { actor } from '@/lib/actor.ts';
import { startRun } from '@/lib/agent-runs.ts';
import { addCheckpoint, fireWakeByHand } from '@/lib/checkpoints.ts';
import { pool, tx } from '@/lib/db.ts';
import { BAD_QUERY, query } from '@/lib/prom.ts';
import { ack, addFollowUp, addItem, addNote, createIssue, merge, setFollowUpDone, setRunbookStep, split, setItemDone, setItemNote, setRole, setSev, setSummary, transition, type Role } from '@/lib/incidents.ts';
import { STATES, type Sev, type State } from '@/lib/lifecycle.ts';


const text = (f: FormData, k: string, max = 2000) => String(f.get(k) ?? '').slice(0, max);

export async function transitionAction(id: string, to: string) {
  if (!STATES.includes(to as State)) throw new Error('unknown state');
  const who = await actor();
  const from = (await pool().query<{ state: string }>('SELECT state FROM incidents WHERE id = $1', [id])).rows[0]?.state;
  await tx((c) => transition(c, id, to as State, who));
  if (to === 'declared' && from === 'candidate') await autoRespond(id, who); // not on reopen: the IC asks in the chat
  refresh();
}

export async function sevAction(id: string, f: FormData) {
  const who = await actor();
  await tx((c) => setSev(c, id, Number(f.get('sev')) as Sev, who));
  refresh();
}

export async function roleAction(id: string, role: Role, f: FormData) {
  const who = await actor();
  await tx((c) => setRole(c, id, role, text(f, 'who', 100), text(f, 'doing', 300), who));
  refresh();
}

export async function summaryAction(id: string, f: FormData) {
  const who = await actor();
  const next = text(f, 'next_update_at', 40);
  const at = next ? new Date(`${next}Z`) : null; // datetime-local entered as UTC (form label says so)
  if (at && Number.isNaN(at.getTime())) throw new Error('invalid next update time');
  await tx((c) => setSummary(c, id, { status_line: text(f, 'status_line', 300), impact: text(f, 'impact', 1000), next_update_at: at }, who));
  refresh();
}

export async function noteAction(id: string, f: FormData) {
  const who = await actor();
  const body = text(f, 'text');
  if (!body.trim()) return;
  await tx((c) => addNote(c, id, 'note', { text: body.trim() }, who));
  refresh();
}

export async function decisionAction(id: string, f: FormData) {
  const who = await actor();
  const d = { decision: text(f, 'decision'), alternatives: text(f, 'alternatives'), reason: text(f, 'reason'), revert_when: text(f, 'revert_when') };
  if (!d.decision.trim()) return;
  await tx((c) => addNote(c, id, 'decision', d, who));
  refresh();
}

// P2: declaring starts the AI on the incident. AI off, Kagent unreachable or a run in progress never block declaring.
async function autoRespond(id: string, who: string) {
  await startRun(pool(), id, 'respond', who).catch((e) => console.error(`auto respond #${id}:`, (e as Error).message));
}

// Declaring needs a SEV; the header offers both in one form.
export async function declareAction(id: string, f: FormData) {
  const who = await actor();
  await tx(async (c) => {
    await setSev(c, id, Number(f.get('sev')) as Sev, who);
    await transition(c, id, 'declared', who);
  });
  await autoRespond(id, who);
  refresh();
}

export async function completeItemAction(id: string, itemId: string, f: FormData) {
  const who = await actor();
  await tx((c) => setItemDone(c, id, itemId, true, text(f, 'note'), who));
  refresh();
}

export async function reopenItemAction(id: string, itemId: string) {
  const who = await actor();
  await tx((c) => setItemDone(c, id, itemId, false, '', who));
  refresh();
}

export async function itemNoteAction(id: string, itemId: string, f: FormData) {
  const who = await actor();
  await tx((c) => setItemNote(c, id, itemId, text(f, 'note'), who));
  refresh();
}

export async function addItemAction(id: string, role: string, f: FormData) {
  const who = await actor();
  await tx((c) => addItem(c, id, role, text(f, 'phase', 20), text(f, 'text', 300), who));
  refresh();
}

export async function ackAction(id: string) {
  const who = await actor();
  await tx((c) => ack(c, id, who));
  refresh();
}

export type CheckpointResult = { ok: true; warning?: string } | { ok: false; errors: string[] } | null;

// The wake condition is checked against Prometheus before saving: a broken expression would never wake anyone,
// and one that already matches would page on the next timer pass.
export async function checkpointAction(id: string, _prev: CheckpointResult, f: FormData): Promise<CheckpointResult> {
  const who = await actor();
  const wake = text(f, 'wake_expr', 4000).trim();
  let warning: string | undefined;
  if (wake) {
    try {
      const now = await query(wake);
      if (now.length) return { ok: false, errors: [`The wake condition already matches (${now.length} series), so it would page right away. Write it as the state you want to be woken for.`] };
    } catch (e) {
      const m = (e as Error).message;
      if (m.startsWith(BAD_QUERY)) return { ok: false, errors: [m] };
      warning = `Prometheus could not be reached to check the expression (${m}); it is saved and checked on the next pass.`;
    }
  }
  const eta = text(f, 'action_eta', 40);
  const at = eta ? new Date(`${eta}Z`) : null; // datetime-local entered as UTC
  if (at && Number.isNaN(at.getTime())) return { ok: false, errors: ['Expected finish time is not a valid time.'] };
  try {
    await tx((c) => addCheckpoint(c, id, {
      status_line: text(f, 'status_line', 300), hypothesis: text(f, 'hypothesis'), action: text(f, 'action'), action_eta: at,
      wake_expr: wake, next_step: text(f, 'next_step'), handoff_to: text(f, 'handoff_to', 100),
    }, who));
  } catch (e) {
    return { ok: false, errors: [(e as Error).message] };
  }
  refresh();
  return { ok: true, warning };
}

export async function mergeAction(id: string, f: FormData) {
  const who = await actor();
  const into = text(f, 'into', 20);
  if (!/^\d+$/.test(into)) throw new Error('choose an incident to merge into');
  await tx((c) => merge(c, id, into, who));
  redirect(`/incidents/${into}`);
}

export async function splitAction(id: string, f: FormData) {
  const who = await actor();
  const keys = f.getAll('alert').map((v) => String(v).slice(0, 200)).slice(0, 500);
  const nid = await tx((c) => split(c, id, keys, who));
  redirect(`/incidents/${nid}?tab=alerts`);
}

export async function runbookStepAction(id: string, runbook: string, key: string, text: string, done: boolean) {
  const who = await actor();
  await tx((c) => setRunbookStep(c, id, runbook, key, text, done, who));
  refresh();
}

// Read-only run of a runbook query: values, not just a count.
export async function runQueryAction(expr: string): Promise<{ rows: { metric: Record<string, string>; value: string }[] } | { error: string }> {
  await actor();
  if (!expr.trim() || expr.length > 4000) return { error: 'empty or too long' };
  try {
    return { rows: (await query(expr)).slice(0, 20).map((r) => ({ metric: r.metric, value: r.value[1] })) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export async function addFollowUpAction(id: string, f: FormData) {
  const who = await actor();
  await tx((c) => addFollowUp(c, id, { action: text(f, 'action', 300), type: text(f, 'type', 20), priority: text(f, 'priority', 5), owner: text(f, 'owner', 100) }, who));
  refresh();
}

export async function createIssueAction(id: string, fid: string) {
  const who = await actor();
  await tx((c) => createIssue(c, id, fid, who));
  refresh();
}

export async function followUpDoneAction(id: string, fid: string, done: boolean) {
  const who = await actor();
  await tx((c) => setFollowUpDone(c, id, fid, done, who));
  refresh();
}

export async function wakeNowAction(id: string) {
  const who = await actor();
  await tx((c) => fireWakeByHand(c, id, who));
  refresh();
}
