// Probable cause and priority score of open incidents (PRD F8), from their alerts and the topology.
import type pg from 'pg';
import { probableCause, score, type Score } from './grouping.ts';
import type { Topology } from './topology.ts';
import type { ReliabilityRow } from './reliability.ts';

export type Priority = Score & { cause: string | null; comps: string[] };

export async function priorities(c: pg.Pool | pg.PoolClient, t: Topology, budgets: Map<string, number>, ids?: string[], now = new Date()): Promise<Map<string, Priority>> {
  const { rows } = await c.query<{ incident_id: string; component: string | null; slo: string | null; severity: string; status: string; starts_at: Date; received_at: Date; detected_at: Date }>(
    `SELECT a.incident_id::text, a.component, a.labels->>'slo' AS slo, a.severity, a.status, a.starts_at, a.received_at, i.detected_at
     FROM alerts a JOIN incidents i ON i.id = a.incident_id
     WHERE ${ids ? 'i.id = ANY($1::bigint[])' : "i.state IN ('candidate','declared','mitigated')"}`, ids ? [ids] : []);
  const by = new Map<string, typeof rows>();
  for (const r of rows) (by.get(r.incident_id) ?? by.set(r.incident_id, []).get(r.incident_id)!).push(r);
  const out = new Map<string, Priority>();
  for (const [id, as] of by) {
    const members = as.filter((a) => a.component).map((a) => ({ comp: a.component!, firstAt: a.starts_at }));
    const comps = [...new Set(members.map((m) => m.comp))];
    const slos = [...new Set([...as.map((a) => a.slo).filter(Boolean) as string[], ...comps.flatMap((x) => t.nodes.find((n) => n.id === x)?.slos ?? [])])];
    const s = score(t, {
      comps, slos, budgets, critical: as.some((a) => a.status === 'firing' && a.severity === 'critical'),
      openSince: as[0].detected_at, lastJoin: new Date(Math.max(...as.map((a) => a.received_at.getTime()))), now,
    });
    out.set(id, { ...s, cause: probableCause(t, members), comps });
  }
  return out;
}

// Incidents declared in the last `days` (dismissed candidates excluded), with their probable cause, for Reliability (F14).
export async function reliabilityRows(c: pg.Pool, t: Topology, days: number, sev?: number) {
  const { rows } = await c.query<Omit<ReliabilityRow, 'cause'>>(
    `SELECT i.id::text, i.title, i.sev, i.state, i.detected_at, i.declared_at, i.mitigated_at, i.resolved_at, i.acked_at,
            (SELECT min(sent_at) FROM pages p WHERE p.incident_id = i.id AND p.kind = 'escalation' AND p.step > 0) AS first_page_at
     FROM incidents i
     WHERE i.declared_at IS NOT NULL AND i.detected_at > now() - make_interval(days => $1) AND ($2::int IS NULL OR i.sev = $2)
     ORDER BY i.detected_at DESC`, [days, sev ?? null]);
  const prio = await priorities(c, t, new Map(), rows.map((r) => r.id));
  return rows.map((r): ReliabilityRow => ({ ...r, cause: prio.get(r.id)?.cause ?? null }));
}

export async function openFollowUps(c: pg.Pool) {
  return (await c.query<{ id: string; incident_id: string; title: string; action: string; priority: string; type: string; owner: string; created_at: Date; issue_number: number | null }>(
    `SELECT f.id::text, f.incident_id::text, i.title, f.action, f.priority, f.type, f.owner, f.created_at, f.issue_number
     FROM follow_ups f JOIN incidents i ON i.id = f.incident_id WHERE f.done_at IS NULL ORDER BY f.priority, f.created_at`)).rows;
}
