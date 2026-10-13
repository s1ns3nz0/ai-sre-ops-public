// IC checkpoints and wake conditions (PRD F13). A long incident is handed to sleep or to the next person with a
// checkpoint; its wake condition (PromQL) is watched by the platform timer and pages the IC once when it matches.
import type pg from 'pg';
import { pool, tx } from './db.ts';
import { event, lock } from './incidents.ts';

export type Checkpoint = {
  id: string; status_line: string; hypothesis: string; action: string; action_eta: Date | null; wake_expr: string;
  next_step: string; handoff_to: string; author: string; created_at: Date;
  wake_state: 'watching' | 'fired' | 'stopped' | null; wake_checked_at: Date | null; wake_error: string | null; wake_fired_at: Date | null;
};
export type CheckpointInput = Pick<Checkpoint, 'status_line' | 'hypothesis' | 'action' | 'action_eta' | 'wake_expr' | 'next_step' | 'handoff_to'>;
type Query = (expr: string) => Promise<{ metric: Record<string, string>; value: [number, string] }[]>;

const COLS = 'id::text, status_line, hypothesis, action, action_eta, wake_expr, next_step, handoff_to, author, created_at, wake_state, wake_checked_at, wake_error, wake_fired_at';

export async function checkpoints(c: pg.Pool | pg.PoolClient, id: string): Promise<Checkpoint[]> {
  return (await c.query<Checkpoint>(`SELECT ${COLS} FROM checkpoints WHERE incident_id = $1 ORDER BY id DESC`, [id])).rows;
}

// A new checkpoint replaces the previous one's wake condition.
export async function addCheckpoint(c: pg.PoolClient, id: string, cp: CheckpointInput, actor: string) {
  const cur = await lock(c, id);
  if (cur.state !== 'declared' && cur.state !== 'mitigated') throw new Error('checkpoints are for declared or mitigated incidents');
  if (!cp.status_line.trim()) throw new Error('status is required');
  const t = (s: string, n = 2000) => s.trim().slice(0, n);
  const expr = t(cp.wake_expr, 4000);
  const stopped = await c.query<{ id: string }>(
    "UPDATE checkpoints SET wake_state = 'stopped' WHERE incident_id = $1 AND wake_state = 'watching' RETURNING id::text", [id]);
  const row = (await c.query<{ id: string }>(
    `INSERT INTO checkpoints (incident_id, status_line, hypothesis, action, action_eta, wake_expr, next_step, handoff_to, author, wake_state)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id::text`,
    [id, t(cp.status_line, 300), t(cp.hypothesis), t(cp.action), cp.action_eta, expr, t(cp.next_step), t(cp.handoff_to, 100), actor, expr ? 'watching' : null])).rows[0];
  await event(c, id, 'checkpoint', actor, {
    checkpoint: row.id, status_line: t(cp.status_line, 300), hypothesis: t(cp.hypothesis), action: t(cp.action), action_eta: cp.action_eta,
    wake_expr: expr, next_step: t(cp.next_step), handoff_to: t(cp.handoff_to, 100), replaced_wake: stopped.rows.length > 0,
  });
  return row.id;
}

// One pass of the platform timer: check every watched condition. Matches page once (ntfy, urgent); conditions on
// incidents that are no longer declared/mitigated stop. Query errors are kept on the row and retried next pass.
export async function wakeSweep(q: Query, p: pg.Pool = pool(), now = new Date()) {
  const { rows } = await p.query<{ id: string; incident_id: string; wake_expr: string; state: string }>(
    `SELECT k.id::text, k.incident_id::text, k.wake_expr, i.state FROM checkpoints k JOIN incidents i ON i.id = k.incident_id
     WHERE k.wake_state = 'watching'`);
  const out: { id: string; result: 'fired' | 'stopped' | 'quiet' | 'error' }[] = [];
  for (const k of rows) {
    if (k.state !== 'declared' && k.state !== 'mitigated') {
      await tx(async (c) => {
        const r = await c.query("UPDATE checkpoints SET wake_state = 'stopped' WHERE id = $1 AND wake_state = 'watching'", [k.id]);
        if (r.rowCount) await event(c, k.incident_id, 'wake_stopped', 'platform', { checkpoint: k.id, reason: `incident ${k.state}` });
      }, p);
      out.push({ id: k.id, result: 'stopped' });
      continue;
    }
    let series: Awaited<ReturnType<Query>>;
    try {
      series = await q(k.wake_expr);
    } catch (e) {
      await p.query('UPDATE checkpoints SET wake_checked_at = $2, wake_error = $3 WHERE id = $1', [k.id, now, (e as Error).message.slice(0, 500)]);
      out.push({ id: k.id, result: 'error' });
      continue;
    }
    if (!series.length) {
      await p.query('UPDATE checkpoints SET wake_checked_at = $2, wake_error = NULL WHERE id = $1', [k.id, now]);
      out.push({ id: k.id, result: 'quiet' });
      continue;
    }
    await tx((c) => fire(c, k, now, 'platform', { series: series.length, sample: series.slice(0, 3).map((x) => ({ metric: x.metric, value: x.value[1] })) }), p);
    out.push({ id: k.id, result: 'fired' });
  }
  return out;
}

// Fire a watched wake condition: mark it, page the IC (mock urgent ntfy) and log it. false if nothing was watching.
async function fire(c: pg.PoolClient, k: { id: string; incident_id: string; wake_expr: string }, now: Date, actor: string, extra: Record<string, unknown>) {
  const r = await c.query(
    "UPDATE checkpoints SET wake_state = 'fired', wake_fired_at = $2, wake_checked_at = $2, wake_error = NULL WHERE id = $1 AND wake_state = 'watching'", [k.id, now]);
  if (!r.rowCount) return false; // a newer checkpoint replaced it meanwhile, or it already fired
  const inc = (await c.query<{ sev: number | null; title: string }>('SELECT sev, title FROM incidents WHERE id = $1', [k.incident_id])).rows[0];
  await c.query(
    "INSERT INTO pages (incident_id, kind, step, channel, priority, message, sent_at) VALUES ($1, 'wake', $2, 'ntfy', 'urgent', $3, $4) ON CONFLICT DO NOTHING",
    [k.incident_id, -Number(k.id), `[SEV${inc.sev}] #${k.incident_id} wake condition met: ${inc.title}`, now]);
  await c.query("INSERT INTO timeline (incident_id, at, kind, actor, body) VALUES ($1, $2, 'wake', $3, $4)", [k.incident_id, now, actor, { checkpoint: k.id, wake_expr: k.wake_expr, ...extra }]);
  return true;
}

// The "Send wake alarm" button: fire the latest checkpoint's watched condition by hand (drills, demos, or when the
// IC knows it is time). Same effect as the condition matching.
export async function fireWakeByHand(c: pg.PoolClient, incidentId: string, actor: string) {
  await lock(c, incidentId);
  const k = (await c.query<{ id: string; incident_id: string; wake_expr: string }>(
    "SELECT id::text, incident_id::text, wake_expr FROM checkpoints WHERE incident_id = $1 AND wake_state = 'watching' ORDER BY id DESC LIMIT 1", [incidentId])).rows[0];
  if (!k) throw new Error('no wake condition is being watched');
  return fire(c, k, new Date(), actor, { manual: true });
}
