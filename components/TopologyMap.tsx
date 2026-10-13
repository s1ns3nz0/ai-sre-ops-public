'use client';
import { useMemo, useState } from 'react';
import type { NodeStage, Stage } from '@/lib/stages.ts';
import type { Edge, Node, Topology, Via } from '@/lib/topology.ts';
import { ComponentDrawer, EdgeDrawer } from './ComponentDrawer.tsx';

type Status = Record<string, NodeStage>;

const W = 150, H = 54; // node box
// Impact stages (PRD F4). Unknown is dark, never green: missing data must not read as healthy.
export const TONE: Record<Stage, { stroke: string; dot: string; label: string }> = {
  breach: { stroke: 'var(--sev1)', dot: 'var(--sev1)', label: 'Breach' },
  risk: { stroke: 'var(--sev2)', dot: 'var(--sev2)', label: 'At risk' },
  slow: { stroke: 'var(--sev3)', dot: 'var(--sev3)', label: 'Slow' },
  normal: { stroke: '#059669', dot: '#059669', label: 'Normal' },
  unknown: { stroke: 'var(--ink)', dot: 'var(--ink)', label: 'Unknown' },
  off: { stroke: 'var(--sev4)', dot: 'var(--sev4)', label: 'Scaled to 0' },
};
// Every link looks the same; protocol and port live on the label. Only a broken end changes a link's color.
const LINE = 1.5;
const VIA: Record<Via, string> = {
  engine: 'Engine API', rpc: 'JSON-RPC', ws: 'WebSocket', http: 'HTTP', state: 'State', signing: 'Signing', file: 'Shared volume',
};

// Point where the line from the box center towards (tx, ty) leaves the box.
function exit(n: Node, tx: number, ty: number) {
  const dx = tx - n.x, dy = ty - n.y;
  const s = Math.min((W / 2 + 4) / Math.abs(dx || 1e-9), (H / 2 + 4) / Math.abs(dy || 1e-9));
  return { x: n.x + dx * s, y: n.y + dy * s };
}

// ax/bx shift where a link attaches so several links into one box fan out instead of meeting at a point.
function path(a: Node, b: Node, ax = 0, bx = 0) {
  const p = exit({ ...a, x: a.x + ax }, b.x + bx, b.y), q = exit({ ...b, x: b.x + bx }, a.x + ax, a.y);
  const vertical = Math.abs(q.y - p.y) > Math.abs(q.x - p.x);
  const k = 0.45;
  const c1 = vertical ? { x: p.x, y: p.y + (q.y - p.y) * k } : { x: p.x + (q.x - p.x) * k, y: p.y };
  const c2 = vertical ? { x: q.x, y: q.y - (q.y - p.y) * k } : { x: q.x - (q.x - p.x) * k, y: q.y };
  return { d: `M${p.x},${p.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${q.x},${q.y}`, mid: { x: (p.x + 3 * c1.x + 3 * c2.x + q.x) / 8, y: (p.y + 3 * c1.y + 3 * c2.y + q.y) / 8 } };
}

// Links are one blue so they never read as a status; status lives on the component border.
const LINK = 'var(--link)';
const DASH = '6 5'; // every link is dashed; the dashes march in the direction data flows

export type RunbookRef = { id: string; title: string; alerts: string[]; components: string[] };

export function TopologyMap({ topology, status, edges = {}, grafana = null, at = null, runbooks = [] }: {
  topology: Topology; status: Status; edges?: Record<string, Stage | null>; grafana?: string | null; at?: string | null; runbooks?: RunbookRef[];
}) {
  // Runbooks for a set of components: by component, or by an alert those components own.
  const rbFor = (ids: string[]) => runbooks.filter((r) => r.components.some((c) => ids.includes(c))
    || r.alerts.some((a) => ids.some((id) => byId.get(id)?.alerts?.includes(a))));
  const [selected, setSelected] = useState<string | null>(null);
  const [edgeSel, setEdgeSel] = useState<number | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const byId = useMemo(() => new Map(topology.nodes.map((n) => [n.id, n])), [topology]);
  const focus = hover ?? selected;
  const touches = (e: Edge) => !focus || e.from === focus || e.to === focus;
  // Attachment offsets: links sharing an end are ordered by the other end's x and spread across the box.
  const offsets = useMemo(() => {
    const spread = (list: { peer: string; i: number }[]) => {
      const sorted = [...list].sort((p, q) => byId.get(p.peer)!.x - byId.get(q.peer)!.x);
      return new Map(sorted.map((x, k) => [x.i, sorted.length < 2 ? 0 : (k - (sorted.length - 1) / 2) * Math.min(26, (W - 30) / (sorted.length - 1))]));
    };
    const at = topology.edges.map(() => ({ a: 0, b: 0 }));
    for (const n of topology.nodes) {
      const inc = topology.edges.flatMap((e, i) => (e.to === n.id && Math.abs(byId.get(e.from)!.y - n.y) > 40 ? [{ peer: e.from, i }] : []));
      const out = topology.edges.flatMap((e, i) => (e.from === n.id && Math.abs(byId.get(e.to)!.y - n.y) > 40 ? [{ peer: e.to, i }] : []));
      spread(inc).forEach((v, i) => (at[i].b = v));
      spread(out).forEach((v, i) => (at[i].a = v));
    }
    return at;
  }, [topology, byId]);

  return (
    <div className="relative">
      <div className="overflow-x-auto rounded-xl border border-line bg-surface">
        <svg viewBox="0 0 1200 780" className="block w-full min-w-[960px]" role="img" aria-label="Component topology">
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,1 L9,5 L0,9 z" fill={LINK} />
            </marker>
          </defs>

          {topology.groups.map((g) => (
            <g key={g.id}>
              <rect x={g.x} y={g.y} width={g.w} height={g.h} rx={14} fill="var(--canvas)" stroke="var(--line)" />
              <text x={g.x + 16} y={g.y + 26} className="fill-sub text-[13px] font-medium">{g.label}</text>
            </g>
          ))}

          {topology.edges.map((e, i) => {
            const a = byId.get(e.from)!, b = byId.get(e.to)!;
            const { d } = path(a, b, offsets[i].a, offsets[i].b);
            // A link in trouble (its dependency at risk or breached, the caller affected) takes that stage's colour.
            const trouble = edges[`${e.from}>${e.to}`] ?? null;
            const color = trouble ? TONE[trouble].stroke : LINK;
            const on = touches(e) || edgeSel === i;
            const live = !['off', 'unknown'].includes(status[e.from]?.stage) && !['off', 'unknown'].includes(status[e.to]?.stage);
            const opacity = focus && !on ? 0.08 : 1;
            const showFlow = live && on;
            const label = `${a.label} → ${b.label}: ${VIA[e.via]}${e.port ? ` :${e.port}` : ''}${e.note ? ` (${e.note})` : ''}`;
            return (
              <g key={i} opacity={opacity} className="cursor-pointer outline-none transition-opacity" role="button" tabIndex={0} aria-label={`Link ${label}`}
                onClick={() => { setSelected(null); setEdgeSel(i); }} onKeyDown={(ev) => { if (ev.key === 'Enter') { setSelected(null); setEdgeSel(i); } }}>
                <path d={d} fill="none" stroke="transparent" strokeWidth={14} />
                <path d={d} fill="none" stroke={color} strokeWidth={trouble || edgeSel === i ? 3 : LINE} strokeDasharray={DASH}
                  markerEnd={trouble ? undefined : 'url(#arrow)'} className={showFlow ? 'flow' : undefined}>
                  <title>{`${label}${trouble ? ` · ${TONE[trouble].label}` : ''}`}</title>
                </path>
              </g>
            );
          })}

          {topology.nodes.map((n) => {
            const s = status[n.id] ?? { stage: 'unknown' as const, reasons: [], ready: 0, desired: 0, restarts1h: 0 };
            const tone = TONE[s.stage];
            const isSel = selected === n.id;
            const dim = focus && focus !== n.id && !topology.edges.some((e) => (e.from === focus && e.to === n.id) || (e.to === focus && e.from === n.id));
            return (
              <g key={n.id} transform={`translate(${n.x - W / 2},${n.y - H / 2})`} opacity={dim ? 0.35 : 1}
                className="cursor-pointer outline-none transition-opacity" role="button" tabIndex={0} aria-label={`${n.label}, ${n.role}, ${tone.label}`}
                onFocus={() => setHover(n.id)} onBlur={() => setHover(null)}
                onClick={() => { setEdgeSel(null); setSelected(n.id); }} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { setEdgeSel(null); setSelected(n.id); } }}
                onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)}>
                <rect width={W} height={H} rx={10} fill="var(--surface)" stroke={tone.stroke}
                  strokeWidth={isSel ? 4 : s.stage === 'normal' || s.stage === 'off' ? 1.75 : 2.5} strokeDasharray={s.stage === 'unknown' ? '4 3' : undefined} />
                {s.stage === 'breach' && <rect width={W} height={H} rx={10} fill="var(--sev1)" opacity={0.08} />}
                <circle cx={W - 14} cy={14} r={4.5} fill={tone.dot}>
                  {s.stage === 'breach' && <animate attributeName="opacity" values="1;0.25;1" dur="1.4s" repeatCount="indefinite" />}
                </circle>
                <text x={12} y={22} className={`text-[14px] font-semibold ${s.stage === 'off' ? 'fill-sub' : 'fill-ink'}`}>{n.label}</text>
                <text x={12} y={40} className="fill-sub text-[11.5px]">
                  {n.role}
                  {s.restarts1h > 0 && <tspan className="fill-sev2 font-semibold"> · {s.restarts1h} restarts/h</tspan>}
                </text>
              </g>
            );
          })}
          {focus && topology.edges.map((e, i) => {
            if (!touches(e)) return null;
            const { mid } = path(byId.get(e.from)!, byId.get(e.to)!, offsets[i].a, offsets[i].b);
            const text = `${VIA[e.via]}${e.port ? ` :${e.port}` : ''}`;
            const w = text.length * 6.4 + 16;
            return (
              <g key={`label-${i}`} pointerEvents="none">
                <rect x={mid.x - w / 2} y={mid.y - 10} width={w} height={20} rx={10} fill="var(--ink)" />
                <text x={mid.x} y={mid.y + 4} textAnchor="middle" className="fill-white text-[11px] font-medium">{text}</text>
              </g>
            );
          })}
        </svg>
      </div>

      <Legend />
      {selected && <ComponentDrawer id={selected} stage={status[selected] ?? null} at={at} grafana={grafana} runbooks={rbFor([selected])} onClose={() => setSelected(null)} onSelect={setSelected} />}
      {edgeSel !== null && topology.edges[edgeSel] && (
        <EdgeDrawer edge={topology.edges[edgeSel]} from={byId.get(topology.edges[edgeSel].from)!} to={byId.get(topology.edges[edgeSel].to)!}
          stage={edges[`${topology.edges[edgeSel].from}>${topology.edges[edgeSel].to}`] ?? null} status={status} at={at} grafana={grafana}
          runbooks={rbFor([topology.edges[edgeSel].from, topology.edges[edgeSel].to])}
          onClose={() => setEdgeSel(null)} onSelect={(id) => { setEdgeSel(null); setSelected(id); }} />
      )}
    </div>
  );
}

function Legend() {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-sub">
      <span className="inline-flex items-center gap-2"><svg width="30" height="8" aria-hidden><line x1="0" y1="4" x2="24" y2="4" stroke={LINK} strokeWidth={1.5} strokeDasharray={DASH} /><path d="M23,1 L30,4 L23,7 z" fill={LINK} /></svg>Caller to callee. Point at a component for protocol and port.</span>
      <span>Border color is the component's impact stage; a link in trouble takes its stage's color. Click a link for what breaks.</span>
      <span className="ml-auto inline-flex items-center gap-3">
        {(['breach', 'risk', 'slow', 'normal', 'unknown', 'off'] as Stage[]).map((s) => (
          <span key={s} className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full" style={{ background: TONE[s].dot }} />{TONE[s].label}</span>
        ))}
      </span>
    </div>
  );
}
