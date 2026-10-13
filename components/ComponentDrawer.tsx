'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { Pod } from '@/lib/prom.ts';
import type { NodeStage, Stage } from '@/lib/stages.ts';
import type { Edge, Node, WhenBroken } from '@/lib/topology.ts';
import { Ts } from './Ts.tsx';

type Link_ = Edge & { peer: string; peerLabel: string };
type Details = {
  node: Node; pods: Pod[]; promError: string | null; out: Link_[]; in: Link_[];
  alerts: { alertname: string; severity: string; status: string; starts_at: string; ends_at: string | null; summary: string; incident_id: string }[];
  links: { dashboard: string | null; logs: string } | null;
};

const STAGE_TEXT: Record<Stage, string> = { breach: 'Breach', risk: 'At risk', slow: 'Slow', normal: 'Normal', unknown: 'Unknown', off: 'Scaled to 0' };
const STAGE_CLS: Record<Stage, string> = {
  breach: 'text-white bg-sev1', risk: 'text-white bg-sev2', slow: 'text-ink bg-sev3/25', normal: 'text-emerald-700 bg-emerald-50',
  unknown: 'text-white bg-ink', off: 'text-sub bg-canvas',
};
const DOT: Record<Stage, string> = { breach: 'bg-sev1', risk: 'bg-sev2', slow: 'bg-sev3', normal: 'bg-emerald-600', unknown: 'bg-ink', off: 'bg-sev4' };

// Grafana Explore on Loki for one LogQL query: an hour either side of the viewed instant, or the last hour.
function explore(grafana: string, expr: string, at: string | null) {
  const range = at ? { from: String(Date.parse(at) - 3600_000), to: String(Date.parse(at) + 3600_000) } : { from: 'now-1h', to: 'now' };
  const panes = { a: { datasource: 'loki', queries: [{ refId: 'A', datasource: { type: 'loki', uid: 'loki' }, expr }], range } };
  return `${grafana}/explore?schemaVersion=1&panes=${encodeURIComponent(JSON.stringify(panes))}`;
}

type RunbookRef = { id: string; title: string };

function Runbooks({ list }: { list: RunbookRef[] }) {
  return (
    <Section title="Runbooks">
      {list.length ? (
        <ul className="space-y-1">
          {list.map((r) => <li key={r.id}><Link href={`/runbooks/${r.id}`} className="block rounded-md px-2 py-1 text-sm hover:bg-canvas"><span className="font-medium">{r.title}</span> <span className="text-xs text-sub">{r.id}</span></Link></li>)}
        </ul>
      ) : <Empty>No runbook covers this yet.</Empty>}
    </Section>
  );
}

// Why the stage, and what breaks: shared by the component and the link drawer.
function StageAndImpact({ reasons, wb, grafana, at }: { reasons: NodeStage['reasons']; wb: WhenBroken; grafana: string | null; at: string | null }) {
  return (
    <>
      <Section title="Why this stage">
        {reasons.length ? (
          <ul className="space-y-1 text-sm">
            {reasons.map((r, i) => <li key={i} className="flex gap-2"><span className={`mt-1.5 size-2 shrink-0 rounded-full ${DOT[r.stage]}`} /><span>{r.text}</span></li>)}
          </ul>
        ) : <Empty>No alert, pod or dashboard threshold signal.</Empty>}
      </Section>
      {(wb.when_broken || wb.logs?.length || wb.precedents?.length) && (
        <Section title="When it breaks">
          {wb.when_broken && (
            <dl className="grid gap-y-1.5 text-sm">
              <dt className="text-xs text-sub">Symptoms</dt><dd>{wb.when_broken.symptoms}</dd>
              <dt className="text-xs text-sub">Impact</dt><dd>{wb.when_broken.impact}</dd>
            </dl>
          )}
          {wb.logs?.length ? (
            <div className="mt-3">
              <div className="mb-1 text-xs text-sub">Logs to check{at ? ' (an hour either side)' : ' (last hour)'}</div>
              <ul className="space-y-1">
                {wb.logs.map((q) => (
                  <li key={q}>{grafana
                    ? <a href={explore(grafana, q, at)} target="_blank" rel="noreferrer" className="block truncate font-mono text-xs underline underline-offset-2" title={q}>{q}</a>
                    : <code className="block truncate text-xs" title={q}>{q}</code>}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {wb.precedents?.length ? <p className="mt-3 text-xs text-sub">Seen before: {wb.precedents.join(', ')}</p> : null}
        </Section>
      )}
    </>
  );
}

export function EdgeDrawer({ edge, from, to, stage, status, at, grafana, runbooks = [], onClose, onSelect }: {
  edge: Edge; from: Node; to: Node; stage: Stage | null; status: Record<string, NodeStage>; at: string | null; grafana: string | null; runbooks?: RunbookRef[];
  onClose: () => void; onSelect: (id: string) => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const reasons = [from, to].flatMap((n) => (status[n.id]?.reasons ?? []).map((r) => ({ ...r, text: `${n.label}: ${r.text}` })));
  return (
    <aside role="dialog" aria-label="Link details"
      className="fixed right-0 top-0 z-20 h-full w-[min(28rem,100vw)] overflow-y-auto border-l border-line bg-surface shadow-2xl motion-safe:animate-[slidein_160ms_ease-out]">
      <header className="sticky top-0 flex items-start gap-3 border-b border-line bg-surface px-5 py-4">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">{from.label} → {to.label}</h2>
          <p className="text-sm text-sub">{edge.via}{edge.port ? ` :${edge.port}` : ''}{edge.note ? ` · ${edge.note}` : ''}</p>
        </div>
        {stage && <span className={`ml-auto inline-flex h-6 items-center rounded-md px-2 text-xs font-medium ${STAGE_CLS[stage]}`}>{STAGE_TEXT[stage]}</span>}
        <button aria-label="Close" onClick={onClose} className={`${stage ? '' : 'ml-auto '}text-xl leading-none text-sub hover:text-ink`}>×</button>
      </header>
      <div className="space-y-6 p-5">
        <div className="flex gap-2">
          {[from, to].map((n) => (
            <button key={n.id} onClick={() => onSelect(n.id)} className="inline-flex h-8 items-center gap-2 rounded-lg border border-line px-3 text-sm hover:border-ink/40">
              <span className={`size-2 rounded-full ${DOT[status[n.id]?.stage ?? 'unknown']}`} />{n.label}
            </button>
          ))}
        </div>
        <StageAndImpact reasons={reasons} wb={edge} grafana={grafana} at={at} />
        <Runbooks list={runbooks} />
      </div>
    </aside>
  );
}

const gib = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GiB` : `${Math.round(b / 1024 ** 2)} MiB`);

export function ComponentDrawer({ id, stage, at, grafana, runbooks = [], onClose, onSelect }: {
  id: string; stage: NodeStage | null; at: string | null; grafana: string | null; runbooks?: RunbookRef[]; onClose: () => void; onSelect: (id: string) => void;
}) {
  const st = stage?.stage ?? 'unknown';
  const [data, setData] = useState<Details | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setData(null); setError(null);
    fetch(`${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}/api/components/${id}`).then(async (r) => {
      const body = await r.json();
      if (!live) return;
      if (r.ok) setData(body); else setError(body.error ?? `HTTP ${r.status}`);
    }, (e) => live && setError(String(e)));
    return () => { live = false; };
  }, [id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <aside role="dialog" aria-label="Component details"
      className="fixed right-0 top-0 z-20 h-full w-[min(28rem,100vw)] overflow-y-auto border-l border-line bg-surface shadow-2xl motion-safe:animate-[slidein_160ms_ease-out]">
      <header className="sticky top-0 flex items-start gap-3 border-b border-line bg-surface px-5 py-4">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">{data?.node.label ?? id}</h2>
          <p className="text-sm text-sub">{data?.node.role}</p>
        </div>
        <span className={`ml-auto rounded-md px-2 h-6 inline-flex items-center text-xs font-medium ${STAGE_CLS[st]}`}>{STAGE_TEXT[st]}</span>
        <button aria-label="Close" onClick={onClose} className="text-sub hover:text-ink text-xl leading-none">×</button>
      </header>

      {error && <p className="p-5 text-sm text-sev1">Could not load details: {error}</p>}
      {!data && !error && <p className="p-5 text-sm text-sub">Loading…</p>}
      {data && (
        <div className="space-y-6 p-5">
          {data.links && (
            <div className="flex gap-2">
              {data.links.dashboard && <a href={data.links.dashboard} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center rounded-lg border border-line px-3 text-sm hover:border-ink/40">Grafana dashboard</a>}
              <a href={data.links.logs} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center rounded-lg border border-line px-3 text-sm hover:border-ink/40">Logs, last hour</a>
            </div>
          )}

          <StageAndImpact reasons={stage?.reasons ?? []} wb={data.node} grafana={grafana} at={at} />
          <Runbooks list={runbooks} />
          {at && <p className="text-xs text-sub">The stage is as of the viewed time; pods and alerts below are live.</p>}

          <Section title="Alerts">
            {data.alerts.length ? (
              <ul className="space-y-2">
                {data.alerts.map((a) => (
                  <li key={a.alertname + a.starts_at}>
                    <Link href={`/incidents/${a.incident_id}`} className={`block rounded-lg border px-3 py-2 text-sm hover:border-ink/40 ${a.status === 'firing' ? 'border-sev1 bg-sev1/5' : 'border-line'}`}>
                      <div className="flex items-center gap-2">
                        <span className={`size-2 rounded-full ${a.status === 'firing' ? 'bg-sev1' : 'bg-emerald-600'}`} />
                        <span className="font-medium">{a.alertname}</span>
                        <span className="ml-auto text-xs text-sub">#{a.incident_id}</span>
                      </div>
                      <div className="mt-0.5 text-xs text-sub">{a.status === 'firing' ? 'Firing since ' : 'Fired '}<Ts at={a.starts_at} /></div>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : <Empty>No alerts in the last 24 hours.</Empty>}
          </Section>

          <Section title="Pods">
            {data.promError && <p className="text-sm text-sev1">Prometheus: {data.promError}</p>}
            {data.pods.length ? (
              <ul className="space-y-3">
                {data.pods.map((p) => (
                  <li key={p.name} className="rounded-lg border border-line p-3 text-sm">
                    <div className="flex items-center gap-2">
                      <span className={`size-2 rounded-full ${p.ready ? 'bg-emerald-600' : 'bg-sev1'}`} />
                      <span className="font-medium truncate">{p.name}</span>
                      <span className="ml-auto text-xs text-sub">{p.ready ? 'Ready' : 'Not ready'}</span>
                    </div>
                    <dl className="mt-2 grid grid-cols-[6.5rem_1fr] gap-y-1 text-xs">
                      <dt className="text-sub">Restarts</dt>
                      <dd className={p.restarts ? 'text-sev2 font-medium' : ''}>{p.restarts}{p.lastTerminated && <span className={p.lastTerminated === 'OOMKilled' ? 'text-sev1 font-semibold' : ''}>, last: {p.lastTerminated}</span>}</dd>
                      <dt className="text-sub">Image</dt><dd className="truncate" title={p.image}>{p.image.split('/').pop()?.split('@')[0]}</dd>
                      <dt className="text-sub">CPU</dt><dd>{p.cpuCores === null ? '—' : `${p.cpuCores.toFixed(2)} cores`}</dd>
                    </dl>
                    <Meter label="Memory" used={p.memBytes} request={p.memRequest} limit={p.memLimit} />
                  </li>
                ))}
              </ul>
            ) : !data.promError && <Empty>No running pods.</Empty>}
          </Section>

          <Section title="Connections">
            <LinkList title="Calls" items={data.out} onSelect={onSelect} />
            <LinkList title="Called by" items={data.in} onSelect={onSelect} />
          </Section>
        </div>
      )}
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section><h3 className="mb-2 text-sm font-semibold">{title}</h3>{children}</section>;
}
function Empty({ children }: { children: React.ReactNode }) { return <p className="text-sm text-sub">{children}</p>; }

// Usage bar against the limit, with the request as a tick. Over 85% of the limit turns orange, over 95% red.
function Meter({ label, used, request, limit }: { label: string; used: number | null; request?: number | null; limit: number | null }) {
  if (used === null || Number.isNaN(used)) return null;
  const max = limit && !Number.isNaN(limit) ? limit : null;
  const ratio = max ? used / max : null;
  const tone = ratio === null ? 'bg-sub' : ratio > 0.95 ? 'bg-sev1' : ratio > 0.85 ? 'bg-sev2' : 'bg-ink';
  return (
    <div className="mt-2 text-xs">
      <div className="flex justify-between"><span className="text-sub truncate">{label}</span><span>{gib(used)}{max ? ` of ${gib(max)}` : ''}</span></div>
      {max && (
        <div className="relative mt-1 h-1.5 rounded-full bg-line">
          <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.min(1, ratio!) * 100}%` }} />
          {request ? <div className="absolute -top-0.5 h-2.5 w-px bg-sub" style={{ left: `${Math.min(1, request / max) * 100}%` }} title={`request ${gib(request)}`} /> : null}
        </div>
      )}
    </div>
  );
}

function LinkList({ title, items, onSelect }: { title: string; items: Link_[]; onSelect: (id: string) => void }) {
  if (!items.length) return null;
  return (
    <div className="mb-3">
      <div className="mb-1 text-xs text-sub">{title}</div>
      <ul className="space-y-1">
        {items.map((e) => (
          <li key={e.peer + e.via}>
            <button onClick={() => onSelect(e.peer)} className="flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-canvas">
              <span className="font-medium">{e.peerLabel}</span>
              <span className="text-xs text-sub truncate">{e.note}</span>
              <span className="ml-auto shrink-0 text-xs text-sub">{e.via}{e.port ? ` :${e.port}` : ''}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
