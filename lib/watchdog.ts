// Watching the watcher (PRD F11). Two signals, one SEV2 incident that pages (F10):
// - Prometheus fires the always-on `Watchdog`; Alertmanager repeats it to this app. None for 5 minutes = alerts are
//   not reaching this console (Prometheus, Alertmanager or the route).
// - The timer also asks Prometheus `/-/ready` every 30 s. Not ready for 2 minutes = Prometheus is down. This one is
//   faster: Alertmanager keeps re-sending an alert until it expires (~4 min after Prometheus' last send), so the
//   Watchdog alone pages 7-9 minutes after Prometheus stops (measured, CHG-2026-10-13-01).
// Maintenance mode pauses both for planned work.
import type pg from 'pg';
import { isDemo } from './demo.ts';
import { pool, tx } from './db.ts';
import { transition } from './incidents.ts';

export const SILENT_MS = 5 * 60_000;
export const PROM_DOWN_MS = 2 * 60_000;
const GROUP = 'platform:watchdog';

export type Monitor = { last_seen: Date | null; maintenance_until: Date | null; maintenance_by: string | null; prom_ready_at: Date | null };

export async function monitor(c: pg.Pool | pg.PoolClient): Promise<Monitor> {
  const r = (await c.query<Monitor>(
    `SELECT w.last_seen, w.maintenance_until, w.maintenance_by, (SELECT last_seen FROM monitor WHERE name = 'prometheus') AS prom_ready_at
     FROM (SELECT 1) x LEFT JOIN monitor w ON w.name = 'watchdog'`)).rows[0];
  // Demo mode: the pipeline is healthy (the timer does not run the watchdog against the seeded scenario).
  if (isDemo()) { const now = new Date(Date.now() - 40_000); return { last_seen: now, maintenance_until: null, maintenance_by: null, prom_ready_at: now }; }
  return r ?? { last_seen: null, maintenance_until: null, maintenance_by: null, prom_ready_at: null };
}

// Why the pipeline counts as down at `now`, or null. Never seen = not set up yet (no page).
export function silence(m: Monitor, now: Date): { reason: 'prometheus' | 'watchdog'; since: Date } | null {
  if (m.prom_ready_at && now.getTime() - m.prom_ready_at.getTime() > PROM_DOWN_MS) return { reason: 'prometheus', since: m.prom_ready_at };
  if (m.last_seen && now.getTime() - m.last_seen.getTime() > SILENT_MS) return { reason: 'watchdog', since: m.last_seen };
  return null;
}

export async function recordPromReady(c: pg.Pool | pg.PoolClient, at = new Date()) {
  await c.query("INSERT INTO monitor (name, last_seen) VALUES ('prometheus', $1) ON CONFLICT (name) DO UPDATE SET last_seen = GREATEST(monitor.last_seen, $1)", [at]);
}

export async function openWatchdogIncident(c: pg.Pool | pg.PoolClient): Promise<string | null> {
  const r = await c.query<{ id: string }>("SELECT id::text FROM incidents WHERE group_key = $1 AND state IN ('declared','mitigated') ORDER BY id DESC LIMIT 1", [GROUP]);
  return r.rows[0]?.id ?? null;
}

export async function setMaintenance(c: pg.PoolClient, until: Date | null, actor: string) {
  await c.query(
    `INSERT INTO monitor (name, maintenance_until, maintenance_by) VALUES ('watchdog', $1, $2)
     ON CONFLICT (name) DO UPDATE SET maintenance_until = $1, maintenance_by = $2`, [until, until ? actor : null]);
}

// Open the incident when the Watchdog goes silent; mark it mitigated when it comes back. Never seen = not set up
// yet, which the overview shows instead of paging.
export async function watchdogCheck(c: pg.PoolClient, now = new Date()): Promise<'ok' | 'never' | 'maintenance' | 'opened' | 'silent' | 'recovered'> {
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [GROUP]);
  const m = await monitor(c);
  if (!m.last_seen && !m.prom_ready_at) return 'never';
  const openId = await openWatchdogIncident(c);
  const open = openId ? (await c.query<{ id: string; state: string }>('SELECT id::text, state FROM incidents WHERE id = $1', [openId])).rows[0] : undefined;
  const down = silence(m, now);
  if (!down) {
    if (open?.state !== 'declared') return 'ok';
    await transition(c, open.id, 'mitigated', 'watchdog');
    return 'recovered';
  }
  if (open?.state === 'declared') return 'silent';
  // A mitigated one (an earlier outage that recovered) does not hold back the page for a new outage.
  if (m.maintenance_until && m.maintenance_until > now) return 'maintenance';
  const prom = down.reason === 'prometheus';
  const last = down.since.toISOString().slice(0, 16).replace('T', ' ');
  const id = (await c.query<{ id: string }>(
    "INSERT INTO incidents (group_key, title, detected_at, sev, sev_suggested) VALUES ($1, $2, $3, 2, 2) RETURNING id::text",
    [GROUP, prom ? 'Alert pipeline down: Prometheus not ready for 2 minutes' : 'Alert pipeline silent: no Watchdog from Alertmanager for 5 minutes',
      new Date(down.since.getTime() + (prom ? PROM_DOWN_MS : SILENT_MS))])).rows[0].id;
  await c.query('UPDATE incidents SET status_line = $2, impact = $3 WHERE id = $1', [id,
    prom ? `Prometheus last ready ${last} UTC. Check the Prometheus pod and its storage.`
      : `Last Watchdog ${last} UTC. Check Prometheus, Alertmanager and the route to this app.`,
    'Other alerts may not be reaching this console; incidents can go unnoticed.']);
  await transition(c, id, 'declared', 'watchdog'); // pages via F10
  await c.query("UPDATE incidents SET roles = roles - 'ic' WHERE id = $1", [id]); // whoever acknowledges the page becomes IC
  return 'opened';
}

// ponytail: readiness probe from the app process; a broken route from the app to Prometheus also reads as "down".
async function promReady(): Promise<boolean> {
  const base = process.env.PROMETHEUS_URL;
  if (!base) return false;
  try {
    return (await fetch(`${base.replace(/\/$/, '')}/-/ready`, { signal: AbortSignal.timeout(5000) })).ok;
  } catch {
    return false;
  }
}

export async function watchdogSweep(p: pg.Pool = pool()) {
  if (await promReady()) await recordPromReady(p);
  return tx((c) => watchdogCheck(c), p);
}
