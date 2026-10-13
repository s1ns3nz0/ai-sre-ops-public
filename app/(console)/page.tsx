import { connection } from 'next/server';
import { Suspense } from 'react';
import { Elapsed } from '@/components/Elapsed.tsx';
import { Modal } from '@/components/Modal.tsx';
import { Ts } from '@/components/Ts.tsx';
import { button, Card, field } from '@/components/ui.tsx';
import Link from 'next/link';
import { pool } from '@/lib/db.ts';
import { monitor, openWatchdogIncident, silence } from '@/lib/watchdog.ts';
import { maintenanceAction } from './actions.ts';
import { slos, type Slo } from '@/lib/prom.ts';
import { topology } from '@/lib/topology.ts';
import { stagesAt, type Stage } from '@/lib/stages.ts';

export default function OverviewPage() {
  return (
    <div className="mx-auto max-w-6xl px-8 py-7 space-y-5">
      <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
      <Suspense fallback={<Card title="Alert pipeline"><p className="text-sm text-sub">Loading…</p></Card>}>
        <PipelinePanel />
      </Suspense>
      <Suspense fallback={<Card title="Service level objectives"><p className="text-sm text-sub">Loading…</p></Card>}>
        <SloPanel />
      </Suspense>
      <Suspense fallback={<Card title="Infrastructure"><p className="text-sm text-sub">Loading…</p></Card>}>
        <InfraPanel />
      </Suspense>
    </div>
  );
}

const pct = (x: number, digits = 1) => `${(x * 100).toFixed(digits).replace(/\.0+$/, '')}%`;

function Unreachable({ title, error }: { title: string; error: unknown }) {
  return (
    <Card title={title}>
      <p className="text-sm text-sev1">Cannot reach Prometheus ({(error as Error).message}).</p>
      <p className="mt-1 text-sm text-sub">Set PROMETHEUS_URL, or locally run <code>kubectl -n monitoring port-forward svc/monitoring-kube-prometheus-prometheus 9090</code>.</p>
    </Card>
  );
}

async function SloPanel() {
  await connection(); // budgets are "now" (demo mode reads them from the scenario, not a fetch)
  let rows: Slo[];
  try { rows = await slos(); } catch (e) { return <Unreachable title="Service level objectives" error={e} />; }
  const burned = rows.filter((r) => r.budgetRemaining <= 0).length;
  return (
    <Card title="Service level objectives" aside={<span className={`text-sm ${burned ? 'text-sev1 font-medium' : 'text-sub'}`}>{burned ? `${burned} out of budget` : 'All within budget'}</span>}>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-sub">
            <th className="pb-2 font-normal">SLO</th>
            <th className="pb-2 font-normal text-right">Target</th>
            <th className="pb-2 font-normal text-right">SLI, last hour</th>
            <th className="pb-2 pl-6 font-normal w-[45%]">Error budget left, 28 days</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const left = r.budgetRemaining;
            const tone = !(left > 0) ? 'bg-sev1' : left < 0.25 ? 'bg-sev2' : 'bg-emerald-600';
            const text = !(left > 0) ? 'text-sev1' : left < 0.25 ? 'text-sev2' : 'text-ink';
            const sliBad = r.sli1h !== null && r.sli1h < r.objective;
            return (
              <tr key={r.name} className="border-t border-line">
                <td className="py-2.5 font-medium">{r.name}</td>
                <td className="py-2.5 text-right text-sub">{pct(r.objective)}</td>
                <td className={`py-2.5 text-right ${sliBad ? 'text-sev1 font-medium' : ''}`}>{r.sli1h === null ? <span className="text-sub">no data</span> : pct(r.sli1h, 2)}</td>
                <td className="py-2.5 pl-6">
                  <div className="flex items-center gap-3">
                    <div className="h-2 flex-1 rounded-full bg-line overflow-hidden" role="meter" aria-valuenow={Math.round(left * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={`${r.name} budget left`}>
                      <div className={`h-full ${tone}`} style={{ width: `${Math.max(0, Math.min(1, left)) * 100}%` }} />
                    </div>
                    <span className={`w-16 text-right font-medium ${text}`}>{Number.isNaN(left) ? '—' : pct(left, 0)}</span>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

const SUMMARY = [
  { key: 'breach', label: 'breach', cls: 'text-sev1', dot: 'bg-sev1' },
  { key: 'risk', label: 'at risk', cls: 'text-sev2', dot: 'bg-sev2' },
  { key: 'slow', label: 'slow', cls: 'text-sev3', dot: 'bg-sev3' },
  { key: 'unknown', label: 'unknown', cls: 'text-ink', dot: 'bg-ink' },
  { key: 'normal', label: 'normal', cls: 'text-ink', dot: 'bg-emerald-600' },
  { key: 'off', label: 'scaled to 0', cls: 'text-sub', dot: 'bg-sev4' },
] as const;
const CHIP: Partial<Record<Stage, string>> = { breach: 'bg-sev1/10 text-sev1', risk: 'bg-sev2/10 text-sev2', slow: 'bg-sev3/15 text-sev3', unknown: 'bg-ink/10 text-ink' };

// Impact stages (F4), same as the map.
async function InfraPanel() {
  await connection();
  const t = topology();
  const { nodes, error } = await stagesAt(pool(), t);
  if (error) return <Unreachable title="Infrastructure" error={new Error(error)} />;
  const states = t.nodes.map((n) => ({ n, s: nodes[n.id]?.stage ?? 'unknown' }));
  const attention = states.filter((x) => CHIP[x.s]);
  return (
    <Card title="Infrastructure" aside={<Link href="/infrastructure" className="text-sm underline underline-offset-2">Open map</Link>}>
      <p className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
        {SUMMARY.map((x) => (
          <span key={x.key} className="inline-flex items-center gap-1.5">
            <span className={`size-2 rounded-full ${x.dot}`} /><b className={x.cls}>{states.filter((y) => y.s === x.key).length}</b> <span className="text-sub">{x.label}</span>
          </span>
        ))}
      </p>
      {attention.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-2">
          {attention.map(({ n, s }) => (
            <li key={n.id} className={`inline-flex h-7 items-center rounded-md px-2 text-sm ${CHIP[s]}`} title={nodes[n.id]?.reasons[0]?.text}>{n.label} · {SUMMARY.find((x) => x.key === s)?.label}</li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// F11: is the alert pipeline itself alive? Read from the last Watchdog delivery.
async function PipelinePanel() {
  const [m, open] = await Promise.all([monitor(pool()), openWatchdogIncident(pool())]);
  const now = Date.now();
  const down = silence(m, new Date(now));
  const silent = down?.reason === 'watchdog';
  const maint = m.maintenance_until && new Date(m.maintenance_until).getTime() > now;
  return (
    <Card title="Alert pipeline" aside={
      <div className="flex gap-2">
        {maint && <form action={maintenanceAction}><input type="hidden" name="minutes" value="0" /><button className={button.quiet}>End maintenance</button></form>}
        <Modal label={maint ? 'Extend maintenance' : 'Start maintenance'} title="Planned maintenance" buttonClass={button.quiet}>
          <form action={maintenanceAction} className="grid gap-3">
            <p className="text-sm text-sub">Pauses the page for a silent Watchdog or a Prometheus that is not ready, while it is down on purpose. Alerts and other pages are not affected.</p>
            <label className="grid gap-1 text-sm">For
              <select name="minutes" defaultValue="60" className={field}>
                {[30, 60, 120, 240, 480].map((n) => <option key={n} value={n}>{n < 60 ? `${n} minutes` : `${n / 60} hour${n > 60 ? 's' : ''}`}</option>)}
              </select>
            </label>
            <button className={`${button.primary} justify-self-end`}>Start maintenance</button>
          </form>
        </Modal>
      </div>
    }>
      <div className="flex items-center gap-2.5 text-sm">
        <span className={`size-2.5 rounded-full ${!m.last_seen ? 'bg-sev4' : down ? 'bg-sev1' : 'bg-emerald-600'}`} aria-hidden />
        {down?.reason === 'prometheus' ? (
          <span className="font-medium text-sev1">Prometheus not ready for <Elapsed from={down.since} />: no alerts are being evaluated.
            {open && <> <Link href={`/incidents/${open}`} className="underline underline-offset-2">Incident #{open}</Link></>}</span>
        ) : !m.last_seen ? (
          <span>No Watchdog received yet. Route <code>alertname=&quot;Watchdog&quot;</code> to this app with a 1 minute repeat to turn on the check.</span>
        ) : silent ? (
          <span className="font-medium text-sev1">No Watchdog for <Elapsed from={m.last_seen} />: alerts may not be reaching this console.
            {open && <> <Link href={`/incidents/${open}`} className="underline underline-offset-2">Incident #{open}</Link></>}</span>
        ) : (
          <span>Receiving alerts. Last Watchdog <Elapsed from={m.last_seen} /> ago{m.prom_ready_at ? <>, Prometheus ready <Elapsed from={m.prom_ready_at} /> ago</> : null}.</span>
        )}
      </div>
      {maint && <p className="mt-2 text-sm text-sev2">Maintenance until <Ts at={m.maintenance_until!} />, set by {m.maintenance_by}. The pipeline check does not page.</p>}
    </Card>
  );
}
