// Impact stages (PRD F4): what each component's state means for users, at now or at a past instant.
//   breach  critical alert (incl. an owned SLO's page burn) · 0 pods ready · a dashboard panel past red
//   risk    warning alert (incl. SLO ticket burn) · some pods not ready or restarting
//   slow    a dashboard panel past yellow (the dashboards' "usual range": baseline, limit or alert-derived)
//   unknown the workload is not in kube-state-metrics (never shown green)
//   off     scaled to 0 on purpose
// Worst signal wins; every signal is kept as a reason. A link is in trouble when the component it depends on is
// at risk or breached and the dependent component is affected too.
import type pg from 'pg';
import { isDemo } from './demo.ts';
import { health, query, queryRange, workloads, type Workload } from './prom.ts';
import { thresholds, type Threshold } from './detection.ts';
import type { Edge, Topology } from './topology.ts';

export const STAGES = ['breach', 'risk', 'slow', 'unknown', 'normal', 'off'] as const;
export type Stage = (typeof STAGES)[number];
export type Reason = { stage: Stage; text: string };
export type NodeStage = { stage: Stage; reasons: Reason[]; ready: number; desired: number; restarts1h: number };

const RANK: Record<Stage, number> = { breach: 5, risk: 4, slow: 3, unknown: 2, normal: 1, off: 0 };
export const worst = (a: Stage, b: Stage) => (RANK[b] > RANK[a] ? b : a);

// The step a value falls in: the last step whose value is null (the base) or <= v.
export function colorOf(steps: Threshold['steps'], v: number): string {
  let c = steps[0]?.color ?? 'green';
  for (const s of steps) if (s.value === null || v >= s.value) c = s.color;
  return c;
}
const COLOR_STAGE: Record<string, Stage | undefined> = { red: 'breach', orange: 'slow', yellow: 'slow' };

export type AlertFact = { component: string; severity: string; alertname: string; summary: string };

// Pure: facts for one component → its stage and reasons.
export function decide(f: { alerts: AlertFact[]; workloads: Workload[]; missing: boolean; panels: { t: Threshold; value: number }[] }): { stage: Stage; reasons: Reason[] } {
  const reasons: Reason[] = [];
  for (const a of f.alerts) reasons.push({ stage: a.severity === 'critical' ? 'breach' : 'risk', text: `${a.alertname} firing${a.summary ? `: ${a.summary}` : ''}` });
  for (const w of f.workloads) {
    const h = health(w);
    if (h === 'down') reasons.push({ stage: 'breach', text: `${w.name}: 0/${w.desired} pods ready` });
    else if (h === 'degraded') reasons.push({ stage: 'risk', text: `${w.name}: ${w.ready}/${w.desired} ready, ${w.restarts1h} restarts in 1h` });
  }
  for (const p of f.panels) {
    const s = COLOR_STAGE[colorOf(p.t.steps, p.value)];
    if (s) reasons.push({ stage: s, text: `${p.t.panel} ${fmt(p.value, p.t.unit)} (${(p.t.source.split('Source: ')[1] ?? p.t.source).replace(/\.$/, '')})` });
  }
  if (f.missing) reasons.push({ stage: 'unknown', text: 'not found in kube-state-metrics: no data' });
  const off = !f.missing && f.workloads.length > 0 && f.workloads.every((w) => w.desired === 0);
  const base: Stage = off ? 'off' : 'normal';
  const stage = reasons.reduce<Stage>((s, r) => worst(s, r.stage), base);
  return { stage, reasons: reasons.sort((a, b) => RANK[b.stage] - RANK[a.stage]) };
}

function fmt(v: number, unit: string) {
  if (unit === 'percent') return `${v.toFixed(0)}%`;
  if (unit === 'percentunit') return `${(v * 100).toFixed(0)}%`;
  if (unit === 'bytes') return v >= 1024 ** 3 ? `${(v / 1024 ** 3).toFixed(2)} GiB` : `${Math.round(v / 1024 ** 2)} MiB`;
  if (unit === 's') return `${v.toFixed(v < 10 ? 1 : 0)}s`;
  return Number.isInteger(v) ? String(v) : v.toPrecision(3);
}

// The dependency (callee) and the dependent (caller) of a link; engine links run the other way.
export const ends = (e: Edge) => (e.via === 'engine' ? { dep: e.from, user: e.to } : { dep: e.to, user: e.from });

export function edgeStage(e: Edge, st: Record<string, { stage: Stage }>): Stage | null {
  const { dep, user } = ends(e);
  const d = st[dep]?.stage, u = st[user]?.stage;
  if ((d === 'breach' || d === 'risk') && u && u !== 'normal' && u !== 'off' && u !== 'unknown') return d;
  return null;
}

const key = (e: Edge) => `${e.from}>${e.to}`;

// Alerts firing at `at` (or now), by component.
async function alertsAt(c: pg.Pool, at?: Date): Promise<AlertFact[]> {
  const { rows } = await c.query<AlertFact>(
    at ? `SELECT component, severity, alertname, coalesce(annotations->>'summary', '') AS summary FROM alerts
          WHERE component IS NOT NULL AND starts_at <= $1 AND (ends_at > $1 OR (ends_at IS NULL AND status = 'firing'))`
      : `SELECT component, severity, alertname, coalesce(annotations->>'summary', '') AS summary FROM alerts
          WHERE component IS NOT NULL AND status = 'firing'`, at ? [at] : []);
  return rows;
}

const firstValue = (rows: { value: [number, string] }[]) => {
  const vs = rows.map((r) => Number(r.value[1])).filter((v) => Number.isFinite(v));
  return vs.length ? Math.max(...vs) : null;
};

// ponytail: live results cached 15 s per process; every page auto-refreshes and each pass runs ~100 queries.
const sc = globalThis as unknown as { stageCache?: { at: number; v: Awaited<ReturnType<typeof compute>> } };
export async function stagesAt(c: pg.Pool, t: Topology, at?: Date) {
  if (at) return compute(c, t, at);
  if (sc.stageCache && Date.now() - sc.stageCache.at < 15_000) return sc.stageCache.v;
  const v = await compute(c, t);
  sc.stageCache = { at: Date.now(), v };
  return v;
}

async function compute(c: pg.Pool, t: Topology, at?: Date) {
  const [alerts, ws, ths] = await Promise.all([
    alertsAt(c, at),
    workloads(at).then((v) => ({ v }), (e: Error) => ({ e: e.message })),
    thresholds().catch(() => [] as Threshold[]),
  ]);
  const nodes: Record<string, NodeStage> = {};
  await Promise.all(t.nodes.map(async (n) => {
    const mine = 'v' in ws ? ws.v.filter((w) => n.workloads.some((r) => r.ns === w.ns && r.name === w.name && r.kind === w.kind)) : [];
    const missing = 'v' in ws && mine.length < n.workloads.length;
    // Demo mode: dashboard panels would read the live lab; the scenario speaks through alerts and workloads.
    const panels = isDemo() ? [] : (await Promise.all(ths.filter((x) => x.dashboard === n.dashboard).map(async (x) => {
      const v = await query(x.expr, at).then(firstValue, () => null);
      return v === null ? null : { t: x, value: v };
    }))).filter((x) => x !== null);
    const d = decide({ alerts: alerts.filter((a) => a.component === n.id), workloads: mine, missing: 'e' in ws || missing, panels });
    nodes[n.id] = { ...d, ready: mine.reduce((s, w) => s + w.ready, 0), desired: mine.reduce((s, w) => s + w.desired, 0), restarts1h: mine.reduce((s, w) => s + w.restarts1h, 0) };
  }));
  const edges = Object.fromEntries(t.edges.map((e) => [key(e), edgeStage(e, nodes)]));
  return { nodes, edges, error: 'e' in ws ? ws.e : null };
}

export type FirstSign = { component: string; stage: Stage; at: Date; text: string; sinceStart?: boolean }; // sinceStart: already true when the window opens

// The earliest sign per component in the hours before detection: alerts (any incident) and dashboard panels
// crossing yellow/red (query_range, 1 min steps). This is what "detected earlier than the postmortem" is checked on.
// ponytail: cached 5 min per (components, detection) since the past barely changes; pages auto-refresh every 5 s.
const fc = globalThis as unknown as { firstSignCache?: Map<string, { at: number; v: FirstSign[] }> };
export async function firstSigns(c: pg.Pool, t: Topology, comps: string[], detected: Date, hours = 6): Promise<FirstSign[]> {
  const k = `${comps.join(',')}@${detected.toISOString()}`;
  const cache = (fc.firstSignCache ??= new Map());
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < 300_000) return hit.v;
  const v = await computeFirstSigns(c, t, comps, detected, hours);
  cache.set(k, { at: Date.now(), v });
  return v;
}

async function computeFirstSigns(c: pg.Pool, t: Topology, comps: string[], detected: Date, hours: number): Promise<FirstSign[]> {
  const from = new Date(detected.getTime() - hours * 3600_000);
  const ths = await thresholds().catch(() => [] as Threshold[]);
  const out: FirstSign[] = [];
  for (const id of comps) {
    const n = t.nodes.find((x) => x.id === id);
    if (!n) continue;
    const cands: FirstSign[] = [];
    const { rows } = await c.query<{ starts_at: Date; severity: string; alertname: string }>(
      'SELECT starts_at, severity, alertname FROM alerts WHERE component = $1 AND starts_at BETWEEN $2 AND $3 ORDER BY starts_at LIMIT 1', [id, from, detected]);
    if (rows[0]) cands.push({ component: id, stage: rows[0].severity === 'critical' ? 'breach' : 'risk', at: rows[0].starts_at, text: `${rows[0].alertname} fired` });
    await Promise.all(ths.filter((x) => x.dashboard === n.dashboard && !isDemo()).map(async (x) => {
      const series = await queryRange(x.expr, from, detected).catch(() => []);
      for (const s of series) {
        const i = s.values.findIndex(([, v]) => COLOR_STAGE[colorOf(x.steps, Number(v))]);
        if (i < 0) continue;
        const [ts, v] = s.values[i];
        cands.push({ component: id, stage: COLOR_STAGE[colorOf(x.steps, Number(v))]!, at: new Date(ts * 1000), text: `${x.panel} ${fmt(Number(v), x.unit)}`, sinceStart: i === 0 });
      }
    }));
    const first = cands.sort((a, b) => a.at.getTime() - b.at.getTime())[0];
    if (first) out.push(first);
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}
