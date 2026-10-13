'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { HandoffData } from '@/lib/handoff.ts';
import { fmtDuration } from '@/lib/time.ts';
import { Ts } from './Ts.tsx';

// The shift as one picture (PRD F5). An hour axis; a short numbered lane per incident (state as bar segments,
// turning points as markers), then Alerts, Deploys and CHG lanes. Pick a lane to read it in the panel below.
const SEG: Record<string, string> = {
  candidate: 'bg-sev3/60', declared: 'bg-sev1', mitigated: 'bg-sev2', resolved: 'bg-emerald-600', postmortem: 'bg-emerald-600/70',
  closed: 'bg-emerald-600/45', dismissed: 'bg-sev4/60',
};
const STATE_TEXT: Record<string, string> = {
  candidate: 'text-sev3', declared: 'text-sev1', mitigated: 'text-sev2', resolved: 'text-emerald-700', postmortem: 'text-emerald-700', closed: 'text-emerald-700', dismissed: 'text-sub',
};
// Turning points on an incident's bar. All drawn as the same dot; hovering says which is which.
const MARK_LABEL: Record<string, string> = {
  decision: 'Decision', checkpoint: 'Checkpoint', sev: 'Severity changed', wake: 'Wake alarm paged the IC',
  ack: 'Page answered', reopen: 'Reopened', merge: 'Merged', split: 'Split',
};
const STATE_LABEL: Record<string, string> = { candidate: 'Candidate', declared: 'Declared', mitigated: 'Mitigated', resolved: 'Resolved', postmortem: 'Postmortem', closed: 'Closed', dismissed: 'Dismissed' };
type Tip = { head: string; body?: string };

// Events closer than ~1.5% of the track would overlap: one dot for them, all listed on hover.
function cluster<T>(list: T[], at: (x: T) => number, gap = 1.5): T[][] {
  const out: T[][] = [];
  for (const x of [...list].sort((a, b) => at(a) - at(b))) {
    const last = out.at(-1);
    if (last && at(x) - at(last.at(-1)!) < gap) last.push(x); else out.push([x]);
  }
  return out;
}

// Hover card, shown at once; flips left near the right edge.
function HoverCard({ left, items }: { left: number; items: Tip[] }) {
  return (
    <span className={`pointer-events-none absolute top-full z-30 mt-2 hidden w-72 rounded-lg border border-line bg-surface p-2.5 text-left text-xs font-normal text-ink shadow-lg group-hover:block ${left > 65 ? 'right-0' : left < 15 ? 'left-0' : 'left-1/2 -translate-x-1/2'}`}>
      {items.map((it, i) => (
        <span key={i} className={`block ${i ? 'mt-2 border-t border-line pt-2' : ''}`}>
          <b className="font-semibold">{it.head}</b>
          {it.body && <span className="mt-0.5 block text-sub">{it.body}</span>}
        </span>
      ))}
    </span>
  );
}

function Dot({ left, cls, items, ring = false }: { left: number; cls: string; items: Tip[]; ring?: boolean }) {
  return (
    <span className="group absolute top-1/2 z-[2] -translate-x-1/2 -translate-y-1/2 hover:z-20" style={{ left: `${left}%` }}>
      <span className={`block size-3.5 rounded-full shadow-sm ring-2 ring-surface ${cls} ${ring ? 'outline outline-4 outline-sev1/20' : ''}`} />
      {items.length > 1 && <span className="absolute -top-2.5 -right-2.5 rounded-full bg-ink px-1 text-[9px] leading-[14px] font-semibold text-white">{items.length}</span>}
      <HoverCard left={left} items={items} />
    </span>
  );
}

// The row's text without what its tag already says.
function detail(e: { kind: string; text: string }): string {
  if (e.kind === 'state') return `moved to ${e.text}`;
  if (e.kind === 'sev') { const m = /SEV (\S+) → (\S+)/.exec(e.text); return m ? (m[1] === '—' ? `set to SEV${m[2]}` : `SEV${m[1]} → SEV${m[2]}`) : e.text; }
  return e.text.replace(/^(Decision|Checkpoint): /, '').replace(/^Page acknowledged after /, 'after ');
}
const CHIP: Record<number, string> = { 1: 'bg-sev1 text-white', 2: 'bg-sev2 text-white', 3: 'bg-sev3 text-white', 4: 'bg-sev4 text-white' };
const DONE = new Set(['resolved', 'postmortem', 'closed', 'dismissed']);
const hm = (iso: string) => new Date(iso).toISOString().slice(11, 16);

export function ShiftTimeline({ d, from, to, note }: { d: HandoffData; from: string; to: string; note?: React.ReactNode }) {
  const story = d.story ?? [];
  const [sel, setSel] = useState<string>(story[0] ? `inc:${story[0].id}` : 'alerts');
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => { setNow(Date.now()); const t = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(t); }, []);

  // The past gets the width: shift start → now fills PAST% of the track; the rest is a short stub ending at the handoff.
  const PAST = 84;
  const t0 = Date.parse(from), t1 = Date.parse(to);
  const live = now !== null && now < t1;
  const tEnd = live ? now! : t1;
  const span = Math.max(60_000, tEnd - t0);
  const pos = (iso: string | number) => Math.max(0, Math.min(PAST, (((typeof iso === 'number' ? iso : Date.parse(iso)) - t0) / span) * PAST));
  const step = span > 5 * 3600_000 ? 2 * 3600_000 : 3600_000;
  const hours = Array.from({ length: Math.floor(span / step) + 1 }, (_, k) => t0 + k * step);
  const nowPct = PAST;
  const toHandoff = t1 - (now ?? t1);

  const Track = ({ children }: { children: React.ReactNode }) => (
    <div className="relative h-9">
      <span aria-hidden className="absolute left-0 top-1/2 h-px bg-line" style={{ width: `${PAST}%` }} />
      <span aria-hidden className="absolute right-0 top-1/2 border-t border-dashed border-sub/40" style={{ left: `${PAST}%` }} />
      {hours.slice(1).map((t) => <span key={t} aria-hidden className="absolute inset-y-1 w-px bg-line/60" style={{ left: `${pos(t)}%` }} />)}
      {live && <span aria-hidden className="absolute inset-y-0 z-[3] w-0.5 rounded bg-ink" style={{ left: `${nowPct}%` }} />}
      <span aria-hidden className="absolute inset-y-1 right-0 w-0.5 rounded bg-sev2/60" />
      {children}
    </div>
  );
  const Lane = ({ id, label, title, children }: { id: string; label: React.ReactNode; title: string; children: React.ReactNode }) => {
    const on = sel === id;
    return (
      <button type="button" onClick={() => setSel(id)} aria-pressed={on} aria-label={title}
        className={`grid w-full grid-cols-[13rem_1fr] items-center gap-4 px-5 text-left transition-colors ${on ? 'bg-canvas shadow-[inset_3px_0_0_var(--ink)]' : 'hover:bg-canvas/60'}`}>
        <span className="flex items-center gap-2">{label}</span>
        <Track>{children}</Track>
      </button>
    );
  };
  const markDots = (marks: { at: string; kind: string; text: string }[]) => cluster(marks, (m) => pos(m.at)).map((g, k) => (
    <Dot key={k} left={pos(g[0].at)} cls="border-2 border-ink bg-surface"
      items={g.map((m) => ({ head: `${MARK_LABEL[m.kind] ?? m.kind} · ${hm(m.at)} UTC`, body: detail(m) }))} />
  ));

  const picked = story.find((x) => `inc:${x.id}` === sel);
  const alertsFired = d.alerts.reduce((n, a) => n + a.count, 0);
  const failed = d.flux.filter((f) => f.severity === 'error').length;

  return (
    <section className="mt-6 overflow-hidden rounded-xl border border-line bg-surface">
      <header className="flex items-center gap-2 border-b border-line bg-canvas px-5 py-2.5">
        <h3 className="text-base font-semibold">The shift at a glance</h3>
      </header>

      {/* hour axis */}
      <div className="grid grid-cols-[13rem_1fr] gap-4 px-5 pt-3 pb-1">
        <span />
        <div className="relative h-5 text-[11px] tabular-nums text-sub">
          {hours.map((t, k) => (
            pos(t) > PAST - 7 && live ? null : <span key={t} className={`absolute ${k === 0 ? '' : '-translate-x-1/2'}`} style={{ left: `${pos(t)}%` }}>{hm(new Date(t).toISOString())}</span>
          ))}
          {/* arrows on the axis instead of labels: they never collide; hover gives the time */}
          {live && <span title={`Now ${hm(new Date(now!).toISOString())} UTC`} aria-label={`now ${hm(new Date(now!).toISOString())}`}
            className="absolute bottom-0 z-[3] -translate-x-1/2 border-x-[6px] border-t-[8px] border-x-transparent border-t-ink" style={{ left: `${nowPct}%` }} />}
          <span title={`Handoff ${hm(to)} UTC${live ? `, in ${fmtDuration(toHandoff)}` : ''}`} aria-label={`handoff ${hm(to)}`}
            className="absolute bottom-0 right-0 z-[3] translate-x-1/2 border-x-[6px] border-t-[8px] border-x-transparent border-t-sev2" />
        </div>
      </div>

      <div className="divide-y divide-line/70 border-t border-line">
        {story.map((x) => (
          <Lane key={x.id} id={`inc:${x.id}`} title={x.title}
            label={<>
              <span className={`inline-flex h-6 min-w-9 shrink-0 items-center justify-center rounded-md px-1.5 text-xs font-bold tabular-nums ${x.sev ? CHIP[x.sev] : 'border border-dashed border-sub/60 text-sub'}`}>#{x.id}</span>
              <span className="min-w-0 truncate text-sm font-semibold">{x.cause ?? 'unknown'}</span>
              <span className={`ml-auto shrink-0 text-xs font-medium ${STATE_TEXT[x.state] ?? 'text-sub'}`}>{x.state}</span>
            </>}>
            {(x.segments ?? []).map((g, k, all) => (
              <span key={k} className={`group absolute top-1/2 h-3.5 -translate-y-1/2 hover:z-20 ${SEG[g.state] ?? 'bg-line'} ${k === 0 ? 'rounded-l-full' : ''} ${k === all.length - 1 ? 'rounded-r-full' : ''}`}
                style={{ left: `${pos(g.from)}%`, width: `${Math.max(0.8, pos(g.to) - pos(g.from))}%` }}>
                <HoverCard left={pos(g.from)} items={[{ head: `${STATE_LABEL[g.state] ?? g.state} · ${hm(g.from)}–${hm(g.to)} UTC` }]} />
              </span>
            ))}
            {markDots(x.marks ?? [])}
          </Lane>
        ))}
        <Lane id="alerts" title="Alerts this shift" label={<span className="text-xs font-semibold text-sub">Alerts</span>}>
          {cluster(d.alerts.filter((a) => a.first_at), (a) => pos(a.first_at!)).map((g, k) => (
            <Dot key={k} left={pos(g[0].first_at!)} ring={g.some((a) => a.firing)} cls={g.some((a) => a.severity === 'critical') ? 'bg-sev1' : 'bg-sev2'}
              items={g.map((a) => ({ head: `${a.alertname} · ${hm(a.first_at!)} UTC`, body: `${a.severity}, fired ${a.count}×${a.firing ? ', still firing' : ''}` }))} />
          ))}
        </Lane>
        <Lane id="deploys" title="Flux deploys this shift" label={<span className="text-xs font-semibold text-sub">Deploys</span>}>
          {cluster(d.flux, (f) => pos(f.at)).map((g, k) => (
            <Dot key={k} left={pos(g[0].at)} cls={g.some((f) => f.severity === 'error') ? 'bg-sev1' : 'bg-sub'}
              items={g.map((f) => ({ head: `${f.severity === 'error' ? 'Deploy failed' : 'Deployed'} · ${hm(f.at)} UTC`, body: `${f.object}${f.severity === 'error' ? `: ${f.message}` : ''}` }))} />
          ))}
        </Lane>
        <Lane id="chgs" title="Changes in progress" label={<span className="text-xs font-semibold text-sub">CHG</span>}>
          {d.chgs.map((c, k) => (
            <span key={c.id}
              className={`group absolute h-1.5 rounded-full hover:z-20 ${c.risk === 'high' ? 'bg-sev1/75' : c.risk === 'medium' ? 'bg-sev2/65' : 'bg-sev4/60'}`}
              style={{ left: `${c.start ? pos(c.start) : 0}%`, width: `${Math.max(0.8, PAST - (c.start ? pos(c.start) : 0))}%`, top: `${8 + k * (20 / Math.max(1, d.chgs.length))}px` }}>
              <HoverCard left={c.start ? pos(c.start) : 0} items={[{ head: `${c.id} · ${c.risk} risk`, body: c.title }]} />
            </span>
          ))}
        </Lane>
      </div>

      {/* the picked lane, in words */}
      <div className="border-t border-line bg-canvas/40 px-5 py-4">
        {picked ? (
          <>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className={`inline-flex h-6 items-center rounded-md px-1.5 text-xs font-bold ${picked.sev ? CHIP[picked.sev] : 'border border-dashed border-sub/60 text-sub'}`}>#{picked.id}{picked.sev ? ` SEV${picked.sev}` : ''}</span>
              <Link href={`/incidents/${picked.id}`} className="text-lg font-semibold hover:underline">{picked.title}</Link>
              <span className={`ml-auto text-sm font-semibold ${DONE.has(picked.state) ? 'text-emerald-700' : 'text-sev2'}`}>
                {DONE.has(picked.state) ? (picked.state === 'postmortem' ? 'resolved, in postmortem' : picked.state) : `still ${picked.state}`}
                <span className="ml-2 font-normal text-sub">{DONE.has(picked.state) ? 'took' : 'open'} {fmtDuration((picked.resolved_at ? Date.parse(picked.resolved_at) : now ?? Date.parse(to)) - Date.parse(picked.detected_at))}</span>
              </span>
            </div>
            <IncidentStory x={picked} />
            <Link href={`/incidents/${picked.id}?tab=updates`} className="mt-3 inline-block text-sm text-sub underline underline-offset-2">All {picked.updates} updates this shift</Link>
          </>
        ) : sel === 'alerts' ? (
          <LaneCards title="Alerts" count={`${alertsFired} fired`} empty="No alert fired this shift.">
            {[...d.alerts].sort((x, y) => Number(y.firing > 0) - Number(x.firing > 0) || Number(y.severity === 'critical') - Number(x.severity === 'critical') || Number(y.flapping) - Number(x.flapping)).map((a) => {
              const inc = story.find((x) => x.id === a.incident_id);
              return (
                <Card key={a.alertname + a.severity} edge={a.severity === 'critical' ? 'border-l-sev1' : 'border-l-sev2'}
                  head={<><span className="min-w-0 break-words font-semibold">{a.alertname}</span><span className={`ml-auto shrink-0 text-xs font-medium ${a.severity === 'critical' ? 'text-sev1' : 'text-sev2'}`}>{a.severity}</span></>}>
                  <Fields items={[
                    ['First fired', a.first_at ? hm(a.first_at) : '—'],
                    ['Fired', `${a.count}×${a.flapping ? ' · flapping' : ''}`, a.flapping ? 'text-sev2' : ''],
                    ['Now', a.firing ? 'still firing' : 'cleared', a.firing ? 'text-sev1' : 'text-emerald-700'],
                  ]} />
                  <Link href={`/incidents/${a.incident_id}?tab=alerts`} className="mt-auto block pt-3 text-sm text-sub hover:text-ink">
                    in <b className="font-semibold text-ink">#{a.incident_id}</b>{inc ? ` ${inc.cause ?? ''} · ${inc.state}` : ''}
                  </Link>
                </Card>
              );
            })}
          </LaneCards>
        ) : sel === 'deploys' ? (
          <LaneCards title="Deploys" count={`${d.flux.length}${failed ? `, ${failed} failed` : ''}`} empty="Nothing was deployed this shift.">
            {[...d.flux].sort((x, y) => Number(y.severity === 'error') - Number(x.severity === 'error') || y.at.localeCompare(x.at)).map((f, k) => (
              <Card key={k} edge={f.severity === 'error' ? 'border-l-sev1' : 'border-l-sev3'}
                head={<><span className={`font-semibold ${f.severity === 'error' ? 'text-sev1' : 'text-sev3'}`}>{f.severity === 'error' ? 'Failed' : 'Deployed'}</span><span className="ml-auto text-xs tabular-nums text-sub">{hm(f.at)}</span></>}>
                <p className="font-semibold">{f.object.replace(/^Kustomization /, '')}</p>
                <div title={f.message} className="mt-2 rounded-md bg-canvas px-3 py-2"><p className="line-clamp-3 break-all font-mono text-xs leading-relaxed text-ink/80">{f.message}</p></div>
              </Card>
            ))}
          </LaneCards>
        ) : (
          <LaneCards title="Changes in progress" count={String(d.chgs.length)} empty="No change is being implemented.">
            {[...d.chgs].sort((x, y) => RISK_RANK[y.risk] - RISK_RANK[x.risk] || (x.start ?? '').localeCompare(y.start ?? '') /* same risk: oldest first */).map((c) => (
              <Card key={c.id} edge={c.risk === 'high' ? 'border-l-sev1' : c.risk === 'medium' ? 'border-l-sev2' : 'border-l-sev4'}
                head={<><a href={c.href} target="_blank" rel="noreferrer" className="font-semibold hover:underline">{c.id}</a>
                  <span className={`ml-auto rounded px-1.5 text-[11px] font-medium ${c.risk === 'high' ? 'bg-sev1 text-white' : c.risk === 'medium' ? 'bg-sev2 text-white' : 'bg-line text-sub'}`}>{c.risk} risk</span></>}>
                <p title={c.title} className="line-clamp-2 text-[15px] font-medium leading-snug">{c.title}</p>
                <Fields items={[['Since', c.start ? <Ts at={c.start} /> : '—']]} />
                {c.components?.length ? (
                  <ul className="mt-2 flex flex-wrap gap-1" title={c.components.join(', ')}>
                    {c.components.slice(0, MAX_CHIPS).map((x) => <li key={x} className="rounded bg-canvas px-1.5 text-xs">{x}</li>)}
                    {c.components.length > MAX_CHIPS && <li className="rounded px-1.5 text-xs text-sub">+{c.components.length - MAX_CHIPS} more</li>}
                  </ul>
                ) : <p className="mt-2 text-xs text-sub">no topology component</p>}
              </Card>
            ))}
          </LaneCards>
        )}
      </div>
      {note && <div className="border-t border-line px-5 py-3">{note}</div>}
    </section>
  );
}

const RISK_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };
const MAX_CHIPS = 5;

const LIFE = ['candidate', 'declared', 'mitigated', 'resolved', 'closed'] as const;

// One incident's shift, grouped by meaning: where it went (stepper), what was decided and why, the latest
// checkpoint, and the minor events on one line.
function IncidentStory({ x }: { x: NonNullable<HandoffData['story']>[number] }) {
  const marks = x.marks ?? [];
  const decisions = marks.filter((m) => m.kind === 'decision');
  const cp = [...marks].reverse().find((m) => m.kind === 'checkpoint');
  const minor = marks.filter((m) => m.kind !== 'decision' && m.kind !== 'checkpoint');
  // When each lifecycle step was reached in this shift (postmortem counts as resolved).
  const norm = (st: string) => (st === 'postmortem' ? 'resolved' : st);
  const reached = new Map<string, string | null>();
  const start = x.path[0] === 'new' ? x.path[1] : x.path[0];
  if (start) reached.set(norm(start), null); // already there when the shift (or the incident) began
  for (const c of x.changes ?? []) reached.set(norm(c.state), c.at);
  const cur = LIFE.indexOf(norm(x.state) as (typeof LIFE)[number]);
  return (
    <div className="mt-4 space-y-5">
      {x.state === 'dismissed' ? <p className="text-sm text-sub">Dismissed.</p> : (
        <ol className="flex items-start" aria-label="Lifecycle this shift">
          {LIFE.map((st, k) => {
            const done = k <= cur;
            const at = reached.get(st);
            return (
              <li key={st} className="flex flex-1 items-start last:flex-none">
                <div className="flex flex-col items-center">
                  <span className={`size-3.5 rounded-full ${k === cur ? 'bg-ink ring-4 ring-ink/15' : done ? 'bg-ink' : 'border-2 border-line bg-surface'}`} />
                  <span className={`mt-1.5 text-sm ${k === cur ? 'font-semibold' : done ? '' : 'text-sub'}`}>{st === 'resolved' && x.state === 'postmortem' ? 'resolved · postmortem' : st}</span>
                  <span className="text-xs tabular-nums text-sub">{at ? hm(at) : done && reached.has(st) ? 'before' : ' '}</span>
                </div>
                {k < LIFE.length - 1 && <span aria-hidden className={`mx-2 mt-1.5 h-0.5 flex-1 rounded ${k < cur ? 'bg-ink' : 'bg-line'}`} />}
              </li>
            );
          })}
        </ol>
      )}

      {decisions.length > 0 && (
        <div>
          <h4 className="mb-2 text-sm font-semibold">Decisions <span className="font-normal text-sub">{decisions.length}</span></h4>
          <ul className="space-y-2">
            {decisions.map((m, k) => (
              <li key={k} className="rounded-lg border border-line bg-surface px-4 py-3">
                <div className="flex items-baseline gap-3">
                  <p className="min-w-0 flex-1 text-[15px] font-semibold leading-snug">{m.what ?? m.text}</p>
                  <span className="shrink-0 text-xs tabular-nums text-sub">{hm(m.at)}</span>
                </div>
                {m.why && <p className="mt-1 text-sm text-sub">Why: {m.why}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {cp && (
        <div>
          <h4 className="mb-2 flex items-baseline text-sm font-semibold">Latest checkpoint <span className="ml-auto text-xs font-normal tabular-nums text-sub">{hm(cp.at)}</span></h4>
          <blockquote className="rounded-r-lg border-l-4 border-ink bg-surface px-4 py-3">
            <p className="text-[15px] font-medium leading-snug">{cp.what ?? cp.text}</p>
            {cp.why && <p className="mt-1 text-sm text-sub">Next: {cp.why}</p>}
          </blockquote>
        </div>
      )}

      {minor.length > 0 && (
        <p className="text-sm text-sub">
          Also: {minor.map((m, k) => <span key={k}>{k > 0 && ' · '}{MARK_LABEL[m.kind] ?? m.kind}: {detail(m)} <span className="tabular-nums">({hm(m.at)})</span></span>)}
        </p>
      )}
    </div>
  );
}

// Lane details as a grid of cards (alerts, deploys, CHGs), each with the same anatomy: header row, fields, footer.
function LaneCards({ title, count, empty, children }: { title: string; count: string; empty: string; children: React.ReactNode }) {
  const list = Array.isArray(children) ? children : [children];
  return (
    <div>
      <h4 className="text-lg font-semibold">{title} <span className="text-sm font-normal text-sub">{count}</span></h4>
      {!list.length ? <p className="mt-2 text-sm text-sub">{empty}</p> : <div className="mt-3 grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(20rem,1fr))]">{children}</div>}
    </div>
  );
}

function Card({ edge, head, children }: { edge: string; head: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className={`flex flex-col rounded-lg border border-line border-l-4 bg-surface px-4 py-3 ${edge}`}>
      <div className="flex items-baseline gap-2">{head}</div>
      <div className="mt-2 flex flex-1 flex-col">{children}</div>
    </div>
  );
}

function Fields({ items }: { items: [string, React.ReactNode, string?][] }) {
  return (
    <dl className={`grid gap-2 ${items.length > 1 ? 'grid-cols-3' : 'grid-cols-1'}`}>
      {items.map(([k, v, cls]) => (
        <div key={k} className="rounded-md bg-canvas px-2.5 py-1.5">
          <dt className="text-[11px] text-sub">{k}</dt>
          <dd className={`text-sm font-semibold ${cls ?? ''}`}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

