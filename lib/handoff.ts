// Shift handoff (PRD F5, P1: raw collection, no AI summary). For the shift that is ending:
//   1 open incidents (latest checkpoint first) · 2 alerts in the shift, grouped, flapping = fired 3+ times
//   3 components that got worse (stage at shift start vs end) · 4 SLO budget change · 5 changes (CHGs in progress,
//   Flux events) · 6 the outgoing person's note.
// Flow: a draft 30 min before the shift ends → outgoing marks it ready (data frozen) → incoming acknowledges.
// Not acknowledged 15 min into the next shift → one mock page.
import type pg from 'pg';
import { chgs, inProgress } from './chg.ts';
import { PHASE_LABEL, currentPhase } from './checklists.ts';
import type { State } from './lifecycle.ts';
import { priorities } from './priority.ts';
import { pool, tx } from './db.ts';
import { anchor, demoSlos, isDemo } from './demo.ts';
import { query } from './prom.ts';
import { shifts } from './shifts.ts';
import { STAGES, stagesAt, type Stage } from './stages.ts';
import { shiftWindow } from './time.ts';
import { topology, type Topology } from './topology.ts';

export const DRAFT_BEFORE_MS = 30 * 60_000;
export const ACK_WITHIN_MS = 15 * 60_000;
export const FLAPPING = 3;

export type HandoffData = {
  from: string; to: string;
  incidents: {
    id: string; title: string; sev: number | null; sev_suggested?: number | null; state: string; checkpoint: string | null; handoff_to: string | null;
    components?: string[]; firing?: string[];
    // actionable facts, frozen at hand-over (timers are recomputed from these times when shown)
    detected_at?: string; ic?: string | null; next_update_at?: string | null; action?: string | null; action_eta?: string | null;
    next_step?: string | null; wake?: { state: string; expr: string } | null; open_items?: number; phase?: string; unacked?: boolean; cause?: string | null;
  }[];
  alerts: { alertname: string; severity: string; count: number; firing: number; flapping: boolean; incident_id: string; first_at?: string }[];
  worse: { component: string; from: Stage; to: Stage; reason: string | null }[];
  slo: { name: string; from: number | null; to: number | null }[];
  chgs: { id: string; title: string; risk: string; href: string; start?: string; components?: string[] }[];
  // Every incident that changed during the shift, open or not: its state path and turning points.
  story?: {
    id: string; title: string; sev: number | null; state: string; path: string[]; detected_at: string; resolved_at: string | null; cause?: string | null;
    events: { at: string; kind: string; text: string }[]; more: number; updates: number;
    // the incident's state over the shift, for the timeline bar, and every turning point as a marker
    segments?: { state: string; from: string; to: string }[]; changes?: { state: string; at: string }[]; marks?: { at: string; kind: string; text: string; what?: string; why?: string }[];
  }[];
  flux: { at: string; severity: string; object: string; message: string }[];
};
export type Handoff = {
  id: string; shift_id: string; shift_start: Date; shift_end: Date; to_shift_id: string; from_people: string[]; to_people: string[];
  status: 'draft' | 'ready' | 'acked'; note: string; notes: Record<string, string>; data: HandoffData | null; created_at: Date;
  ready_at: Date | null; ready_by: string | null; acked_at: Date | null; acked_by: string | null; paged_at: Date | null; reads: string[] | null;
};

// Pure: alerts in the shift grouped by name (and severity); fired 3+ times = flapping.
export function groupAlerts(rows: { alertname: string; severity: string; status: string; incident_id: string; starts_at?: Date }[]): HandoffData['alerts'] {
  const by = new Map<string, HandoffData['alerts'][number]>();
  for (const r of rows) {
    const k = `${r.alertname}/${r.severity}`;
    const g = by.get(k) ?? { alertname: r.alertname, severity: r.severity, count: 0, firing: 0, flapping: false, incident_id: r.incident_id };
    const at = r.starts_at ? new Date(r.starts_at).toISOString() : undefined;
    if (at && (!g.first_at || at < g.first_at)) g.first_at = at;
    g.count++;
    if (r.status === 'firing') g.firing++;
    g.flapping = g.count >= FLAPPING;
    by.set(k, g);
  }
  return [...by.values()].sort((a, b) => Number(b.flapping) - Number(a.flapping) || Number(b.severity === 'critical') - Number(a.severity === 'critical') || b.count - a.count);
}

const RANK = Object.fromEntries(STAGES.map((s, i) => [s, STAGES.length - i])) as Record<Stage, number>; // breach highest

// Turning points worth retelling (alert churn, checklist ticks, runbook steps and notes stay in the incident).
const STORY_KINDS = ['state', 'sev', 'decision', 'checkpoint', 'wake', 'reopen', 'merge', 'split', 'ack'];
const MAX_EVENTS = 6;

export function storyText(kind: string, b: Record<string, unknown>): string {
  const str = (k: string) => (typeof b[k] === 'string' ? (b[k] as string) : '');
  switch (kind) {
    case 'state': return `${str('from')} → ${str('to')}`;
    case 'sev': return `SEV ${b.from ?? '—'} → ${b.to}`;
    case 'decision': return `Decision: ${str('decision')}${str('reason') ? ` (why: ${str('reason')})` : ''}`;
    case 'checkpoint': return `Checkpoint: ${str('status_line')}`;
    case 'wake': return 'Wake condition met; paged the IC';
    case 'reopen': return `Reopened: ${str('reason')}`;
    case 'merge': return b.into ? `Merged into #${b.into}` : `Merged in #${b.from}`;
    case 'split': return b.to ? `Split alerts out to #${b.to}` : `Split from #${b.from}`;
    case 'ack': return `Page acknowledged after ${Math.round(Number(b.mtta_s ?? 0))}s`;
    default: return kind;
  }
}

async function story(c: pg.Pool, from: Date, end: Date, t: Topology): Promise<NonNullable<HandoffData['story']>> {
  const { rows } = await c.query<{ id: string; title: string; sev: number | null; state: string; detected_at: Date; resolved_at: Date | null; created_at: Date }>(
    `SELECT i.id::text, i.title, i.sev, i.state, i.detected_at, i.resolved_at, i.created_at FROM incidents i
     WHERE i.created_at BETWEEN $1 AND $2 OR EXISTS (SELECT 1 FROM timeline t WHERE t.incident_id = i.id AND t.kind = ANY($3) AND t.at BETWEEN $1 AND $2)
     ORDER BY (i.state IN ('candidate','declared','mitigated')) DESC, coalesce(i.sev, 5), i.id`, [from, end, STORY_KINDS]);
  const prio = await priorities(c, t, new Map(), rows.map((r) => r.id));
  return Promise.all(rows.map(async (i) => {
    const ev = (await c.query<{ at: Date; kind: string; body: Record<string, unknown> }>(
      'SELECT at, kind, body FROM timeline WHERE incident_id = $1 AND at BETWEEN $2 AND $3 ORDER BY at, id', [i.id, from, end])).rows;
    const key = ev.filter((e) => STORY_KINDS.includes(e.kind));
    const states = key.filter((e) => e.kind === 'state' || e.kind === 'reopen');
    const path = states.length
      ? [String(states[0].body.from ?? (states[0].kind === 'reopen' ? 'resolved' : i.state)), ...states.map((e) => String(e.kind === 'reopen' ? 'declared' : e.body.to))]
      : [i.state];
    if (!states.length && i.created_at >= from) path.unshift('new');
    const shown = key.slice(-MAX_EVENTS);
    // State segments across the shift: from the shift start (or when it appeared) to each change, up to the end.
    const segments: { state: string; from: string; to: string }[] = [];
    let cur = path[0] === 'new' ? path[1] ?? i.state : path[0];
    let t = i.created_at > from ? i.created_at : from;
    for (const e of states) {
      segments.push({ state: cur, from: t.toISOString(), to: e.at.toISOString() });
      cur = String(e.kind === 'reopen' ? 'declared' : e.body.to);
      t = e.at;
    }
    segments.push({ state: cur, from: t.toISOString(), to: end.toISOString() });
    return {
      segments: segments.filter((x) => x.to > x.from),
      changes: states.map((e) => ({ state: String(e.kind === 'reopen' ? 'declared' : e.body.to), at: e.at.toISOString() })),
      marks: key.filter((e) => e.kind !== 'state').slice(-30).map((e) => ({
        at: e.at.toISOString(), kind: e.kind, text: storyText(e.kind, e.body),
        ...(e.kind === 'decision' ? { what: String(e.body.decision ?? ''), why: String(e.body.reason ?? '') } : {}),
        ...(e.kind === 'checkpoint' ? { what: String(e.body.status_line ?? ''), why: String(e.body.next_step ?? '') } : {}),
      })),
      id: i.id, title: i.title, sev: i.sev, state: i.state, path, cause: prio.get(i.id)?.cause ?? null, detected_at: i.detected_at.toISOString(), resolved_at: i.resolved_at?.toISOString() ?? null,
      events: shown.map((e) => ({ at: e.at.toISOString(), kind: e.kind, text: storyText(e.kind, e.body) })), more: key.length - shown.length, updates: ev.length,
    };
  }));
}

export async function collect(c: pg.Pool, from: Date, to: Date): Promise<HandoffData> {
  const t = topology();
  const end = new Date(Math.min(to.getTime(), Date.now()));
  const [inc, al, flux, before, after, budgetFrom, budgetTo, chgList] = await Promise.all([
    c.query<HandoffData['incidents'][number]>(
      `SELECT i.id::text, i.title, i.sev, i.sev_suggested, i.state, i.detected_at, i.roles->'ic'->>'who' AS ic, i.next_update_at,
              (i.acked_at IS NULL AND EXISTS (SELECT 1 FROM pages p WHERE p.incident_id = i.id AND p.kind = 'escalation' AND p.step > 0)) AS unacked,
              (SELECT nullif(k.action, '') FROM checkpoints k WHERE k.incident_id = i.id ORDER BY k.id DESC LIMIT 1) AS action,
              (SELECT k.action_eta FROM checkpoints k WHERE k.incident_id = i.id ORDER BY k.id DESC LIMIT 1) AS action_eta,
              (SELECT nullif(k.next_step, '') FROM checkpoints k WHERE k.incident_id = i.id ORDER BY k.id DESC LIMIT 1) AS next_step,
              (SELECT json_build_object('state', k.wake_state, 'expr', k.wake_expr) FROM checkpoints k WHERE k.incident_id = i.id AND k.wake_state IS NOT NULL ORDER BY k.id DESC LIMIT 1) AS wake,
              (SELECT k.status_line FROM checkpoints k WHERE k.incident_id = i.id ORDER BY k.id DESC LIMIT 1) AS checkpoint,
              (SELECT nullif(k.handoff_to, '') FROM checkpoints k WHERE k.incident_id = i.id ORDER BY k.id DESC LIMIT 1) AS handoff_to,
              coalesce((SELECT array_agg(DISTINCT a.component) FROM alerts a WHERE a.incident_id = i.id AND a.component IS NOT NULL), '{}') AS components,
              coalesce((SELECT array_agg(DISTINCT a.alertname) FROM alerts a WHERE a.incident_id = i.id AND a.status = 'firing'), '{}') AS firing
       FROM incidents i WHERE i.state IN ('candidate','declared','mitigated')
       ORDER BY (i.state <> 'candidate') DESC, coalesce(i.sev, i.sev_suggested, 5), i.detected_at`),
    c.query<{ alertname: string; severity: string; status: string; incident_id: string; starts_at: Date }>(
      'SELECT alertname, severity, status, incident_id::text, starts_at FROM alerts WHERE starts_at >= $1 AND starts_at < $2', [from, end]),
    c.query<{ at: Date; severity: string; object_kind: string; object_name: string; message: string }>(
      'SELECT at, severity, object_kind, object_name, message FROM change_events WHERE at >= $1 AND at < $2 ORDER BY at DESC LIMIT 30', [from, end]),
    stagesAt(c, t, from).catch(() => null),
    stagesAt(c, t, end.getTime() >= Date.now() - 60_000 ? undefined : end).catch(() => null),
    budgetAt(c, from),
    budgetAt(c, end),
    chgs(),
  ]);
  const worse = before && after ? t.nodes.flatMap((n) => {
    const a = before.nodes[n.id]?.stage, b = after.nodes[n.id]?.stage;
    return a && b && RANK[b] > RANK[a] && b !== 'unknown' ? [{ component: n.id, from: a, to: b, reason: after.nodes[n.id].reasons[0]?.text ?? null }] : [];
  }) : [];
  const bf = new Map(budgetFrom.map((r) => [r.metric.slo, Number(r.value[1])]));
  const bt = new Map(budgetTo.map((r) => [r.metric.slo, Number(r.value[1])]));
  const slo = [...new Set([...bf.keys(), ...bt.keys()])].map((name) => ({ name, from: bf.get(name) ?? null, to: bt.get(name) ?? null }))
    .sort((a, b) => ((b.from ?? 0) - (b.to ?? 0)) - ((a.from ?? 0) - (a.to ?? 0)));
  // Open checklist items in the phase the incident is in now, and the probable cause.
  const prio = await priorities(c, t, new Map(), inc.rows.map((i) => i.id));
  const incidents = await Promise.all(inc.rows.map(async (i) => {
    const phase = currentPhase(i.state as State);
    const open = (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM checklist_items WHERE incident_id = $1 AND phase = $2 AND done_at IS NULL', [i.id, phase])).rows[0].n;
    const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
    return { ...i, detected_at: iso(i.detected_at)!, next_update_at: iso(i.next_update_at), action_eta: iso(i.action_eta), open_items: open, phase: PHASE_LABEL[phase], cause: prio.get(i.id)?.cause ?? null };
  }));
  return {
    from: from.toISOString(), to: to.toISOString(),
    story: await story(c, from, end, t),
    incidents, alerts: groupAlerts(al.rows), worse, slo,
    chgs: inProgress(chgList.chgs, end).map((x) => ({ id: x.id, title: x.title, risk: x.risk, href: x.href, start: x.window.start.toISOString(), components: x.components })),
    flux: flux.rows.map((r) => ({ at: r.at.toISOString(), severity: r.severity, object: `${r.object_kind} ${r.object_name}`, message: r.message.split('\n')[0] })),
  };
}

const COLS = 'id::text, shift_id, shift_start, shift_end, to_shift_id, from_people, to_people, status, note, notes, data, created_at, ready_at, ready_by, acked_at, acked_by, paged_at, reads';

export async function handoffs(c: pg.Pool | pg.PoolClient, limit = 20): Promise<Handoff[]> {
  return (await c.query<Handoff>(`SELECT ${COLS} FROM handoffs ORDER BY shift_start DESC LIMIT $1`, [limit])).rows;
}
export async function handoff(c: pg.Pool | pg.PoolClient, id: string): Promise<Handoff | null> {
  if (!/^\d+$/.test(id)) return null;
  return (await c.query<Handoff>(`SELECT ${COLS} FROM handoffs WHERE id = $1`, [id])).rows[0] ?? null;
}

// The draft for the shift running at `now` (idempotent).
export async function ensureDraft(c: pg.Pool | pg.PoolClient, now = new Date()): Promise<string> {
  const w = shiftWindow(now, shifts());
  await c.query(
    `INSERT INTO handoffs (shift_id, shift_start, shift_end, to_shift_id, from_people, to_people)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (shift_id, shift_start) DO NOTHING`,
    [w.shift.id, w.start, w.end, w.next.id, w.shift.roster, w.next.roster]);
  return (await c.query<{ id: string }>('SELECT id::text FROM handoffs WHERE shift_id = $1 AND shift_start = $2', [w.shift.id, w.start])).rows[0].id;
}

async function lockHandoff(c: pg.PoolClient, id: string) {
  if (!/^\d+$/.test(id)) throw new Error('invalid handoff');
  const h = (await c.query<Handoff>(`SELECT ${COLS} FROM handoffs WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!h) throw new Error('handoff not found');
  return h;
}

// A note on one incident of the handoff (kept beside it on the card).
export async function setIncidentNote(c: pg.PoolClient, id: string, incidentId: string, note: string) {
  if (!/^\d+$/.test(incidentId)) throw new Error('invalid incident');
  const r = await c.query("UPDATE handoffs SET notes = CASE WHEN $3 = '' THEN notes - $2 ELSE jsonb_set(notes, ARRAY[$2], to_jsonb($3::text)) END WHERE id = $1 AND status <> 'acked'", [id, incidentId, note.trim().slice(0, 2000)]);
  if (!r.rowCount) throw new Error('handoff not found or already acknowledged');
}

export async function setNote(c: pg.PoolClient, id: string, note: string) {
  const h = await lockHandoff(c, id);
  if (h.status === 'acked') throw new Error('this handoff was already acknowledged');
  await c.query('UPDATE handoffs SET note = $2 WHERE id = $1', [id, note.slice(0, 4000)]);
}

// Outgoing: freeze what was collected so the incoming person reads exactly what was handed over.
export async function markReady(c: pg.PoolClient, id: string, actor: string, data: HandoffData) {
  const h = await lockHandoff(c, id);
  if (h.status !== 'draft') throw new Error(`handoff is ${h.status}`);
  await c.query("UPDATE handoffs SET status = 'ready', data = $2, ready_at = now(), ready_by = $3 WHERE id = $1", [id, data, actor]);
}

// What the incoming person must tick as read: the note (if any), every open incident, and the "not in an incident" box.
export function readItems(d: HandoffData, note: string): string[] {
  const claimedAlerts = new Set(d.incidents.flatMap((i) => i.firing ?? d.alerts.filter((a) => a.incident_id === i.id && a.firing > 0).map((a) => a.alertname)));
  const claimedComps = new Set(d.incidents.flatMap((i) => i.components ?? []));
  const stray = d.alerts.some((a) => a.firing > 0 && !claimedAlerts.has(a.alertname)) || d.worse.some((x) => !claimedComps.has(x.component));
  return [...(note.trim() ? ['note'] : []), ...d.incidents.map((i) => `inc:${i.id}`), ...(stray ? ['stray'] : [])];
}

// Incoming: acknowledge after reading every item (freezing the data now if it was never handed over).
export async function acknowledge(c: pg.PoolClient, id: string, actor: string, data: HandoffData | null, reads: string[] | null = null) {
  const h = await lockHandoff(c, id);
  if (h.status === 'acked') return;
  const d = h.data ?? data;
  if (reads && d) {
    const missing = readItems(d, h.note).filter((k) => !reads.includes(k));
    if (missing.length) throw new Error(`not everything was read yet: ${missing.join(', ')}`);
  }
  await c.query("UPDATE handoffs SET status = 'acked', data = coalesce(data, $2), acked_at = now(), acked_by = $3, reads = $4 WHERE id = $1", [id, data, actor, reads]);
}

// Timer (instrumentation.ts): draft 30 min before a shift ends; page once if the last handoff is still not
// acknowledged 15 min after its shift ended. ponytail: the page is mock (recorded on the handoff), like F10.
export async function handoffSweep(p: pg.Pool = pool(), now = new Date()) {
  const w = shiftWindow(now, shifts());
  if (w.end.getTime() - now.getTime() <= DRAFT_BEFORE_MS) await ensureDraft(p, now);
  await tx(async (c) => {
    const r = await c.query<{ id: string }>(
      `UPDATE handoffs SET paged_at = $1 WHERE status <> 'acked' AND paged_at IS NULL AND shift_end <= $1::timestamptz - make_interval(secs => $2)
       RETURNING id::text`, [now, ACK_WITHIN_MS / 1000]);
    for (const x of r.rows) console.warn(`handoff #${x.id} not acknowledged ${ACK_WITHIN_MS / 60000} min after the shift ended: paging (mock ntfy)`);
  }, p);
}

// SLO error budget left at an instant (the handoff's shift start and end).
async function budgetAt(c: pg.Pool, t: Date): Promise<{ metric: Record<string, string>; value: [number, string] }[]> {
  if (isDemo()) return demoSlos(await anchor(c), t).map((x) => ({ metric: { slo: x.name }, value: [t.getTime() / 1000, String(x.budgetRemaining)] }));
  return query('slo:error_budget_remaining:ratio', t).catch(() => []);
}
