import Link from 'next/link';
import { connection } from 'next/server';
import { Suspense } from 'react';
import { Ts } from '@/components/Ts.tsx';
import { Until } from '@/components/Elapsed.tsx';
import { SevBadge } from '@/components/badges.tsx';
import type { Sev } from '@/lib/lifecycle.ts';
import { button, field } from '@/components/ui.tsx';
import { pool } from '@/lib/db.ts';
import { ACK_WITHIN_MS, DRAFT_BEFORE_MS, collect, handoff, handoffs, readItems, type Handoff, type HandoffData } from '@/lib/handoff.ts';
import { AckButton, GotIt, ReadThrough } from '@/components/ReadThrough.tsx';
import { ShiftTimeline } from '@/components/ShiftTimeline.tsx';
import { Panel as BasePanel } from '@/components/Panel.tsx';
import { runbooks } from '@/lib/runbooks.ts';
import { shifts } from '@/lib/shifts.ts';
import { fmtDuration, shiftWindow } from '@/lib/time.ts';
import { ackAction, incidentNoteAction, noteAction, prepareAction, readyAction } from './actions.ts';

export default function HandoffPage({ searchParams }: PageProps<'/handoff'>) {
  return (
    <div className="min-h-full bg-surface">
      <div className="px-8 py-7">
        <h1 className="text-2xl font-semibold tracking-tight">Shift handoff</h1>
        <Suspense fallback={<p className="mt-6 text-sm text-sub">Loading…</p>}>
          <Body searchParams={searchParams} />
        </Suspense>
      </div>
    </div>
  );
}

const STATUS: Record<Handoff['status'], { label: string; cls: string }> = {
  draft: { label: 'Draft', cls: 'bg-sev3/20 text-ink' }, ready: { label: 'Handed over', cls: 'bg-sev2 text-white' }, acked: { label: 'Acknowledged', cls: 'bg-emerald-600 text-white' },
};
const name = (id: string) => shifts().find((s) => s.id === id)?.name ?? id;
const hm = (d: Date) => new Date(d).toISOString().slice(11, 16);

async function Body({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  const sp = await searchParams;
  const now = new Date();
  const w = shiftWindow(now, shifts());
  const list = await handoffs(pool());
  const picked = typeof sp.id === 'string' ? await handoff(pool(), sp.id) : null;
  const current = list.find((h) => h.shift_id === w.shift.id && new Date(h.shift_start).getTime() === w.start.getTime());
  const h = picked ?? current ?? list.find((x) => x.status !== 'acked') ?? null;
  const draftAt = new Date(w.end.getTime() - DRAFT_BEFORE_MS);

  return (
    <div className="mt-6">
      {/* Write (or open) this shift's handoff, unless it is the one shown below. */}
      {(!current || current.id !== h?.id) && (
        <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-canvas px-5 py-3 text-sm">
          <span><b className="font-semibold">{w.shift.name} shift</b> ends at {hm(w.end)} UTC (<Until at={w.end} />).{!current && <> A draft opens on its own at {hm(draftAt)} UTC.</>}</span>
          {current
            ? <Link href={`/handoff?id=${current.id}`} className={`${button.primary} ml-auto`}>Open this shift's handoff</Link>
            : <form action={prepareAction} className="ml-auto"><button className={button.primary}>Write handoff</button></form>}
        </div>
      )}
      {h ? <HandoffView h={h} /> : <p className="text-sm text-sub">No handoff yet.</p>}
    </div>
  );
}

async function HandoffView({ h }: { h: Handoff }) {
  const live = !h.data;
  const d: HandoffData = h.data ?? await collect(pool(), new Date(h.shift_start), new Date(h.shift_end));
  const ackBy = new Date(new Date(h.shift_end).getTime() + ACK_WITHIN_MS);
  const ended = Date.now() >= new Date(h.shift_end).getTime();

  // Group what needs attention by incident: its firing alerts and the stage changes of its components.
  // Handoffs frozen before components/firing were collected fall back to the alerts' incident ids.
  const firingOf = (i: HandoffData['incidents'][number]) => i.firing ?? d.alerts.filter((a) => a.incident_id === i.id && a.firing > 0).map((a) => a.alertname);
  const claimedAlerts = new Set(d.incidents.flatMap(firingOf));
  const claimedComps = new Set(d.incidents.flatMap((i) => i.components ?? []));
  const strayAlerts = d.alerts.filter((a) => a.firing > 0 && !claimedAlerts.has(a.alertname));
  const strayWorse = d.worse.filter((x) => !claimedComps.has(x.component));
  const firing = d.alerts.reduce((s, a) => s + a.firing, 0);
  const worst = d.slo.reduce((m, x) => (x.from !== null && x.to !== null ? Math.min(m, x.to - x.from) : m), 0);
  const failed = d.flux.filter((f) => f.severity === 'error').length;
  // Which runbook covers an alert (the firing alerts link to it).
  const runbookFor = new Map((await runbooks().catch(() => [])).flatMap((r) => r.alerts.map((a) => [a, r.id] as const)));
  // Frozen handoffs: which incidents changed after they were handed over.
  const frozenAt = h.data ? h.ready_at ?? h.acked_at : null;
  const changed = new Set(frozenAt && d.incidents.length ? (await pool().query<{ id: string }>(
    'SELECT DISTINCT incident_id::text AS id FROM timeline WHERE incident_id = ANY($1::bigint[]) AND at > $2', [d.incidents.map((i) => i.id), frozenAt])).rows.map((r) => r.id) : []);


  return (
    <ReadThrough required={readItems(d, h.note)} done={h.status === 'acked' ? (h.reads ?? []) : null} off={h.status === 'draft'}>
    <article>
      <header className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-semibold">{name(h.shift_id)} → {name(h.to_shift_id)} <span className="font-normal text-sub">· {hm(h.shift_start)}–{hm(h.shift_end)} UTC{!ended && <> · ends <Until at={h.shift_end} /></>}</span></h2>
        </div>
        <div className="flex gap-2">
          {/* One button, by stage: the outgoing person hands over, then the incoming person acknowledges. */}
          {h.status === 'draft' && <form action={readyAction.bind(null, h.id)}><button className={button.primary} title="Freeze the contents and pass it to the next shift">Hand over</button></form>}
          {h.status === 'ready' && <AckButton action={ackAction.bind(null, h.id)} className={button.primary} />}
        </div>
      </header>

      <Stepper h={h} ended={ended} ackBy={ackBy} />

      {/* The shift in six numbers; a tile turns red only when it needs action. */}
      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat value={d.incidents.length} label="open incidents" sub={`${d.incidents.filter((i) => i.state !== 'candidate').length} declared`} hot={d.incidents.some((i) => i.state !== 'candidate')} />
        <Stat value={firing} label="alerts firing" sub={`${d.alerts.reduce((n, a) => n + a.count, 0)} fired this shift`} hot={firing > 0} />
        <Stat value={d.worse.length} label="got worse" sub={d.worse.map((x) => x.component).join(', ') || 'all steady'} hot={d.worse.some((x) => x.to === 'breach' || x.to === 'risk')} />
        <Stat value={`${(worst * 100).toFixed(1)}%`} label="worst budget move" sub={d.slo.find((x) => x.from !== null && x.to !== null && x.to - x.from === worst && worst < 0)?.name ?? 'no budget spent'} hot={worst < -0.05} />
        <Stat value={d.chgs.length} label="CHGs in progress" sub={d.chgs.some((c) => c.risk === 'high') ? 'one is high risk' : 'none high risk'} hot={false} />
        <Stat value={failed} label="failed deploys" sub={`${d.flux.length} Flux event${d.flux.length === 1 ? '' : 's'}`} hot={failed > 0} />
      </div>

      <ShiftTimeline d={d} from={new Date(h.shift_start).toISOString()} to={new Date(h.shift_end).toISOString()}
        note={<div className="flex items-start gap-3">
          <div className="min-w-0 flex-1"><Note label={`Note on the shift from ${h.from_people.join(', ')}`} value={h.note} editable={h.status !== 'acked'} action={noteAction.bind(null, h.id)}
            placeholder="The shift as a whole: what to watch, what is planned" /></div>
          {h.note.trim() && <GotIt id="note" />}
        </div>} />

      <Panel title="Needs you" count={d.incidents.length + (strayAlerts.length || strayWorse.length ? 1 : 0)}>
        {!d.incidents.length && !strayAlerts.length && !strayWorse.length ? <div className="px-5 py-4"><Empty>Nothing open, nothing firing, nothing got worse.</Empty></div> : (
          <ul className="space-y-3 p-4">
            {[...d.incidents].sort((x, y) => Number(x.state === 'candidate') - Number(y.state === 'candidate')).map((i) => (
              <IncidentCard key={i.id} i={i} firing={firingOf(i)} worse={d.worse.filter((x) => (i.components ?? []).includes(x.component))} changed={changed.has(i.id)}
                runbookFor={runbookFor} note={<Note label="Note for the next shift" value={h.notes?.[i.id] ?? ''} editable={h.status !== 'acked'} action={incidentNoteAction.bind(null, h.id, i.id)}
                  placeholder="Anything about this incident the next person should know" />} />
            ))}
            {(strayAlerts.length > 0 || strayWorse.length > 0) && (
              <li className="rounded-xl border border-dashed border-line px-5 py-4">
                <p className="flex items-center text-lg font-semibold">Not in an incident yet<GotIt id="stray" /></p>
                {strayAlerts.length > 0 && <div className="mt-2"><FiringAlerts names={strayAlerts.map((a) => a.alertname)} runbookFor={runbookFor} fallback={(n) => `/incidents/${strayAlerts.find((a) => a.alertname === n)?.incident_id}?tab=alerts`} /></div>}
                {strayWorse.length > 0 && <div className="mt-3"><WorseTable list={strayWorse} /></div>}
              </li>
            )}
          </ul>
        )}
      </Panel>

      <SloSec slo={d.slo} />
    </article>
    </ReadThrough>
  );
}

const ago = (iso: string) => fmtDuration(Date.now() - new Date(iso).getTime());

// One open incident as the incoming person needs it, in zones: facts at a glance, where it stands, your next move,
// and supporting detail. Everything is neutral; only a fact that needs action turns red.
function IncidentCard({ i, firing, worse, changed, runbookFor, note }: { i: HandoffData['incidents'][number]; firing: string[]; worse: HandoffData['worse']; changed: boolean; runbookFor: Map<string, string>; note: React.ReactNode }) {
  const candidate = i.state === 'candidate';
  const overdue = !!i.next_update_at && new Date(i.next_update_at).getTime() < Date.now();
  const facts: { label: string; value: React.ReactNode; hot?: boolean }[] = candidate ? [
    { label: 'Waiting', value: i.detected_at ? ago(i.detected_at) : '—' },
    { label: 'Suggested', value: i.sev_suggested ? `SEV${i.sev_suggested}` : '—' },
    { label: 'Cause', value: i.cause ?? '—' },
    { label: 'Firing', value: firing.length ? `${firing.length} alert${firing.length === 1 ? '' : 's'}` : 'none', hot: firing.length > 0 },
  ] : [
    { label: 'Next update', value: !i.next_update_at ? 'not scheduled' : overdue ? `overdue ${ago(i.next_update_at)}` : <Until at={i.next_update_at} />, hot: overdue || !i.next_update_at },
    { label: 'Open for', value: i.detected_at ? ago(i.detected_at) : '—' },
    { label: 'IC', value: i.ic ?? 'nobody', hot: !i.ic },
    { label: 'Checklist', value: i.open_items ? `${i.open_items} open` : 'done', hot: false },
  ];
  const sentence = (x: string) => (/[.!?]$/.test(x.trim()) ? x.trim() : `${x.trim()}.`);
  const now = [i.checkpoint, i.action && `${i.action}${i.action_eta ? `, done by ${hm(new Date(i.action_eta))} UTC` : ''}`].filter(Boolean).map((x) => sentence(x as string));
  const detail = [
    i.unacked && <b key="u" className="font-medium text-sev1">Page not acknowledged</b>,
  ].filter(Boolean);
  return (
    <li className={`rounded-xl border bg-surface ${candidate ? 'border-dashed border-sub/40' : 'border-line'}`}>
      <div className="flex items-start gap-3 px-5 pt-4">
        <div className="min-w-0 flex-1">
          <Link href={`/incidents/${i.id}`} className="group flex items-start gap-2.5">
            <span className="mt-1"><SevBadge sev={(candidate ? null : i.sev) as Sev | null} suggested={(i.sev_suggested ?? null) as Sev | null} /></span>
            <span className="text-lg font-semibold leading-snug group-hover:underline">{i.title}</span>
          </Link>
          <p className="mt-1 text-sm text-sub">
            #{i.id} {i.state}{i.cause && !candidate ? ` · cause ${i.cause}` : ''}
            {changed && <Link href={`/incidents/${i.id}?tab=updates`} className="font-medium text-sev2 underline underline-offset-2"> · changed since hand-over</Link>}
          </p>
        </div>
        <GotIt id={`inc:${i.id}`} />
      </div>

      {/* ① facts at a glance */}
      <div className="mt-3 grid grid-cols-2 gap-2 px-5 sm:grid-cols-4">
        {facts.map((f) => (
          <div key={f.label} className={`rounded-lg border px-3 py-2 ${f.hot ? 'border-sev1/60 bg-sev1/5' : 'border-line'}`}>
            <div className="text-xs text-sub">{f.label}</div>
            <div className={`mt-0.5 text-[15px] font-semibold ${f.hot ? 'text-sev1' : ''}`}>{f.value}</div>
          </div>
        ))}
      </div>

      {/* ② where it stands */}
      {now.length > 0 && (
        <div className="mt-4 px-5">
          <div className="text-xs font-medium text-sub">Where it stands</div>
          <p className="mt-1 text-[15px] leading-relaxed">{now.join(' ')}</p>
        </div>
      )}
      {firing.length > 0 && <div className="mt-4 px-5"><FiringAlerts names={firing} runbookFor={runbookFor} fallback={() => `/incidents/${i.id}?tab=alerts`} /></div>}
      {candidate && worse.length > 0 && <div className="mt-4 px-5"><WorseTable list={worse} /></div>}

      {/* ③ your move */}
      <div className="mx-5 mt-4 mb-4">
        {candidate ? (
          <Callout href={`/incidents/${i.id}`} action="Open to declare">Declare this incident or dismiss it.</Callout>
        ) : i.next_step ? (
          <Callout href={`/incidents/${i.id}`} action="Open incident" source="from the last checkpoint">{i.next_step}</Callout>
        ) : (
          <Callout href={`/incidents/${i.id}`} action="Write a checkpoint">No checkpoint yet: write one so the next person knows what to do.</Callout>
        )}
      </div>

      <div className="mx-5 mb-4">{note}</div>

      {/* ④ supporting detail */}
      {(!candidate && worse.length > 0) || detail.length ? (
        <div className="space-y-1 border-t border-line bg-canvas/60 px-5 py-2.5 text-sm">
          {!candidate && worse.length > 0 && <WorseTable list={worse} />}
          {detail.map((x, k) => <div key={k}>{x}</div>)}
        </div>
      ) : null}
    </li>
  );
}

const DONE = new Set(['resolved', 'postmortem', 'closed', 'dismissed']);
// Every card ends the same way: what the incoming person does next, with the button that does it.
function Callout({ href, action, source, children }: { href: string; action: string; source?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg bg-ink px-4 py-3 text-white">
      <div className="min-w-0 flex-1">
        <div className="text-xs font-semibold text-accent">Your next step{source && <span className="ml-2 font-normal text-white/50">{source}</span>}</div>
        <p className="mt-0.5 text-base font-semibold leading-snug">{children}</p>
      </div>
      <Link href={href} className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-ink hover:bg-accent/85">{action} →</Link>
    </div>
  );
}

// Firing alerts in their own block; each is a button to its runbook (or the incident's Alerts tab without one).
function FiringAlerts({ names, runbookFor, fallback }: { names: string[]; runbookFor: Map<string, string>; fallback: (name: string) => string }) {
  return (
    <section className="rounded-lg border border-sev1/25 bg-sev1/[0.04] px-3 py-2.5">
      <h4 className="flex items-center gap-2 text-xs font-semibold text-sev1"><span aria-hidden className="size-1.5 rounded-full bg-sev1" />Firing alerts {names.length}</h4>
      <ul className="mt-2 flex flex-wrap gap-1.5">
        {names.map((n) => {
          const rb = runbookFor.get(n);
          return (
            <li key={n}>
              <Link href={rb ? `/runbooks/${rb}` : fallback(n)} title={rb ? `Open the runbook ${rb}` : 'No runbook: open the alert'}
                className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 py-1 text-xs font-medium hover:border-ink/40">
                {n}<span aria-hidden className="text-sub">→</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// A note on one part of the handoff, editable until the next shift acknowledges it.
function Note({ label, value, editable, action, placeholder }: { label: string; value: string; editable: boolean; action: (f: FormData) => Promise<void>; placeholder: string }) {
  if (!editable) return value.trim() ? <div><div className="text-xs font-medium text-sub">{label}</div><p className="mt-0.5 whitespace-pre-wrap text-sm">{value}</p></div> : null;
  return (
    <form action={action}>
      <label className="text-xs font-medium text-sub">{label}
        <textarea name="note" rows={2} defaultValue={value} maxLength={2000} placeholder={placeholder} className={`${field} mt-1 h-auto py-1.5 text-sm`} />
      </label>
      <div className="mt-1 flex justify-end"><button className={`${button.quiet} h-7 text-xs`}>Save note</button></div>
    </form>
  );
}



function Stat({ value, label, hot }: { value: React.ReactNode; label: string; sub?: string; hot: boolean }) {
  return (
    <div className={`rounded-xl border px-4 py-3 ${hot ? 'border-sev1/50 bg-sev1/5' : 'border-line bg-surface'}`}>
      <div className={`text-3xl font-semibold leading-none tracking-tight tabular-nums ${hot ? 'text-sev1' : ''}`}>{value}</div>
      <div className="mt-1.5 text-sm font-medium">{label}</div>
    </div>
  );
}

// Where the handoff is: written → handed over → acknowledged, with who/when under each done step and the
// acknowledgement deadline under the last one.
function Stepper({ h, ended, ackBy }: { h: Handoff; ended: boolean; ackBy: Date }) {
  const at = { draft: 0, ready: 1, acked: 2 }[h.status];
  const steps = [
    { label: 'Written', sub: h.from_people.join(', ') },
    { label: 'Handed over', sub: h.ready_at ? <>{h.ready_by} · <Ts at={h.ready_at} /></> : 'by the outgoing shift' },
    { label: 'Acknowledged', sub: h.acked_at ? <>{h.acked_by} · <Ts at={h.acked_at} /></> : h.paged_at ? <b className="text-sev1">paged at {hm(h.paged_at)} UTC</b> : <>by {hm(ackBy)} UTC{ended && <> · <Until at={ackBy} /></>}</> },
  ];
  return (
    <ol className="mt-5 grid grid-cols-[auto_1fr_auto_1fr_auto] items-center gap-x-4" aria-label="Handoff progress">
      {steps.map((st, k) => {
        const done = k < at || (k === 2 && at === 2), current = k === at && !done;
        const late = k === 2 && !!h.paged_at && !h.acked_at;
        return [
          <li key={st.label} className="flex items-center gap-3">
            <span className={`flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-bold ${done ? 'bg-emerald-600 text-white' : late ? 'bg-sev1 text-white' : current ? 'bg-ink text-white' : 'border-2 border-line text-sub'}`}>{done ? '✓' : k + 1}</span>
            <div>
              <div className={`text-[15px] font-semibold ${!done && !current ? 'text-sub' : ''}`}>{st.label}</div>
              <div className="text-sm text-sub">{st.sub}</div>
            </div>
          </li>,
          k < steps.length - 1 && <li key={`bar${k}`} aria-hidden className={`h-1 rounded-full ${k < at ? 'bg-emerald-600' : 'bg-line'}`} />,
        ];
      })}
    </ol>
  );
}

// Components whose health stage got worse during the shift (stage = how close its SLOs/signals are to breaking:
// Normal → Slow → At risk → Breach), from the shift start to now, with the signal that moved it.
function WorseTable({ list }: { list: HandoffData['worse'] }) {
  return (
    <div>
      <div className="text-xs font-medium text-sub" title="Stage: Normal → Slow → At risk → Breach, from the component's SLOs and signals">Components that got worse this shift</div>
      <table className="mt-1 w-full text-sm">
        <thead><tr className="text-left text-xs text-sub"><th className="py-1 font-normal">Component</th><th className="font-normal">Shift start</th><th className="font-normal">Now</th><th className="font-normal">Why</th></tr></thead>
        <tbody>
          {list.map((x) => (
            <tr key={x.component} className="border-t border-line align-top">
              <td className="py-1.5 pr-3 font-semibold">{x.component}</td>
              <td className="pr-3"><StageChip s={x.from} /></td>
              <td className="pr-3"><StageChip s={x.to} /></td>
              <td className="text-xs text-sub">{x.reason ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}


const STAGE: Record<string, { label: string; cls: string }> = {
  breach: { label: 'Breach', cls: 'bg-sev1 text-white' }, risk: { label: 'At risk', cls: 'bg-sev2 text-white' }, slow: { label: 'Slow', cls: 'bg-sev3/25 text-ink' },
  normal: { label: 'Normal', cls: 'bg-emerald-50 text-emerald-700' }, unknown: { label: 'Unknown', cls: 'bg-ink text-white' }, off: { label: 'Off', cls: 'bg-line text-sub' },
};
const STAGE_TEXT: Record<string, string> = { breach: 'text-sev1', risk: 'text-sev2', slow: 'text-sev3', normal: 'text-emerald-700', unknown: 'text-ink', off: 'text-sub' };
function StageChip({ s }: { s: string }) {
  return <span className={`font-medium ${STAGE_TEXT[s] ?? ''}`}>{STAGE[s]?.label ?? s}</span>;
}

// Budgets that moved this shift or are already spent, full names, with a bar; the rest fold away.
function SloSec({ slo }: { slo: HandoffData['slo'] }) {
  const delta = (x: HandoffData['slo'][number]) => (x.from !== null && x.to !== null ? x.to - x.from : null);
  const shown = slo.filter((x) => (delta(x) ?? 0) < -0.0005 || (x.to ?? 1) <= 0);
  const row = (x: HandoffData['slo'][number]) => {
    const dd = delta(x), left = x.to;
    return (
      <tr key={x.name} className="border-t border-line">
        <td className="px-5 py-2.5">{x.name}</td>
        <td className="w-1/3 py-2"><span className="block h-2 overflow-hidden rounded-full bg-line"><span className={`block h-full ${left === null ? '' : left <= 0 ? 'bg-sev1' : left < 0.25 ? 'bg-sev2' : 'bg-emerald-600'}`} style={{ width: `${left !== null && left <= 0 ? 100 : Math.max(0, Math.min(1, left ?? 0)) * 100}%` }} /></span></td>
        <td className={`py-2 pl-4 text-right tabular-nums ${left !== null && left <= 0 ? 'font-medium text-sev1' : ''}`}>{left === null ? '—' : left <= 0 ? `overspent ${Math.round(-left * 100)}%` : `${Math.round(left * 100)}% left`}</td>
        <td className={`py-2.5 pl-4 pr-5 text-right tabular-nums ${dd !== null && dd < -0.005 ? 'font-medium text-sev1' : 'text-sub'}`}>{dd === null ? '' : `${dd > 0 ? '+' : ''}${(dd * 100).toFixed(1)}%`}</td>
      </tr>
    );
  };
  return (
    <Panel title="SLO error budget" count={shown.length}>
      {!slo.length ? <div className="px-5 py-4"><Empty>Prometheus was unreachable; no budget numbers.</Empty></div> : (
        <>
          {shown.length ? (
            <table className="w-full text-[15px]">
              <thead><tr className="text-left text-xs text-sub"><th className="px-5 py-2 font-medium">SLO</th><th className="w-1/3 py-2 font-medium">Budget left</th><th className="py-2" /><th className="py-2 pr-5 text-right font-medium">This shift</th></tr></thead>
              <tbody>{shown.map(row)}</tbody>
            </table>
          ) : <div className="px-5 py-4"><Empty>No budget spent this shift.</Empty></div>}
          {slo.length > shown.length && (
            <details className="border-t border-line">
              <summary className="cursor-pointer px-5 py-2.5 text-sm text-sub">{slo.length - shown.length} more, unchanged and within budget</summary>
              <table className="w-full text-[15px]"><tbody>{slo.filter((x) => !shown.includes(x)).map(row)}</tbody></table>
            </details>
          )}
        </>
      )}
    </Panel>
  );
}

function Empty({ children }: { children: React.ReactNode }) { return <p className="text-sm text-sub">{children}</p>; }

// Handoff panels stack with a gap between them.
function Panel(props: React.ComponentProps<typeof BasePanel>) {
  return <BasePanel {...props} className={`mt-6 ${props.className ?? ''}`} />;
}
