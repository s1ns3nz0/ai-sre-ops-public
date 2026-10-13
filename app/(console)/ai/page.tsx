import Link from 'next/link';
import { connection } from 'next/server';
import { Suspense } from 'react';
import { Elapsed } from '@/components/Elapsed.tsx';
import { Ts } from '@/components/Ts.tsx';
import { button } from '@/components/ui.tsx';
import { CAPS, aiEnabled } from '@/lib/agent-runs.ts';
import { pool } from '@/lib/db.ts';
import { setAiAction } from './actions.ts';

export default function AiPage() {
  return (
    <div className="min-h-full bg-surface">
      <div className="mx-auto max-w-6xl px-8 py-7">
        <h1 className="text-2xl font-semibold tracking-tight">AI</h1>
        <p className="mt-1 text-sm text-sub">The incident agents: whether they run, what they cost, and every run and action, newest first.</p>
        <Suspense fallback={<p className="mt-6 text-sm text-sub">Loading…</p>}>
          <Body />
        </Suspense>
      </div>
    </div>
  );
}

// OpenRouter account spend (the key's own limit caps it). Null when the key is missing or OpenRouter is unreachable.
async function spend() {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return null;
  try {
    const [c, k] = await Promise.all(['credits', 'key'].map((p) => fetch(`https://openrouter.ai/api/v1/${p}`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(4000) }).then((r) => r.json())));
    return { credits: c.data.total_credits as number, used: c.data.total_usage as number, limit: k.data.limit as number | null, remaining: k.data.limit_remaining as number | null };
  } catch { return null; }
}

async function kagentUp() {
  if (!process.env.KAGENT_URL) return 'KAGENT_URL not set';
  try { const r = await fetch(`${process.env.KAGENT_URL}/api/agents`, { signal: AbortSignal.timeout(3000) }); return r.ok ? null : `HTTP ${r.status}`; }
  catch (e) { return (e as Error).message; }
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const STATUS: Record<string, string> = { running: 'text-sev2', failed: 'text-sev1', stopped: 'text-sev2', done: 'text-emerald-700', proposed: 'text-sev2', skipped: 'text-sub' };

async function Body() {
  await connection();
  const [on, s, down, runs, actions] = await Promise.all([
    aiEnabled(pool()), spend(), kagentUp(),
    pool().query<{ id: string; incident_id: string | null; title: string; kind: string; asked_by: string; status: string; error: string | null; tool_calls: number; tokens_in: number; tokens_out: number; started_at: Date; ended_at: Date | null }>(
      `SELECT r.id::text, r.incident_id::text, coalesce(i.title, '') AS title, r.kind, r.asked_by, r.status, r.error, r.tool_calls, r.tokens_in, r.tokens_out, r.started_at, r.ended_at
       FROM agent_runs r LEFT JOIN incidents i ON i.id = r.incident_id ORDER BY r.id DESC LIMIT 50`),
    pool().query<{ id: string; incident_id: string; command: string; status: string; proposed_by: string; decided_by: string | null; proposed_at: Date }>(
      'SELECT id::text, incident_id::text, command, status, proposed_by, decided_by, proposed_at FROM agent_actions ORDER BY id DESC LIMIT 50'),
  ]);
  const card = 'rounded-xl border border-line px-4 py-3';
  return (
    <>
      <div className="mt-6 grid gap-3 md:grid-cols-3">
        <section className={card}>
          <h2 className="text-xs font-semibold text-sub">Agents</h2>
          <p className="mt-1 text-lg font-semibold">{!on ? 'Off' : down ? 'Unreachable' : 'On'}</p>
          <p className="text-xs text-sub">{down && on ? `Kagent: ${down}` : on ? 'Declaring an incident starts the AI.' : 'No agent runs; declaring works as before.'}</p>
          <form action={setAiAction.bind(null, !on)} className="mt-2">
            <button className={on ? button.danger : button.primary}>{on ? 'Turn AI off' : 'Turn AI on'}</button>
          </form>
        </section>
        <section className={card}>
          <h2 className="text-xs font-semibold text-sub">OpenRouter spend</h2>
          {s ? <>
            <p className="mt-1 text-lg font-semibold tabular-nums">{usd(s.used)} <span className="text-sm font-normal text-sub">of {usd(s.credits)} credit</span></p>
            <p className="text-xs text-sub">{s.limit !== null && s.remaining !== null ? `Key limit ${usd(s.limit)}, ${usd(s.remaining)} left. ` : ''}A full response costs about $0.30.</p>
          </> : <p className="mt-1 text-sm text-sub">Not available (key missing or OpenRouter unreachable).</p>}
        </section>
        <section className={card}>
          <h2 className="text-xs font-semibold text-sub">Limits per run</h2>
          <p className="mt-1 text-sm">{CAPS.toolCalls} tool calls, {CAPS.ms / 60_000} minutes, then the run stops.</p>
          <p className="text-xs text-sub">Agents read the lab only. Changes are proposals; the IC clicks Run and the executor applies them.</p>
        </section>
      </div>

      <h2 className="mt-8 text-sm font-semibold">Runs</h2>
      {!runs.rows.length ? <p className="mt-2 text-sm text-sub">No agent has run yet.</p> : (
        <table className="mt-2 w-full text-sm">
          <thead><tr className="text-left text-xs text-sub"><th className="py-2 font-normal">Started</th><th className="font-normal">Incident</th><th className="font-normal">Asked by</th><th className="font-normal">Status</th><th className="text-right font-normal">Tool calls</th><th className="text-right font-normal">Tokens in/out</th><th className="text-right font-normal">Took</th></tr></thead>
          <tbody>
            {runs.rows.map((r) => (
              <tr key={r.id} className="border-t border-line align-top">
                <td className="py-2 pr-3"><Ts at={r.started_at} /></td>
                <td className="pr-3">{r.incident_id ? <Link className="hover:underline" href={`/incidents/${r.incident_id}?tab=response`}>#{r.incident_id} <span className="text-sub">{r.title}</span></Link> : <span className="text-sub">General question</span>}</td>
                <td className="pr-3">{r.kind === 'respond' ? `${r.asked_by} (response)` : r.asked_by}</td>
                <td className={`pr-3 ${STATUS[r.status] ?? ''}`} title={r.error ?? undefined}>{r.status}</td>
                <td className="pr-3 text-right tabular-nums">{r.tool_calls}</td>
                <td className="pr-3 text-right tabular-nums">{r.tokens_in.toLocaleString()} / {r.tokens_out.toLocaleString()}</td>
                <td className="text-right tabular-nums">{r.ended_at ? <Elapsed from={r.started_at} until={r.ended_at} /> : '…'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="mt-1 text-xs text-sub">Tokens count the main AI only; Investigate and Plan tokens are in the OpenRouter spend.</p>

      <h2 className="mt-8 text-sm font-semibold">Actions</h2>
      {!actions.rows.length ? <p className="mt-2 text-sm text-sub">No action proposed yet.</p> : (
        <table className="mt-2 w-full text-sm">
          <thead><tr className="text-left text-xs text-sub"><th className="py-2 font-normal">Proposed</th><th className="font-normal">Incident</th><th className="font-normal">Command</th><th className="font-normal">By</th><th className="font-normal">Status</th><th className="font-normal">Decided by</th></tr></thead>
          <tbody>
            {actions.rows.map((a) => (
              <tr key={a.id} className="border-t border-line align-top">
                <td className="py-2 pr-3"><Ts at={a.proposed_at} /></td>
                <td className="pr-3"><Link className="hover:underline" href={`/incidents/${a.incident_id}?tab=response`}>#{a.incident_id}</Link></td>
                <td className="pr-3"><code className="text-xs break-all">{a.command}</code></td>
                <td className="pr-3">{a.proposed_by}</td>
                <td className={`pr-3 ${STATUS[a.status] ?? ''}`}>{a.status}</td>
                <td>{a.decided_by ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
