import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { ACTION_LABEL, SevBadge, StateBadge } from '@/components/badges.tsx';
import { Elapsed, Until } from '@/components/Elapsed.tsx';
import { fmtDuration } from '@/lib/time.ts';
import { Ts } from '@/components/Ts.tsx';
import { Modal } from '@/components/Modal.tsx';
import { button, field } from '@/components/ui.tsx';
import { Panel } from '@/components/Panel.tsx';
import { Updates } from '@/components/Updates.tsx';
import { pool } from '@/lib/db.ts';
import { CopyButton } from '@/components/CopyButton.tsx';
import { CheckpointForm } from '@/components/CheckpointForm.tsx';
import { checkpoints, type Checkpoint } from '@/lib/checkpoints.ts';
import { changesFor, incidentComponents, duringIncident, suspects, SUSPECT_WINDOW_MS, type Suspect } from '@/lib/changes.ts';
import { chgs, type Chg } from '@/lib/chg.ts';
import { topology } from '@/lib/topology.ts';
import { priorities, type Priority } from '@/lib/priority.ts';
import { firstSigns, type FirstSign } from '@/lib/stages.ts';
import { matchRunbooks, runbooks } from '@/lib/runbooks.ts';
import { RunbookView } from '@/components/RunbookView.tsx';
import { AgentPanel } from '@/components/AgentPanel.tsx';
import { DraftPostmortem } from '@/components/DraftPostmortem.tsx';
import { isDemo } from '@/lib/demo.ts';
import { slos } from '@/lib/prom.ts';
import { TransitionButton } from '@/components/TransitionButton.tsx';
import { PHASES, PHASE_LABEL, currentPhase, itemsFor, phasesBefore, template } from '@/lib/checklists.ts';
import { FOLLOW_UP_TYPES, PRIORITIES, ROLES, checklist, followUps, getIncident, listIncidents, runbookSteps, type FollowUp, type RunbookStep, type Alert, type SentPage, type ChecklistItem, type Incident, type Role } from '@/lib/incidents.ts';
import { OPEN, allowedNext } from '@/lib/lifecycle.ts';
import { MAX_STEP, stepAt } from '@/lib/paging.ts';
import { ackAction, wakeNowAction, addFollowUpAction, createIssueAction, followUpDoneAction, addItemAction, mergeAction, splitAction, completeItemAction, declareAction, decisionAction, itemNoteAction, noteAction, reopenItemAction, roleAction, sevAction, summaryAction, transitionAction } from './actions.ts';

const ROLE_SHORT: Record<Role, string> = { ic: 'IC', ops: 'Ops', comms: 'Comms', planning: 'Planning' };
const ROLE_LABEL: Record<Role, string> = { ic: 'Incident commander', ops: 'Ops lead', comms: 'Comms lead', planning: 'Planning lead' };
const ROLE_JOB: Record<Role, string> = {
  ic: 'Owns the incident and every role nobody else holds.',
  ops: 'Works the system: diagnosis and mitigation.',
  comms: 'Keeps people outside the response informed.',
  planning: 'Tracks follow-ups, handoffs and the longer view.',
};
const TABS = [
  { id: 'summary', label: 'Summary' },
  { id: 'response', label: 'Response' },
  { id: 'updates', label: 'Updates' },
  { id: 'alerts', label: 'Alerts' },
  { id: 'roles', label: 'Roles' },
  { id: 'runbook', label: 'Runbook' },
] as const;
type Tab = (typeof TABS)[number]['id'];

export default function IncidentPage({ params, searchParams }: PageProps<'/incidents/[id]'>) {
  return (
    <Suspense fallback={<p className="p-8 text-sub">Loading…</p>}>
      <Board params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function Board({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  if (!/^\d+$/.test(id)) notFound();
  const data = await getIncident(pool(), id);
  if (!data) notFound();
  const { inc, alerts, timeline, pages } = data;
  const [cps, fus] = await Promise.all([checkpoints(pool(), inc.id), followUps(pool(), inc.id)]);
  // F12: changes around this incident. Suspects = before detection; the timeline also shows changes while it is open.
  const topo = topology();
  const names = [...new Set(alerts.map((a) => a.alertname))];
  const { chgs: chgList } = await chgs();
  const sus = await suspects(pool(), topo, names, new Date(inc.detected_at), chgList);
  const during = await duringIncident(pool(), new Date(inc.detected_at), inc.resolved_at ? new Date(inc.resolved_at) : new Date(), chgList);
  const comps = incidentComponents(topo, names);
  const changeEvents = (await changesFor(pool(), [...comps.own, ...comps.deps], new Date(new Date(inc.detected_at).getTime() - SUSPECT_WINDOW_MS), inc.closed_at ?? inc.resolved_at ?? new Date()))
    .map((e) => ({ id: `chg-${e.id}`, at: e.at, kind: 'change', actor: 'flux', body: { ...e } as Record<string, unknown> }));
  const budgets = new Map((await slos().catch(() => [])).map((x) => [x.name, x.budgetRemaining]));
  const prio = (await priorities(pool(), topo, budgets, [inc.id])).get(inc.id) ?? null;
  const alertComps = [...new Set(alerts.map((a) => a.component).filter((x): x is string => !!x))];
  const rbs = matchRunbooks(await runbooks(), names, alertComps);
  const rbSteps = rbs.length ? await runbookSteps(pool(), inc.id) : [];
  const signs = await firstSigns(pool(), topo, [...new Set(alerts.map((a) => a.component).filter((x): x is string => !!x))], new Date(inc.detected_at)).catch(() => []);
  const others = OPEN.includes(inc.state) ? (await listIncidents(pool())).filter((x) => x.id !== inc.id && OPEN.includes(x.state)) : [];
  const merged = [...timeline, ...changeEvents].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  // Before declaring there is no checklist yet: show what declaring at the suggested SEV would create.
  const previewSev = inc.state === 'candidate' ? (inc.sev ?? inc.sev_suggested ?? 3) : null;
  const items: ChecklistItem[] = previewSev
    ? itemsFor(template(), previewSev).map((t) => ({ id: t.key, role: t.role, phase: t.phase, text: t.text, template_key: t.key, added_by: null, done_by: null, done_at: null, note: null }))
    : await checklist(pool(), inc.id);
  const openFor = (to: string) => items
    .filter((i) => !i.done_at && phasesBefore(to as never).includes(i.phase))
    .map((i) => ({ role: ROLE_SHORT[i.role], text: i.text }));
  // Actions waiting for the IC on the briefing's do-now steps (not-needed steps can still be run, but do not nag).
  const toDecide = (await pool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM agent_actions a JOIN agent_briefings b ON b.id = a.briefing_id, jsonb_array_elements(b.body->'items') x
     WHERE a.incident_id = $1 AND a.status = 'proposed' AND x->>'action_id' = a.id::text AND x->>'decision' = 'do_now'`, [inc.id])).rows[0].n;
  // Postmortem: owed by every SEV1–2 once resolved (Google SRE); linked once drafted.
  const pm = ['resolved', 'postmortem', 'closed'].includes(inc.state)
    ? (await pool().query<{ postmortem_id: string | null; postmortem_pr: string | null }>('SELECT postmortem_id, postmortem_pr FROM incidents WHERE id = $1', [inc.id])).rows[0] : null;
  // The AI briefing's headline for the Summary tab.
  const brief = (await pool().query<{ version: number; situation: string; todo: number }>(
    `SELECT version, body->>'situation' AS situation,
       (SELECT count(*) FROM jsonb_array_elements(body->'items') x WHERE x->>'decision' = 'do_now')::int AS todo
     FROM agent_briefings WHERE incident_id = $1 ORDER BY version DESC LIMIT 1`, [inc.id])).rows[0] ?? null;
  const tab: Tab = TABS.some((t) => t.id === sp.tab) ? (sp.tab as Tab) : 'summary';
  const next = allowedNext(inc.state, inc.sev);
  // F14: closing waits until every follow-up has an issue.
  const noIssue = fus.filter((f) => f.issue_number === null).length;
  const primary = next.find((s) => s !== 'dismissed' && !(inc.state === 'resolved' && s === 'declared'));
  const secondary = next.filter((s) => s !== primary && !(s === 'closed' && noIssue));
  const live = OPEN.includes(inc.state);
  const firing = alerts.filter((a) => a.status === 'firing').length;
  const people = timeline.filter((e) => !e.kind.startsWith('alert_')).length;
  const done = items.filter((i) => i.done_at).length;
  const count: Record<Tab, string | null> = { response: toDecide ? `${toDecide} to decide` : null, runbook: rbs.length ? String(rbs.length) : null, summary: null, updates: String(people), alerts: firing ? String(firing) : String(alerts.length), roles: items.length && !previewSev ? `${done}/${items.length}` : null };

  return (
    <div className="min-h-full bg-surface">
    <div className="mx-auto max-w-7xl px-8 py-7">
      {/* Header: what it is, where it stands, the one next step */}
      <header className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm text-sub">
            <span>#{inc.id}</span>
            <SevBadge sev={inc.sev} suggested={inc.sev_suggested} />
            {inc.state !== 'candidate' && <StateBadge state={inc.state} />}
            {sus.length > 0 && <span className="rounded bg-sev3/15 px-1.5 text-xs font-medium text-sev3">⚠ Suspected change</span>}
          </div>
          <h1 className="mt-1.5 text-2xl font-semibold tracking-tight">{inc.title}</h1>
          {prio && prio.comps.length > 0 && (
            <p className="mt-1.5 text-sm text-sub">
              {prio.cause && <>Probable cause <b className="font-semibold text-ink">{prio.cause}</b>{prio.comps.length > 1 && ' · '}</>}
              {prio.comps.length > 1 && <>affects {prio.comps.filter((x) => x !== prio.cause).join(', ')}</>}
            </p>
          )}
          <LifecycleLine inc={inc} />
        </div>
        <div className="flex items-center gap-2">
          {secondary.map((to) => (
            <TransitionButton key={to} label={to === 'declared' ? 'Reopen' : ACTION_LABEL[to]} className={to === 'declared' ? button.danger : button.quiet}
              action={transitionAction.bind(null, inc.id, to)} open={openFor(to)} />
          ))}
          {inc.state === 'candidate' && others.length > 0 && (
            <Modal label="Merge into…" title="Merge into another incident" buttonClass={button.quiet}>
              <form action={mergeAction.bind(null, inc.id)} className="grid gap-3">
                <p className="text-sm text-sub">{alerts.length === 1 ? 'Its alert moves' : `All ${alerts.length} alerts move`} to the chosen incident and this candidate is dismissed. Both timelines record it.</p>
                <select name="into" required className={field} aria-label="Incident">
                  {others.map((o) => <option key={o.id} value={o.id}>#{o.id} {o.title.slice(0, 70)} ({o.state})</option>)}
                </select>
                <button className={`${button.primary} justify-self-end`}>Merge</button>
              </form>
            </Modal>
          )}
          {inc.state === 'candidate' ? (
            <Modal label="Declare incident" title="Declare incident" buttonClass={button.primary}>
              <form action={declareAction.bind(null, inc.id)} className="grid gap-3">
                <label className="grid gap-1 text-sm">Severity
                  <select name="sev" defaultValue={inc.sev ?? inc.sev_suggested ?? 3} className={field}>
                    {[1, 2, 3, 4].map((s) => <option key={s} value={s}>SEV{s}{s === inc.sev_suggested ? ' (suggested from alerts)' : ''}</option>)}
                  </select>
                </label>
                <p className="text-sm text-sub">You become incident commander unless someone already holds the role.</p>
                <button className={`${button.primary} justify-self-end`}>Declare incident</button>
              </form>
            </Modal>
          ) : primary === 'closed' && noIssue ? (
            <Link href={`/incidents/${inc.id}`} className={`${button.quiet} border-sev2/50 text-sev2`} title="Create an issue for every follow-up first">
              Close blocked: {noIssue} follow-up{noIssue === 1 ? '' : 's'} without an issue
            </Link>
          ) : primary && (
            <TransitionButton label={ACTION_LABEL[primary]} className={button.primary} action={transitionAction.bind(null, inc.id, primary)} open={openFor(primary)} />
          )}
        </div>
      </header>

      <Glance inc={inc} firing={firing} total={alerts.length} done={done} items={previewSev ? 0 : items.length} pages={pages} />

      {live && !inc.acked_at && <PageBanner id={inc.id} pages={pages} />}


      <nav role="tablist" aria-label="Incident sections" className="mt-6 flex gap-1 border-b border-line">
        {TABS.map((t) => {
          const active = t.id === tab;
          return (
            <Link key={t.id} role="tab" aria-selected={active} scroll={false}
              href={t.id === 'summary' ? `/incidents/${inc.id}` : `/incidents/${inc.id}?tab=${t.id}`}
              className={`-mb-px inline-flex h-10 items-center gap-2 border-b-2 px-3 text-sm ${active ? 'border-ink font-medium text-ink' : 'border-transparent text-sub hover:text-ink'}`}>
              {t.label}
              {count[t.id] && <span className={`rounded-full px-1.5 text-xs ${(t.id === 'alerts' && firing) || (t.id === 'response' && toDecide) ? 'bg-sev1 text-white' : 'bg-line/70 text-sub'}`}>{count[t.id]}</span>}
            </Link>
          );
        })}
      </nav>

      <div className="mt-5">
        {tab === 'summary' && pm && (pm.postmortem_id || (inc.sev ?? 5) <= 2) && (
          <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-line px-4 py-2.5 text-sm">
            <b className="font-semibold">Postmortem</b>
            {pm.postmortem_id
              ? <><Link href={`/postmortems/${pm.postmortem_id}`} className="underline underline-offset-2">{pm.postmortem_id}</Link>{pm.postmortem_pr && <a href={pm.postmortem_pr} target="_blank" rel="noreferrer" className="text-sub underline underline-offset-2">draft PR ↗</a>}</>
              : <><span className="text-sev1">due: SEV{inc.sev} incidents need one</span><span className="ml-auto"><DraftPostmortem incidentId={inc.id} demo={isDemo()} /></span></>}
          </div>
        )}
        {tab === 'summary' && brief && (
          <Link href={`/incidents/${inc.id}?tab=response`} scroll={false} className="mb-4 flex items-baseline gap-3 rounded-lg border border-ink/25 px-4 py-2.5 text-sm hover:border-ink/50">
            <b className="shrink-0 font-semibold">AI</b>
            <span className="min-w-0 flex-1 truncate">{brief.situation}</span>
            <span className="shrink-0 text-sub">{brief.todo ? `${brief.todo} next step${brief.todo === 1 ? '' : 's'}` : 'nothing to do now'} →</span>
          </Link>
        )}
        {tab === 'summary' && <SummaryTab inc={inc} live={live} pages={pages} cps={cps} sus={sus} during={during} prio={live ? prio : null} signs={signs} fus={fus} />}
        {tab === 'updates' && (
          <Updates events={merged} actions={live && (
            <div className="flex gap-2">
              <Modal label="Record decision" title="Record a decision" buttonClass={button.quiet}>
                <form action={decisionAction.bind(null, inc.id)} className="grid gap-3">
                  <label className="grid gap-1 text-sm">Decision<input name="decision" required className={field} /></label>
                  <label className="grid gap-1 text-sm">Why<input name="reason" className={field} /></label>
                  <label className="grid gap-1 text-sm">Instead of<input name="alternatives" className={field} /></label>
                  <label className="grid gap-1 text-sm">Revert when<input name="revert_when" className={field} /></label>
                  <button className={`${button.primary} justify-self-end`}>Record decision</button>
                </form>
              </Modal>
              <Modal label="Post update" title="Post an update" buttonClass={button.primary}>
                <form action={noteAction.bind(null, inc.id)} className="grid gap-3">
                  <textarea name="text" required rows={4} placeholder="What did you see or do?" className={`${field} h-auto py-2`} />
                  <button className={`${button.primary} justify-self-end`}>Post update</button>
                </form>
              </Modal>
            </div>
          )} />
        )}
        {tab === 'response' && <AgentPanel incidentId={inc.id} live={live} sev={inc.sev} />}
        {tab === 'alerts' && <AlertsTab id={inc.id} live={live} alerts={alerts} chgs={chgList} />}
        {tab === 'runbook' && <RunbookTab inc={inc} live={live} rbs={rbs} steps={rbSteps} pick={typeof sp.rb === 'string' ? sp.rb : null} />}
        {tab === 'roles' && <RolesTab inc={inc} live={live} items={items} previewSev={previewSev} />}
      </div>
    </div>
    </div>
  );
}

// Lifecycle as a stepper: where the incident is, and when each step happened.
const STEPS = [
  { key: 'detected_at', label: 'Detected' },
  { key: 'declared_at', label: 'Declared' },
  { key: 'mitigated_at', label: 'Mitigated' },
  { key: 'resolved_at', label: 'Resolved' },
  { key: 'closed_at', label: 'Closed' },
] as const;

// Unacknowledged page: what went out, when the next escalation goes, and the ack button.
function PageBanner({ id, pages }: { id: string; pages: SentPage[] }) {
  const esc = pages.filter((p) => p.kind === 'escalation' && p.step > 0);
  if (!esc.length) return null;
  const last = esc[esc.length - 1];
  const nextAt = last.step < MAX_STEP ? new Date(new Date(esc[0].sent_at).getTime() + stepAt(last.step + 1)) : null;
  return (
    <div role="alert" className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-sev1/40 bg-sev1/5 px-4 py-3">
      <span className="size-2.5 animate-pulse rounded-full bg-sev1" aria-hidden />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium text-sev1">Paged, not acknowledged</p>
        <p className="text-sub">
          Step {last.step} via {last.channel === 'ntfy' ? 'ntfy' : 'Slack'} at <Ts at={last.sent_at} />.
          {nextAt ? <> Escalates to {last.step + 1 >= 3 ? 'Slack' : 'ntfy urgent'} <Until at={nextAt} />.</> : ' Escalation finished.'}
        </p>
      </div>
      <form action={ackAction.bind(null, id)}><button className={button.danger}>Acknowledge</button></form>
    </div>
  );
}

// A titled block without a box: heading row, then content. Sections are separated by a rule.
function Section({ title, aside, children }: { title?: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="border-t border-line py-5 first:border-t-0 first:pt-0">
      {(title || aside) && (
        <header className="mb-3 flex items-center gap-3">
          {title && <h2 className="text-[15px] font-semibold">{title}</h2>}
          {aside && <div className="ml-auto">{aside}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

// Lifecycle as one line under the title: reached steps dark, the rest faint; hover shows the time.
function LifecycleLine({ inc }: { inc: Incident }) {
  return (
    <ol className="mt-3 flex items-center text-xs" aria-label="Lifecycle">
      {STEPS.map((s, i) => {
        const at = inc[s.key];
        const nextAt = STEPS[i + 1] ? inc[STEPS[i + 1].key] : null;
        return (
          <li key={s.key} className="flex items-center" title={at ? `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'Not yet'}>
            <span className={`size-2 rounded-full ${at ? 'bg-ink' : 'border border-sub/50'}`} />
            <span className={`ml-1.5 ${at ? 'font-medium text-ink' : 'text-sub'}`}>{s.label}</span>
            {i < STEPS.length - 1 && <span className={`mx-2.5 h-px w-8 ${nextAt ? 'bg-ink' : 'bg-line'}`} />}
          </li>
        );
      })}
    </ol>
  );
}

const mtta = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 90 ? `${s}s` : `${Math.round(s / 60)}m`; };

// The incident at a glance: five tiles; one turns red only when it needs action.
function Glance({ inc, firing, total, done, items, pages }: { inc: Incident; firing: number; total: number; done: number; items: number; pages: SentPage[] }) {
  const first = pages.find((p) => p.kind === 'escalation' && p.step > 0);
  const waiting = !!first && !inc.acked_at && OPEN.includes(inc.state);
  const overdue = !!inc.next_update_at && new Date(inc.next_update_at).getTime() < Date.now() && OPEN.includes(inc.state);
  const tile = (label: string, value: React.ReactNode, hot = false, good = false) => (
    <div className={`rounded-xl border px-4 py-3 ${hot ? 'border-sev1/50 bg-sev1/5' : 'border-line bg-surface'}`}>
      <div className={`text-2xl font-semibold leading-tight tracking-tight tabular-nums ${hot ? 'text-sev1' : good ? 'text-emerald-700' : ''}`}>{value}</div>
      <div className="mt-1 text-sm text-sub">{label}</div>
    </div>
  );
  return (
    <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
      {tile(inc.resolved_at ? 'to resolve' : 'open for', <Elapsed from={inc.detected_at} until={inc.resolved_at} />)}
      {tile(firing ? 'alerts firing' : 'alerts, all cleared', firing || total, firing > 0)}
      {tile('checklist', items ? <span className="flex items-center gap-2">{done}/{items}<span className="h-1.5 w-12 overflow-hidden rounded-full bg-line"><span className="block h-full bg-ink" style={{ width: `${(done / items) * 100}%` }} /></span></span> : '—')}
      {tile('next update', inc.next_update_at ? <Until at={inc.next_update_at} /> : '—', overdue)}
      {tile('paging', !first ? (pages.length ? 'Slack' : 'none') : inc.acked_at ? `acked ${mtta(new Date(inc.acked_at).getTime() - new Date(first.sent_at).getTime())}` : waiting ? 'waiting' : 'never acked', waiting, !!inc.acked_at)}
    </div>
  );
}

const CHANNEL: Record<string, string> = { ntfy: 'ntfy', slack: 'Slack' };

// Pages as a small vertical timeline: who was paged how, and when it was answered.
function PagingPanel({ inc, pages }: { inc: Incident; pages: SentPage[] }) {
  const first = pages.find((p) => p.kind === 'escalation' && p.step > 0);
  const DOT: Record<string, string> = { urgent: 'bg-sev1', high: 'bg-sev2', default: 'bg-sev4' };
  return (
    <Panel title="Paging" aside={<span className="text-xs text-sub">mock delivery</span>}>
      <div className="px-5 py-4">
        {!pages.length ? <p className="text-sm text-sub">{inc.state === 'candidate' ? 'Declaring at SEV1–2 pages on ntfy; SEV3 posts to Slack.' : 'No page for this severity.'}</p> : (
          <ol className="relative space-y-3 before:absolute before:inset-y-1 before:left-[5px] before:w-px before:bg-line">
            {pages.map((p) => (
              <li key={p.id} className="relative flex items-start gap-3 text-sm">
                <span className={`relative z-[1] mt-1 size-[11px] shrink-0 rounded-full ring-2 ring-surface ${DOT[p.priority] ?? 'bg-sev4'}`} />
                <div className="min-w-0">
                  <div className="font-medium">{p.kind === 'wake' ? 'Wake condition' : p.kind === 'triage' ? 'Triage reminder' : p.step ? `Page ${p.step}` : 'Slack notice'} · {CHANNEL[p.channel]} <span className="font-normal text-sub">{p.priority}</span></div>
                  <div className="text-xs text-sub"><Ts at={p.sent_at} /></div>
                </div>
              </li>
            ))}
            {inc.acked_at && first && (
              <li className="relative flex items-start gap-3 text-sm">
                <span className="relative z-[1] mt-0.5 flex size-[11px] shrink-0 items-center justify-center rounded-full bg-emerald-600 text-[8px] text-white ring-2 ring-surface">✓</span>
                <div><div className="font-medium text-emerald-700">Acknowledged by {inc.acked_by}</div>
                  <div className="text-xs text-sub">{mtta(new Date(inc.acked_at).getTime() - new Date(first.sent_at).getTime())} after the first page</div></div>
              </li>
            )}
          </ol>
        )}
      </div>
    </Panel>
  );
}

const WAKE: Record<string, { label: string; cls: string }> = {
  watching: { label: 'Watching', cls: 'bg-emerald-600 text-white' },
  fired: { label: 'Woke the IC', cls: 'bg-sev1 text-white' },
  stopped: { label: 'Stopped', cls: 'bg-line text-sub' },
};

// The newest checkpoint as a card: status on top, the four working facts in boxes, the next step called out,
// and the wake condition as one status row (its query folded).
function CheckpointPanel({ inc, cps, live }: { inc: Incident; cps: Checkpoint[]; live: boolean }) {
  const k = cps[0] ?? null;
  const canWrite = live && inc.state !== 'candidate';
  const box = (label: string, v: React.ReactNode) => (
    <div className="rounded-lg border border-line px-4 py-3">
      <div className="text-xs font-medium text-sub">{label}</div>
      <div className="mt-1 text-[15px] leading-snug">{v}</div>
    </div>
  );
  return (
    <Panel title="Checkpoint" aside={<>
      {k && <span className="text-xs text-sub">{k.author} · <Ts at={k.created_at} />{cps.length > 1 && ` · ${cps.length - 1} earlier`}</span>}
      {canWrite && (
        <Modal label={k ? 'New checkpoint' : 'Write checkpoint'} title="IC checkpoint" buttonClass={button.quiet} keepOpen wide>
          <CheckpointForm id={inc.id} last={k} />
        </Modal>
      )}
    </>}>
      {!k ? (
        <p className="px-5 py-4 text-sm text-sub">{canWrite ? 'None yet. Write one before you hand over or step away; a wake condition pages you when it matters.' : 'No checkpoint was written.'}</p>
      ) : (
        <div className="space-y-4 px-5 py-4">
          <p className="text-lg font-semibold leading-snug">{k.status_line}</p>
          <div className="grid gap-3 sm:grid-cols-3">
            {box('Hypothesis', k.hypothesis || <span className="text-sub">—</span>)}
            {box('In progress', k.action ? <>{k.action}{k.action_eta && <span className="mt-1 block text-sm text-sub">done by {new Date(k.action_eta).toISOString().slice(11, 16)} UTC · <Until at={k.action_eta} /></span>}</> : <span className="text-sub">—</span>)}
            {box('Handed to', k.handoff_to ? <b className="font-semibold">{k.handoff_to}</b> : <span className="text-sub">nobody</span>)}
          </div>
          {k.next_step && (
            <div className="rounded-lg border-l-4 border-ink bg-canvas px-4 py-3">
              <div className="text-xs font-semibold text-sub">Next step</div>
              <p className="mt-0.5 text-base font-semibold leading-snug">{k.next_step}</p>
            </div>
          )}
          {k.wake_expr && k.wake_state && (
            <details className="group/wake rounded-lg border border-line">
              <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-4 py-2.5 text-sm [&::-webkit-details-marker]:hidden">
                <span className="font-medium">Wake condition</span>
                <span className={`rounded px-1.5 text-[11px] ${WAKE[k.wake_state].cls}`}>{WAKE[k.wake_state].label}</span>
                <span className="text-xs text-sub">
                  {k.wake_state === 'fired' && k.wake_fired_at ? <>met at <Ts at={k.wake_fired_at} />, paged</> : k.wake_checked_at ? <>checked <Ts at={k.wake_checked_at} /></> : 'not checked yet'}
                </span>
                {k.wake_error && k.wake_state === 'watching' && <span className="text-xs text-sev2">last check failed</span>}
                <span className="ml-auto text-xs text-sub group-open/wake:hidden">show query</span>
              </summary>
              <code className="block break-all border-t border-line px-4 py-2.5 text-xs text-sub">{k.wake_expr}</code>
            </details>
          )}
          {k.wake_state === 'watching' && live && (
            <form action={wakeNowAction.bind(null, inc.id)} className="flex items-center gap-3">
              <button className={`${button.danger}`} title="Fire the wake condition now: pages the IC (mock ntfy, urgent)">Send wake alarm</button>
              <span className="text-xs text-sub">Fires it now instead of waiting for the query. Mock delivery.</span>
            </form>
          )}
        </div>
      )}
    </Panel>
  );
}

// Changes around this incident: before detection on its components or their dependencies (2 h; a rollback lead),
// and anything that started while it was open, on any component.
function SuspectPanel({ sus, during }: { sus: Suspect[]; during: Suspect[] }) {
  if (!sus.length && !during.length) return null;
  // Title only (a deploy also says where it ended up); the CHG document or the Updates timeline has the rest.
  const item = (x: Suspect, i: number) => (
    <li key={i} className="flex items-baseline gap-2 px-5 py-2 text-sm" title={x.label}>
      <span className="min-w-0 flex-1 truncate">{x.href ? <a href={x.href} target="_blank" rel="noreferrer" className="hover:underline">{x.label}</a> : x.label}</span>
      {x.status && x.status !== 'applied' && <span className={`shrink-0 text-xs ${x.failed ? 'font-medium text-sev1' : 'text-sub'}`}>{x.status}</span>}
    </li>
  );
  const group = (title: string, list: Suspect[]) => list.length > 0 && (
    <>
      <div className="border-b border-line bg-canvas/60 px-5 py-1.5 text-xs font-semibold">{title}</div>
      <ul className="divide-y divide-line border-b border-line last:border-b-0">{list.slice(0, 4).map(item)}</ul>
      {list.length > 4 && (
        <details className="group/more border-b border-line last:border-b-0">
          <summary className="cursor-pointer list-none px-5 py-2 text-xs text-sub hover:text-ink group-open/more:hidden [&::-webkit-details-marker]:hidden">{list.length - 4} more</summary>
          <ul className="divide-y divide-line">{list.slice(4).map((x, i) => item(x, i + 4))}</ul>
        </details>
      )}
    </>
  );
  return (
    <Panel title="Changes" count={sus.length + during.length}>
      {group('Before detection', sus)}
      {group('During the incident', during)}
    </Panel>
  );
}

// Where this sits in the queue: the score; how it is made up opens on demand.
function PriorityPanel({ p }: { p: Priority }) {
  const max = Math.max(1, ...p.parts.map((x) => x.points));
  return (
    <Panel title="Priority" aside={p.pinned ? <span className="rounded bg-sev1 px-1.5 text-[11px] text-white">pinned</span> : null}>
      <div className="flex items-center gap-3 px-5 py-4">
        <span className="text-4xl font-semibold tracking-tight tabular-nums">{p.total}</span><span className="text-sm text-sub">queue score</span>
        <span className="ml-auto">
        <Modal label="How it's scored" title={`Queue score ${p.total}`} buttonClass={button.quiet}>
        <ul className="space-y-2.5">
          {p.parts.map((x) => (
            <li key={x.label} title={x.why}>
              <div className="flex items-baseline text-sm"><span className="font-medium">{x.label}</span><span className="ml-auto tabular-nums">{x.points}</span></div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-line"><div className="h-full rounded-full bg-ink" style={{ width: `${(x.points / max) * 100}%` }} /></div>
              <div className="mt-0.5 text-xs text-sub">{x.why}</div>
            </li>
          ))}
        </ul>
        </Modal>
        </span>
      </div>
    </Panel>
  );
}

const SIGN: Record<string, { label: string; cls: string }> = {
  breach: { label: 'Breach', cls: 'bg-sev1 text-white' }, risk: { label: 'At risk', cls: 'bg-sev2 text-white' }, slow: { label: 'Slow', cls: 'bg-sev3/25 text-ink' },
};

// The earliest non-normal signal per component in the 6 hours before detection (PRD F4, §8 "detected earlier").
function FirstSignsPanel({ inc, signs }: { inc: Incident; signs: FirstSign[] }) {
  const detected = new Date(inc.detected_at);
  const at = (d: Date) => `/infrastructure?at=${encodeURIComponent(d.toISOString().slice(0, 16))}`;
  return (
    <Panel title="First signs" aside={<Link href={at(detected)} className="text-xs underline underline-offset-2">map at detection</Link>}>
      {!signs.length ? <p className="px-5 py-4 text-sm text-sub">Nothing crossed a threshold in the 6 hours before detection.</p> : (
        <ul className="divide-y divide-line">
          {signs.map((x) => {
            const lead = detected.getTime() - x.at.getTime();
            return (
              <li key={x.component + x.at.toISOString()} className="px-5 py-3 text-sm">
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{x.component}</span>
                  <span className={`rounded px-1.5 text-[11px] ${SIGN[x.stage]?.cls ?? 'bg-line'}`}>{SIGN[x.stage]?.label ?? x.stage}</span>
                  <span className={`ml-auto text-xs font-medium ${lead >= 60_000 ? 'text-emerald-700' : 'text-sub'}`}>{x.sinceStart ? `${fmtDuration(lead)}+ early` : lead >= 60_000 ? `${fmtDuration(lead)} early` : 'at detection'}</span>
                </div>
                <div className="mt-0.5 text-sub">{x.text} · <Link href={at(x.at)} className="hover:underline"><Ts at={x.at} /></Link></div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

const PRIO_CLS: Record<string, string> = { P0: 'bg-sev1 text-white', P1: 'bg-sev2 text-white', P2: 'bg-line text-sub' };

// Postmortem follow-ups (PRD F14): each becomes a (mock) GitHub issue; closing the incident waits for all of them.
function FollowUpsPanel({ inc, fus }: { inc: Incident; fus: FollowUp[] }) {
  const show = fus.length > 0 || ['resolved', 'postmortem', 'closed'].includes(inc.state);
  if (!show) return null;
  const withIssue = fus.filter((f) => f.issue_number !== null).length;
  const canEdit = inc.state !== 'dismissed';
  return (
    <Panel title="Follow-ups" count={fus.length} aside={<>
      {fus.length > 0 && <span className={`text-xs ${withIssue === fus.length ? 'text-emerald-700' : 'text-sub'}`}>{withIssue}/{fus.length} have issues</span>}
      {canEdit && (
        <Modal label="Add follow-up" title="Add a follow-up" buttonClass={button.quiet}>
          <form action={addFollowUpAction.bind(null, inc.id)} className="grid gap-3">
            <label className="grid gap-1 text-sm">Action<input name="action" required maxLength={300} placeholder="What will prevent, detect or mitigate this next time" className={field} /></label>
            <div className="grid grid-cols-3 gap-3">
              <label className="grid gap-1 text-sm">Type<select name="type" className={field}>{FOLLOW_UP_TYPES.map((x) => <option key={x}>{x}</option>)}</select></label>
              <label className="grid gap-1 text-sm">Priority<select name="priority" defaultValue="P1" className={field}>{PRIORITIES.map((x) => <option key={x}>{x}</option>)}</select></label>
              <label className="grid gap-1 text-sm">Owner<input name="owner" maxLength={100} className={field} /></label>
            </div>
            <button className={`${button.primary} justify-self-end`}>Add follow-up</button>
          </form>
        </Modal>
      )}
    </>}>
      {!fus.length ? <p className="px-5 py-4 text-sm text-sub">No follow-ups yet. Add what should change so this does not happen again (prevent), is seen sooner (detect) or hurts less (mitigate).</p> : (
        <ul className="divide-y divide-line">
          {fus.map((f) => {
            const old = !f.done_at && Date.now() - new Date(f.created_at).getTime() > 30 * 86_400_000;
            return (
              <li key={f.id} className={`flex items-center gap-3 px-5 py-2.5 text-sm ${f.done_at ? 'text-sub' : ''}`}>
                <span className={`w-8 shrink-0 rounded text-center text-[11px] ${PRIO_CLS[f.priority]}`}>{f.priority}</span>
                <span className="w-16 shrink-0 text-xs text-sub">{f.type}</span>
                <span className={`min-w-0 flex-1 ${f.done_at ? 'line-through decoration-sub/50' : ''}`}>{f.action}
                  {old && <span className="ml-2 rounded bg-sev2/15 px-1.5 text-[11px] text-sev2">open over 30 days</span>}</span>
                <span className="flex w-36 shrink-0 items-center justify-end gap-2">
                  {f.issue_number === null ? (
                    canEdit && <form action={createIssueAction.bind(null, inc.id, f.id)}><button className={`${button.quiet} h-7 text-xs`}>Create issue</button></form>
                  ) : (
                    <>
                      <span className="text-xs" title={`mock issue; labels ${f.issue_labels?.join(', ')}`}>#{f.issue_number}</span>
                      <form action={followUpDoneAction.bind(null, inc.id, f.id, !f.done_at)}>
                        <button className="text-xs text-sub underline underline-offset-2 hover:text-ink">{f.done_at ? 'Reopen' : 'Done'}</button>
                      </form>
                    </>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

// Two columns: what to act on (left) and the context behind it (right).
function SummaryTab({ inc, live, pages, cps, sus, during, prio, signs, fus }: { inc: Incident; live: boolean; pages: SentPage[]; cps: Checkpoint[]; sus: Suspect[]; during: Suspect[]; prio: Priority | null; signs: FirstSign[]; fus: FollowUp[] }) {
  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_21rem]">
      <div className="min-w-0 space-y-5">
        <Panel title="Status" aside={live && (<>
          {inc.state !== 'candidate' && (
            <Modal label="Change severity" title="Change severity" buttonClass={button.quiet}>
              <form action={sevAction.bind(null, inc.id)} className="grid gap-3">
                <select name="sev" defaultValue={inc.sev ?? 3} className={field} aria-label="Severity">
                  {[1, 2, 3, 4].map((s) => <option key={s} value={s}>SEV{s}</option>)}
                </select>
                <button className={`${button.primary} justify-self-end`}>Save severity</button>
              </form>
            </Modal>
          )}
          <Modal label="Edit status" title="Edit status" buttonClass={button.quiet}>
            <form action={summaryAction.bind(null, inc.id)} className="grid gap-3">
              <label className="grid gap-1 text-sm">Status<input name="status_line" defaultValue={inc.status_line} placeholder="Where things stand, in one line" className={field} /></label>
              <label className="grid gap-1 text-sm">Impact<input name="impact" defaultValue={inc.impact} placeholder="Who or what is affected" className={field} /></label>
              <label className="grid gap-1 text-sm">Next update (UTC)
                <input type="datetime-local" name="next_update_at" defaultValue={inc.next_update_at ? new Date(inc.next_update_at).toISOString().slice(0, 16) : ''} className={field} />
              </label>
              <button className={`${button.primary} justify-self-end`}>Save status</button>
            </form>
          </Modal>
        </>)}>
          <div className="px-5 py-4">
            <p className="text-xl font-medium leading-snug">{inc.status_line || <span className="text-sub">No status yet</span>}</p>
            <div className="mt-3 rounded-lg bg-canvas px-4 py-2.5 text-[15px]"><span className="mr-2 text-xs font-medium text-sub">Impact</span>{inc.impact || <span className="text-sub">not described</span>}</div>
          </div>
        </Panel>
        <CheckpointPanel inc={inc} cps={cps} live={live} />
        <FollowUpsPanel inc={inc} fus={fus} />
      </div>
      <div className="min-w-0 space-y-5">
        {prio && <PriorityPanel p={prio} />}
        <PagingPanel inc={inc} pages={pages} />
        <SuspectPanel sus={sus} during={during} />
        <FirstSignsPanel inc={inc} signs={signs} />
      </div>
    </div>
  );
}

function AlertsTab({ id, live, alerts, chgs }: { id: string; live: boolean; alerts: Alert[]; chgs: Chg[] }) {
  const canSplit = live && alerts.length > 1;
  const topo = topology();
  // Alerts that started inside an implementing CHG window on their component are marked, never hidden.
  const during = (a: Alert) => {
    const comps = topo.nodes.filter((n) => n.alerts?.includes(a.alertname)).map((n) => n.id);
    const at = new Date(a.starts_at);
    return chgs.find((c) => (c.status === 'implementing' || c.status === 'pir' || c.status === 'closed') && c.window.start <= at && (!c.window.end || c.window.end >= at) && c.components.some((x) => comps.includes(x)));
  };
  const sorted = [...alerts].sort((a, b) => Number(b.status === 'firing') - Number(a.status === 'firing'));
  return (
    <Section>
      <form action={splitAction.bind(null, id)}>
      {canSplit && (
        <div className="-mt-2 mb-2 flex items-center gap-3 text-sm text-sub">
          <span>Wrongly grouped? Tick alerts and move them to a new candidate.</span>
          <button className={`${button.quiet} ml-auto`}>Move to new candidate</button>
        </div>
      )}
      <ul className="divide-y divide-line">
        {sorted.map((a) => (
          <li key={a.fingerprint + a.starts_at} className="py-3">
            <div className="flex items-center gap-2">
              {canSplit && <input type="checkbox" name="alert" value={`${a.fingerprint}|${new Date(a.starts_at).toISOString()}`} aria-label={`Select ${a.alertname}`} className="size-4 accent-ink" />}
              <span className={`size-2 rounded-full ${a.status === 'firing' ? 'bg-sev1' : 'bg-emerald-600'}`} />
              <span className="font-medium">{a.alertname}</span>
              {a.component && <span className="rounded-md bg-line/60 px-1.5 text-xs">{a.component}</span>}
              <span className="rounded-md border border-line px-1.5 text-xs text-sub">{a.severity}</span>
              {during(a) && <span className="rounded bg-sev3/15 px-1.5 text-xs text-sev3">during {during(a)!.id}</span>}
              <span className={`ml-auto text-sm ${a.status === 'firing' ? 'font-medium text-sev1' : 'text-sub'}`}>{a.status === 'firing' ? 'Firing' : 'Cleared'}</span>
            </div>
            <p className="mt-1 pl-4 text-sm">{a.annotations.summary}</p>
            <p className="mt-0.5 pl-4 text-xs text-sub"><Ts at={a.starts_at} />{a.ends_at && <> → <Ts at={a.ends_at} />, <Elapsed from={a.starts_at} until={a.ends_at} /></>}</p>
          </li>
        ))}
      </ul>
      </form>
    </Section>
  );
}

// One runbook at a time, picked from tabs that show each one's step progress.
function RunbookTab({ inc, live, rbs, steps, pick }: { inc: Incident; live: boolean; rbs: ReturnType<typeof matchRunbooks>; steps: RunbookStep[]; pick: string | null }) {
  if (!rbs.length) return <p className="text-sm text-sub">No runbook matches these alerts or components. Write one in lineth-observability <code>runbooks/</code>.</p>;
  const cur = rbs.find((x) => x.r.id === pick) ?? rbs[0];
  const progress = (r: (typeof rbs)[number]['r']) => {
    const keys = r.sections.flatMap((s) => s.blocks.flatMap((b) => (b.kind === 'step' ? [b.key] : [])));
    return { done: keys.filter((k) => steps.some((s) => s.runbook === r.id && s.step_key === k)).length, total: keys.length };
  };
  const view = (
    <RunbookView rb={cur.r} incident={inc.id} steps={steps} live={live} grafana={process.env.GRAFANA_URL ?? null}
      range={{ from: String(new Date(inc.detected_at).getTime() - 3600_000), to: inc.resolved_at ? String(new Date(inc.resolved_at).getTime() + 3600_000) : 'now' }}
      matched={cur.by.length ? `matched by ${cur.by.join(', ')}` : `matched by component ${cur.comps.join(', ')}`} />
  );
  if (rbs.length === 1) return view;
  // Several runbooks: a list on the left (title, why it matched, progress), the chosen one on the right.
  return (
    <div className="grid gap-6 lg:grid-cols-[15rem_1fr]">
      <nav aria-label="Runbooks" className="lg:sticky lg:top-4 lg:self-start">
        <div className="mb-2 text-xs text-sub">{rbs.length} runbooks match</div>
        <ul className="space-y-1">
          {rbs.map((x) => {
            const on = x === cur;
            const p = progress(x.r);
            return (
              <li key={x.r.id}>
                <Link href={`/incidents/${inc.id}?tab=runbook&rb=${x.r.id}`} scroll={false} aria-current={on ? 'page' : undefined}
                  className={`block rounded-lg border px-3 py-2 ${on ? 'border-ink bg-ink/[0.03] shadow-[inset_3px_0_0_var(--ink)]' : 'border-transparent hover:border-line'}`}>
                  <span className={`block text-sm leading-snug ${on ? 'font-semibold' : ''}`}>{x.r.title}</span>
                  <span className="mt-0.5 block truncate text-xs text-sub" title={x.by.join(', ') || x.comps.join(', ')}>
                    {x.by.length ? x.by.map((a) => a.replace(/^LinethL[12]/, '')).join(', ') : `component ${x.comps.join(', ')}`}
                  </span>
                  <span className="mt-1.5 flex items-center gap-2">
                    <span className="h-1 flex-1 overflow-hidden rounded-full bg-line"><span className={`block h-full ${p.done === p.total && p.total ? 'bg-emerald-600' : 'bg-ink'}`} style={{ width: `${p.total ? (p.done / p.total) * 100 : 0}%` }} /></span>
                    <span className="text-[11px] tabular-nums text-sub">{p.done}/{p.total}</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="min-w-0">{view}</div>
    </div>
  );
}

function RolesTab({ inc, live, items, previewSev }: { inc: Incident; live: boolean; items: ChecklistItem[]; previewSev: number | null }) {
  const editable = live && !previewSev;
  const now = currentPhase(inc.state);
  const added = items.filter((i) => i.template_key === null);
  const yaml = ROLES.filter((r) => added.some((i) => i.role === r))
    .map((r) => `${r}:\n${added.filter((i) => i.role === r).map((i) => `  - {key: ${r}-${i.id}, phase: ${i.phase}, text: ${JSON.stringify(i.text)}}`).join('\n')}`).join('\n');

  return (
    <div className="space-y-6">
      {previewSev && (
        <p className="rounded-lg border border-sev2/40 bg-sev2/5 px-4 py-3 text-sm">
          <b>Preview for SEV{previewSev}{inc.sev ? '' : ' (suggested)'}.</b> Declaring the incident creates these checklists; items can be checked after that.
        </p>
      )}
      {live && (
        <div className="flex justify-end">
          <Modal label="Assign roles" title="Assign roles" buttonClass={button.quiet}>
            <div className="grid gap-4">
              {ROLES.map((r) => (
                <form key={r} action={roleAction.bind(null, inc.id, r)} className="grid gap-1.5">
                  <span className="text-sm font-medium">{ROLE_LABEL[r]}</span>
                  <div className="flex gap-2">
                    <input name="who" defaultValue={inc.roles[r]?.who} placeholder="Name" className={`${field} w-36`} />
                    <input name="doing" defaultValue={inc.roles[r]?.doing} placeholder="Working on" className={field} />
                    <button className={button.quiet}>Save</button>
                  </div>
                </form>
              ))}
              <p className="text-xs text-sub">Leave the name empty to hand the role back to the commander.</p>
            </div>
          </Modal>
        </div>
      )}

      <div className="grid gap-x-10 gap-y-8 lg:grid-cols-2">
        {ROLES.map((r) => {
          const s = inc.roles[r];
          const mine = items.filter((i) => i.role === r);
          const doneCount = mine.filter((i) => i.done_at).length;
          return (
            <section key={r} className="border-t-2 border-ink pt-3">
              <header className="flex items-baseline gap-3">
                <h2 className="text-[15px] font-semibold">{ROLE_LABEL[r]}</h2>
                {mine.length > 0 && <span className={`ml-auto text-sm ${doneCount === mine.length ? 'text-emerald-700' : 'text-sub'}`}>{doneCount}/{mine.length}</span>}
              </header>
              <p className="text-xs text-sub">{ROLE_JOB[r]}</p>
              <div className="mt-2 text-sm">
                {s?.who ? <><b className="font-medium">{s.who}</b>{s.doing && <span className="text-sub">, {s.doing}</span>}</>
                  : r === 'ic' ? <span className="text-sev2">Unassigned</span> : <span className="text-sub">Held by the commander</span>}
              </div>

              {PHASES.map((ph) => {
                const list = mine.filter((i) => i.phase === ph);
                if (!list.length) return null;
                const n = list.filter((i) => i.done_at).length;
                const complete = n === list.length;
                // A finished phase folds to one line; open it to read the notes.
                return (
                  <details key={ph} open={!complete} className="group/ph mt-4">
                    <summary className="mb-1.5 flex cursor-pointer list-none items-center gap-2 text-xs [&::-webkit-details-marker]:hidden">
                      <span aria-hidden className="text-[9px] text-sub transition-transform group-open/ph:rotate-90">▶</span>
                      <span className={ph === now ? 'font-semibold text-ink' : 'text-sub'}>{PHASE_LABEL[ph]}</span>
                      {ph === now && editable && <span className="rounded bg-accent px-1.5 text-[11px] font-semibold text-ink">Now</span>}
                      <span className={`ml-auto ${complete ? 'text-emerald-700' : 'text-sub'}`}>{complete ? '✓ ' : ''}{n}/{list.length}</span>
                    </summary>
                    <ul className="space-y-1">
                      {list.map((i) => (
                        <li key={i.id}>
                          <ChecklistRow incId={inc.id} item={i} editable={editable} />
                        </li>
                      ))}
                    </ul>
                  </details>
                );
              })}

              {editable && (
                <div className="mt-4 border-t border-line pt-3">
                  <Modal label="Add item" title={`Add to the ${ROLE_LABEL[r].toLowerCase()} checklist`} buttonClass={button.quiet}>
                    <form action={addItemAction.bind(null, inc.id, r)} className="grid gap-3">
                      <label className="grid gap-1 text-sm">Item<input name="text" required maxLength={300} placeholder="What needs doing" className={field} /></label>
                      <label className="grid gap-1 text-sm">When
                        <select name="phase" defaultValue={now} className={field}>
                          {PHASES.map((ph) => <option key={ph} value={ph}>{PHASE_LABEL[ph]}</option>)}
                        </select>
                      </label>
                      <button className={`${button.primary} justify-self-end`}>Add item</button>
                    </form>
                  </Modal>
                </div>
              )}
            </section>
          );
        })}
      </div>

      {!live && added.length > 0 && (
        <Section title="Added during this incident" aside={<CopyButton text={yaml} />}>
          <p className="text-sm text-sub">Belongs in every incident? Add it to checklists.yaml.</p>
          <pre className="mt-3 overflow-x-auto rounded-lg border border-line p-3 text-xs">{yaml}</pre>
        </Section>
      )}
    </div>
  );
}

// Open item: the checkbox asks how it was handled, then checks it off. Done item: shows that note, with edit and reopen.
function ChecklistRow({ incId, item: i, editable }: { incId: string; item: ChecklistItem; editable: boolean }) {
  const box = (done: boolean) => (
    <span aria-hidden className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border text-[11px] ${done ? 'border-ink bg-ink text-white' : 'border-sub/50 bg-surface'}`}>{done ? '✓' : ''}</span>
  );
  if (!i.done_at) {
    const row = (
      <span className="flex w-full items-start gap-2.5 text-left">
        {box(false)}
        <span className="min-w-0">{i.text}{i.added_by && <span className="block text-xs text-sub">added by {i.added_by}</span>}</span>
      </span>
    );
    if (!editable) return <div className="px-1.5 py-1 text-sm">{row}</div>;
    return (
      <Modal label={`Mark done: ${i.text}`} title="Mark done" buttonClass="w-full rounded-md px-1.5 py-1 text-sm hover:bg-sev4/10" trigger={row}>
        <form action={completeItemAction.bind(null, incId, i.id)} className="grid gap-3">
          <p className="text-sm font-medium">{i.text}</p>
          <label className="grid gap-1 text-sm">How was it handled?
            <textarea name="note" rows={4} maxLength={2000} placeholder="What you did and what you found. Optional, but it is what the postmortem will need." className={`${field} h-auto py-2`} />
          </label>
          <button className={`${button.primary} justify-self-end`}>Mark done</button>
        </form>
      </Modal>
    );
  }
  return (
    <div className="group/row rounded-md px-1.5 py-1 text-sm">
      <div className="flex items-start gap-2.5">
        {box(true)}
        <div className="min-w-0 flex-1">
          <span className="text-sub line-through decoration-sub/50">{i.text}</span>
          {i.note
            ? <p className="mt-1 whitespace-pre-wrap border-l-2 border-ink pl-2.5 text-ink">{i.note}</p>
            : <p className="mt-0.5 text-xs text-sev2">No note</p>}
          <div className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-sub">
            <span>{i.done_by} · <Ts at={i.done_at} /></span>
            {editable && (
              <span className="flex gap-3 opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100">
                <Modal label={i.note ? 'Edit note' : 'Add note'} title="How was it handled?" buttonClass="underline underline-offset-2 hover:text-ink">
                  <form action={itemNoteAction.bind(null, incId, i.id)} className="grid gap-3">
                    <p className="text-sm font-medium">{i.text}</p>
                    <textarea name="note" rows={4} maxLength={2000} defaultValue={i.note ?? ''} className={`${field} h-auto py-2`} />
                    <button className={`${button.primary} justify-self-end`}>Save note</button>
                  </form>
                </Modal>
                <form action={reopenItemAction.bind(null, incId, i.id)}><button className="underline underline-offset-2 hover:text-ink">Reopen</button></form>
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
