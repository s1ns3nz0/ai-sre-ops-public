'use client';
import Link from 'next/link';
import { runActionAction } from '@/app/(console)/ai/actions.ts';
import { runbookStepAction, sevAction } from '@/app/(console)/incidents/[id]/actions.ts';
import type { Action, StoredBriefing } from '@/lib/agent-runs.ts';
import type { BriefingStep } from '@/lib/briefing.ts';
import { CopyButton } from './CopyButton.tsx';
import { RunQuery } from './RunQuery.tsx';
import { Ts } from './Ts.tsx';
import { button } from './ui.tsx';

const LEVEL: Record<string, string> = { low: 'bg-emerald-600/15 text-emerald-700', medium: 'bg-sev3/20 text-ink', high: 'bg-sev1/15 text-sev1' };

// The AI's briefing: what is going on, and the next steps with their runbook place, command and button.
export function Briefing({ incidentId, b, sev, actions, doneSteps, live, busy, act, refresh }: {
  incidentId: string; b: StoredBriefing; sev: number | null; actions: Action[]; doneSteps: string[]; live: boolean; busy: boolean;
  act: (fn: () => Promise<unknown>) => void; refresh?: React.ReactNode;
}) {
  const now = b.items.filter((x) => x.decision === 'do_now');
  const later = b.items.filter((x) => x.decision === 'not_needed');
  const step = (x: BriefingStep, n: number) => (
    <Step key={`${x.runbook}-${x.step}-${n}`} n={n} x={x} incidentId={incidentId} live={live} busy={busy} act={act}
      action={actions.find((a) => a.id === x.action_id)} done={!!(x.runbook && x.step_key && doneSteps.includes(`${x.runbook}/${x.step_key}`))} />
  );
  return (
    <article className="overflow-hidden rounded-xl border border-ink/25">
      <header className="flex items-baseline gap-2 border-b border-line bg-canvas px-4 py-2.5 text-xs text-sub">
        <b className="text-sm font-semibold text-ink">AI briefing</b>
        <span>v{b.version} · <Ts at={b.created_at} /></span>
        <span className="ml-auto">{refresh}</span>
      </header>
      <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 px-4 py-3 text-sm">
        <dt className="text-sub">Situation</dt><dd className="font-medium">{b.situation}</dd>
        <dt className="text-sub">Impact</dt><dd>{b.impact}</dd>
        <dt className="text-sub">Cause</dt>
        <dd>{b.cause} <span className={`ml-1 rounded px-1.5 text-xs ${LEVEL[b.confidence === 'high' ? 'low' : b.confidence === 'low' ? 'high' : 'medium']}`}>confidence {b.confidence}</span></dd>
        {b.sev && (
          <>
            <dt className="text-sub">SEV</dt>
            <dd className="flex flex-wrap items-center gap-2">
              <span>Suggest <b>SEV{b.sev.sev}</b>: {b.sev.why}</span>
              {live && sev !== b.sev.sev && (
                <button disabled={busy} className={`${button.quiet} h-7`} onClick={() => act(async () => { const f = new FormData(); f.set('sev', String(b.sev!.sev)); await sevAction(incidentId, f); })}>Apply SEV{b.sev.sev}</button>
              )}
              {sev === b.sev.sev && <span className="text-xs text-sub">(current)</span>}
            </dd>
          </>
        )}
      </dl>
      <section className="border-t border-line px-4 py-3">
        <h3 className="text-sm font-semibold">Next steps {now.length > 0 && <span className="font-normal text-sub">{now.length}</span>}</h3>
        {!now.length && <p className="mt-1 text-sm text-sub">Nothing to do now.</p>}
        <ol className="mt-2 space-y-3">{now.map((x, i) => step(x, i + 1))}</ol>
        {later.length > 0 && (
          <details className="mt-3">
            <summary className="cursor-pointer text-sm text-sub hover:text-ink">AI: not needed ({later.length})</summary>
            <ol className="mt-2 space-y-3 opacity-80">{later.map((x, i) => step(x, now.length + i + 1))}</ol>
          </details>
        )}
      </section>
    </article>
  );
}

function Step({ n, x, incidentId, action, done, live, busy, act }: {
  n: number; x: BriefingStep; incidentId: string; action?: Action; done: boolean; live: boolean; busy: boolean; act: (fn: () => Promise<unknown>) => void;
}) {
  const ran = action && action.status !== 'proposed' && action.status !== 'skipped';
  return (
    <li className="flex gap-3">
      <span aria-hidden className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${done ? 'bg-ink text-white' : 'border border-ink/40'}`}>{done ? '✓' : n}</span>
      <div className="min-w-0 flex-1">
        <p className={`text-sm font-medium ${done ? 'text-sub line-through decoration-sub/50' : ''}`}>{x.title}</p>
        <p className="mt-0.5 text-xs text-sub">
          {x.runbook
            ? <Link className="underline-offset-2 hover:underline" href={`/incidents/${incidentId}?tab=runbook&rb=${x.runbook}`}>{x.runbook_title ?? x.runbook}</Link>
            : 'No runbook step'}
          {x.section && <> · {x.section} {x.pos}/{x.total}</>}
        </p>
        <p className="mt-1 text-[13px] text-ink/85">{x.why}</p>
        {x.command && (
          <div className="mt-1.5 flex items-start gap-2">
            <code className="min-w-0 flex-1 rounded bg-canvas px-2 py-1 text-xs break-all">{x.command}</code>
            <CopyButton text={x.command} label="Copy" className="h-7 shrink-0 rounded-md border border-line px-2 text-xs hover:border-ink/40" />
          </div>
        )}
        {x.query && <div className="mt-1.5"><RunQuery expr={x.query} /></div>}
        {x.action && (
          <div className="mt-1.5 rounded-lg border border-line px-3 py-2 text-[13px]">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded px-1.5 text-xs ${LEVEL[x.action.risk_level]}`}>risk {x.action.risk_level}</span>
              {x.action.expected && <span className="text-ink/85">Expected: {x.action.expected}</span>}
            </div>
            {(x.action.rollback || x.action.verify) && <p className="mt-1 text-xs text-sub">{x.action.rollback && <>Rollback: {x.action.rollback} · </>}Verify: {x.action.verify}</p>}
            {action?.status === 'proposed' && live && (
              <button disabled={busy} className={`${button.primary} mt-2`}
                onClick={() => { if (confirm(`${x.action!.summary}\n\nRun on the lab cluster?\n${x.command}`)) act(() => runActionAction(action.id)); }}>Approve & run</button>
            )}
            {ran && (
              <div className="mt-1.5 text-xs">
                <span className={action.status === 'done' ? 'text-emerald-700' : action.status === 'failed' ? 'text-sev1' : 'text-sev2 motion-safe:animate-pulse'}>
                  {action.status === 'running' ? 'Running…' : action.status === 'done' ? 'Done' : 'Failed'}
                </span>
                {action.decided_by && <span className="text-sub"> · approved by {action.decided_by} <Ts at={action.decided_at} /></span>}
                {action.result?.error && <p className="text-sev1">{action.result.error}</p>}
                {action.result?.log?.map((l, i) => <p key={i} className="text-sub">{l}</p>)}
              </div>
            )}
            {action?.status === 'skipped' && <p className="mt-1 text-xs text-sub">Replaced by a newer briefing.</p>}
          </div>
        )}
        {live && x.runbook && x.step_key && !x.action && (
          <button disabled={busy} className="mt-1.5 text-xs text-sub underline-offset-2 hover:text-ink hover:underline"
            onClick={() => act(() => runbookStepAction(incidentId, x.runbook!, x.step_key!, x.step_text ?? x.title, !done))}>{done ? 'Mark not done' : 'Mark done'}</button>
        )}
      </div>
    </li>
  );
}
