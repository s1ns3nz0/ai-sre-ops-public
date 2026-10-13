import Link from 'next/link';
import { connection } from 'next/server';
import { Suspense } from 'react';
import { AgentLauncher } from '@/components/AgentLauncher.tsx';
import { isDemo } from '@/lib/demo.ts';
import { AutoRefresh } from '@/components/AutoRefresh.tsx';
import { QueueNav } from '@/components/QueueNav.tsx';
import { QueuePane } from '@/components/QueuePane.tsx';
import { pool } from '@/lib/db.ts';
import { firingSummary, listIncidents } from '@/lib/incidents.ts';
import { suspectedIncidents } from '@/lib/changes.ts';
import { chgs, inProgress } from '@/lib/chg.ts';
import { topology } from '@/lib/topology.ts';
import { priorities } from '@/lib/priority.ts';
import { slos } from '@/lib/prom.ts';

// Firing banner on every screen, then two panes: queue (left) and overview or the selected incident (right).
export default function ConsoleLayout({ children }: LayoutProps<'/'>) {
  return (
    <div className="flex h-[calc(100vh-5.75rem)] flex-col">
      <Suspense fallback={null}>
        <DemoBanner />
      </Suspense>
      <Suspense fallback={null}>
        <FiringBanner />
      </Suspense>
      <Suspense fallback={null}>
        <ChangeBanner />
      </Suspense>
      <div className="flex min-h-0 flex-1">
        <Suspense fallback={<div className="w-80 shrink-0 border-r border-line" />}>
          <QueuePane>
            <Suspense fallback={<p className="p-4 text-sm text-sub">Loading…</p>}>
              <Queue />
            </Suspense>
          </QueuePane>
        </Suspense>
        <section className="flex-1 min-w-0 overflow-y-auto">{children}</section>
      </div>
      <AutoRefresh />
      <Suspense fallback={null}>
        <AgentLauncher />
      </Suspense>
    </div>
  );
}

async function Queue() {
  await connection(); // CHG cache and windows read the clock
  const [items, list] = await Promise.all([listIncidents(pool()), chgs()]);
  const t = topology();
  const suspected = await suspectedIncidents(pool(), t, list.chgs).catch(() => new Set<string>());
  // F8: open incidents ordered by pinned (critical firing) then score; Prometheus down only drops the SLO term.
  const budgets = new Map((await slos().catch(() => [])).map((x) => [x.name, x.budgetRemaining]));
  const prio = await priorities(pool(), t, budgets);
  const rank = (id: string) => { const p = prio.get(id); return p ? (p.pinned ? 1e6 : 0) + p.total : -1; };
  const sorted = [...items].sort((a, b) => (prio.has(b.id) ? 1 : 0) - (prio.has(a.id) ? 1 : 0) || rank(b.id) - rank(a.id));
  const meta = Object.fromEntries([...prio].map(([id, p]) => [id, { score: p.total, pinned: p.pinned, cause: p.cause, why: p.parts.map((x) => `${x.label} ${x.points}: ${x.why}`).join('\n') }]));
  return <QueueNav items={sorted} suspected={[...suspected]} meta={meta} />;
}

const RISK = { high: 0, medium: 1, low: 2 } as const;

// CHGs being implemented right now (status implementing, inside their window). One line: the riskiest, newest
// first; the rest are on /changes. Alerts are not suppressed.
async function ChangeBanner() {
  await connection();
  const now = inProgress((await chgs()).chgs).sort((a, b) => RISK[a.risk] - RISK[b.risk] || b.window.start.getTime() - a.window.start.getTime());
  if (!now.length) return null;
  const c = now[0];
  return (
    <div className="flex h-9 items-center gap-3 bg-sev3/15 px-4 text-sm">
      <b className="shrink-0 font-semibold">Change in progress</b>
      <a href={c.href} target="_blank" rel="noreferrer" className="min-w-0 truncate underline-offset-2 hover:underline">
        {c.id} {c.title} <span className="text-sub">({c.risk} risk{c.components.length ? `, ${c.components.length} component${c.components.length === 1 ? '' : 's'}` : ''})</span>
      </a>
      <Link href="/changes" className="ml-auto shrink-0 font-medium underline underline-offset-2">
        {now.length > 1 ? `${now.length - 1} more` : 'Details'}
      </Link>
    </div>
  );
}

// Read per request: a prerendered layout would bake in the build machine's environment.
async function DemoBanner() {
  await connection();
  if (!isDemo()) return null;
  return (
    <div className="flex h-7 shrink-0 items-center gap-2 bg-accent/25 px-4 text-xs text-ink">
      <b className="font-semibold">Demo data</b> Sample data for a portfolio demo; not real incidents.
    </div>
  );
}

async function FiringBanner() {
  const f = await firingSummary(pool());
  if (!f) return null;
  return (
    <Link href={`/incidents/${f.incident_id}`} role="alert"
      className="flex items-center gap-3 bg-sev1 px-4 h-10 text-sm text-white hover:bg-sev1/90">
      <span className="relative flex size-2.5">
        <span className="absolute inline-flex size-full rounded-full bg-white opacity-75 motion-safe:animate-ping" />
        <span className="relative inline-flex size-2.5 rounded-full bg-white" />
      </span>
      <b className="font-semibold">{f.total} alert{f.total === 1 ? '' : 's'} firing</b>
      <span className="truncate opacity-90">{f.alertname} ({f.severity})</span>
      <span className="ml-auto shrink-0 underline underline-offset-2">Open incident #{f.incident_id}</span>
    </Link>
  );
}
