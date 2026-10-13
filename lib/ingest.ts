// Alertmanager webhook (v4) → alerts + incident candidates + timeline. Replaces alert-sink.
import type pg from 'pg';
import { componentOf, pickGroup } from './grouping.ts';
import { OPEN, REOPEN_WINDOW_MS, suggestSev, type State } from './lifecycle.ts';
import { topology } from './topology.ts';

export type AmAlert = {
  status: 'firing' | 'resolved';
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt: Date;
  endsAt: Date | null;
  fingerprint: string;
};
export type AmPayload = { groupKey: string; alerts: AmAlert[] };

const MAX_ALERTS = 1000;

function strMap(v: unknown, what: string): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${what} must be an object`);
  for (const [k, x] of Object.entries(v)) if (typeof x !== 'string') throw new Error(`${what}.${k} must be a string`);
  return v as Record<string, string>;
}

function date(v: unknown, what: string): Date {
  const d = typeof v === 'string' ? new Date(v) : null;
  if (!d || Number.isNaN(d.getTime())) throw new Error(`${what} must be an RFC3339 time`);
  return d;
}

// Trust boundary: everything arriving on the webhook is validated here.
export function parsePayload(body: unknown): AmPayload {
  const b = body as Record<string, unknown>;
  if (!b || typeof b !== 'object') throw new Error('body must be an object');
  if (b.version !== '4') throw new Error('only Alertmanager webhook version 4 is supported');
  if (typeof b.groupKey !== 'string' || !b.groupKey) throw new Error('groupKey is required');
  if (!Array.isArray(b.alerts) || b.alerts.length > MAX_ALERTS) throw new Error(`alerts must be an array of at most ${MAX_ALERTS}`);
  const alerts = b.alerts.map((raw: unknown, i: number): AmAlert => {
    const a = raw as Record<string, unknown>;
    if (a.status !== 'firing' && a.status !== 'resolved') throw new Error(`alerts[${i}].status is invalid`);
    if (typeof a.fingerprint !== 'string' || !a.fingerprint) throw new Error(`alerts[${i}].fingerprint is required`);
    const labels = strMap(a.labels, `alerts[${i}].labels`);
    if (!labels.alertname) throw new Error(`alerts[${i}].labels.alertname is required`);
    const endsAt = date(a.endsAt, `alerts[${i}].endsAt`);
    return {
      status: a.status,
      labels,
      annotations: strMap(a.annotations ?? {}, `alerts[${i}].annotations`),
      startsAt: date(a.startsAt, `alerts[${i}].startsAt`),
      endsAt: endsAt.getUTCFullYear() <= 1 ? null : endsAt, // Alertmanager sends 0001-01-01 while firing
      fingerprint: a.fingerprint,
    };
  });
  return { groupKey: b.groupKey, alerts };
}

type Inc = { id: string; state: State; resolved_at: Date | null };

// Shared with the manual Reopen button: back to declared, keep declared_at, clear the later stamps.
export async function reopen(c: pg.PoolClient, id: string) {
  const r = await c.query("UPDATE incidents SET state = 'declared', mitigated_at = NULL, resolved_at = NULL WHERE id = $1 AND state = 'resolved'", [id]);
  if (r.rowCount !== 1) throw new Error(`incident ${id} is not resolved`);
}

async function reopenIfRecent(c: pg.PoolClient, last: Inc | undefined, a: AmAlert): Promise<string | null> {
  // Reopen only for a new firing that started after the resolve (late or replayed old alerts open a new candidate).
  const since = last?.resolved_at ? a.startsAt.getTime() - last.resolved_at.getTime() : -1;
  if (!last || last.state !== 'resolved' || a.status !== 'firing' || since < 0 || since > REOPEN_WINDOW_MS) return null;
  await reopen(c, last.id);
  await c.query(
    "INSERT INTO timeline (incident_id, at, kind, actor, body) VALUES ($1, $2, 'reopen', 'alertmanager', $3)",
    [last.id, a.startsAt, { reason: `${a.labels.alertname} fired again within 24 h of resolve`, previous_resolved_at: last.resolved_at }],
  );
  return last.id;
}

// Which incident a new alert belongs to. With a known component (PRD F8): the open incident with an alert still
// firing on the same or a linked component, else reopen the latest resolved one on that component, else a new
// candidate. Without one: the Alertmanager group, as before.
async function incidentFor(c: pg.PoolClient, groupKey: string, a: AmAlert, comp: string | null): Promise<string> {
  const t = topology();
  if (comp) {
    const { rows: open } = await c.query<{ id: string; firing: string[]; last: Date }>(
      `SELECT i.id::text, coalesce(array_agg(DISTINCT a.component) FILTER (WHERE a.status = 'firing' AND a.component IS NOT NULL), '{}') AS firing,
              max(a.starts_at) AS last
       FROM incidents i JOIN alerts a ON a.incident_id = i.id WHERE i.state = ANY($1) GROUP BY i.id`, [OPEN]);
    const hit = pickGroup(t, comp, open.map((g) => ({ id: g.id, firing: g.firing, lastStart: g.last })));
    if (hit) return hit;
    const { rows } = await c.query<Inc>(
      `SELECT i.id::text, i.state, i.resolved_at FROM incidents i WHERE EXISTS (SELECT 1 FROM alerts a WHERE a.incident_id = i.id AND a.component = $1)
       ORDER BY i.created_at DESC, i.id DESC LIMIT 1 FOR UPDATE`, [comp]);
    const re = await reopenIfRecent(c, rows[0], a);
    if (re) return re;
  } else {
    const { rows } = await c.query<Inc>(
      'SELECT id, state, resolved_at FROM incidents WHERE group_key = $1 ORDER BY created_at DESC, id DESC LIMIT 1 FOR UPDATE', [groupKey]);
    if (rows[0] && OPEN.includes(rows[0].state)) return rows[0].id;
    const re = await reopenIfRecent(c, rows[0], a);
    if (re) return re;
  }
  const ins = await c.query<{ id: string }>(
    'INSERT INTO incidents (group_key, title, detected_at) VALUES ($1, $2, $3) RETURNING id',
    [comp ? `component:${comp}` : groupKey, a.annotations.summary || a.labels.alertname, a.startsAt],
  );
  return ins.rows[0].id;
}

export async function ingest(c: pg.PoolClient, p: AmPayload, now = new Date()): Promise<{ incidents: string[] }> {
  // The always-firing Watchdog is a heartbeat (F11, lib/watchdog.ts), not an incident.
  if (p.alerts.some((a) => a.labels.alertname === 'Watchdog' && a.status === 'firing')) {
    await c.query(
      `INSERT INTO monitor (name, last_seen) VALUES ('watchdog', $1)
       ON CONFLICT (name) DO UPDATE SET last_seen = GREATEST(monitor.last_seen, EXCLUDED.last_seen)`, [now]);
  }
  p = { ...p, alerts: p.alerts.filter((a) => a.labels.alertname !== 'Watchdog') };
  if (!p.alerts.length) return { incidents: [] };
  // ponytail: one lock for all webhooks, since alerts from different Alertmanager groups can join one incident;
  // per-component locks if webhook volume ever makes this a bottleneck.
  await c.query("SELECT pg_advisory_xact_lock(hashtext('lineth:ingest'))");
  const t = topology();
  const touched = new Set<string>();
  for (const a of p.alerts) {
    const { rows } = await c.query<{ incident_id: string; status: string }>(
      'SELECT incident_id, status FROM alerts WHERE fingerprint = $1 AND starts_at = $2',
      [a.fingerprint, a.startsAt],
    );
    let incidentId = rows[0]?.incident_id;
    if (!incidentId) {
      const comp = componentOf(t, a.labels);
      incidentId = await incidentFor(c, p.groupKey, a, comp);
      const ins = await c.query(
        `INSERT INTO alerts (fingerprint, starts_at, ends_at, status, alertname, severity, labels, annotations, incident_id, component)
         VALUES ($1, $2, NULL, 'firing', $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
        [a.fingerprint, a.startsAt, a.labels.alertname, a.labels.severity ?? '', a.labels, a.annotations, incidentId, comp],
      );
      if (ins.rowCount === 0) continue; // same alert delivered concurrently via another group (route `continue: true`)
      await c.query(
        "INSERT INTO timeline (incident_id, at, kind, actor, body) VALUES ($1, $2, 'alert_firing', 'alertmanager', $3)",
        [incidentId, a.startsAt, { alertname: a.labels.alertname, severity: a.labels.severity, summary: a.annotations.summary, fingerprint: a.fingerprint }],
      );
      touched.add(incidentId);
    }
    if (a.status === 'resolved' && rows[0]?.status !== 'resolved') {
      const at = a.endsAt ?? new Date();
      await c.query("UPDATE alerts SET status = 'resolved', ends_at = $3 WHERE fingerprint = $1 AND starts_at = $2", [a.fingerprint, a.startsAt, at]);
      await c.query(
        "INSERT INTO timeline (incident_id, at, kind, actor, body) VALUES ($1, $2, 'alert_resolved', 'alertmanager', $3)",
        [incidentId, at, { alertname: a.labels.alertname, fingerprint: a.fingerprint }],
      );
      touched.add(incidentId);
    }
  }
  for (const id of touched) {
    const { rows } = await c.query<{ labels: Record<string, string> }>('SELECT labels FROM alerts WHERE incident_id = $1', [id]);
    await c.query('UPDATE incidents SET sev_suggested = $2 WHERE id = $1', [id, suggestSev(rows.map((r) => r.labels))]);
  }
  return { incidents: [...touched] };
}
