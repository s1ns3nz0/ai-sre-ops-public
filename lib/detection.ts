// Detection as Code source: rule and dashboard files of lineth-observability, read from GitHub (or a local clone in
// dev), plus the live rule state from Prometheus. Changes never write to Prometheus: they become pull requests.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pool } from './db.ts';
import { isDemo } from './demo.ts';
import { snapshot } from './demo-prom.ts';
import { query as _q } from './prom.ts';
import { metricsIn, parseRuleFile, type RuleFile } from './rules.ts';

const REPO = () => process.env.DETECTION_REPO ?? 's1ns3nz0/lineth-observability';
const BRANCH = () => process.env.DETECTION_BRANCH ?? 'main';
const TOKEN = () => process.env.DETECTION_GITHUB_TOKEN;
const LOCAL = () => process.env.DETECTION_REPO_DIR;
const RULE_DIRS = ['alerts', 'slos'];

export const repoUrl = (p = '') => `https://github.com/${REPO()}${p ? `/blob/${BRANCH()}/${p}` : ''}`;

async function gh<T>(p: string, init: RequestInit = {}): Promise<T> {
  const token = TOKEN();
  if (!token) throw new Error('DETECTION_GITHUB_TOKEN is not set, so pull requests cannot be opened.');
  const res = await fetch(`https://api.github.com/repos/${REPO()}${p}`, {
    ...init,
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', ...init.headers },
    signal: AbortSignal.timeout(10_000), cache: 'no-store',
  });
  if (!res.ok) throw new Error(`GitHub ${init.method ?? 'GET'} ${p}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<T>;
}

type GhFile = { path: string; type: string; sha: string; content?: string };

// A file's text and the blob sha it was read at (the sha guards the PR against a concurrent change).
export async function readRepoFile(p: string): Promise<{ text: string; sha: string | null }> {
  if (TOKEN()) {
    const f = await gh<GhFile>(`/contents/${p}?ref=${BRANCH()}`);
    return { text: Buffer.from(f.content ?? '', 'base64').toString('utf8'), sha: f.sha };
  }
  const dir = LOCAL();
  if (!dir) throw new Error('Set DETECTION_GITHUB_TOKEN, or DETECTION_REPO_DIR for read-only local use.');
  return { text: await readFile(path.join(dir, p), 'utf8'), sha: null };
}

export async function listRepoDir(dir: string, ext: string): Promise<string[]> {
  if (TOKEN()) return (await gh<GhFile[]>(`/contents/${dir}?ref=${BRANCH()}`)).filter((f) => f.type === 'file' && f.path.endsWith(ext)).map((f) => f.path);
  const local = LOCAL();
  if (!local) throw new Error('Set DETECTION_GITHUB_TOKEN, or DETECTION_REPO_DIR for read-only local use.');
  return (await readdir(path.join(local, dir))).filter((n) => n.endsWith(ext)).sort().map((n) => `${dir}/${n}`);
}

export async function ruleFiles(): Promise<RuleFile[]> {
  const paths = (await Promise.all(RULE_DIRS.map((d) => listRepoDir(d, '.yaml')))).flat();
  return Promise.all(paths.map(async (p) => parseRuleFile(p, (await readRepoFile(p)).text)));
}

// Metric names used by each dashboard (any "expr" field in the JSON).
export async function dashboardMetrics(): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  const walk = (v: unknown, add: (e: string) => void) => {
    if (Array.isArray(v)) v.forEach((x) => walk(x, add));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (k === 'expr' && typeof x === 'string' ? add(x) : walk(x, add));
  };
  for (const p of await listRepoDir('dashboards', '.json')) {
    const json = JSON.parse((await readRepoFile(p)).text) as { title?: string };
    const set = new Set<string>();
    walk(json, (e) => metricsIn(e.replaceAll(/\$\{?\w+\}?/g, '1m')).forEach((m) => set.add(m)));
    out.set(json.title ?? p, set);
  }
  return out;
}

export type LiveRule = { name: string; type: 'alerting' | 'recording'; health: string; lastError?: string; state?: string; firing: number; lastEvaluation: string; file: string };

// Rules Prometheus has loaded from the PrometheusRule objects this repo owns.
export async function liveRules(): Promise<LiveRule[]> {
  if (isDemo()) {
    // Demo: every rule in the repo, healthy; firing as the scenario's alerts are.
    const firing = new Map((await pool().query<{ alertname: string; n: number }>("SELECT alertname, count(*)::int AS n FROM alerts WHERE status = 'firing' GROUP BY 1")).rows.map((r) => [r.alertname, r.n]));
    const now = new Date(Date.now() - 2000).toISOString();
    return (await ruleFiles()).flatMap((f) => f.groups.flatMap((g) => [
      ...g.alerts.map((a) => ({ name: a.alert, type: 'alerting' as const, health: 'ok', state: firing.get(a.alert) ? 'firing' : 'inactive', firing: firing.get(a.alert) ?? 0, lastEvaluation: now, file: f.path })),
      ...g.records.map((r) => ({ name: r.record, type: 'recording' as const, health: 'ok', firing: 0, lastEvaluation: now, file: f.path })),
    ]));
  }
  const res = await fetch(`${process.env.PROMETHEUS_URL ?? 'http://localhost:9090'}/api/v1/rules`, { signal: AbortSignal.timeout(4000), cache: 'no-store' });
  if (!res.ok) throw new Error(`Prometheus ${res.status}`);
  const groups = ((await res.json()) as { data: { groups: { file: string; rules: (LiveRule & { alerts?: { state: string }[] })[] }[] } }).data.groups;
  return groups.filter((g) => /lineth|local-l1/.test(g.file)).flatMap((g) => g.rules.map((r) => ({
    name: r.name, type: r.type, health: r.health, lastError: r.lastError, state: r.state,
    firing: (r.alerts ?? []).filter((a) => a.state === 'firing').length, lastEvaluation: r.lastEvaluation, file: g.file,
  })));
}

export async function liveMetricNames(): Promise<Set<string>> {
  if (isDemo()) return new Set(Object.keys(snapshot().metrics));
  const res = await fetch(`${process.env.PROMETHEUS_URL ?? 'http://localhost:9090'}/api/v1/label/__name__/values`, { signal: AbortSignal.timeout(4000), cache: 'no-store' });
  if (!res.ok) throw new Error(`Prometheus ${res.status}`);
  return new Set(((await res.json()) as { data: string[] }).data);
}

const PROM = () => process.env.PROMETHEUS_URL ?? 'http://localhost:9090';
async function promGet<T>(path: string): Promise<T> {
  const res = await fetch(`${PROM()}${path}`, { signal: AbortSignal.timeout(5000), cache: 'no-store' });
  if (!res.ok) throw new Error(`Prometheus ${res.status}`);
  return ((await res.json()) as { data: T }).data;
}

export const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

// Label names per metric for the inventory table. One /api/v1/labels request per metric (the full series list is
// ~150 MB), 24 at a time: ~1 s for 3.5k metrics.
// ponytail: cached 10 min per process; a new label shows up on the next refresh.
const lc = globalThis as unknown as { labelCache?: { at: number; v: Map<string, string[]> } };
export async function metricLabels(names: string[]): Promise<Map<string, string[]>> {
  if (isDemo()) return new Map(names.map((n) => [n, Object.keys(snapshot().metrics[n]?.labels ?? {})]));
  if (lc.labelCache && Date.now() - lc.labelCache.at < 600_000) return lc.labelCache.v;
  const out = new Map<string, string[]>();
  const queue = names.filter((n) => METRIC_NAME.test(n));
  await Promise.all(Array.from({ length: 24 }, async () => {
    for (let n = queue.pop(); n !== undefined; n = queue.pop()) {
      const labels = await promGet<string[]>(`/api/v1/labels?match[]=${encodeURIComponent(n)}`).catch(() => null);
      if (labels) out.set(n, labels.filter((l) => l !== '__name__'));
    }
  }));
  lc.labelCache = { at: Date.now(), v: out };
  return out;
}

export type MetricDetail = {
  name: string; type: string | null; help: string | null; unit: string | null; series: number;
  labels: { name: string; values: string[]; total: number }[];
};

// One metric, opened in the inventory: metadata, series count, and the first values of each label.
export async function metricDetail(name: string): Promise<MetricDetail> {
  if (!METRIC_NAME.test(name)) throw new Error('not a metric name');
  if (isDemo()) {
    const s = snapshot().metrics[name];
    if (!s) return { name, type: null, help: null, unit: null, series: 0, labels: [] };
    return { name, type: s.type, help: s.help, unit: s.unit, series: s.series, labels: Object.entries(s.labels).map(([l, v]) => ({ name: l, values: v, total: v.length })) };
  }
  const m = encodeURIComponent(name);
  const [meta, count, labels] = await Promise.all([
    promGet<Record<string, { type: string; help: string; unit: string }[]>>(`/api/v1/metadata?metric=${m}&limit=1`).catch(() => ({})),
    _q(`count(${name})`).then((r) => Number(r[0]?.value[1] ?? 0)).catch(() => 0),
    promGet<string[]>(`/api/v1/labels?match[]=${m}`),
  ]);
  const md = (meta as Record<string, { type: string; help: string; unit: string }[]>)[name]?.[0];
  const values = await Promise.all(labels.filter((l) => l !== '__name__').map(async (l) => {
    const v = await promGet<string[]>(`/api/v1/label/${encodeURIComponent(l)}/values?match[]=${m}`).catch(() => []);
    return { name: l, values: v.slice(0, 12), total: v.length };
  }));
  return { name, type: md?.type ?? null, help: md?.help ?? null, unit: md?.unit || null, series: count, labels: values };
}

export const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

// Values of one label across all metrics (for the label filter), capped.
export async function labelValues(label: string): Promise<string[]> {
  if (!LABEL_NAME.test(label)) throw new Error('not a label name');
  if (isDemo()) return [...new Set(Object.values(snapshot().metrics).flatMap((m) => m.labels[label] ?? []))].sort().slice(0, 1000);
  return (await promGet<string[]>(`/api/v1/label/${encodeURIComponent(label)}/values`)).slice(0, 1000);
}

// Metric names that have a series with label=value.
export async function metricsWithLabel(label: string, value: string): Promise<string[]> {
  if (!LABEL_NAME.test(label)) throw new Error('not a label name');
  if (isDemo()) return Object.entries(snapshot().metrics).filter(([, m]) => m.labels[label]?.includes(value)).map(([n]) => n);
  const sel = `{${label}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"}`;
  return promGet<string[]>(`/api/v1/label/__name__/values?match[]=${encodeURIComponent(sel)}`);
}

// Run an expression read-only to preview what it would match now.
export async function preview(expr: string): Promise<{ series: number; sample: string[] } | { error: string }> {
  try {
    const rows = await _q(expr);
    return { series: rows.length, sample: rows.slice(0, 3).map((r) => JSON.stringify(r.metric)) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

// One change = one branch + one PR (a commit per file), based on the blobs the user saw (stale edits fail).
export async function openPullRequest(p: { files: { path: string; text: string; baseSha: string }[]; title: string; body: string; slug: string; prefix?: string }): Promise<string> {
  const base = await gh<{ object: { sha: string } }>(`/git/ref/heads/${BRANCH()}`);
  const branch = `${p.prefix ?? 'detection'}/${p.slug.toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 60)}-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
  await gh('/git/refs', { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: base.object.sha }) });
  for (const f of p.files) {
    await gh(`/contents/${f.path}`, { method: 'PUT', body: JSON.stringify({ message: `${p.title} (${f.path})`, content: Buffer.from(f.text).toString('base64'), ...(f.baseSha ? { sha: f.baseSha } : {}), branch }) });
  }
  const pr = await gh<{ html_url: string }>('/pulls', { method: 'POST', body: JSON.stringify({ title: p.title, head: branch, base: BRANCH(), body: p.body }) });
  return pr.html_url;
}

export const THRESHOLDS_PATH = 'catalog/thresholds.json';
export type Threshold = { dashboard: string; panel: string; expr: string; unit: string; steps: { value: number | null; color: string }[]; source: string };

// Dashboard thresholds exported by the generator (PRD F4: "outside the usual range" = past a panel's yellow line).
// ponytail: 60 s in-process cache; the file changes only when dashboards are regenerated.
const tc = globalThis as unknown as { thresholdCache?: { at: number; v: Threshold[] } };
export async function thresholds(): Promise<Threshold[]> {
  if (tc.thresholdCache && Date.now() - tc.thresholdCache.at < 60_000) return tc.thresholdCache.v;
  const v = JSON.parse((await readRepoFile(THRESHOLDS_PATH)).text) as Threshold[];
  tc.thresholdCache = { at: Date.now(), v };
  return v;
}
