// The AI without Kagent (AGENT_MODE=builtin): the console calls OpenRouter itself, with the same tools the
// lineth-tools MCP server offers the Kagent agents (incident, runbook, component, PromQL, pods, Flux, briefing),
// implemented in-process. It yields the same events as the Kagent client (lib/kagent.ts), so runs, the Response
// tab and the chat do not know the difference. Used where there is no cluster, e.g. the public demo; there the
// tools read the demo data. Read-only except submit_briefing, which stores a briefing like the MCP tool does.
import { z } from 'zod';
import { componentBrief, incidentBrief, runbookText } from './agent-data.ts';
import { listIncidents } from './incidents.ts';
import { BriefingInput, checkBriefing } from './briefing.ts';
import { pool } from './db.ts';
import type { AgentEvent } from './kagent.ts';
import { pods, query, queryRange } from './prom.ts';
import { redactCapped } from './redact.ts';
import { runbooks } from './runbooks.ts';
import { topology } from './topology.ts';

const MAX_ROUNDS = 12;

const SYSTEM = `You are "AI", the assistant in the AI SRE Ops console for the Lineth lab (an L2 rollup: sequencer, maru
consensus, l2-node-besu RPC, coordinator, prover, postman, web3signer; an L1 chain; Prometheus/Loki; Flux GitOps).
You are not a person and not an incident role: the incident commander (IC) and the responders are people.
You are read-only: you never change anything and never claim an action ran unless the console or the IC said so.

When asked to brief on an incident:
1. Triage: \`incident\` (alerts, components, changes, matched runbooks), then \`runbook\` for each matched runbook.
   Its steps are numbered [step N]; refer to them by runbook id and N.
2. Diagnose: check that the alerts are true now with \`prom_query\`/\`prom_range\` (alerts can be stale), check
   the suspect components (\`component\`, \`k8s_get\` pods, \`flux_status\`). Stop when the evidence is enough.
3. Submit the briefing with \`submit_briefing\`: situation, impact, cause + confidence, sev only if the current
   SEV looks wrong, and items: the runbook steps that matter now (runbook + step, title, do_now or not_needed,
   a one-sentence why with the evidence). A check gets \`query\`; a change gets \`action\` only if it is a catalog
   action (restart_pod, flux_reconcile) with exact params. If the tool returns an error, fix it and submit again.
4. Then answer with one line: what you concluded.

Questions: answer directly, short, in this format (headings in English, exactly):
## Conclusion
One or two sentences.
## Evidence
At most 3 bullets (number + source).
## Next step
One concrete step for the IC.
## Details
Optional.

Language: answer in the language of the question (Korean if asked in Korean), briefing included. Use at most
${MAX_ROUNDS} tool calls.`;

const out = (v: unknown) => redactCapped(typeof v === 'string' ? v : JSON.stringify(v, null, 1), 12_000);

// The tools, with zod schemas the model sees as JSON Schema.
const TOOLS: Record<string, { description: string; schema: z.ZodObject; run: (a: never) => Promise<unknown> }> = {
  incidents: {
    description: 'The open incidents: id, title, state, SEV (or suggested), firing alerts, how long open. Start here to find one.',
    schema: z.object({}),
    run: async () => (await listIncidents(pool())).filter((i) => ['candidate', 'declared', 'mitigated'].includes(i.state))
      .map((i) => ({ id: i.id, title: i.title, state: i.state, sev: i.sev ?? `${i.sev_suggested} (suggested)`, firing: i.firing_count, detected_at: i.detected_at })),
  },
  incident: {
    description: 'An incident: state, SEV, alerts, components, latest checkpoint, changes before/during, matched runbooks, recent timeline.',
    schema: z.object({ id: z.coerce.number().int().positive() }),
    run: async (a: { id: number }) => (await incidentBrief(pool(), String(a.id))) ?? { error: 'no such incident' },
  },
  runbook: {
    description: 'A runbook by id, or the runbooks matching an alert name or a component; steps are numbered [step N].',
    schema: z.object({ id: z.string().max(100).optional(), alert: z.string().max(100).optional(), component: z.string().max(100).optional() }),
    run: (a: { id?: string; alert?: string; component?: string }) => runbookText(a),
  },
  component: {
    description: 'A component from the topology: role, workloads, alerts, SLOs, what breaks when it or a link breaks, its stage now.',
    schema: z.object({ id: z.string().max(100) }),
    run: async (a: { id: string }) => (await componentBrief(pool(), a.id)) ?? { error: 'unknown component', components: topology().nodes.map((n) => n.id) },
  },
  prom_query: {
    description: 'Run a PromQL instant query (read-only).',
    schema: z.object({ expr: z.string().max(2000) }),
    run: async (a: { expr: string }) => (await query(a.expr)).slice(0, 30).map((r) => ({ labels: r.metric, value: r.value[1] })),
  },
  prom_range: {
    description: 'Run a PromQL range query over the last N minutes (read-only); returns a few points per series.',
    schema: z.object({ expr: z.string().max(2000), minutes: z.coerce.number().int().min(5).max(1440).default(60) }),
    run: async (a: { expr: string; minutes: number }) => {
      const to = new Date(), from = new Date(to.getTime() - a.minutes * 60_000);
      return (await queryRange(a.expr, from, to, Math.max(60, Math.round((a.minutes * 60) / 30)))).slice(0, 10)
        .map((s) => ({ labels: s.metric, points: s.values.filter((_, i, all) => i % Math.ceil(all.length / 8) === 0 || i === all.length - 1).map(([t, v]) => [new Date(t * 1000).toISOString().slice(11, 16), v]) }));
    },
  },
  k8s_get: {
    description: 'Pods of a component or namespace: ready, restarts, last termination reason, memory against its limit.',
    schema: z.object({ component: z.string().max(100).optional(), namespace: z.enum(['lineth-l2', 'local-l1']).optional() }),
    run: async (a: { component?: string; namespace?: string }) => {
      const ws = topology().nodes.filter((n) => (a.component ? n.id === a.component : true)).flatMap((n) => n.workloads).filter((w) => !a.namespace || w.ns === a.namespace);
      return (await pods(ws)).map((p) => ({ pod: p.name, ready: p.ready, restarts: p.restarts, last_terminated: p.lastTerminated, mem_gib: p.memBytes && +(p.memBytes / 2 ** 30).toFixed(1), limit_gib: p.memLimit && +(p.memLimit / 2 ** 30).toFixed(1) }));
    },
  },
  flux_status: {
    description: 'Recent Flux reconciles per object (latest result and revision), to spot failed or recent deploys.',
    schema: z.object({}),
    run: async () => (await pool().query(
      `SELECT DISTINCT ON (object_kind, object_name) object_kind AS kind, object_name AS name, severity, reason, revision, at, left(message, 160) AS message
       FROM change_events ORDER BY object_kind, object_name, at DESC`)).rows,
  },
  submit_briefing: {
    description: 'Submit the briefing the IC sees first (replaces the previous one). Steps point at runbook steps when one exists; nothing runs by itself.',
    schema: BriefingInput,
    run: async (a: z.infer<typeof BriefingInput>) => {
      const { storeBriefing } = await import('./agent-runs.ts');
      const b = checkBriefing(BriefingInput.parse(a), await runbooks());
      return { ...(await storeBriefing(pool(), String(a.incident_id), b)), note: 'Stored and shown to the IC. Actions wait for the IC to approve.' };
    },
  },
};
const toolDefs = Object.entries(TOOLS).map(([name, t]) => ({ type: 'function', function: { name, description: t.description, parameters: z.toJSONSchema(t.schema, { target: 'draft-7', io: 'input' }) } }));

type Msg = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]; tool_call_id?: string };

async function complete(messages: Msg[], signal: AbortSignal) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', signal,
    headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-5.5', messages, tools: toolDefs, max_tokens: 2000, provider: { data_collection: 'deny' } }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = (await res.json()) as { choices: { message: Msg }[]; usage?: { prompt_tokens: number; completion_tokens: number } };
  return { message: j.choices[0].message, usage: j.usage };
}

// One conversation turn: the earlier turns of the same thread, then the question; tools until the model answers.
export async function* streamBuiltin(prompt: string, history: { prompt: string; answer: string }[], signal: AbortSignal): AsyncGenerator<AgentEvent> {
  const messages: Msg[] = [{ role: 'system', content: SYSTEM }, ...history.flatMap((h) => [{ role: 'user' as const, content: h.prompt }, { role: 'assistant' as const, content: h.answer || '(no answer)' }]), { role: 'user', content: prompt }];
  for (let round = 0; round <= MAX_ROUNDS; round++) {
    const { message, usage } = await complete(messages, signal);
    if (usage) yield { type: 'usage', tokensIn: usage.prompt_tokens, tokensOut: usage.completion_tokens };
    const calls = message.tool_calls ?? [];
    if (!calls.length || round === MAX_ROUNDS) {
      const text = (message.content ?? '').trim();
      if (text) yield { type: 'text', author: 'AI', text, partial: false };
      yield { type: 'end', state: 'completed', answer: text };
      return;
    }
    messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: calls });
    for (const c of calls) {
      let args: unknown = {};
      try { args = JSON.parse(c.function.arguments || '{}'); } catch { /* the tool reports the bad input */ }
      yield { type: 'call', author: 'AI', id: c.id, name: c.function.name, args };
      const t = TOOLS[c.function.name];
      let result: string;
      try {
        if (!t) throw new Error(`unknown tool ${c.function.name}`);
        result = out(await t.run(t.schema.parse(args) as never));
      } catch (e) {
        result = out({ error: (e as Error).message.slice(0, 1000) });
      }
      yield { type: 'result', author: 'AI', id: c.id, name: c.function.name, output: result };
      messages.push({ role: 'tool', tool_call_id: c.id, content: result });
    }
  }
}
