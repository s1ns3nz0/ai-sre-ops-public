import { runbookStepAction } from '@/app/(console)/incidents/[id]/actions.ts';
import type { RunbookStep } from '@/lib/incidents.ts';
import type { Block, Runbook } from '@/lib/runbooks.ts';
import { RunQuery } from './RunQuery.tsx';
import { Ts } from './Ts.tsx';

const SEV: Record<string, string> = { critical: 'bg-sev1 text-white', warning: 'bg-sev2 text-white' };

// Inline `code` in runbook text.
function Inline({ text }: { text: string }) {
  return <>{text.split(/(`[^`]+`)/).map((p, i) => (p.startsWith('`') && p.endsWith('`') ? <code key={i} className="rounded bg-line/60 px-1 text-[0.9em]">{p.slice(1, -1)}</code> : p))}</>;
}

function explore(grafana: string, expr: string, range: { from: string; to: string }) {
  const panes = { a: { datasource: 'loki', queries: [{ refId: 'A', datasource: { type: 'loki', uid: 'loki' }, expr }], range } };
  return `${grafana}/explore?schemaVersion=1&panes=${encodeURIComponent(JSON.stringify(panes))}`;
}

// One runbook, rendered from its sections. With an incident, steps tick onto its timeline; queries run read-only.
export function RunbookView({ rb, incident, steps = [], live = false, grafana, range, matched }: {
  rb: Runbook; incident?: string; steps?: RunbookStep[]; live?: boolean; grafana: string | null;
  range: { from: string; to: string }; matched?: string;
}) {
  const done = new Map(steps.filter((s) => s.runbook === rb.id).map((s) => [s.step_key, s]));
  const block = (b: Block, i: number) => {
    if (b.kind === 'text') return <p key={i} className="text-sm leading-relaxed"><Inline text={b.text} /></p>;
    if (b.kind === 'item') return <p key={i} className="flex gap-2 text-sm"><span aria-hidden className="text-sub">•</span><span><Inline text={b.text} /></span></p>;
    if (b.kind === 'step') {
      const d = done.get(b.key);
      const box = <span aria-hidden className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border text-[11px] ${d ? 'border-ink bg-ink text-white' : 'border-sub/50 bg-surface'}`}>{d ? '✓' : ''}</span>;
      const body = (
        <span className="min-w-0 text-left">
          <span className={d ? 'text-sub line-through decoration-sub/50' : ''}><Inline text={b.text} /></span>
          {d && <span className="block text-xs text-sub">{d.done_by} · <Ts at={d.done_at} /></span>}
        </span>
      );
      if (!incident || !live) return <div key={i} className="flex items-start gap-2.5 py-1 text-sm">{box}{body}</div>;
      return (
        <form key={i} action={runbookStepAction.bind(null, incident, rb.id, b.key, b.text, !d)}>
          <button className="flex w-full items-start gap-2.5 rounded-md px-1 py-1 text-sm hover:bg-sev4/10" aria-pressed={!!d}>{box}{body}</button>
        </form>
      );
    }
    if (b.lang === 'promql') return <RunQuery key={i} expr={b.text} />;
    if (b.lang === 'logql') {
      return (
        <div key={i} className="flex items-start gap-2 rounded-lg border border-line px-3 py-2">
          <code className="min-w-0 flex-1 whitespace-pre-wrap break-all text-xs">{b.text}</code>
          {grafana && <a href={explore(grafana, b.text, range)} target="_blank" rel="noreferrer" className="h-7 shrink-0 rounded-md border border-line px-2.5 text-xs leading-7 hover:border-ink/40">Open logs</a>}
        </div>
      );
    }
    return <pre key={i} className="overflow-x-auto rounded-lg border border-line px-3 py-2 text-xs">{b.text}</pre>;
  };
  const summary = rb.sections.filter((x) => x.title === 'Meaning' || x.title === 'Impact and severity');
  const rest = rb.sections.filter((x) => !summary.includes(x));
  const meta = (sec: Runbook['sections'][number]) => {
    const st = sec.blocks.filter((b) => b.kind === 'step');
    const q = sec.blocks.filter((b) => b.kind === 'code').length;
    if (st.length) return { text: `${st.filter((b) => b.kind === 'step' && done.has(b.key)).length}/${st.length}`, full: st.every((b) => b.kind === 'step' && done.has(b.key)) };
    return { text: q ? `${q} quer${q === 1 ? 'y' : 'ies'}` : '', full: false };
  };
  return (
    <article>
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-lg font-semibold">{rb.title}</h2>
        {rb.severity && <span className={`rounded px-1.5 text-[11px] ${SEV[rb.severity] ?? 'bg-line'}`}>{rb.severity}</span>}
        <span className="text-xs text-sub">{matched ? `${matched} · ` : ''}reviewed {rb.last_reviewed}</span>
      </header>

      {/* Meaning + impact as a short card: two lines each, the full text one click away */}
      <div className="mt-3 grid gap-3 rounded-xl border border-line px-4 py-3 sm:grid-cols-2">
        {summary.map((sec) => {
          const text = sec.blocks.map((b) => ('text' in b ? b.text : '')).join(' ');
          return (
            <details key={sec.title} className="group/sum min-w-0">
              <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
                <span className="text-xs font-semibold text-sub">{sec.title === 'Meaning' ? 'What it means' : 'Impact'}</span><span className="ml-2 text-xs text-sub group-open/sum:hidden">more</span>
                <span className="mt-0.5 text-sm leading-snug line-clamp-2 group-open/sum:line-clamp-none"><Inline text={text} /></span>
              </summary>
            </details>
          );
        })}
      </div>

      <div className="mt-4 divide-y divide-line border-y border-line">
        {rest.map((sec) => {
          const m = meta(sec);
          const first = sec.title === 'Quick mitigation';
          return (
            <details key={sec.title} open={first} className="group/sec py-1">
              <summary className="flex cursor-pointer list-none items-center gap-2 py-2.5 [&::-webkit-details-marker]:hidden">
                <span aria-hidden className="text-[10px] text-sub transition-transform group-open/sec:rotate-90">▶</span>
                <span className={`text-[15px] font-semibold ${first ? 'text-sev1' : ''}`}>{sec.title}</span>
                {m.text && <span className={`rounded-full px-2 text-xs ${m.full ? 'bg-emerald-600 text-white' : 'bg-line/70 text-sub'}`}>{m.text}</span>}
              </summary>
              <div className="space-y-2 pb-4 pl-5">{sec.blocks.map(block)}</div>
            </details>
          );
        })}
      </div>
      {rb.precedents.length > 0 && <p className="mt-3 text-xs text-sub">Seen in {rb.precedents.join(', ')}{rb.impact_slo.length ? ` · SLOs ${rb.impact_slo.join(', ')}` : ''} · owner {rb.owner}</p>}
    </article>
  );
}
