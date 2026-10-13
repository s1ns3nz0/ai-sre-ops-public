// Change correlation (PRD F12). Flux notification events (generic-hmac provider) become change events; CHGs come
// from lineth-l2-gitops (lib/chg.ts). A candidate whose components, or what they depend on, changed in the
// 2 hours before it was detected is flagged "suspected change" — a lead for the rollback call, not a score.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import type { Chg } from './chg.ts';
import type { Topology } from './topology.ts';

export const SUSPECT_WINDOW_MS = 2 * 3600_000;

export type FluxEvent = {
  at: Date; severity: 'info' | 'error'; kind: string; namespace: string; name: string;
  reason: string; message: string; revision: string;
};
export type ChangeEvent = {
  id: string; at: Date; severity: 'info' | 'error'; object_kind: string; object_ns: string; object_name: string;
  reason: string; message: string; revision: string; components: string[];
};

// Flux signs the body with the provider secret: X-Signature: <sha256|sha384|sha512>=<hex>.
export function verifySignature(body: string, header: string | null, secret: string): boolean {
  const m = /^(sha256|sha384|sha512)=([0-9a-f]+)$/.exec(header ?? '');
  if (!m || !secret) return false;
  const want = createHmac(m[1], secret).update(body).digest();
  const got = Buffer.from(m[2], 'hex');
  return got.length === want.length && timingSafeEqual(got, want);
}

const str = (v: unknown, what: string, max: number, required = true): string => {
  if (v === undefined && !required) return '';
  if (typeof v !== 'string' || (required && !v)) throw new Error(`${what} must be a string`);
  return v.slice(0, max);
};

// Trust boundary: the Flux event payload (fluxcd/pkg runtime/events.Event).
export function parseFluxEvent(body: unknown): FluxEvent {
  const b = body as Record<string, unknown>;
  if (!b || typeof b !== 'object') throw new Error('body must be an object');
  const o = b.involvedObject as Record<string, unknown>;
  if (!o || typeof o !== 'object') throw new Error('involvedObject is required');
  if (b.severity !== 'info' && b.severity !== 'error') throw new Error('severity must be info or error');
  const at = new Date(str(b.timestamp, 'timestamp', 40));
  if (Number.isNaN(at.getTime())) throw new Error('timestamp must be an RFC3339 time');
  const meta = (b.metadata && typeof b.metadata === 'object' ? b.metadata : {}) as Record<string, unknown>;
  return {
    at, severity: b.severity, kind: str(o.kind, 'involvedObject.kind', 100), namespace: str(o.namespace, 'involvedObject.namespace', 100, false),
    name: str(o.name, 'involvedObject.name', 200), reason: str(b.reason, 'reason', 100, false), message: str(b.message, 'message', 4000, false),
    revision: typeof meta.revision === 'string' ? meta.revision.slice(0, 200) : '',
  };
}

export const componentsOf = (t: Topology, objectName: string) => t.nodes.filter((n) => n.flux.includes(objectName)).map((n) => n.id);

export async function recordChange(c: pg.PoolClient | pg.Pool, e: FluxEvent, t: Topology) {
  const r = await c.query(
    `INSERT INTO change_events (at, severity, object_kind, object_ns, object_name, reason, message, revision, components)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING`,
    [e.at, e.severity, e.kind, e.namespace, e.name, e.reason, e.message, e.revision, componentsOf(t, e.name)]);
  return r.rowCount === 1;
}

// Components an incident is about: nodes that own one of its alerts, plus what those call (their dependencies).
export function incidentComponents(t: Topology, alertnames: string[]): { own: string[]; deps: string[] } {
  const own = t.nodes.filter((n) => n.alerts?.some((a) => alertnames.includes(a))).map((n) => n.id);
  const deps = [...new Set(t.edges.filter((e) => own.includes(e.from)).map((e) => e.to))].filter((d) => !own.includes(d));
  return { own, deps };
}

export async function changesFor(c: pg.Pool | pg.PoolClient, components: string[], from: Date, to: Date): Promise<ChangeEvent[]> {
  if (!components.length) return [];
  const { rows } = await c.query<ChangeEvent>(
    `SELECT id::text, at, severity, object_kind, object_ns, object_name, reason, message, revision, components FROM change_events
     WHERE components && $1 AND at BETWEEN $2 AND $3 ORDER BY at DESC LIMIT 50`, [components, from, to]);
  return rows;
}

export type Suspect = { what: 'flux' | 'chg'; label: string; at: Date; components: string[]; failed?: boolean; href?: string; status?: string };

// Flux reports every reconcile of a revision; one line per object + revision, with where it ended up.
export function oneLinePerDeploy(list: Suspect[]): Suspect[] {
  const by = new Map<string, Suspect[]>();
  for (const x of list) by.set(x.label, [...(by.get(x.label) ?? []), x]);
  return [...by.values()].map((evs) => {
    evs.sort((a, b) => a.at.getTime() - b.at.getTime());
    const last = evs.at(-1)!;
    const okBefore = evs.some((e) => !e.failed) && last.failed;
    const failedBefore = evs.some((e) => e.failed) && !last.failed;
    return { ...last, components: [...new Set(evs.flatMap((e) => e.components))],
      status: last.failed ? (okBefore ? 'applied, then failed' : 'failed') : failedBefore ? 'applied after a failure' : 'applied' };
  });
}

// Flux changes and CHG windows that touched the incident's components or their dependencies in the 2 hours before detection.
export async function suspects(c: pg.Pool | pg.PoolClient, t: Topology, alertnames: string[], detected: Date, chgs: Chg[]): Promise<Suspect[]> {
  const { own, deps } = incidentComponents(t, alertnames);
  const all = [...own, ...deps];
  const from = new Date(detected.getTime() - SUSPECT_WINDOW_MS);
  const flux = (await changesFor(c, all, from, detected)).map((e): Suspect => ({
    what: 'flux', label: `${e.object_kind} ${e.object_name}${e.revision ? ` ${e.revision.replace(/sha1:([0-9a-f]{7})[0-9a-f]+/, '$1')}` : ''}`,
    at: e.at, components: e.components.filter((x) => all.includes(x)), failed: e.severity === 'error',
  }));
  const chg = chgs.filter((k) => k.window.start <= detected && (!k.window.end || k.window.end >= from) && k.components.some((x) => all.includes(x)))
    .map((k): Suspect => ({ what: 'chg', label: `${k.id} ${k.title}`, at: k.window.start, components: k.components.filter((x) => all.includes(x)), href: k.href }));
  return [...oneLinePerDeploy(flux), ...chg].sort((a, b) => b.at.getTime() - a.at.getTime());
}

// Changes that started while the incident was open (detection → resolve, or now), on any component: a change
// mid-incident is worth a look even when it touches something else (e.g. a load change during catch-up).
export async function duringIncident(c: pg.Pool | pg.PoolClient, detected: Date, until: Date, chgs: Chg[]): Promise<Suspect[]> {
  const { rows } = await c.query<ChangeEvent>(
    `SELECT id::text, at, severity, object_kind, object_ns, object_name, reason, message, revision, components FROM change_events
     WHERE at > $1 AND at <= $2 ORDER BY at DESC LIMIT 50`, [detected, until]);
  const flux = rows.map((e): Suspect => ({
    what: 'flux', label: `${e.object_kind} ${e.object_name}${e.revision ? ` ${e.revision.replace(/sha1:([0-9a-f]{7})[0-9a-f]+/, '$1')}` : ''}`,
    at: e.at, components: e.components, failed: e.severity === 'error',
  }));
  const chg = chgs.filter((k) => k.window.start > detected && k.window.start <= until)
    .map((k): Suspect => ({ what: 'chg', label: `${k.id} ${k.title}`, at: k.window.start, components: k.components, href: k.href }));
  return [...oneLinePerDeploy(flux), ...chg].sort((a, b) => b.at.getTime() - a.at.getTime());
}

// Open incidents with at least one suspected change, for the queue.
export async function suspectedIncidents(c: pg.Pool, t: Topology, list: Chg[]): Promise<Set<string>> {
  const { rows } = await c.query<{ id: string; detected_at: Date; names: string[] }>(
    `SELECT i.id::text, i.detected_at, array_agg(DISTINCT a.alertname) AS names FROM incidents i JOIN alerts a ON a.incident_id = i.id
     WHERE i.state IN ('candidate','declared','mitigated') GROUP BY i.id`);
  const out = new Set<string>();
  for (const r of rows) if ((await suspects(c, t, r.names, r.detected_at, list)).length) out.add(r.id);
  return out;
}
