// The AI briefing (P2): what the AI tells the IC first when an incident is declared, and again whenever the plan
// changes. Situation, impact, likely cause, an optional SEV suggestion, and next steps tied to runbook steps.
// The AI submits it as data (tool submit_briefing); the console checks every step against the runbook and the
// action catalog before storing it. Commands never come from model text: a step's command is the runbook's own
// (backticked in the step) or the catalog's (checkAction), the AI only fills catalog parameters.
import { z } from 'zod';
import { ACTION_TYPES, checkAction, actionSummary, type ActionType } from './actions.ts';
import type { Runbook } from './runbooks.ts';

const s = (n: number) => z.string().trim().max(n);
export const BriefingItem = z.object({
  runbook: s(100).optional(),
  step: z.coerce.number().int().positive().optional(), // [step N] as the runbook tool numbers them
  title: s(160).min(1),
  decision: z.enum(['do_now', 'not_needed']),
  why: s(300).min(1),
  query: s(2000).optional(), // PromQL to check something; read-only
  action: z.object({
    type: z.enum(ACTION_TYPES as [ActionType, ...ActionType[]]),
    params: z.record(z.string(), z.unknown()),
    risk_level: z.enum(['low', 'medium', 'high']),
    expected: s(300).min(1), rollback: s(300).default(''), verify: s(300).min(1),
  }).optional(),
});
export const BriefingInput = z.object({
  incident_id: z.coerce.number().int().positive(),
  situation: s(400).min(1),
  impact: s(300).min(1),
  cause: s(400).min(1),
  confidence: z.enum(['low', 'medium', 'high']),
  sev: z.object({ sev: z.coerce.number().int().min(1).max(4), why: s(200).min(1) }).optional(),
  items: z.array(BriefingItem).max(8),
});
export type BriefingInput = z.infer<typeof BriefingInput>;

// A checked step, ready to show: where it is in its runbook and the exact command, if any.
export type BriefingStep = Omit<z.infer<typeof BriefingItem>, 'action'> & {
  runbook_title?: string; step_key?: string; step_text?: string; section?: string; pos?: number; total?: number;
  command?: string; // runbook (manual) or catalog command
  action?: { type: ActionType; params: Record<string, string>; summary: string; risk_level: 'low' | 'medium' | 'high'; expected: string; rollback: string; verify: string };
  action_id?: string; // set when stored
};
export type Briefing = Omit<BriefingInput, 'items' | 'incident_id'> & { items: BriefingStep[] };

// Runbook steps numbered as the agents see them: [step 1], [step 2]… across the whole runbook.
export function numberedSteps(rb: Runbook) {
  const out: { n: number; key: string; text: string; section: string; pos: number; total: number }[] = [];
  for (const sec of rb.sections) {
    const steps = sec.blocks.filter((b) => b.kind === 'step');
    steps.forEach((b, i) => out.push({ n: out.length + 1, key: b.key, text: b.text, section: sec.title, pos: i + 1, total: steps.length }));
  }
  return out;
}

// A runbook command that is exactly a catalog action, or null. Only these exact shapes; anything else stays a
// command to copy.
export function catalogAction(cmd: string): { type: ActionType; params: Record<string, string> } | null {
  const c = cmd.trim().replace(/\s+/g, ' ');
  let m = /^kubectl -n (\S+) delete pod (\S+)$/.exec(c);
  if (m) return { type: 'restart_pod', params: { namespace: m[1], pod: m[2] } };
  m = /^flux reconcile (kustomization|helmrelease) (\S+)(?: -n (\S+))?$/.exec(c);
  if (m) return { type: 'flux_reconcile', params: { kind: m[1] === 'kustomization' ? 'Kustomization' : 'HelmRelease', name: m[2], namespace: m[3] ?? 'flux-system' } };
  return null;
}

// Checks a submitted briefing against the runbooks and the catalog. Throws with a message the agent can act on.
export function checkBriefing(input: BriefingInput, all: Runbook[]): Briefing {
  const items = input.items.map((it, i): BriefingStep => {
    const where = `items[${i}]`;
    const out: BriefingStep = { ...it, action: undefined };
    if (it.step && !it.runbook) throw new Error(`${where}: step needs runbook`);
    if (it.runbook) {
      const rb = all.find((r) => r.id === it.runbook);
      if (!rb) throw new Error(`${where}: no runbook "${it.runbook}" (available: ${all.map((r) => r.id).join(', ')})`);
      out.runbook_title = rb.title;
      if (it.step) {
        const st = numberedSteps(rb).find((x) => x.n === it.step);
        if (!st) throw new Error(`${where}: runbook ${rb.id} has no [step ${it.step}]`);
        Object.assign(out, { step_key: st.key, step_text: st.text, section: st.section, pos: st.pos, total: st.total });
        // The step's command: the first backticked text that looks like one (has a space; `maru-heap-full` is a name).
        const cmd = [...st.text.matchAll(/`([^`]+)`/g)].map((m) => m[1]).find((c) => /\s/.test(c.trim()));
        if (cmd) out.command = cmd;
      }
    }
    // A runbook command that is a catalog action gets its button even when the AI did not attach the action
    // (e.g. a step it judged not needed): the IC can still decide to run it.
    const fromRunbook = !it.action && out.command ? catalogAction(out.command) : null;
    let c: ReturnType<typeof checkAction> | null = null;
    try { c = fromRunbook && checkAction(fromRunbook.type, fromRunbook.params); } catch { c = null; } // outside the catalog's scope: copy only
    if (fromRunbook && c) {
      out.action = { type: fromRunbook.type, params: c.params, summary: actionSummary(fromRunbook.type, c.params), risk_level: 'medium', expected: '', rollback: '', verify: 'Ask the AI to verify after it runs.' };
      out.command = c.command;
    }
    if (it.action) {
      c = checkAction(it.action.type, it.action.params); // throws on bad params
      out.action = { type: it.action.type, params: c.params, summary: actionSummary(it.action.type, c.params), risk_level: it.action.risk_level, expected: it.action.expected, rollback: it.action.rollback, verify: it.action.verify };
      out.command = c.command;
    }
    return out;
  });
  const { incident_id: _, ...rest } = input;
  return { ...rest, items };
}
