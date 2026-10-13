// Reliability numbers (PRD F14). Pure: incident rows in, durations and stats out.
//   MTTD first alert → declared · MTTA first page → acknowledged · MTTM declared → mitigated · MTTR first alert → resolved
export type ReliabilityRow = {
  id: string; title: string; sev: number | null; state: string; cause: string | null;
  detected_at: Date; declared_at: Date | null; mitigated_at: Date | null; resolved_at: Date | null;
  first_page_at: Date | null; acked_at: Date | null;
};
export const METRICS = ['mttd', 'mtta', 'mttm', 'mttr'] as const;
export type Metric = (typeof METRICS)[number];
export const METRIC_LABEL: Record<Metric, { short: string; what: string }> = {
  mttd: { short: 'MTTD', what: 'first alert → declared' },
  mtta: { short: 'MTTA', what: 'first page → acknowledged' },
  mttm: { short: 'MTTM', what: 'declared → mitigated' },
  mttr: { short: 'MTTR', what: 'first alert → resolved' },
};

const span = (a: Date | null, b: Date | null) => (a && b ? Math.max(0, new Date(b).getTime() - new Date(a).getTime()) : null);

export function durations(r: ReliabilityRow): Record<Metric, number | null> {
  return {
    mttd: span(r.detected_at, r.declared_at),
    mtta: span(r.first_page_at, r.acked_at),
    mttm: span(r.declared_at, r.mitigated_at),
    mttr: span(r.detected_at, r.resolved_at),
  };
}

// Nearest-rank quantile; null when there is nothing to measure.
export function quantile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}

export function summarize(rows: ReliabilityRow[]) {
  const d = rows.map(durations);
  return Object.fromEntries(METRICS.map((m) => {
    const xs = d.map((x) => x[m]).filter((x): x is number => x !== null);
    return [m, { p50: quantile(xs, 0.5), p90: quantile(xs, 0.9), n: xs.length }];
  })) as Record<Metric, { p50: number | null; p90: number | null; n: number }>;
}

// Incidents whose probable cause repeats within `days` of an earlier one with the same cause.
export function repeats(rows: ReliabilityRow[], days = 30) {
  const byCause = new Map<string, ReliabilityRow[]>();
  for (const r of rows) if (r.cause) (byCause.get(r.cause) ?? byCause.set(r.cause, []).get(r.cause)!).push(r);
  const out: { cause: string; incidents: ReliabilityRow[] }[] = [];
  for (const [cause, list] of byCause) {
    const sorted = list.sort((a, b) => new Date(a.detected_at).getTime() - new Date(b.detected_at).getTime());
    const hit = sorted.filter((r, i) => sorted.some((o, j) => j !== i && Math.abs(new Date(o.detected_at).getTime() - new Date(r.detected_at).getTime()) <= days * 86_400_000));
    if (hit.length > 1) out.push({ cause, incidents: hit });
  }
  return out.sort((a, b) => b.incidents.length - a.incidents.length);
}
