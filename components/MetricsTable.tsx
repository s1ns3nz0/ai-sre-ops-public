'use client';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { labelValuesAction, metricDetailAction, metricsWithLabelAction } from '@/app/(console)/detection/actions.ts';
import type { MetricDetail } from '@/lib/detection.ts';

export type MetricRow = { name: string; service: string; source: string; usedBy: string[]; labels: string[]; status: 'used' | 'unused' | 'broken' };
const STATUS: Record<MetricRow['status'], string> = { broken: 'Broken', used: 'In use', unused: 'Unused' };

const PAGE = 200;

// Every metric Prometheus collects plus everything rules and dashboards reference. Search matches all words
// (case-insensitive) against the name, service, source and what uses it, e.g. "prover memory" or "kube restarts".
export function MetricsTable({ rows }: { rows: MetricRow[] }) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'all' | MetricRow['status']>('all');
  const [source, setSource] = useState('all');
  const [service, setService] = useState('all');
  const [limit, setLimit] = useState(PAGE);
  const sources = useMemo(() => [...new Set(rows.map((r) => r.source))].sort(), [rows]);
  const services = useMemo(() => [...new Set(rows.map((r) => r.service))].sort(), [rows]);
  const hay = useMemo(() => new Map(rows.map((r) => [r.name, `${r.name} ${r.service} ${r.source} ${r.usedBy.join(' ')} ${r.labels.join(' ')}`.toLowerCase()])), [rows]);
  const [open, setOpen] = useState<string | null>(null);
  // Label filter: a name alone keeps metrics that carry it; name=value asks Prometheus which metrics have that series.
  const [label, setLabel] = useState('');
  const [value, setValue] = useState('');
  const [values, setValues] = useState<string[]>([]);
  const [withValue, setWithValue] = useState<Set<string> | null>(null);
  const labelNames = useMemo(() => {
    const c = new Map<string, number>();
    for (const r of rows) for (const l of r.labels) c.set(l, (c.get(l) ?? 0) + 1);
    return [...c].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [rows]);
  useEffect(() => { setValue(''); setWithValue(null); setValues([]); if (label) labelValuesAction(label).then(setValues); }, [label]);
  useEffect(() => {
    if (!label || !value) { setWithValue(null); return; }
    let live = true;
    const t = setTimeout(() => metricsWithLabelAction(label, value).then((n) => live && setWithValue(new Set(n))), 250);
    return () => { live = false; clearTimeout(t); };
  }, [label, value]);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = rows.filter((r) => (status === 'all' || r.status === status) && (source === 'all' || r.source === source)
    && (service === 'all' || r.service === service) && words.every((w) => hay.get(r.name)!.includes(w))
    && (!label || (value ? !!withValue?.has(r.name) : r.labels.includes(label))));
  const count = (s: MetricRow['status']) => rows.filter((r) => r.status === s).length;
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setLimit(PAGE); };
  const select = 'h-9 rounded-lg border border-line bg-surface px-2 text-sm';

  return (
    <div>
      <div className="relative">
        <span aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sub">⌕</span>
        <input type="search" value={q} onChange={(e) => reset(setQ)(e.target.value)} autoFocus
          placeholder="Search metrics: name, label, service or what uses it (all words must match)"
          aria-label="Search metrics" className="h-10 w-full rounded-lg border border-line bg-surface pl-8 pr-3 text-sm focus:border-ink/40 focus:outline-none" />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {(['all', 'broken', 'used', 'unused'] as const).map((s) => (
          <button key={s} onClick={() => reset(setStatus)(s)} className={`h-9 rounded-lg px-3 text-sm ${status === s ? 'bg-ink text-white' : 'border border-line bg-surface text-sub hover:text-ink'}`}>
            {s === 'all' ? `All ${rows.length}` : `${STATUS[s]} ${count(s)}`}
          </button>
        ))}
        <select value={service} onChange={(e) => reset(setService)(e.target.value)} aria-label="Service" className={select}>
          <option value="all">All services</option>
          {services.map((s) => <option key={s}>{s}</option>)}
        </select>
        <select value={source} onChange={(e) => reset(setSource)(e.target.value)} aria-label="Source" className={select}>
          <option value="all">All sources</option>
          {sources.map((s) => <option key={s}>{s}</option>)}
        </select>
        <span className="flex items-center gap-1">
          <select value={label} onChange={(e) => { setLabel(e.target.value); setLimit(PAGE); }} aria-label="Label" className={select}>
            <option value="">Any label</option>
            {labelNames.map(([l, n]) => <option key={l} value={l}>{l} ({n})</option>)}
          </select>
          {label && <>
            <span className="text-sm text-sub">=</span>
            <input list="label-values" value={value} onChange={(e) => { setValue(e.target.value); setLimit(PAGE); }} placeholder="any value" aria-label="Label value"
              className="h-9 w-44 rounded-lg border border-line bg-surface px-2 font-mono text-xs" />
            <datalist id="label-values">{values.map((v) => <option key={v} value={v} />)}</datalist>
            <button type="button" onClick={() => setLabel('')} aria-label="Clear label filter" className="px-1 text-sub hover:text-ink">×</button>
          </>}
        </span>
        <span className="ml-auto text-sm text-sub">{shown.length === rows.length ? `${rows.length} metrics` : `${shown.length} of ${rows.length}`}</span>
      </div>
      <table className="mt-3 w-full table-fixed text-sm">
        <colgroup><col className="w-[34%]" /><col className="w-[32%]" /><col className="w-[17%]" /><col /></colgroup>
        <thead><tr className="text-left text-xs text-sub"><th className="py-2 font-normal">Metric</th><th className="font-normal">Labels</th><th className="font-normal">Service</th><th className="font-normal">Used by</th></tr></thead>
        <tbody>
          {shown.slice(0, limit).map((r) => {
            const isOpen = open === r.name;
            return (
              <Fragment key={r.name}>
                <tr onClick={() => setOpen(isOpen ? null : r.name)} aria-expanded={isOpen}
                  className={`cursor-pointer border-t border-line align-top hover:bg-sev4/5 ${isOpen ? 'bg-canvas' : ''}`}>
                  <td className={`py-2 pr-3 font-mono text-xs break-all ${r.status === 'broken' ? 'text-sev1' : ''}`} title={r.status === 'broken' ? 'Broken: referenced but not collected' : undefined}>
                    <span aria-hidden className={`mr-1.5 inline-block text-[9px] text-sub transition-transform ${isOpen ? 'rotate-90' : ''}`}>▶</span>{r.name}
                  </td>
                  <td className="py-2 pr-3">
                    <span className="flex flex-wrap gap-1">
                      {r.labels.slice(0, 5).map((l) => <span key={l} className="rounded bg-canvas px-1.5 font-mono text-[11px] text-ink/80">{l}</span>)}
                      {r.labels.length > 5 && <span className="text-[11px] text-sub">+{r.labels.length - 5}</span>}
                      {!r.labels.length && <span className="text-xs text-sub">—</span>}
                    </span>
                  </td>
                  <td className="py-2 pr-3">{r.service}</td>
                  <td className="py-2 text-xs text-sub">
                    {r.usedBy.length ? <span className="underline decoration-dotted underline-offset-2">{r.usedBy.length} {r.usedBy.length === 1 ? 'reference' : 'references'}</span> : '—'}
                  </td>
                </tr>
                {isOpen && <tr><td colSpan={4} className="border-t border-line bg-canvas/60 px-4 py-4"><Detail r={r} /></td></tr>}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {!shown.length && <p className="mt-4 text-sm text-sub">No metric matches. Try fewer words or clear the filters.</p>}
      {shown.length > limit && (
        <button type="button" onClick={() => setLimit((n) => n + PAGE)} className="mt-3 h-9 w-full rounded-lg border border-line text-sm text-sub hover:text-ink">
          Show {Math.min(PAGE, shown.length - limit)} more ({shown.length - limit} left)
        </button>
      )}
    </div>
  );
}

const KIND: [string, string][] = [['alert', 'Alerts'], ['record', 'Recording rules'], ['dashboard', 'Dashboards']];
const SOURCE_NOTE: Record<string, string> = {
  'custom exporter': 'Exported by our own code (lineth exporters, workflow metrics, lab exporters).',
  'custom record': 'Produced by a recording rule in lineth-observability.',
  upstream: 'Exported by third-party software (clients, Kubernetes, the monitoring stack).',
};

// The opened row: what the metric is (Prometheus metadata), its labels with their current values, where it comes
// from, and everything that uses it. Loaded on open, read-only.
function Detail({ r }: { r: MetricRow }) {
  const [d, setD] = useState<MetricDetail | { error: string } | null>(null);
  useEffect(() => { let live = true; metricDetailAction(r.name).then((x) => live && setD(x)); return () => { live = false; }; }, [r.name]);
  const groups = KIND.map(([k, label]) => [label, r.usedBy.filter((u) => u.startsWith(`${k} `)).map((u) => u.slice(k.length + 1))] as const).filter(([, l]) => l.length);
  const box = 'rounded-lg border border-line bg-surface px-4 py-3';
  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <div className={box}>
        {!d ? <p className="text-sm text-sub">Loading from Prometheus…</p> : 'error' in d ? <p className="text-sm text-sev2">{d.error}</p> : (
          <>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
              {d.type && <span className="rounded bg-ink px-1.5 text-[11px] text-white">{d.type}</span>}
              {d.unit && <span className="text-xs text-sub">unit {d.unit}</span>}
              <span className="text-xs text-sub">{d.series} series now</span>
            </div>
            <p className="mt-1.5 text-sm">{d.help || <span className="text-sub">No description (HELP) exported.</span>}</p>
            <h4 className="mt-3 text-xs font-semibold text-sub">Labels</h4>
            {!d.labels.length ? <p className="text-sm text-sub">No labels.</p> : (
              <dl className="mt-1 divide-y divide-line">
                {d.labels.map((l) => (
                  <div key={l.name} className="flex gap-3 py-1.5">
                    <dt className="w-36 shrink-0 font-mono text-xs">{l.name}</dt>
                    <dd className="flex min-w-0 flex-wrap gap-1">
                      {l.values.map((v) => <span key={v} className="max-w-full truncate rounded bg-canvas px-1.5 font-mono text-[11px]" title={v}>{v}</span>)}
                      {l.total > l.values.length && <span className="text-[11px] text-sub">+{l.total - l.values.length} more</span>}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </>
        )}
      </div>
      <div className="space-y-3">
        <div className={box}>
          <h4 className="text-xs font-semibold text-sub">Source</h4>
          <p className="mt-1 text-sm"><b className="font-semibold">{r.source}</b> · {r.service}</p>
          <p className="mt-0.5 text-xs text-sub">{SOURCE_NOTE[r.source] ?? ''}</p>
        </div>
        <div className={box}>
          <h4 className="text-xs font-semibold text-sub">Used by {r.usedBy.length > 0 && <span className="font-normal">{r.usedBy.length}</span>}</h4>
          {!groups.length ? <p className="mt-1 text-sm text-sub">Nothing references it: no alert, recording rule or dashboard.</p> : groups.map(([label, list]) => (
            <div key={label} className="mt-2">
              <div className="text-[11px] text-sub">{label}</div>
              <ul className="mt-0.5 space-y-0.5">{list.map((x) => <li key={x} className="text-sm">{x}</li>)}</ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
