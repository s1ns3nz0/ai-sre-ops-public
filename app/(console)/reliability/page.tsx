import Link from 'next/link';
import { connection } from 'next/server';
import { Suspense } from 'react';
import { Ts } from '@/components/Ts.tsx';
import { pool } from '@/lib/db.ts';
import { openFollowUps, reliabilityRows } from '@/lib/priority.ts';
import { METRICS, METRIC_LABEL, durations, repeats, summarize } from '@/lib/reliability.ts';
import { fmtDuration } from '@/lib/time.ts';
import { topology } from '@/lib/topology.ts';

export default function ReliabilityPage({ searchParams }: PageProps<'/reliability'>) {
  return (
    <div className="min-h-full bg-surface">
      <div className="mx-auto max-w-6xl px-8 py-7">
        <h1 className="text-2xl font-semibold tracking-tight">Reliability</h1>
        <p className="mt-1 text-sm text-sub">How fast incidents are seen, answered, contained and fixed; where they come from; what is still owed. Declared incidents only.</p>
        <Suspense fallback={<p className="mt-6 text-sm text-sub">Loading…</p>}>
          <Body searchParams={searchParams} />
        </Suspense>
      </div>
    </div>
  );
}

const DAYS = [30, 90] as const;
const d = (ms: number | null) => (ms === null ? '—' : fmtDuration(ms));

async function Body({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  const sp = await searchParams;
  const days = sp.days === '90' ? 90 : 30;
  const sev = typeof sp.sev === 'string' && /^[1-4]$/.test(sp.sev) ? Number(sp.sev) : undefined;
  const t = topology();
  const [rows, owed] = await Promise.all([reliabilityRows(pool(), t, days, sev), openFollowUps(pool())]);
  const stats = summarize(rows);
  const reps = repeats(rows);
  const byCause = [...rows.reduce((m, r) => m.set(r.cause ?? 'unknown', (m.get(r.cause ?? 'unknown') ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...byCause.map((x) => x[1]));
  const href = (o: { days?: number; sev?: number | null }) => {
    const q = new URLSearchParams();
    const dd = o.days ?? days, ss = o.sev === undefined ? sev : o.sev;
    if (dd !== 30) q.set('days', String(dd));
    if (ss) q.set('sev', String(ss));
    return `/reliability${q.size ? `?${q}` : ''}`;
  };
  const chip = (on: boolean) => `inline-flex h-7 items-center rounded-md px-2.5 text-sm ${on ? 'bg-ink text-white' : 'text-sub hover:text-ink'}`;
  const overdue = owed.filter((f) => Date.now() - new Date(f.created_at).getTime() > 30 * 86_400_000).length;

  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <span className="inline-flex rounded-lg border border-line p-0.5">{DAYS.map((x) => <Link key={x} href={href({ days: x })} className={chip(days === x)}>Last {x} days</Link>)}</span>
        <span className="inline-flex rounded-lg border border-line p-0.5">
          <Link href={href({ sev: null })} className={chip(!sev)}>All SEV</Link>
          {[1, 2, 3, 4].map((x) => <Link key={x} href={href({ sev: x })} className={chip(sev === x)}>SEV{x}</Link>)}
        </span>
        <span className="text-sub">{rows.length} incident{rows.length === 1 ? '' : 's'}</span>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-x-6 gap-y-5 border-y border-line py-5 sm:grid-cols-4">
        {METRICS.map((m) => (
          <div key={m}>
            <div className="text-3xl font-semibold tracking-tight">{d(stats[m].p50)}</div>
            <div className="mt-0.5 text-sm font-medium">{METRIC_LABEL[m].short} <span className="font-normal text-sub">median</span></div>
            <div className="text-xs text-sub">{METRIC_LABEL[m].what} · p90 {d(stats[m].p90)} · n={stats[m].n}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-x-10 lg:grid-cols-2">
        <section className="border-b border-line py-5">
          <h2 className="mb-3 text-[15px] font-semibold">Incidents by probable cause</h2>
          {!byCause.length ? <p className="text-sm text-sub">No declared incidents in this window.</p> : (
            <ul className="space-y-2">
              {byCause.map(([c, n]) => (
                <li key={c} className="flex items-center gap-3 text-sm">
                  <span className="w-28 shrink-0 font-medium">{c}</span>
                  <span className="h-2 flex-1 overflow-hidden rounded-full bg-line"><span className="block h-full bg-ink" style={{ width: `${(n / max) * 100}%` }} /></span>
                  <span className="w-6 text-right tabular-nums">{n}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="border-b border-line py-5">
          <h2 className="mb-3 text-[15px] font-semibold">Repeats <span className="font-normal text-sub">same cause within 30 days</span></h2>
          {!reps.length ? <p className="text-sm text-sub">No repeated cause.</p> : (
            <ul className="space-y-2 text-sm">
              {reps.map((r) => (
                <li key={r.cause}><b className="font-medium">{r.cause}</b> ×{r.incidents.length}: {r.incidents.map((i, k) => <span key={i.id}>{k ? ', ' : ''}<Link href={`/incidents/${i.id}`} className="underline underline-offset-2">#{i.id}</Link></span>)}</li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="border-b border-line py-5">
        <h2 className="mb-3 text-[15px] font-semibold">Open follow-ups <span className="font-normal text-sub">{owed.length}{overdue ? `, ${overdue} over 30 days` : ''}</span></h2>
        {!owed.length ? <p className="text-sm text-sub">Nothing owed.</p> : (
          <ul className="divide-y divide-line">
            {owed.map((f) => {
              const old = Date.now() - new Date(f.created_at).getTime() > 30 * 86_400_000;
              return (
                <li key={f.id} className="flex items-center gap-3 py-2 text-sm">
                  <span className="w-8 shrink-0 text-xs font-semibold">{f.priority}</span>
                  <span className="min-w-0 flex-1">{f.action}{old && <span className="ml-2 rounded bg-sev2/15 px-1.5 text-[11px] text-sev2">over 30 days</span>}</span>
                  <span className="shrink-0 text-xs text-sub">{f.issue_number ? `#${f.issue_number} mock` : 'no issue'}</span>
                  <Link href={`/incidents/${f.incident_id}`} className="w-12 shrink-0 text-right text-xs underline underline-offset-2">#{f.incident_id}</Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="py-5">
        <h2 className="mb-3 text-[15px] font-semibold">Incidents</h2>
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-sub">
            <th className="pb-2 font-normal">Incident</th><th className="pb-2 font-normal">Cause</th>
            {METRICS.map((m) => <th key={m} className="pb-2 text-right font-normal">{METRIC_LABEL[m].short}</th>)}
            <th className="pb-2 text-right font-normal">Detected</th>
          </tr></thead>
          <tbody>
            {rows.map((r) => {
              const x = durations(r);
              return (
                <tr key={r.id} className="border-t border-line">
                  <td className="py-2 pr-3"><Link href={`/incidents/${r.id}`} className="underline-offset-2 hover:underline">#{r.id} <span className="text-sub">SEV{r.sev}</span> {r.title.slice(0, 60)}</Link></td>
                  <td className="py-2 pr-3">{r.cause ?? '—'}</td>
                  {METRICS.map((m) => <td key={m} className="py-2 text-right tabular-nums">{d(x[m])}</td>)}
                  <td className="py-2 pl-3 text-right text-xs text-sub"><Ts at={r.detected_at} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}
