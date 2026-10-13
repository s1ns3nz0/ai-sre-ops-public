import Link from 'next/link';
import { Suspense } from 'react';
import { AlertRulesBoard } from '@/components/AlertRules.tsx';
import { MetricsTable, type MetricRow } from '@/components/MetricsTable.tsx';
import { Card } from '@/components/ui.tsx';
import { SloBoard, type SloRow } from '@/components/SloBoard.tsx';
import { dashboardMetrics, liveMetricNames, liveRules, metricLabels, readRepoFile, repoUrl, ruleFiles, type LiveRule } from '@/lib/detection.ts';
import { query, slos } from '@/lib/prom.ts';
import { SLO_DEFINITIONS_PATH, parseDefinitions } from '@/lib/slo.ts';
import { runbooks } from '@/lib/runbooks.ts';
import { classify, metricsIn, type RuleFile } from '@/lib/rules.ts';

const TABS = [
  { id: 'alerts', label: 'Alert rules' },
  { id: 'slo', label: 'SLO rules' },
  { id: 'metrics', label: 'Metrics' },
  { id: 'runbooks', label: 'Runbooks' },
] as const;
type Tab = (typeof TABS)[number]['id'];

export default function DetectionPage({ searchParams }: PageProps<'/detection'>) {
  return (
    <div className="mx-auto max-w-6xl px-8 py-7">
      <h1 className="text-2xl font-semibold tracking-tight">Detection management</h1>
      <p className="mt-1 text-sm text-sub">
        A <a href={repoUrl()} target="_blank" rel="noreferrer" className="underline underline-offset-2">GitHub repository</a> is the single
        source of truth for alert rules, SLOs and runbooks. Edits here open a pull request; they apply after review, merge and the GitOps sync.
      </p>
      <Suspense fallback={<p className="mt-6 text-sm text-sub">Loading…</p>}>
        <Body searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function Body({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const tab: Tab = TABS.some((t) => t.id === sp.tab) ? (sp.tab as Tab) : 'alerts';
  const [files, live] = await Promise.all([
    ruleFiles().then((v) => ({ v }), (e: Error) => ({ e: e.message })),
    liveRules().then((v) => ({ v }), (e: Error) => ({ e: e.message })),
  ]);
  return (
    <>
      <nav role="tablist" className="mt-6 flex gap-1 border-b border-line">
        {TABS.map((t) => (
          <Link key={t.id} role="tab" aria-selected={t.id === tab} scroll={false} href={t.id === 'alerts' ? '/detection' : `/detection?tab=${t.id}`}
            className={`-mb-px inline-flex h-10 items-center border-b-2 px-3 text-sm ${t.id === tab ? 'border-ink font-medium' : 'border-transparent text-sub hover:text-ink'}`}>
            {t.label}
          </Link>
        ))}
      </nav>
      <div className="mt-5 space-y-5">
        {'e' in files && <p className="text-sm text-sev1">Cannot read the rule repo: {files.e}</p>}
        {'e' in live && <p className="text-sm text-sev2">Cannot reach Prometheus ({live.e}); live status is unavailable.</p>}
        {'v' in files && tab === 'alerts' && <AlertsTab files={files.v} live={'v' in live ? live.v : null} />}
        {'v' in files && tab === 'slo' && <SloTab files={files.v} />}
        {'v' in files && tab === 'metrics' && <MetricsTab files={files.v} />}
        {'v' in files && tab === 'runbooks' && <RunbooksTab files={files.v} page={Number(sp.page) || 1} />}
      </div>
    </>
  );
}

function AlertsTab({ files, live }: { files: RuleFile[]; live: LiveRule[] | null }) {
  const hand = files.filter((f) => !f.generated);
  const liveBy = new Map((live ?? []).filter((r) => r.type === 'alerting').map((r) => [r.name, r]));
  const inRepo = new Set(files.flatMap((f) => f.groups.flatMap((g) => [...g.alerts.map((a) => a.alert), ...g.records.map((r) => r.record)])));
  const orphans = (live ?? []).filter((r) => !inRepo.has(r.name));

  return (
    <>
      {orphans.length > 0 && (
        <Card title="Running but not in the repo">
          <p className="text-sm text-sub">Prometheus has these rules loaded, but no file in the repo defines them. They will disappear on the next sync, or someone changed the cluster by hand.</p>
          <ul className="mt-2 flex flex-wrap gap-2">{orphans.map((r) => <li key={r.name} className="rounded-md bg-sev2/10 px-2 py-0.5 font-mono text-xs text-sev2">{r.name}</li>)}</ul>
        </Card>
      )}

      <AlertRulesBoard groups={hand.flatMap((f) => f.groups.map((g) => ({
        path: f.path, group: g.name, href: repoUrl(f.path), rules: g.alerts,
        live: Object.fromEntries(g.alerts.map((a) => {
          const r = liveBy.get(a.alert);
          return [a.alert, live === null ? null : r ? { health: r.health, lastError: r.lastError, state: r.state, firing: r.firing, lastEvaluation: r.lastEvaluation } : 'missing'];
        })),
      })))} />
    </>
  );
}

async function SloTab({ files }: { files: RuleFile[] }) {
  const [defs, budgets, firing] = await Promise.all([
    readRepoFile(SLO_DEFINITIONS_PATH).then((f) => ({ v: parseDefinitions(f.text), sha: f.sha }), () => null),
    slos().catch(() => null),
    query('count by (slo, window) (ALERTS{alertstate="firing", slo!=""})').catch(() => []),
  ]);
  const fire = new Map(firing.map((r) => [`${r.metric.slo}/${r.metric.window}`, Number(r.value[1])]));
  const rows = new Map<string, SloRow>();
  const row = (name: string) => rows.get(name) ?? (rows.set(name, {
    name, def: defs?.v.find((d) => d.name === name) ?? null,
    budget: budgets?.find((b) => b.name === name)?.budgetRemaining ?? null, sli1h: budgets?.find((b) => b.name === name)?.sli1h ?? null,
    alerts: [], records: [],
  }), rows.get(name)!);
  for (const d of defs?.v ?? []) row(d.name);
  for (const f of files.filter((x) => x.generated)) for (const g of f.groups) {
    for (const r of g.records) if (r.labels.slo) row(r.labels.slo).records.push({ name: r.record, expr: r.expr });
    for (const a of g.alerts) if (a.labels.slo) row(a.labels.slo).alerts.push({
      name: a.alert, expr: a.expr, severity: a.labels.severity, window: a.labels.window, burn: a.labels.burn_rate,
      firing: fire.get(`${a.labels.slo}/${a.labels.window}`) ?? 0,
    });
  }
  const list = [...rows.values()].sort((x, y) => (x.budget ?? 9) - (y.budget ?? 9));
  return (
    <>
      {!defs && (
        <p className="rounded-lg border border-sev2/40 bg-sev2/5 px-4 py-3 text-sm">
          <b>slos/definitions.json is not on the branch being read yet.</b> Definitions become editable once
          <a className="mx-1 underline" href="https://github.com/s1ns3nz0/lineth-observability/pull/3" target="_blank" rel="noreferrer">lineth-observability PR #3</a>
          is merged. The generated rules are shown read-only below.
        </p>
      )}
      <SloBoard rows={list} editable={!!defs} />
    </>
  );
}

async function MetricsTab({ files }: { files: RuleFile[] }) {
  const [dash, liveNames] = await Promise.all([dashboardMetrics(), liveMetricNames().catch(() => null)]);
  const usedBy = new Map<string, Set<string>>();
  const use = (m: string, by: string) => (usedBy.get(m) ?? usedBy.set(m, new Set()).get(m)!).add(by);
  for (const f of files) for (const g of f.groups) {
    for (const a of g.alerts) metricsIn(a.expr).forEach((m) => use(m, `alert ${a.alert}`));
    for (const r of g.records) metricsIn(r.expr).forEach((m) => use(m, `record ${r.record}`));
  }
  for (const [title, ms] of dash) ms.forEach((m) => use(m, `dashboard ${title}`));
  // Recording rule outputs are produced by the rules themselves, so referencing one is never "broken".
  const produced = new Set(files.flatMap((f) => f.groups.flatMap((g) => g.records.map((r) => r.record))));

  // Everything Prometheus collects, plus anything referenced (a referenced name that is not collected is broken).
  const names = new Set<string>([...usedBy.keys(), ...(liveNames ?? [])]);
  const labels = liveNames ? await metricLabels([...liveNames]).catch(() => new Map<string, string[]>()) : new Map<string, string[]>();
  const ORDER: Record<MetricRow['status'], number> = { broken: 0, used: 1, unused: 2 };
  const rows: MetricRow[] = [...names].map((name): MetricRow => {
    const { service, source } = classify(name);
    const users = [...(usedBy.get(name) ?? [])];
    const isLive = liveNames ? liveNames.has(name) || produced.has(name) : true;
    return { name, service, source, usedBy: users, labels: labels.get(name) ?? [], status: users.length ? (isLive ? 'used' : 'broken') : 'unused' };
  }).sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.name.localeCompare(b.name));

  return (
    <Card title="Metric inventory">
      <p className="mb-3 text-sm text-sub">
        Where each metric comes from and what uses it. <b>Broken</b>: referenced by a rule or dashboard but not collected.
        <b> Unused</b>: collected but referenced nowhere. Metric names are read from PromQL, so a rare template expression can be missed.
      </p>
      {liveNames === null && <p className="mb-3 text-sm text-sev2">Prometheus is unreachable, so nothing can be marked broken or unused.</p>}
      <MetricsTable rows={rows} />
    </Card>
  );
}

// Runbooks in the repo and the alerts none of them covers (PRD F6), a page at a time. Edits go through PRs.
const RB_PAGE = 8;
async function RunbooksTab({ files, page }: { files: RuleFile[]; page: number }) {
  const rbs = await runbooks();
  const alerts = [...new Set(files.flatMap((f) => f.groups.flatMap((g) => g.alerts.map((a) => a.alert))))].sort();
  const covered = new Set(rbs.flatMap((r) => r.alerts));
  const missing = alerts.filter((a) => !covered.has(a));
  const pages = Math.max(1, Math.ceil(rbs.length / RB_PAGE));
  const at = Math.min(Math.max(1, page), pages);
  const shown = rbs.slice((at - 1) * RB_PAGE, at * RB_PAGE);
  const href = (n: number) => `/detection?tab=runbooks${n > 1 ? `&page=${n}` : ''}`;
  const SEV: Record<string, string> = { critical: 'bg-sev1 text-white', warning: 'bg-sev2 text-white' };
  return (
    <>
      <div className="grid grid-cols-3 gap-3">
        {([[rbs.length, 'runbooks'], [`${alerts.length - missing.length} / ${alerts.length}`, 'alerts covered'], [missing.length, 'alerts without a runbook']] as const).map(([v, l], k) => (
          <div key={l} className="rounded-xl border border-line bg-surface px-4 py-3">
            <div className={`text-2xl font-semibold tabular-nums ${k === 2 && missing.length ? 'text-sev1' : ''}`}>{v}</div>
            <div className="text-xs text-sub">{l}</div>
          </div>
        ))}
      </div>
      <Card title={`Runbooks (${rbs.length})`} aside={<a href={repoUrl('runbooks')} target="_blank" rel="noreferrer" className="text-sm text-sub underline underline-offset-2">runbooks/</a>}>
        {!rbs.length ? <p className="text-sm text-sub">No runbooks found in the repo yet.</p> : (
          <>
            <ul className="-mx-4 divide-y divide-line border-t border-line">
              {shown.map((r) => (
                <li key={r.id}>
                  <Link href={`/runbooks/${r.id}`} className="flex items-baseline gap-3 px-4 py-3 hover:bg-sev4/5">
                    <span className={`shrink-0 rounded px-1.5 text-[11px] ${SEV[r.severity] ?? 'bg-line text-ink'}`}>{r.severity}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{r.title}</span>
                      <span className="block truncate text-xs text-sub">{r.alerts.length} alert{r.alerts.length === 1 ? '' : 's'}: {r.alerts.join(', ')} · {r.components.join(', ')}</span>
                    </span>
                    <span className="shrink-0 text-xs text-sub">reviewed {r.last_reviewed}</span>
                  </Link>
                </li>
              ))}
            </ul>
            {pages > 1 && (
              <nav className="-mx-4 flex items-center gap-1 border-t border-line px-4 pt-3 text-sm" aria-label="Runbook pages">
                <span className="text-xs text-sub">{(at - 1) * RB_PAGE + 1}–{Math.min(at * RB_PAGE, rbs.length)} of {rbs.length}</span>
                <span className="ml-auto flex gap-1">
                  {at > 1 && <Link scroll={false} href={href(at - 1)} className="rounded-md border border-line px-2.5 py-1 hover:border-ink/40">Previous</Link>}
                  {Array.from({ length: pages }, (_, k) => k + 1).map((n) => (
                    <Link key={n} scroll={false} href={href(n)} aria-current={n === at ? 'page' : undefined}
                      className={`rounded-md px-2.5 py-1 ${n === at ? 'bg-ink text-white' : 'border border-line hover:border-ink/40'}`}>{n}</Link>
                  ))}
                  {at < pages && <Link scroll={false} href={href(at + 1)} className="rounded-md border border-line px-2.5 py-1 hover:border-ink/40">Next</Link>}
                </span>
              </nav>
            )}
          </>
        )}
      </Card>
      <Card title={`Alerts without a runbook (${missing.length} of ${alerts.length})`}>
        {missing.length ? <ul className="flex flex-wrap gap-1.5">{missing.map((a) => <li key={a} className="rounded-md bg-line/60 px-2 py-0.5 font-mono text-xs">{a}</li>)}</ul>
          : <p className="text-sm text-sub">Every alert has a runbook. A new alert needs one before it merges (CI checks it).</p>}
      </Card>
    </>
  );
}
