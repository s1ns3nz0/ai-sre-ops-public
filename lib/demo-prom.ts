// Demo mode stand-in for Prometheus (there is no cluster behind a demo deployment). Queries the scenario knows
// (finalized block, maru heap, prover queue, bridge messages, SLOs, firing alerts, …) get values that match the
// seeded story at that time; anything else gets a plausible value of the right shape. The metric inventory comes
// from a metadata snapshot of the lab Prometheus (fixtures/demo-prometheus.json.gz: names, labels, help; no
// samples). Everything here is sample data for the portfolio demo.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import type pg from 'pg';
import { demoSlos } from './demo.ts';

type Sample = { metric: Record<string, string>; value: [number, string] };
type Snapshot = { taken: string; metrics: Record<string, { type: string | null; help: string | null; unit: string | null; series: number; labels: Record<string, string[]> }> };

const g = globalThis as unknown as { demoSnapshot?: Snapshot };
export function snapshot(): Snapshot {
  return (g.demoSnapshot ??= JSON.parse(gunzipSync(readFileSync(path.join(process.cwd(), 'fixtures', 'demo-prometheus.json.gz'))).toString('utf8')) as Snapshot);
}

const minutes = (a: Date, t: Date) => (t.getTime() - a.getTime()) / 60_000;
// The L2 at a time: head grows 20 blocks/min; finalization fell behind during the prover outage and is catching up.
const head = (m: number) => Math.round(21_000 + 20 * m);
const lag = (m: number) => Math.round(m < -300 ? 40 : m < -150 ? Math.min(1_900, 40 + 12 * (m + 300)) : Math.max(60, 840 - 6 * (m + 58)));

// Equality matchers of the first selector, e.g. {job="l2-maru", namespace="lineth-l2"} → labels for the result.
function selectorLabels(expr: string): Record<string, string> {
  const sel = /\{([^}]*)\}/.exec(expr)?.[1] ?? '';
  return Object.fromEntries([...sel.matchAll(/(\w+)\s*=\s*"([^"]*)"/g)].map((m) => [m[1], m[2]]));
}
// A trailing comparison filters the result like PromQL does: `… > 300` keeps the series only when it is true.
function compare(expr: string, v: number): boolean {
  const m = /(==|!=|>=|<=|>|<)\s*([\d.\s*+-]+)\s*$/.exec(expr);
  if (!m) return true;
  const rhs = m[2].split('*').reduce((p, x) => p * Number(x.trim() || 1), 1);
  return ({ '==': v === rhs, '!=': v !== rhs, '>=': v >= rhs, '<=': v <= rhs, '>': v > rhs, '<': v < rhs } as Record<string, boolean>)[m[1]];
}

type Rule = [RegExp, (m: number, expr: string) => { labels?: Record<string, string>; v: number }[]];
const RULES: Rule[] = [
  [/lineth_l2_rollup_finalized_block/, (m, e) => {
    const tag = /l1_block_tag\s*=\s*"finalized"/.test(e) ? 'finalized' : 'latest';
    return [{ labels: { l1_block_tag: tag }, v: /increase|changes/.test(e) ? 90 : head(m) - lag(m) - (tag === 'finalized' ? 64 : 0) }];
  }],
  [/lineth_l2_head_block/, (m) => [{ v: head(m) }]],
  [/jvm_memory_(used|max)_bytes.*l2-maru|l2-maru.*jvm_memory/, () => [{ v: 0.31 }]],
  [/jvm_memory_used_bytes.*area="heap"/, () => [{ labels: { job: 'besu' }, v: 41 }, { labels: { job: 'teku' }, v: 38 }]],
  [/ethereum_blockchain_height/, (m, e) => (/increase|rate|deriv/.test(e) ? [{ labels: { job: 'l2-sequencer' }, v: 22.9 }] : /-\s*max/.test(e) ? [{ v: 2 }] : [{ labels: { job: 'l2-sequencer' }, v: head(m) }])],
  [/shomei_blockchain_head/, (m) => [{ v: head(m) - 3 }]],
  [/lineth_prover_requests/, () => [{ labels: { state: 'pending' }, v: 2 }, { labels: { state: 'inprogress' }, v: 1 }, { labels: { state: 'large' }, v: 0 }]],
  [/lineth_prover_oldest_request_age_seconds/, () => [{ labels: { state: 'pending' }, v: 95 }]],
  [/linea_postman_messages/, (_, e) => (/changes|increase/.test(e) ? [{ labels: { direction: 'L1_TO_L2' }, v: 0 }, { labels: { direction: 'L2_TO_L1' }, v: 3 }]
    : [{ labels: { direction: 'L1_TO_L2', status: 'CLAIMED_REVERTED' }, v: 14 }, { labels: { direction: 'L1_TO_L2', status: 'SENT' }, v: 3 }, { labels: { direction: 'L2_TO_L1', status: 'CLAIMED_SUCCESS' }, v: 412 }])],
  [/ethereum_peer_count/, () => [{ labels: { job: 'l2-sequencer' }, v: 1 }, { labels: { job: 'l2-node-besu' }, v: 1 }]],
  [/signing_signers_loaded_count/, (_, e) => [{ labels: { job: /l2-web3signer/.test(e) ? 'l2-web3signer' : 'web3signer' }, v: 4 }]],
  [/node_memory_MemAvailable_bytes/, (_, e) => [{ v: /1024\s*\^\s*3/.test(e) ? 5.4 : 5.4 * 2 ** 30 }]],
  [/node_filesystem_avail_bytes/, () => [{ labels: { mountpoint: '/var' }, v: 81 }, { labels: { mountpoint: '/srv/lineth' }, v: 61 }]],
  [/kube_pod_container_status_last_terminated_reason|kube_pod_container_status_restarts_total/, (_, e) => [{ labels: { namespace: 'lineth-l2', pod: 'prover-6d9f7c5b8d-x4k2p' }, v: /increase|max_over_time/.test(e) ? 0 : 6 }]],
  [/lineth_l2_liveness_(included|needed)_blocks_total/, () => [{ v: 0.97 }]],
  [/traces_spanmetrics_calls_total/, () => [{ v: 0 }]], // synthetic traffic is paused (CHG-04)
  [/lineth_l2_rpc_txpool_oldest_age_seconds/, () => [{ v: 4 }]],
  [/lineth_l2_exporter_last_collection_timestamp_seconds|lab_sync_exporter_collection_timestamp_seconds|lab_execution_head_timestamp_seconds/, () => [{ v: 6 }]],
  [/linea_blob_highest_submitted_on_l1|linea_conflation_last_block_number/, (m) => [{ v: head(m) - lag(m) - 40 }]],
  [/kube_cronjob_status_last_successful_time/, () => [{ v: 9.5 }]],
  [/^\s*up\b|[^_]up\{/, (_, e) => [{ labels: { job: selectorLabels(e).job ?? 'l2-maru' }, v: 1 }]],
];

export async function demoQuery(db: pg.Pool, anchor: Date, expr: string, at = new Date()): Promise<Sample[]> {
  const m = minutes(anchor, at);
  const ts = at.getTime() / 1000;
  const out = (rows: { labels?: Record<string, string>; v: number }[]) =>
    rows.filter((r) => compare(expr, r.v)).map((r) => ({ metric: { ...selectorLabels(expr), ...r.labels }, value: [ts, String(Math.round(r.v * 1e4) / 1e4)] as [number, string] }));
  if (/slo:/.test(expr)) {
    const s = demoSlos(anchor, at);
    const pick = (x: (typeof s)[number]) => (/objective/.test(expr) ? x.objective : /sli_error/.test(expr) ? 1 - (x.sli1h ?? 1) : x.budgetRemaining);
    const only = selectorLabels(expr).slo;
    return out(s.filter((x) => !only || x.name === only).map((x) => ({ labels: { slo: x.name }, v: pick(x) })));
  }
  if (/ALERTS/.test(expr)) {
    if (/slo!?=/.test(expr)) return [];
    const rows = (await db.query<{ alertname: string; severity: string }>("SELECT DISTINCT alertname, severity FROM alerts WHERE status = 'firing'")).rows;
    const want = selectorLabels(expr).alertname;
    return out(rows.filter((r) => !want || r.alertname === want).map((r) => ({ labels: { alertname: r.alertname, alertstate: 'firing', severity: r.severity }, v: 1 })));
  }
  if (/absent(_over_time)?\(/.test(expr)) return []; // every scraped series exists in the scenario
  for (const [re, f] of RULES) if (re.test(expr)) return out(f(m, expr));
  // Unknown: a plausible value of the right shape.
  const v = /time\(\)\s*-/.test(expr) ? 12 : /\//.test(expr) ? 0.42 : /increase|rate|changes|deriv/.test(expr) ? 3 : 1;
  return out([{ v }]);
}

export async function demoQueryRange(db: pg.Pool, anchor: Date, expr: string, from: Date, to: Date, stepSec: number) {
  const steps = Math.min(240, Math.max(2, Math.floor((to.getTime() - from.getTime()) / 1000 / stepSec)));
  const points: { t: number; rows: Sample[] }[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = new Date(from.getTime() + ((to.getTime() - from.getTime()) * i) / steps);
    points.push({ t: t.getTime() / 1000, rows: await demoQuery(db, anchor, expr, t) });
  }
  const keys = new Map<string, { metric: Record<string, string>; values: [number, string][] }>();
  for (const p of points) for (const r of p.rows) {
    const k = JSON.stringify(r.metric);
    if (!keys.has(k)) keys.set(k, { metric: r.metric, values: [] });
    keys.get(k)!.values.push([p.t, r.value[1]]);
  }
  return [...keys.values()];
}
