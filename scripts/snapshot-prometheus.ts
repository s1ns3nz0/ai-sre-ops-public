// Snapshots what the metric inventory needs from the lab Prometheus (names, type/help, label names, series counts,
// label values) into fixtures/demo-prometheus.json.gz, for demo mode where there is no Prometheus (lib/demo-prom.ts).
// Metadata only: no sample values. Usage: PROMETHEUS_URL=http://localhost:9090 node scripts/snapshot-prometheus.ts
import { writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';

const P = process.env.PROMETHEUS_URL ?? 'http://localhost:9090';
const get = async <T>(path: string): Promise<T> => {
  const r = await fetch(P + path, { signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return ((await r.json()) as { data: T }).data;
};
const names = (await get<string[]>('/api/v1/label/__name__/values')).filter((n) => /^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(n));
const meta = await get<Record<string, { type: string; help: string; unit: string }[]>>('/api/v1/metadata');
const counts = new Map((await get<{ result: { metric: { __name__: string }; value: [number, string] }[] }>(
  `/api/v1/query?query=${encodeURIComponent('count by (__name__) ({__name__=~".+"})')}`)).result.map((r) => [r.metric.__name__, Number(r.value[1])]));
const metrics: Record<string, { type: string | null; help: string | null; unit: string | null; series: number; labels: Record<string, string[]> }> = {};
const queue = [...names];
await Promise.all(Array.from({ length: 16 }, async () => {
  for (let n = queue.pop(); n !== undefined; n = queue.pop()) {
    const m = encodeURIComponent(n);
    const labels = (await get<string[]>(`/api/v1/labels?match[]=${m}`).catch(() => [])).filter((l) => l !== '__name__');
    const values: Record<string, string[]> = {};
    for (const l of labels) values[l] = (await get<string[]>(`/api/v1/label/${encodeURIComponent(l)}/values?match[]=${m}`).catch(() => [])).slice(0, 12);
    const md = meta[n]?.[0];
    metrics[n] = { type: md?.type ?? null, help: md?.help ?? null, unit: md?.unit || null, series: counts.get(n) ?? 0, labels: values };
  }
}));
const sorted = Object.fromEntries(Object.keys(metrics).sort().map((k) => [k, metrics[k]]));
await writeFile(new URL('../fixtures/demo-prometheus.json.gz', import.meta.url), gzipSync(JSON.stringify({ taken: new Date().toISOString().slice(0, 10), metrics: sorted }), { level: 9 }));
console.log(`${Object.keys(sorted).length} metrics`);
