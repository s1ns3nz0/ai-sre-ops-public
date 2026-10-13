// Prometheus HTTP API reads (SLOs from lineth-observability recording rules, workloads and pods from
// kube-state-metrics + cAdvisor). In the cluster PROMETHEUS_URL is the in-cluster Service; locally a port-forward.
import { pool } from './db.ts';
import { anchor, demoPods, demoSlos, demoWorkloads, isDemo } from './demo.ts';
import { demoQuery, demoQueryRange } from './demo-prom.ts';
import { topology, type WorkloadRef } from './topology.ts';

type Sample = { metric: Record<string, string>; value: [number, string] };

const BASE = () => process.env.PROMETHEUS_URL ?? 'http://localhost:9090';

// Prefix of the error thrown when Prometheus rejects the expression itself (vs. being unreachable).
export const BAD_QUERY = 'Prometheus rejected the query';

// at: evaluate at a past instant (time travel, PRD F4) instead of now.
export async function query(q: string, at?: Date): Promise<Sample[]> {
  if (isDemo()) return demoQuery(pool(), await anchor(pool()), q, at);
  const t = at ? `&time=${at.getTime() / 1000}` : '';
  const res = await fetch(`${BASE()}/api/v1/query?query=${encodeURIComponent(q)}${t}`, { signal: AbortSignal.timeout(4000), cache: 'no-store' });
  if (res.status === 400 || res.status === 422) {
    const e = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(`${BAD_QUERY}: ${e?.error ?? res.status}`);
  }
  if (!res.ok) throw new Error(`Prometheus ${res.status}`);
  const body = (await res.json()) as { status: string; data: { result: Sample[] } };
  if (body.status !== 'success') throw new Error('Prometheus query failed');
  return body.data.result;
}

export type Series = { metric: Record<string, string>; values: [number, string][] };

export async function queryRange(q: string, from: Date, to: Date, stepSec = 60): Promise<Series[]> {
  if (isDemo()) return demoQueryRange(pool(), await anchor(pool()), q, from, to, stepSec);
  const u = `${BASE()}/api/v1/query_range?query=${encodeURIComponent(q)}&start=${from.getTime() / 1000}&end=${to.getTime() / 1000}&step=${stepSec}`;
  const res = await fetch(u, { signal: AbortSignal.timeout(8000), cache: 'no-store' });
  if (!res.ok) throw new Error(`Prometheus ${res.status}`);
  const body = (await res.json()) as { status: string; data: { result: Series[] } };
  if (body.status !== 'success') throw new Error('Prometheus query failed');
  return body.data.result;
}

const num = (s: Sample) => Number(s.value[1]);
const byLabel = (rows: Sample[], label: string) => new Map(rows.map((r) => [r.metric[label], num(r)]));

export type Slo = { name: string; objective: number; sli1h: number | null; budgetRemaining: number };

export async function slos(): Promise<Slo[]> {
  if (isDemo()) return demoSlos(await anchor(pool()));
  const [obj, budget, err1h] = await Promise.all([
    query('slo:objective:ratio'),
    query('slo:error_budget_remaining:ratio'),
    query('slo:sli_error:ratio_rate1h'),
  ]);
  const b = byLabel(budget, 'slo');
  const e = byLabel(err1h, 'slo');
  return obj
    .map((r) => {
      const name = r.metric.slo;
      const err = e.get(name);
      return { name, objective: num(r), sli1h: err === undefined || Number.isNaN(err) ? null : 1 - err, budgetRemaining: b.get(name) ?? NaN };
    })
    .sort((x, y) => x.budgetRemaining - y.budgetRemaining);
}

export type Workload = WorkloadRef & { desired: number; ready: number; restarts1h: number };
export type Health = 'ok' | 'degraded' | 'down' | 'off';

const NS = 'namespace=~"lineth-l2|local-l1"';

// Deployment pods are <name>-<replicaset hash>-<5 chars>, StatefulSet pods <name>-<ordinal>. Matching the exact
// shape keeps CronJob pods such as prover-files-cleanup-<id>-<x> from being counted as the prover.
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function ownerOf<T extends { ns: string; name: string; kind: 'Deployment' | 'StatefulSet' }>(ns: string, pod: string, ws: T[]): T | undefined {
  return ws.find((w) => w.ns === ns && new RegExp(`^${escape(w.name)}-${w.kind === 'StatefulSet' ? '\\d+' : '[a-z0-9]{5,10}-[a-z0-9]{5}'}$`).test(pod));
}

export async function workloads(at?: Date): Promise<Workload[]> {
  if (isDemo()) return demoWorkloads(await anchor(pool()), topology().nodes.flatMap((n) => n.workloads), at);
  const [dSpec, dReady, sSpec, sReady, restarts] = await Promise.all([
    query(`kube_deployment_spec_replicas{${NS}}`, at),
    query(`kube_deployment_status_replicas_available{${NS}}`, at),
    query(`kube_statefulset_replicas{${NS}}`, at),
    query(`kube_statefulset_status_replicas_ready{${NS}}`, at),
    query(`sum by (namespace, pod) (increase(kube_pod_container_status_restarts_total{${NS}}[1h]))`, at),
  ]);
  const ready = (rows: Sample[], l: string) => new Map(rows.map((r) => [`${r.metric.namespace}/${r.metric[l]}`, num(r)]));
  const dr = ready(dReady, 'deployment');
  const sr = ready(sReady, 'statefulset');
  const ws: Workload[] = [
    ...dSpec.map((r) => ({ ns: r.metric.namespace, kind: 'Deployment' as const, name: r.metric.deployment, desired: num(r), ready: dr.get(`${r.metric.namespace}/${r.metric.deployment}`) ?? 0, restarts1h: 0 })),
    ...sSpec.map((r) => ({ ns: r.metric.namespace, kind: 'StatefulSet' as const, name: r.metric.statefulset, desired: num(r), ready: sr.get(`${r.metric.namespace}/${r.metric.statefulset}`) ?? 0, restarts1h: 0 })),
  ];
  for (const p of restarts) {
    const w = ownerOf(p.metric.namespace, p.metric.pod, ws);
    if (w) w.restarts1h += Math.round(num(p));
  }
  return ws;
}

export function health(w: Workload): Health {
  if (w.desired === 0) return 'off'; // scaled down on purpose (e.g. explorer during INC-11)
  if (w.ready === 0) return 'down';
  if (w.ready < w.desired || w.restarts1h > 0) return 'degraded';
  return 'ok';
}

export type Pod = {
  workload: string; ns: string; name: string; ready: boolean; restarts: number; lastTerminated: string | null; image: string;
  memBytes: number | null; memRequest: number | null; memLimit: number | null; cpuCores: number | null;
};
// No disk usage: in this kind cluster every PVC is a hostPath PV, and kubelet reports the shared host filesystem
// for each of them, so per-volume numbers would be wrong.

// Everything the component drawer shows about the pods behind a set of workloads.
export async function pods(refs: WorkloadRef[]): Promise<Pod[]> {
  if (isDemo()) return demoPods(await anchor(pool()), refs);
  const nss = [...new Set(refs.map((r) => r.ns))].join('|');
  const sel = `namespace=~"${nss}"`;
  const [info, readyQ, restartsQ, termQ, mem, req, lim, cpu] = await Promise.all([
    query(`kube_pod_container_info{${sel}}`),
    query(`kube_pod_status_ready{${sel},condition="true"}`),
    query(`sum by (namespace, pod) (kube_pod_container_status_restarts_total{${sel}})`),
    query(`kube_pod_container_status_last_terminated_reason{${sel}} == 1`),
    query(`sum by (namespace, pod) (container_memory_working_set_bytes{${sel},container!=""})`),
    query(`sum by (namespace, pod) (kube_pod_container_resource_requests{${sel},resource="memory"})`),
    query(`sum by (namespace, pod) (kube_pod_container_resource_limits{${sel},resource="memory"})`),
    query(`sum by (namespace, pod) (rate(container_cpu_usage_seconds_total{${sel},container!=""}[5m]))`),
  ]);
  const key = (s: Sample) => `${s.metric.namespace}/${s.metric.pod}`;
  const map = (rows: Sample[]) => new Map(rows.map((r) => [key(r), num(r)]));
  const [rdy, rst, m, rq, lm, c] = [readyQ, restartsQ, mem, req, lim, cpu].map(map);
  const out = new Map<string, Pod>();
  for (const s of info) {
    const owner = ownerOf(s.metric.namespace, s.metric.pod, refs);
    if (!owner || out.has(key(s))) continue;
    const k = key(s);
    out.set(k, {
      workload: owner.name, ns: s.metric.namespace, name: s.metric.pod, ready: (rdy.get(k) ?? 0) === 1, restarts: rst.get(k) ?? 0,
      lastTerminated: termQ.find((t) => key(t) === k)?.metric.reason ?? null, image: s.metric.image,
      memBytes: m.get(k) ?? null, memRequest: rq.get(k) ?? null, memLimit: lm.get(k) ?? null, cpuCores: c.get(k) ?? null,
    });
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}
