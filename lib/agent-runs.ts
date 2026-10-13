// Agent runs (P2): the console asks the AI (Kagent agent ai-respond) and records what happened; the IC runs or skips the actions
// agents proposed, through the executor. One conversation (Kagent context) per incident, shared by the automatic
// response and the chat. Agents never reach the executor; only runAction below does, after an IC click.
import type pg from 'pg';
import { tx } from './db.ts';
import { isDemo } from './demo.ts';
import type { Briefing } from './briefing.ts';
import { event, setRunbookStep } from './incidents.ts';
import { streamAgent, type AgentEvent } from './kagent.ts';
import { streamBuiltin } from './builtin-agent.ts';
import { redactCapped } from './redact.ts';

export const LEAD = 'ai-respond';
// Per run: visible tool calls (sub-agents count as one each) and wall time. Spend is capped by the OpenRouter key limit.
export const CAPS = { toolCalls: 40, ms: 10 * 60_000 };

export type Step = { id: string; at: Date; author: string; name: string; args: unknown; result: string | null };
export type Run = {
  id: string; kind: 'respond' | 'chat' | 'general'; prompt: string; asked_by: string; status: 'running' | 'done' | 'failed' | 'stopped';
  answer: string; error: string | null; tool_calls: number; tokens_in: number; tokens_out: number; started_at: Date; ended_at: Date | null; steps: Step[];
};
export type Action = {
  id: string; type: string; params: Record<string, string>; command: string; reason: string; expected: string; risk: string;
  risk_level: 'low' | 'medium' | 'high'; rollback: string; verify: string; runbook: string | null; status: 'proposed' | 'running' | 'done' | 'failed' | 'skipped';
  proposed_by: string; proposed_at: Date; decided_by: string | null; decided_at: Date | null;
  result: { ok: boolean; log?: string[]; error?: string; before?: unknown; after?: unknown } | null;
};

// Runs in flight in this process. ponytail: single console process; a run whose process died is marked failed below.
const g = globalThis as unknown as { agentRuns?: Map<string, AbortController> };
const live = (g.agentRuns ??= new Map());

// Where the AI runs: Kagent (the lab), the built-in agent (OpenRouter from the console, AGENT_MODE=builtin), or none.
export const aiBackend = (): 'kagent' | 'builtin' | null =>
  process.env.KAGENT_URL ? 'kagent' : process.env.AGENT_MODE === 'builtin' && process.env.OPENROUTER_API_KEY ? 'builtin' : null;

export async function aiEnabled(db: pg.Pool): Promise<boolean> {
  if (!aiBackend()) return false;
  const r = await db.query<{ value: string }>("SELECT value FROM settings WHERE key = 'ai_enabled'");
  return r.rows[0]?.value !== 'false';
}

// Demo mode: each person gets a few AI requests a day (questions, briefings), so a shared demo cannot run up the
// model bill. null outside demo mode.
export const DEMO_AI_LIMIT = () => Number(process.env.DEMO_AI_LIMIT ?? 5);
export async function demoQuota(db: pg.Pool, by: string): Promise<{ used: number; limit: number } | null> {
  if (!isDemo()) return null;
  const used = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM agent_runs WHERE asked_by = $1 AND started_at > now() - interval '24 hours'", [by])).rows[0].n;
  return { used, limit: DEMO_AI_LIMIT() };
}
async function checkQuota(db: pg.Pool, by: string) {
  if (by === 'console') return; // the console's own verify request after an action the person ran
  const q = await demoQuota(db, by);
  if (q && q.used >= q.limit) throw new Error(`Demo limit reached: ${q.limit} AI requests per person per day. Try again tomorrow.`);
  // And one cap for the whole demo, whatever the cookies say.
  const site = Number(process.env.DEMO_AI_SITE_LIMIT ?? 30);
  if (q && (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM agent_runs WHERE asked_by <> 'console' AND started_at > now() - interval '24 hours'")).rows[0].n >= site)
    throw new Error(`The demo's AI budget for today (${site} requests) is used up. Try again tomorrow.`);
}

export async function setAiEnabled(db: pg.Pool, on: boolean) {
  await db.query("INSERT INTO settings (key, value) VALUES ('ai_enabled', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [String(on)]);
}

// Automatic responses are answered in Korean (the IC's language); chat answers follow the question's language.
const respondPrompt = (id: string, state: string, sev: number | null, by: string) => (state === 'candidate'
  ? `Incident #${id} is a candidate, not declared yet; ${by} asked you to look at it. Brief the IC: triage, diagnose, then submit_briefing (always submit a new one, even if the plan did not change).`
  : `Incident #${id} was just declared (SEV${sev ?? '?'}) by ${by}. Brief the IC: triage, diagnose, then submit_briefing (always submit a new one, even if the plan did not change).`) + (isDemo() ? ' Write the briefing and your answer in English.' : ' Write the briefing and your answer in Korean.');

// Starts the AI on an incident and returns the run id; the run continues in the background.
export async function startRun(db: pg.Pool, incidentId: string, kind: Run['kind'], by: string, text = ''): Promise<string> {
  if (!(await aiEnabled(db))) throw new Error('AI is off. Turn it on at /ai.');
  await checkQuota(db, by);
  const inc = (await db.query<{ state: string; sev: number | null }>('SELECT state, sev FROM incidents WHERE id = $1', [incidentId])).rows[0];
  if (!inc) throw new Error('no such incident');
  if (!['candidate', 'declared', 'mitigated'].includes(inc.state)) throw new Error(`incident is ${inc.state}`);
  // A run left 'running' by a process that died would block the incident forever.
  // (Older than a minute, so a run another request just inserted is not swept before it registers.)
  const stale = (await db.query<{ id: string }>("SELECT id::text FROM agent_runs WHERE incident_id = $1 AND status = 'running' AND started_at < now() - interval '1 minute'", [incidentId])).rows.filter((r) => !live.has(r.id));
  for (const r of stale) await db.query("UPDATE agent_runs SET status = 'failed', error = 'interrupted (console restarted)', ended_at = now() WHERE id = $1", [r.id]);
  const ctx = (await db.query<{ context_id: string }>('SELECT context_id FROM agent_runs WHERE incident_id = $1 AND agent = $2 AND context_id IS NOT NULL ORDER BY id DESC LIMIT 1', [incidentId, LEAD])).rows[0]?.context_id ?? null;
  const prompt = kind === 'respond' ? respondPrompt(incidentId, inc.state, inc.sev, by) : `[${by}, incident #${incidentId}] ${text}`;
  let id: string;
  try {
    id = (await db.query<{ id: string }>('INSERT INTO agent_runs (incident_id, kind, prompt, asked_by, context_id, agent) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id::text',
      [incidentId, kind, prompt, by, ctx, LEAD])).rows[0].id;
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new Error('The agent is still working on this incident. Wait for it or stop it.');
    throw e;
  }
  const ac = new AbortController();
  live.set(id, ac);
  void drive(db, incidentId, id, prompt, ctx, ac).catch((e) => console.error(`agent run ${id}:`, e)).finally(() => live.delete(id));
  return id;
}

// The ⌘K assistant: a question about anything (the lab, incidents, SLOs, how-to), not tied to an incident. One
// private conversation per person; `fresh` starts a new one.
export async function startGeneral(db: pg.Pool, by: string, text: string, fresh: boolean): Promise<string> {
  if (!(await aiEnabled(db))) throw new Error('AI is off. Turn it on at /ai.');
  await checkQuota(db, by);
  const busy = (await db.query<{ id: string }>("SELECT id::text FROM agent_runs WHERE kind = 'general' AND asked_by = $1 AND status = 'running'", [by])).rows;
  if (busy.some((r) => live.has(r.id))) throw new Error('The AI is still answering your last question.');
  for (const r of busy) await db.query("UPDATE agent_runs SET status = 'failed', error = 'interrupted (console restarted)', ended_at = now() WHERE id = $1", [r.id]);
  const ctx = fresh ? null : (await db.query<{ context_id: string }>(
    "SELECT context_id FROM agent_runs WHERE kind = 'general' AND asked_by = $1 AND agent = $2 AND context_id IS NOT NULL ORDER BY id DESC LIMIT 1", [by, LEAD])).rows[0]?.context_id ?? null;
  const prompt = `[general question from ${by}, not about one incident unless they name it; answer, do not submit a briefing] ${text}`;
  const id = (await db.query<{ id: string }>("INSERT INTO agent_runs (incident_id, kind, prompt, asked_by, context_id, agent) VALUES (NULL, 'general', $1, $2, $3, $4) RETURNING id::text",
    [prompt, by, ctx, LEAD])).rows[0].id;
  const ac = new AbortController();
  live.set(id, ac);
  void drive(db, null, id, prompt, ctx, ac).catch((e) => console.error(`agent run ${id}:`, e)).finally(() => live.delete(id));
  return id;
}

// The person's current general conversation (since their last "New chat").
export async function generalState(db: pg.Pool, by: string): Promise<Run[]> {
  const last = (await db.query<{ id: string; context_id: string | null }>("SELECT id::text, context_id FROM agent_runs WHERE kind = 'general' AND asked_by = $1 ORDER BY id DESC LIMIT 1", [by])).rows[0];
  if (!last) return [];
  const runs = (await db.query<Omit<Run, 'steps'>>(
    `SELECT id::text, kind, prompt, asked_by, status, answer, error, tool_calls, tokens_in, tokens_out, started_at, ended_at
     FROM agent_runs WHERE kind = 'general' AND asked_by = $1 AND (id = $2 OR context_id = $3) ORDER BY id DESC LIMIT 30`, [by, last.id, last.context_id])).rows.reverse();
  const steps = (await db.query<Step & { run_id: string }>(
    'SELECT id::text, run_id::text, at, author, name, args, result FROM agent_steps WHERE run_id = ANY($1::bigint[]) ORDER BY id', [runs.map((r) => r.id)])).rows;
  return runs.map((r) => ({ ...r, steps: steps.filter((x) => x.run_id === r.id) }));
}

export function stopRun(runId: string): boolean {
  const ac = live.get(runId);
  ac?.abort(new Error('stopped by the IC'));
  return !!ac;
}

async function drive(db: pg.Pool, incidentId: string | null, id: string, prompt: string, ctx: string | null, ac: AbortController) {
  const timer = setTimeout(() => ac.abort(new Error(`time cap ${CAPS.ms / 60_000} min`)), CAPS.ms);
  let done = ''; // finished text turns
  let partial = '';
  let answer: string | null = null;
  let calls = 0;
  let flushed = 0;
  const flush = async (force = false) => {
    if (!force && Date.now() - flushed < 800) return;
    flushed = Date.now();
    await db.query('UPDATE agent_runs SET answer = $2 WHERE id = $1', [id, redactCapped(answer ?? done + partial, 50_000)]);
  };
  let status: Run['status'] = 'done';
  let error: string | null = null;
  let ended = false;
  try {
    // The built-in agent keeps the thread itself: earlier turns of the same context are sent as history.
    let events: AsyncGenerator<AgentEvent>;
    if (aiBackend() === 'builtin') {
      const history = ctx ? (await db.query<{ prompt: string; answer: string }>(
        "SELECT prompt, answer FROM agent_runs WHERE context_id = $1 AND id <> $2 AND status = 'done' ORDER BY id DESC LIMIT 6", [ctx, id])).rows.reverse() : [];
      if (!ctx) { ctx = `builtin-${crypto.randomUUID()}`; await db.query('UPDATE agent_runs SET context_id = $2 WHERE id = $1', [id, ctx]); }
      events = streamBuiltin(prompt, history, ac.signal);
    } else events = streamAgent(LEAD, prompt, ctx, ac.signal);
    for await (const ev of events) {
      if (ev.type === 'context' && !ctx) { ctx = ev.contextId; await db.query('UPDATE agent_runs SET context_id = $2 WHERE id = $1', [id, ctx]); }
      else if (ev.type === 'call') {
        calls++;
        await db.query('INSERT INTO agent_steps (run_id, author, call_id, name, args) VALUES ($1,$2,$3,$4,$5)', [id, ev.author, ev.id, ev.name, redactCapped(JSON.stringify(ev.args ?? null), 20_000)]);
        await db.query('UPDATE agent_runs SET tool_calls = $2 WHERE id = $1', [id, calls]);
        if (calls > CAPS.toolCalls) ac.abort(new Error(`tool call cap ${CAPS.toolCalls}`));
      } else if (ev.type === 'result') {
        await db.query('UPDATE agent_steps SET result = $4 WHERE run_id = $1 AND call_id = $2 AND author = $3', [id, ev.id, ev.author, redactCapped(ev.output, 20_000)]);
      } else if (ev.type === 'text') {
        if (ev.partial) partial += ev.text; else { done += (done ? '\n\n' : '') + ev.text; partial = ''; }
        await flush(!ev.partial);
      } else if (ev.type === 'usage') {
        await db.query('UPDATE agent_runs SET tokens_in = tokens_in + $2, tokens_out = tokens_out + $3 WHERE id = $1', [id, ev.tokensIn, ev.tokensOut]);
      } else if (ev.type === 'end') {
        ended = true;
        if (ev.answer) answer = ev.answer;
        if (ev.state !== 'completed') { status = 'failed'; error = ev.error ?? ev.state; }
      }
    }
  } catch (e) {
    status = ac.signal.aborted ? 'stopped' : 'failed';
    error = ((ac.signal.reason as Error | undefined)?.message ?? (e as Error).message).slice(0, 2000);
  } finally {
    clearTimeout(timer);
    ac.abort(); // a consumer error must not leave the Kagent request streaming (and spending)
  }
  if (!ended && status === 'done') { status = 'failed'; error = 'the stream closed before the agent finished'; }
  const final = redactCapped(answer ?? done + partial, 50_000);
  error = error && redactCapped(error, 2000);
  await db.query('UPDATE agent_runs SET status = $2, error = $3, answer = $4, ended_at = now() WHERE id = $1', [id, status, error, final]);
  if (incidentId) await tx((c) => event(c, incidentId, 'agent_run', 'AI', { run: id, status, tool_calls: calls, error }), db);
}

export type StoredBriefing = Briefing & { version: number; created_at: Date };

// Stores a checked briefing as the incident's newest version. Its actions become proposals for the IC; proposals
// from older versions that nobody decided are retired. The timeline keeps every version.
export async function storeBriefing(db: pg.Pool, incidentId: string, b: Briefing) {
  return tx(async (c) => {
    const inc = (await c.query<{ state: string }>('SELECT state FROM incidents WHERE id = $1 FOR UPDATE', [incidentId])).rows[0];
    if (!inc) throw new Error('no such incident');
    if (!['candidate', 'declared', 'mitigated'].includes(inc.state)) throw new Error(`incident is ${inc.state}`);
    const version = (await c.query<{ v: number }>('SELECT coalesce(max(version), 0) + 1 AS v FROM agent_briefings WHERE incident_id = $1', [incidentId])).rows[0].v;
    const id = (await c.query<{ id: string }>('INSERT INTO agent_briefings (incident_id, version, body) VALUES ($1,$2,$3) RETURNING id::text', [incidentId, version, b])).rows[0].id;
    await c.query("UPDATE agent_actions SET status = 'skipped', decided_by = 'AI', decided_at = now() WHERE incident_id = $1 AND status = 'proposed'", [incidentId]);
    for (const it of b.items) {
      if (!it.action || !it.command) continue;
      it.action_id = (await c.query<{ id: string }>(
        `INSERT INTO agent_actions (incident_id, type, params, command, reason, expected, risk, risk_level, rollback, verify, runbook, proposed_by, briefing_id, step_key, step_text)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'AI',$12,$13,$14) RETURNING id::text`,
        [incidentId, it.action.type, it.action.params, it.command, it.why, it.action.expected, it.action.risk_level, it.action.risk_level, it.action.rollback, it.action.verify, it.runbook ?? null, id, it.step_key ?? null, it.step_text ?? null])).rows[0].id;
    }
    await c.query('UPDATE agent_briefings SET body = $2 WHERE id = $1', [id, b]);
    await event(c, incidentId, 'briefing', 'AI', { version, situation: b.situation, steps: b.items.filter((x) => x.decision === 'do_now').length });
    return { version, actions: b.items.filter((x) => x.action_id).map((x) => x.action_id) };
  }, db);
}

export async function agentState(db: pg.Pool, incidentId: string): Promise<{ runs: Run[]; actions: Action[]; briefing: StoredBriefing | null; doneSteps: string[] }> {
  const runs = (await db.query<Omit<Run, 'steps'>>(
    `SELECT id::text, kind, prompt, asked_by, status, answer, error, tool_calls, tokens_in, tokens_out, started_at, ended_at
     FROM agent_runs WHERE incident_id = $1 ORDER BY id DESC LIMIT 30`, [incidentId])).rows.reverse();
  const steps = runs.length ? (await db.query<Step & { run_id: string }>(
    'SELECT id::text, run_id::text, at, author, name, args, result FROM agent_steps WHERE run_id = ANY($1::bigint[]) ORDER BY id', [runs.map((r) => r.id)])).rows : [];
  const actions = (await db.query<Action>(
    `SELECT id::text, type, params, command, reason, expected, risk, risk_level, rollback, verify, runbook, status, proposed_by, proposed_at, decided_by, decided_at, result
     FROM agent_actions WHERE incident_id = $1 ORDER BY id`, [incidentId])).rows;
  const br = (await db.query<{ body: Briefing; version: number; created_at: Date }>('SELECT body, version, created_at FROM agent_briefings WHERE incident_id = $1 ORDER BY version DESC LIMIT 1', [incidentId])).rows[0];
  const doneSteps = (await db.query<{ k: string }>("SELECT runbook || '/' || step_key AS k FROM runbook_steps WHERE incident_id = $1", [incidentId])).rows.map((r) => r.k);
  return { runs: runs.map((r) => ({ ...r, steps: steps.filter((s) => s.run_id === r.id) })), actions, briefing: br ? { ...br.body, version: br.version, created_at: br.created_at } : null, doneSteps };
}

// The IC clicked Run: claim the proposal, call the executor, record the outcome, then ask the AI to verify.
export async function runAction(db: pg.Pool, actionId: string, by: string) {
  const url = process.env.EXECUTOR_URL;
  const token = process.env.EXECUTOR_TOKEN;
  if (!url || !token) throw new Error('EXECUTOR_URL / EXECUTOR_TOKEN not set');
  // Claim and audit in one transaction, the incident row locked so it cannot close in between; the executor is
  // called after commit.
  const a = await tx(async (c) => {
    const row = (await c.query<{ incident_id: string; type: string; params: unknown; command: string; verify: string; runbook: string | null; step_key: string | null; step_text: string | null }>(
      `UPDATE agent_actions SET status = 'running', decided_by = $2, decided_at = now()
       WHERE id = $1 AND status = 'proposed'
         AND incident_id IN (SELECT id FROM incidents WHERE state IN ('candidate','declared','mitigated') FOR SHARE)
       RETURNING incident_id::text, type, params, command, verify, runbook, step_key, step_text`, [actionId, by])).rows[0];
    if (row) await event(c, row.incident_id, 'action_run', by, { action: actionId, command: row.command });
    return row;
  }, db);
  if (!a) throw new Error('This action was already decided, or the incident is no longer open.');
  void (async () => {
    let result: NonNullable<Action['result']>;
    try {
      const res = await fetch(`${url}/run`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ action_id: actionId, type: a.type, params: a.params }), signal: AbortSignal.timeout(240_000),
      });
      result = res.ok ? (await res.json()) ?? { ok: false, error: 'empty executor response' } : { ok: false, error: `executor ${res.status}: ${(await res.text()).slice(0, 300)}` };
    } catch (e) {
      // After the request was sent the executor may still be acting: say so instead of a plain failure.
      result = { ok: false, error: `no answer from the executor (${(e as Error).message.slice(0, 200)}); it may still have acted, check the target` };
    }
    await tx(async (c) => {
      await c.query('UPDATE agent_actions SET status = $2, result = $3 WHERE id = $1', [actionId, result.ok ? 'done' : 'failed', result]);
      await event(c, a.incident_id, 'action_result', 'executor', { action: actionId, command: a.command, ok: result.ok, log: result.log ?? [], error: result.error ?? null });
      // The runbook step it came from is done.
      if (result.ok && a.runbook && a.step_key) await setRunbookStep(c, a.incident_id, a.runbook, a.step_key, a.step_text ?? a.command, true, by);
    }, db);
    const summary = result.ok ? `It finished: ${(result.log ?? []).join('; ')}.` : `It failed: ${result.error}.`;
    await startRun(db, a.incident_id, 'chat', 'console', `The IC ran action #${actionId} (\`${a.command}\`). ${summary} Verify it with: ${a.verify} Then submit an updated briefing.`)
      .catch(() => {}); // AI off or a run in progress: the IC can ask in the chat
  })().catch((e) => console.error(`action ${actionId}:`, e));
}

export async function skipAction(db: pg.Pool, actionId: string, by: string) {
  const a = await tx(async (c) => {
    const row = (await c.query<{ incident_id: string; command: string }>(
      "UPDATE agent_actions SET status = 'skipped', decided_by = $2, decided_at = now() WHERE id = $1 AND status = 'proposed' RETURNING incident_id::text, command", [actionId, by])).rows[0];
    if (row) await event(c, row.incident_id, 'action_skipped', by, { action: actionId, command: row.command });
    return row;
  }, db);
  if (!a) throw new Error('This action was already decided.');
}
