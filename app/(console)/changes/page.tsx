import { connection } from 'next/server';
import { Suspense } from 'react';
import { Ts } from '@/components/Ts.tsx';
import { pool } from '@/lib/db.ts';
import { chgs, inProgress, type Chg } from '@/lib/chg.ts';
import type { ChangeEvent } from '@/lib/changes.ts';

export default function ChangesPage() {
  return (
    <div className="min-h-full bg-surface">
      <div className="mx-auto max-w-5xl px-8 py-7">
        <h1 className="text-2xl font-semibold tracking-tight">Changes</h1>
        <p className="mt-1 text-sm text-sub">CHGs from lineth-l2-gitops and what Flux deployed. Alerts during a change are marked, never silenced.</p>
        <Suspense fallback={<p className="mt-6 text-sm text-sub">Loading…</p>}>
          <Body />
        </Suspense>
      </div>
    </div>
  );
}

const RISK_CLS = { high: 'bg-sev1 text-white', medium: 'bg-sev2 text-white', low: 'bg-line text-sub' } as const;

function ChgList({ title, list, empty }: { title: string; list: Chg[]; empty: string }) {
  return (
    <section className="border-t border-line py-5">
      <h2 className="mb-3 text-[15px] font-semibold">{title} <span className="font-normal text-sub">{list.length}</span></h2>
      {!list.length ? <p className="text-sm text-sub">{empty}</p> : (
        <ul className="divide-y divide-line">
          {list.map((c) => (
            <li key={c.id} className="flex items-baseline gap-3 py-2.5 text-sm">
              <span className={`w-14 shrink-0 rounded text-center text-[11px] ${RISK_CLS[c.risk]}`}>{c.risk}</span>
              <span className="min-w-0 flex-1">
                <a href={c.href} target="_blank" rel="noreferrer" className="font-medium underline-offset-2 hover:underline">{c.id}</a> {c.title}
                <span className="block text-xs text-sub">{c.status} · {c.components.length ? c.components.join(', ') : 'no topology component'}</span>
              </span>
              <span className="shrink-0 text-right text-xs text-sub"><Ts at={c.window.start} /><br />{c.window.end ? <>to <Ts at={c.window.end} /></> : 'open-ended'}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

async function Body() {
  await connection();
  const [{ chgs: all, errors }, flux] = await Promise.all([
    chgs(),
    pool().query<ChangeEvent>(`SELECT id::text, at, severity, object_kind, object_ns, object_name, reason, message, revision, components
      FROM change_events WHERE at > now() - interval '7 days' ORDER BY at DESC LIMIT 100`).then((r) => r.rows),
  ]);
  const now = inProgress(all);
  const upcoming = all.filter((c) => !now.includes(c) && c.window.start > new Date() && c.status !== 'closed');
  const rest = all.filter((c) => !now.includes(c) && !upcoming.includes(c)).sort((a, b) => b.window.start.getTime() - a.window.start.getTime());
  return (
    <div className="mt-6">
      {errors.length > 0 && <ul className="mb-4 text-sm text-sev2">{errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      <ChgList title="In progress" list={now} empty="No CHG is being implemented right now." />
      <ChgList title="Upcoming" list={upcoming} empty="Nothing scheduled." />
      <section className="border-t border-line py-5">
        <h2 className="mb-3 text-[15px] font-semibold">Flux deploys, last 7 days <span className="font-normal text-sub">{flux.length}</span></h2>
        {!flux.length ? <p className="text-sm text-sub">No Flux events received. Point a Flux Provider (generic-hmac) at /api/flux.</p> : (
          <ul className="divide-y divide-line">
            {flux.map((e) => (
              <li key={e.id} className="flex items-baseline gap-3 py-2 text-sm">
                <span className={`w-14 shrink-0 text-xs font-medium ${e.severity === 'error' ? 'text-sev1' : 'text-sev3'}`}>{e.severity === 'error' ? 'Failed' : 'Deployed'}</span>
                <span className="min-w-0 flex-1">{e.object_kind} <b className="font-medium">{e.object_name}</b> <span className="text-sub">{e.revision.replace(/sha1:([0-9a-f]{7})[0-9a-f]+/, '$1')}</span>
                  <span className="block truncate text-xs text-sub" title={e.message}>{e.message.split('\n')[0]}{e.components.length ? ` · ${e.components.join(', ')}` : ''}</span></span>
                <span className="shrink-0 text-xs text-sub"><Ts at={e.at} /></span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <ChgList title="Earlier" list={rest} empty="None." />
    </div>
  );
}
