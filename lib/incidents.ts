import type pg from 'pg';
import { CHECKLIST_ROLES, PHASES, itemsFor, template, type ChecklistRole, type Phase } from './checklists.ts';
import { pool, tx } from './db.ts';
import { reopen } from './ingest.ts';
import { OPEN, STAMP, suggestSev, transitionError, type Sev, type State } from './lifecycle.ts';
import { duePage, type Channel, type Priority } from './paging.ts';

export const ROLES = ['ic', 'ops', 'comms', 'planning'] as const;
export type Role = (typeof ROLES)[number];
export type RoleSlot = { who: string; doing: string; updated_at: string };

export type Incident = {
  id: string; title: string; state: State; sev: Sev | null; sev_suggested: Sev | null;
  status_line: string; impact: string; next_update_at: Date | null; roles: Partial<Record<Role, RoleSlot>>;
  acked_at: Date | null; acked_by: string | null;
  detected_at: Date; declared_at: Date | null; mitigated_at: Date | null; resolved_at: Date | null; closed_at: Date | null;
  alert_count: number; firing_count: number; open_follow_ups: number; overdue_follow_ups: number;
};
export type Alert = { fingerprint: string; component: string | null; alertname: string; severity: string; status: string; starts_at: Date; ends_at: Date | null; annotations: Record<string, string> };
export type SentPage = { id: string; kind: 'escalation' | 'wake' | 'triage'; step: number; channel: Channel; priority: Priority; message: string; sent_at: Date };
export type Event = { id: string; at: Date; kind: string; actor: string; body: Record<string, unknown> };

// bigserial ids come back from pg as strings.
const SELECT = `SELECT i.*,
  (SELECT count(*)::int FROM alerts a WHERE a.incident_id = i.id) AS alert_count,
  (SELECT count(*)::int FROM alerts a WHERE a.incident_id = i.id AND a.status = 'firing') AS firing_count,
  (SELECT count(*)::int FROM follow_ups f WHERE f.incident_id = i.id AND f.done_at IS NULL) AS open_follow_ups,
  (SELECT count(*)::int FROM follow_ups f WHERE f.incident_id = i.id AND f.done_at IS NULL AND f.created_at < now() - interval '30 days') AS overdue_follow_ups
  FROM incidents i`;

// Queue order until the catalog score lands (F8): open first, then firing, then worst SEV, then oldest.
export async function listIncidents(c: pg.Pool | pg.PoolClient): Promise<Incident[]> {
  const { rows } = await c.query<Incident>(`${SELECT}
    ORDER BY (i.state IN ('candidate','declared','mitigated')) DESC,
             (SELECT count(*) FROM alerts a WHERE a.incident_id = i.id AND a.status = 'firing') > 0 DESC,
             coalesce(i.sev, i.sev_suggested, 5), i.detected_at
    LIMIT 200`);
  return rows;
}

// For the global firing banner: how many alerts fire now and the worst one to jump to.
export async function firingSummary(c: pg.Pool | pg.PoolClient) {
  const { rows } = await c.query<{ alertname: string; severity: string; incident_id: string; total: number }>(
    `SELECT a.alertname, a.severity, a.incident_id::text, count(*) OVER ()::int AS total
     FROM alerts a WHERE a.status = 'firing'
     ORDER BY (a.severity = 'critical') DESC, a.starts_at LIMIT 1`);
  return rows[0] ?? null;
}

// Alerts for a component (by alertname): firing now or seen in the last 24 h, newest first.
export async function alertsNamed(c: pg.Pool | pg.PoolClient, names: string[]) {
  if (!names.length) return [];
  const { rows } = await c.query<{ alertname: string; severity: string; status: string; starts_at: Date; ends_at: Date | null; summary: string; incident_id: string; state: string }>(
    `SELECT a.alertname, a.severity, a.status, a.starts_at, a.ends_at, a.annotations->>'summary' AS summary, a.incident_id::text, i.state
     FROM alerts a JOIN incidents i ON i.id = a.incident_id
     WHERE a.alertname = ANY($1) AND (a.status = 'firing' OR coalesce(a.ends_at, a.starts_at) > now() - interval '24 hours')
     ORDER BY (a.status = 'firing') DESC, a.starts_at DESC LIMIT 20`, [names]);
  return rows;
}

export type Activity = Event & { incident_id: string; title: string };

// Cross-incident feed for the overview: newest first.
export async function recentActivity(c: pg.Pool | pg.PoolClient, limit = 20): Promise<Activity[]> {
  const { rows } = await c.query<Activity>(
    `SELECT t.id::text, t.at, t.kind, t.actor, t.body, t.incident_id::text, i.title
     FROM timeline t JOIN incidents i ON i.id = t.incident_id ORDER BY t.at DESC, t.id DESC LIMIT $1`, [limit]);
  return rows;
}

export async function getIncident(c: pg.Pool | pg.PoolClient, id: string) {
  const inc = (await c.query<Incident>(`${SELECT} WHERE i.id = $1`, [id])).rows[0];
  if (!inc) return null;
  const alerts = (await c.query<Alert>('SELECT * FROM alerts WHERE incident_id = $1 ORDER BY starts_at', [id])).rows;
  const timeline = (await c.query<Event>('SELECT id::text, at, kind, actor, body FROM timeline WHERE incident_id = $1 ORDER BY at DESC, id DESC', [id])).rows;
  const pages = (await c.query<SentPage>('SELECT id::text, kind, step, channel, priority, message, sent_at FROM pages WHERE incident_id = $1 ORDER BY sent_at, id', [id])).rows;
  return { inc, alerts, timeline, pages };
}

export async function event(c: pg.PoolClient, id: string, kind: string, actor: string, body: object) {
  await c.query('INSERT INTO timeline (incident_id, at, kind, actor, body) VALUES ($1, now(), $2, $3, $4)', [id, kind, actor, body]);
}

// Row lock + existence check. Closed/dismissed incidents are read-only.
export async function lock(c: pg.PoolClient, id: string, opts: { terminalOk?: boolean } = {}) {
  if (!/^\d+$/.test(id)) throw new Error('invalid incident id');
  const r = (await c.query<{ state: State; sev: Sev | null }>('SELECT state, sev FROM incidents WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!r) throw new Error(`incident ${id} not found`);
  if (!opts.terminalOk && (r.state === 'closed' || r.state === 'dismissed')) throw new Error(`incident ${id} is ${r.state}`);
  return r;
}

export async function transition(c: pg.PoolClient, id: string, to: State, actor: string) {
  const cur = await lock(c, id);
  const err = transitionError(cur.state, to, cur.sev);
  if (err) throw new Error(err);
  if (to === 'closed') {
    const n = (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM follow_ups WHERE incident_id = $1 AND issue_number IS NULL', [id])).rows[0].n;
    if (n) throw new Error(`${n} follow-up${n === 1 ? ' has' : 's have'} no issue yet; create them before closing`);
  }
  if (cur.state === 'resolved' && to === 'declared') {
    await reopen(c, id);
    await event(c, id, 'reopen', actor, { reason: 'reopened by operator' });
    return;
  }
  const stamp = STAMP[to];
  await c.query(`UPDATE incidents SET state = $2${stamp ? `, ${stamp} = now()` : ''} WHERE id = $1`, [id, to]);
  // Declaring makes the declarer IC unless someone already holds it (IMAG: IC owns every undelegated role).
  if (to === 'declared') {
    await seedChecklist(c, id, cur.sev!);
    await c.query(
      `UPDATE incidents SET roles = jsonb_set(roles, '{ic}', jsonb_build_object('who', $2::text, 'doing', 'incident command', 'updated_at', now()))
       WHERE id = $1 AND NOT roles ? 'ic'`, [id, actor]);
  }
  await event(c, id, 'state', actor, { from: cur.state, to });
  if (to === 'declared') await pageTick(c, id);
}

export async function setSev(c: pg.PoolClient, id: string, sev: Sev, actor: string) {
  if (![1, 2, 3, 4].includes(sev)) throw new Error('SEV must be 1–4');
  const cur = await lock(c, id);
  // Fixed once resolved: lowering SEV afterwards would skip the SEV1–2 postmortem rule.
  if (!OPEN.includes(cur.state)) throw new Error(`SEV cannot change once ${cur.state}`);
  if (cur.sev === sev) return;
  await c.query('UPDATE incidents SET sev = $2 WHERE id = $1', [id, sev]);
  await event(c, id, 'sev', actor, { from: cur.sev, to: sev });
  // A higher severity adds the template items that newly apply; nothing is removed when it goes down.
  if (cur.state === 'declared' || cur.state === 'mitigated') {
    await seedChecklist(c, id, sev);
    await pageTick(c, id);
  }
}

export async function setRole(c: pg.PoolClient, id: string, role: Role, who: string, doing: string, actor: string) {
  if (!ROLES.includes(role)) throw new Error('unknown role');
  await lock(c, id);
  // ponytail: any signed-in user may edit any role slot; per-role permissions arrive with multiple operators.
  if (!who.trim()) {
    await c.query('UPDATE incidents SET roles = roles - $2::text WHERE id = $1', [id, role]); // back to "held by IC" / unassigned
    await event(c, id, 'role', actor, { role, who: '', doing: '' });
    return;
  }
  await c.query(
    `UPDATE incidents SET roles = jsonb_set(roles, ARRAY[$2::text], jsonb_build_object('who', $3::text, 'doing', $4::text, 'updated_at', now()))
     WHERE id = $1`, [id, role, who.trim(), doing.trim()]);
  await event(c, id, 'role', actor, { role, who: who.trim(), doing: doing.trim() });
}

export async function setSummary(c: pg.PoolClient, id: string, s: { status_line: string; impact: string; next_update_at: Date | null }, actor: string) {
  await lock(c, id);
  await c.query('UPDATE incidents SET status_line = $2, impact = $3, next_update_at = $4 WHERE id = $1', [id, s.status_line.trim(), s.impact.trim(), s.next_update_at]);
  await event(c, id, 'summary', actor, { status_line: s.status_line.trim(), impact: s.impact.trim(), next_update_at: s.next_update_at });
}

export type DecisionBody = { decision: string; alternatives: string; reason: string; revert_when: string };

export async function addNote(c: pg.PoolClient, id: string, kind: 'note' | 'decision', body: { text: string } | DecisionBody, actor: string) {
  await lock(c, id);
  await event(c, id, kind, actor, body);
}

export type ChecklistItem = {
  id: string; role: ChecklistRole; phase: Phase; text: string; template_key: string | null;
  added_by: string | null; done_by: string | null; done_at: Date | null; note: string | null;
};

// Copy the template items for `sev` that this incident does not have yet (idempotent via template_key).
async function seedChecklist(c: pg.PoolClient, id: string, sev: Sev) {
  for (const i of itemsFor(template(), sev)) {
    await c.query(
      `INSERT INTO checklist_items (incident_id, role, phase, text, template_key) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (incident_id, template_key) DO NOTHING`, [id, i.role, i.phase, i.text, i.key]);
  }
}

export async function checklist(c: pg.Pool | pg.PoolClient, id: string): Promise<ChecklistItem[]> {
  const { rows } = await c.query<ChecklistItem>(
    `SELECT id::text, role, phase, text, template_key, added_by, done_by, done_at, note FROM checklist_items WHERE incident_id = $1
     ORDER BY array_position($2::text[], phase), template_key IS NULL, id`, [id, [...PHASES]]);
  return rows;
}

// Check an item off with how it was handled, or (done = false) put it back to open. Both go to the timeline.
export async function setItemDone(c: pg.PoolClient, id: string, itemId: string, done: boolean, note: string, actor: string) {
  await lock(c, id);
  if (!/^\d+$/.test(itemId)) throw new Error('invalid item');
  const n = note.trim().slice(0, 2000) || null;
  const { rows } = await c.query<{ role: string; text: string }>(
    done
      ? `UPDATE checklist_items SET done_by = $3, done_at = now(), note = $4 WHERE id = $2 AND incident_id = $1 RETURNING role, text`
      : `UPDATE checklist_items SET done_by = NULL, done_at = NULL WHERE id = $2 AND incident_id = $1 RETURNING role, text`,
    done ? [id, itemId, actor, n] : [id, itemId]);
  if (!rows[0]) throw new Error('item not found');
  await event(c, id, 'checklist', actor, { ...rows[0], done, ...(done && n ? { note: n } : {}) });
}

// Kept for callers that only flip the state (demo data, tests).
export async function toggleItem(c: pg.PoolClient, id: string, itemId: string, actor: string, note = '') {
  const cur = (await c.query<{ done: boolean }>('SELECT done_at IS NOT NULL AS done FROM checklist_items WHERE id = $1 AND incident_id = $2', [itemId, id])).rows[0];
  if (!cur) throw new Error('item not found');
  await setItemDone(c, id, itemId, !cur.done, note, actor);
}

export async function setItemNote(c: pg.PoolClient, id: string, itemId: string, note: string, actor: string) {
  await lock(c, id);
  const n = note.trim().slice(0, 2000) || null;
  const { rows } = await c.query<{ role: string; text: string }>(
    'UPDATE checklist_items SET note = $3 WHERE id = $2 AND incident_id = $1 RETURNING role, text', [id, itemId, n]);
  if (!rows[0]) throw new Error('item not found');
  await event(c, id, 'checklist', actor, { ...rows[0], note: n ?? '', noteEdited: true });
}

export async function addItem(c: pg.PoolClient, id: string, role: string, phase: string, text: string, actor: string) {
  await lock(c, id);
  if (!CHECKLIST_ROLES.includes(role as ChecklistRole)) throw new Error('unknown role');
  if (!PHASES.includes(phase as Phase)) throw new Error('unknown phase');
  const t = text.trim().slice(0, 300);
  if (!t) throw new Error('item text is required');
  await c.query('INSERT INTO checklist_items (incident_id, role, phase, text, added_by) VALUES ($1, $2, $3, $4, $5)', [id, role, phase, t, actor]);
  await event(c, id, 'checklist', actor, { role, text: t, added: true });
}

// Send (mock: record) the page that is due now, if any. Paging stops once acked or no longer declared/mitigated.
// ponytail: a reopen keeps the old ack and pages; reset both when reopen should page again.
export async function pageTick(c: pg.PoolClient, id: string, now = new Date()) {
  const inc = (await c.query<{ title: string; state: State; sev: Sev | null; acked_at: Date | null }>(
    'SELECT title, state, sev, acked_at FROM incidents WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!inc || (inc.state !== 'declared' && inc.state !== 'mitigated') || inc.acked_at) return null;
  const s = (await c.query<{ sent: number; first: Date | null; notified: boolean }>(
    `SELECT count(*) FILTER (WHERE step > 0)::int AS sent, min(sent_at) FILTER (WHERE step > 0) AS first,
            coalesce(bool_or(step = 0), false) AS notified FROM pages WHERE incident_id = $1 AND kind = 'escalation'`, [id])).rows[0];
  const p = duePage(inc.sev, { sent: s.sent, sinceFirst: s.first ? now.getTime() - s.first.getTime() : 0, notified: s.notified });
  if (!p) return null;
  const message = `[SEV${inc.sev}] #${id} ${inc.title}`;
  const r = await c.query('INSERT INTO pages (incident_id, step, channel, priority, message, sent_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING',
    [id, p.step, p.channel, p.priority, message, now]);
  if (!r.rowCount) return null;
  await c.query('INSERT INTO timeline (incident_id, at, kind, actor, body) VALUES ($1, $2, $3, $4, $5)', [id, now, 'page', 'paging', p]);
  return p;
}

// Run by the in-process timer (instrumentation.ts): escalate every unacknowledged SEV1–2 incident.
export async function pageSweep(p: pg.Pool = pool()) {
  const { rows } = await p.query<{ id: string }>(
    "SELECT id::text FROM incidents WHERE state IN ('declared','mitigated') AND sev <= 2 AND acked_at IS NULL");
  for (const r of rows) await tx((c) => pageTick(c, r.id), p);
}

// MTTA = ack time − first escalation page.
export async function ack(c: pg.PoolClient, id: string, actor: string) {
  await lock(c, id);
  const first = (await c.query<{ at: Date | null }>("SELECT min(sent_at) AS at FROM pages WHERE incident_id = $1 AND kind = 'escalation' AND step > 0", [id])).rows[0].at;
  if (!first) throw new Error('nothing to acknowledge: no page was sent');
  const r = (await c.query<{ acked_at: Date }>(
    'UPDATE incidents SET acked_at = now(), acked_by = $2 WHERE id = $1 AND acked_at IS NULL RETURNING acked_at', [id, actor])).rows[0];
  if (!r) return; // already acknowledged
  // Whoever answers the page holds IC unless someone already does (system-opened incidents start without one).
  await c.query(
    `UPDATE incidents SET roles = jsonb_set(roles, '{ic}', jsonb_build_object('who', $2::text, 'doing', 'incident command', 'updated_at', now()))
     WHERE id = $1 AND NOT roles ? 'ic'`, [id, actor]);
  await event(c, id, 'ack', actor, { mtta_s: Math.max(0, Math.round((r.acked_at.getTime() - first.getTime()) / 1000)) });
}

// A candidate with a firing critical alert that nobody declared or dismissed within 15 minutes pages once (PRD F8).
export async function triageSweep(p: pg.Pool = pool(), now = new Date()) {
  const { rows } = await p.query<{ id: string; title: string }>(
    `SELECT i.id::text, i.title FROM incidents i
     WHERE i.state = 'candidate' AND i.created_at <= $1::timestamptz - interval '15 minutes'
       AND EXISTS (SELECT 1 FROM alerts a WHERE a.incident_id = i.id AND a.status = 'firing' AND a.severity = 'critical')
       AND NOT EXISTS (SELECT 1 FROM pages g WHERE g.incident_id = i.id AND g.kind = 'triage')`, [now]);
  for (const r of rows) {
    await tx(async (c) => {
      const ins = await c.query(
        "INSERT INTO pages (incident_id, kind, step, channel, priority, message, sent_at) VALUES ($1, 'triage', 1, 'ntfy', 'high', $2, $3) ON CONFLICT DO NOTHING",
        [r.id, `[candidate] #${r.id} unhandled for 15 min: ${r.title}`, now]);
      if (ins.rowCount) await c.query("INSERT INTO timeline (incident_id, at, kind, actor, body) VALUES ($1, $2, 'page', 'paging', $3)",
        [r.id, now, { kind: 'triage', step: 1, channel: 'ntfy', priority: 'high' }]);
    }, p);
  }
  return rows.length;
}

async function resuggest(c: pg.PoolClient, id: string) {
  const { rows } = await c.query<{ labels: Record<string, string> }>('SELECT labels FROM alerts WHERE incident_id = $1', [id]);
  await c.query('UPDATE incidents SET sev_suggested = $2, detected_at = coalesce((SELECT min(starts_at) FROM alerts WHERE incident_id = $1), detected_at) WHERE id = $1',
    [id, suggestSev(rows.map((r) => r.labels))]);
}

// IC merges a candidate into another open incident: its alerts move over and it is dismissed (PRD F8).
export async function merge(c: pg.PoolClient, from: string, into: string, actor: string) {
  if (from === into) throw new Error('cannot merge an incident into itself');
  const [lo, hi] = [from, into].sort((a, b) => Number(a) - Number(b)); // lock in id order: no deadlock with a reverse merge
  const locked = { [lo]: await lock(c, lo), [hi]: await lock(c, hi) };
  if (locked[from].state !== 'candidate') throw new Error('only a candidate can be merged into another incident');
  if (!OPEN.includes(locked[into].state)) throw new Error(`#${into} is ${locked[into].state}`);
  const moved = await c.query('UPDATE alerts SET incident_id = $2 WHERE incident_id = $1', [from, into]);
  await c.query("UPDATE incidents SET state = 'dismissed' WHERE id = $1", [from]);
  await resuggest(c, into);
  await event(c, from, 'merge', actor, { into, alerts: moved.rowCount });
  await event(c, into, 'merge', actor, { from, alerts: moved.rowCount });
}

// IC moves some alerts out into a new candidate. keys are "<fingerprint>|<startsAt ISO>"; at least one alert stays.
export async function split(c: pg.PoolClient, id: string, keys: string[], actor: string): Promise<string> {
  const cur = await lock(c, id);
  if (!OPEN.includes(cur.state)) throw new Error(`incident ${id} is ${cur.state}`);
  const pairs = keys.map((k) => { const i = k.lastIndexOf('|'); return [k.slice(0, i), new Date(k.slice(i + 1))] as const; });
  if (!pairs.length || pairs.some(([f, d]) => !f || Number.isNaN(d.getTime()))) throw new Error('choose alerts to move');
  const total = (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM alerts WHERE incident_id = $1', [id])).rows[0].n;
  const first = (await c.query<{ summary: string; starts_at: Date }>(
    `SELECT coalesce(annotations->>'summary', alertname) AS summary, starts_at FROM alerts
     WHERE incident_id = $1 AND (fingerprint, starts_at) IN (SELECT * FROM unnest($2::text[], $3::timestamptz[])) ORDER BY starts_at LIMIT 1`,
    [id, pairs.map((p) => p[0]), pairs.map((p) => p[1])])).rows[0];
  if (!first) throw new Error('none of those alerts are in this incident');
  const nid = (await c.query<{ id: string }>("INSERT INTO incidents (group_key, title, detected_at) VALUES ($1, $2, $3) RETURNING id::text",
    [`split:${id}`, first.summary, first.starts_at])).rows[0].id;
  const moved = await c.query(
    'UPDATE alerts SET incident_id = $4 WHERE incident_id = $1 AND (fingerprint, starts_at) IN (SELECT * FROM unnest($2::text[], $3::timestamptz[]))',
    [id, pairs.map((p) => p[0]), pairs.map((p) => p[1]), nid]);
  if (moved.rowCount === total) throw new Error('leave at least one alert here (or merge instead)');
  await resuggest(c, id);
  await resuggest(c, nid);
  await event(c, id, 'split', actor, { to: nid, alerts: moved.rowCount });
  await event(c, nid, 'split', actor, { from: id, alerts: moved.rowCount });
  return nid;
}

export type RunbookStep = { runbook: string; step_key: string; done_by: string; done_at: Date };

export async function runbookSteps(c: pg.Pool | pg.PoolClient, id: string): Promise<RunbookStep[]> {
  return (await c.query<RunbookStep>('SELECT runbook, step_key, done_by, done_at FROM runbook_steps WHERE incident_id = $1', [id])).rows;
}

// Tick or untick a runbook step for an incident; both go to the timeline (PRD F6).
export async function setRunbookStep(c: pg.PoolClient, id: string, runbook: string, key: string, text: string, done: boolean, actor: string) {
  await lock(c, id);
  if (!/^[a-z0-9-]{1,100}$/.test(runbook) || !/^[0-9a-f]{16}$/.test(key)) throw new Error('invalid runbook step');
  const t = text.slice(0, 500);
  const r = done
    ? await c.query('INSERT INTO runbook_steps (incident_id, runbook, step_key, text, done_by) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING', [id, runbook, key, t, actor])
    : await c.query('DELETE FROM runbook_steps WHERE incident_id = $1 AND runbook = $2 AND step_key = $3', [id, runbook, key]);
  if (r.rowCount) await event(c, id, 'runbook', actor, { runbook, text: t, done });
}

export const FOLLOW_UP_TYPES = ['prevent', 'detect', 'mitigate'] as const;
export const PRIORITIES = ['P0', 'P1', 'P2'] as const;
export type FollowUp = {
  id: string; action: string; type: (typeof FOLLOW_UP_TYPES)[number]; priority: (typeof PRIORITIES)[number]; owner: string;
  created_by: string; created_at: Date; issue_number: number | null; issue_labels: string[] | null; issue_created_at: Date | null;
  done_by: string | null; done_at: Date | null;
};

export async function followUps(c: pg.Pool | pg.PoolClient, id: string): Promise<FollowUp[]> {
  return (await c.query<FollowUp>(
    `SELECT id::text, action, type, priority, owner, created_by, created_at, issue_number, issue_labels, issue_created_at, done_by, done_at
     FROM follow_ups WHERE incident_id = $1 ORDER BY priority, id`, [id])).rows;
}

export async function addFollowUp(c: pg.PoolClient, id: string, f: { action: string; type: string; priority: string; owner: string }, actor: string) {
  await lock(c, id, { terminalOk: true });
  const action = f.action.trim().slice(0, 300);
  if (!action) throw new Error('action is required');
  if (!FOLLOW_UP_TYPES.includes(f.type as never)) throw new Error('type must be prevent, detect or mitigate');
  if (!PRIORITIES.includes(f.priority as never)) throw new Error('priority must be P0, P1 or P2');
  await c.query('INSERT INTO follow_ups (incident_id, action, type, priority, owner, created_by) VALUES ($1, $2, $3, $4, $5, $6)',
    [id, action, f.type, f.priority, f.owner.trim().slice(0, 100), actor]);
  await event(c, id, 'follow_up', actor, { action, type: f.type, priority: f.priority, added: true });
}

// Mock GitHub issue (PRD F14): a number and the labels the real issue would get; nothing leaves the app.
// ponytail: issue number = 1000 + follow-up id; swap in POST /repos/{gitops}/issues when issues go live.
export async function createIssue(c: pg.PoolClient, id: string, fid: string, actor: string) {
  await lock(c, id, { terminalOk: true });
  if (!/^\d+$/.test(fid)) throw new Error('invalid follow-up');
  const r = (await c.query<{ action: string; type: string; issue_number: number }>(
    `UPDATE follow_ups SET issue_number = 1000 + id, issue_labels = ARRAY['incident:#' || incident_id, 'type:' || type], issue_created_at = now()
     WHERE id = $2 AND incident_id = $1 AND issue_number IS NULL RETURNING action, type, issue_number`, [id, fid])).rows[0];
  if (!r) return; // already has one
  await event(c, id, 'follow_up', actor, { action: r.action, issue: r.issue_number });
}

// Close (or reopen) the follow-up's issue.
export async function setFollowUpDone(c: pg.PoolClient, id: string, fid: string, done: boolean, actor: string) {
  await lock(c, id, { terminalOk: true });
  if (!/^\d+$/.test(fid)) throw new Error('invalid follow-up');
  const r = (await c.query<{ action: string }>(
    done ? 'UPDATE follow_ups SET done_by = $3, done_at = now() WHERE id = $2 AND incident_id = $1 AND issue_number IS NOT NULL AND done_at IS NULL RETURNING action'
      : 'UPDATE follow_ups SET done_by = NULL, done_at = NULL WHERE id = $2 AND incident_id = $1 AND done_at IS NOT NULL RETURNING action',
    done ? [id, fid, actor] : [id, fid])).rows[0];
  if (r) await event(c, id, 'follow_up', actor, { action: r.action, done });
}
