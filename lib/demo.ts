// Demo mode (DEMO=1): the console runs on a seeded scenario instead of the live lab (scripts/demo-seed.ts).
// The database is a separate one (sreops_demo, or DEMO_DATABASE_URL); live inflow (Alertmanager, Flux, the
// watchdog, wake conditions) and the AI are off. What Prometheus would say about the scenario (SLO budgets,
// workloads, pods) comes from here; Detection (rules, metric inventory) stays live. Times are minutes relative
// to the anchor, the moment the scenario was seeded, so elapsed times and the current shift stay plausible.
import type pg from 'pg';
import type { Chg } from './chg.ts';
import type { Postmortem } from './postmortems.ts';
import type { Pod, Slo, Workload } from './prom.ts';
import type { WorkloadRef } from './topology.ts';

export const isDemo = () => process.env.DEMO === '1';

export function demoDbUrl(base: string): string {
  if (process.env.DEMO_DATABASE_URL) return process.env.DEMO_DATABASE_URL;
  const u = new URL(base);
  u.pathname = '/sreops_demo';
  return u.toString();
}

// The anchor from the seeded DB (settings.demo_anchor); cached 30 s so a re-seed shows up without a restart.
const g = globalThis as unknown as { demoAnchor?: { v: Date; at: number } };
export async function anchor(db: pg.Pool): Promise<Date> {
  if (g.demoAnchor && performance.now() - g.demoAnchor.at < 30_000) return g.demoAnchor.v;
  const r = await db.query<{ value: string }>("SELECT value FROM settings WHERE key = 'demo_anchor'");
  if (!r.rows[0]) throw new Error('demo data not seeded: run npm run demo:seed');
  g.demoAnchor = { v: new Date(r.rows[0].value), at: performance.now() };
  return g.demoAnchor.v;
}
export const at = (a: Date, min: number) => new Date(a.getTime() + min * 60_000);
const minutes = (a: Date, t: Date) => (t.getTime() - a.getTime()) / 60_000;

// SLO error budget left over time: [minutes from anchor, budget]. Linear between points, flat outside.
const SLO_CURVE: Record<string, { objective: number; sli1h: number | null; curve: [number, number][] }> = {
  'settlement-freshness': { objective: 0.99, sli1h: 0.995, curve: [[-480, 0.52], [-280, 0.5], [-150, 0.41], [0, 0.39]] },
  'block-production': { objective: 0.995, sli1h: 0.998, curve: [[-480, 0.88], [0, 0.86]] },
  'withdrawal-1h': { objective: 0.99, sli1h: 0.996, curve: [[-480, 0.78], [-280, 0.77], [0, 0.71]] },
  'tx-inclusion-5s': { objective: 0.9, sli1h: 0.99, curve: [[-480, 0.95], [0, 0.92]] },
  'tx-inclusion-60s': { objective: 0.99, sli1h: 0.995, curve: [[-480, 0.97], [0, 0.95]] },
  'rpc-availability': { objective: 0.995, sli1h: 0.999, curve: [[-480, 0.96], [0, 0.95]] },
  'rpc-server-errors': { objective: 0.999, sli1h: 0.9999, curve: [[-480, 0.99], [0, 0.98]] },
  'deposit-10m': { objective: 0.99, sli1h: 1, curve: [[-480, 0.98], [0, 0.98]] },
  'deposit-2m': { objective: 0.95, sli1h: 1, curve: [[-480, 0.99], [0, 0.99]] },
};
function interp(curve: [number, number][], m: number) {
  if (m <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    const [m0, v0] = curve[i - 1], [m1, v1] = curve[i];
    if (m <= m1) return v0 + ((v1 - v0) * (m - m0)) / (m1 - m0);
  }
  return curve.at(-1)![1];
}
export function demoSlos(a: Date, t = new Date()): Slo[] {
  const m = Math.min(0, minutes(a, t));
  return Object.entries(SLO_CURVE).map(([name, s]) => ({ name, objective: s.objective, sli1h: s.sli1h, budgetRemaining: interp(s.curve, m) }))
    .sort((x, y) => x.budgetRemaining - y.budgetRemaining);
}

// Workloads that are not plain healthy, and when: [from, to) minutes from the anchor.
const WORKLOAD_STATES: { ns: string; name: string; from: number; to: number; ready?: number; desired?: number; restarts1h?: number }[] = [
  { ns: 'lineth-l2', name: 'prover', from: -300, to: -170, ready: 0, restarts1h: 4 }, // OOM loop
  { ns: 'lineth-l2', name: 'prover', from: -170, to: -110, restarts1h: 2 },
  { ns: 'lineth-l2', name: 'web3signer', from: -420, to: -385, ready: 0, restarts1h: 1 },
  { ns: 'lineth-l2', name: 'blockscout', from: -60, to: 1e9, desired: 0, ready: 0 }, // suspended for catch-up
  { ns: 'lineth-l2', name: 'blockscout-frontend', from: -60, to: 1e9, desired: 0, ready: 0 },
];
export function demoWorkloads(a: Date, refs: (WorkloadRef & { kind: 'Deployment' | 'StatefulSet' })[], t = new Date()): Workload[] {
  const m = minutes(a, t);
  return refs.map((r) => {
    const s = WORKLOAD_STATES.find((x) => x.ns === r.ns && x.name === r.name && m >= x.from && m < x.to);
    const desired = s?.desired ?? 1;
    return { ...r, desired, ready: s?.ready ?? desired, restarts1h: s?.restarts1h ?? 0 };
  });
}
const MEM: Record<string, [number, number]> = { prover: [21.8, 24], maru: [3.1, 6], 'l2-node-besu': [5.2, 8], sequencer: [4.4, 8], coordinator: [1.9, 4] };
export function demoPods(a: Date, refs: (WorkloadRef & { kind: 'Deployment' | 'StatefulSet' })[]): Pod[] {
  const gi = 2 ** 30;
  return demoWorkloads(a, refs).filter((w) => w.desired > 0).map((w) => {
    const [used, limit] = MEM[w.name] ?? [0.4, 1];
    return {
      workload: w.name, ns: w.ns, name: w.kind === 'StatefulSet' ? `${w.name}-0` : `${w.name}-6d9f7c5b8d-x4k2p`, ready: w.ready > 0,
      restarts: w.name === 'prover' ? 6 : w.restarts1h, lastTerminated: w.name === 'prover' ? 'OOMKilled' : null, image: `lineth/${w.name}:demo`,
      memBytes: used * gi, memRequest: limit * 0.75 * gi, memLimit: limit * gi, cpuCores: w.name === 'prover' ? 3.6 : 0.2,
    };
  });
}

// CHG records of the scenario (what lineth-l2-gitops docs/changes would hold). Windows in minutes from the anchor.
const CHGS: { n: number; title: string; status: Chg['status']; risk: Chg['risk']; from: number; to: number | null; components: string[] }[] = [
  { n: 1, title: 'Rotate the L2 web3signer keys', status: 'closed', risk: 'medium', from: -430, to: -410, components: ['web3signer-l2'] },
  { n: 2, title: 'Tune the prover JVM heap for large batches (-Xmx 20g to 23g)', status: 'pir', risk: 'medium', from: -360, to: -335, components: ['prover'] },
  { n: 3, title: 'Roll back the prover heap tuning', status: 'closed', risk: 'low', from: -160, to: -140, components: ['prover'] },
  { n: 4, title: 'Pause synthetic traffic during finalization catch-up', status: 'implementing', risk: 'low', from: -90, to: 240, components: ['traffic'] },
  { n: 5, title: 'Raise the kind node memory to 64 GiB', status: 'approved', risk: 'high', from: 120, to: 180, components: ['prover', 'coordinator'] },
];
export function demoChgs(a: Date): Chg[] {
  const day = a.toISOString().slice(0, 10);
  return CHGS.map((c) => {
    const id = `CHG-${day}-${String(c.n).padStart(2, '0')}`;
    return { id, title: c.title, status: c.status, risk: c.risk, window: { start: at(a, c.from), end: c.to === null ? null : at(a, c.to) }, components: c.components, file: `docs/changes/${id}.md`, href: `${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}/changes#${id}` };
  });
}

// The scenario's postmortem for the web3signer incident (#1): in review, linked from the seed.
export function demoPostmortems(a: Date): Postmortem[] {
  const day = a.toISOString().slice(0, 10);
  const id = `PM-${day}-16`;
  const t = (min: number) => at(a, min).toISOString().slice(11, 16);
  return [{
    id, incident: `INC-${day}-16`, title: 'L2 web3signer started with 2 of 4 keys after a key rotation; blob submission paused 26 min',
    status: 'draft', severity: 2, date: day, incident_state: 'resolved', components: ['web3signer-l2', 'coordinator'], themes: ['config-change'], authors: ['bob'],
    duration: `impact ${t(-418)} → ${t(-392)} (26 min); detected in 1 min; mitigated 17 min after detection`,
    actions: [
      { id: 'A1', type: 'prevent', priority: 'P1', owner: 'bob', status: 'open', action: 'Validate the key count in CI before a web3signer Secret change merges', note: 'console follow-up' },
      { id: 'A2', type: 'detect', priority: 'P2', owner: 'alice', status: 'done', action: 'Page on LinethL2SignerKeysMissing (critical) instead of a ticket', note: 'done' },
      { id: 'A3', type: 'process', priority: 'P2', owner: 'bob', status: 'open', action: 'Key rotations go through a CHG with a rollback step', note: '' },
    ],
    summary: 'A planned rotation of the L2 web3signer keys (CHG-01) mounted the new key files under the old Secret name; web3signer restarted with 2 of its 4 keys and blob submissions paused 26 min.',
    path: `postmortems/${id}-web3signer-keys-after-rotation.md`,
    body: `# Postmortem: L2 web3signer started with 2 of 4 keys after a key rotation (INC-${day}-16)

Blameless postmortem (sample data for the portfolio demo). Times UTC.

| | |
|---|---|
| Status | draft — incident **resolved** |
| Severity | SEV-2 |
| Authors | bob |
| Duration | impact ${t(-418)} → ${t(-392)} (26 min); detected in 1 min; mitigated 17 min after detection |
| Related | CHG-${day}-01 (key rotation), console incident #1 |

## 1. Summary

A planned rotation of the L2 web3signer keys (CHG-01) mounted the new key files under the old Secret name. web3signer
restarted with 2 of its 4 keys, so the coordinator could not sign blob submissions. The keys alert paged within a
minute; restoring the previous Secret and restarting web3signer brought all four keys back.

## 2. Impact

| what | how much |
|---|---|
| blob submissions to L1 | paused 26 min, caught up within 10 min after |
| users | none visible: L2 blocks kept coming; settlement was 26 min late |

## 3. Root causes and trigger

- Trigger: the rotation changed the Secret name in one manifest and not in the web3signer volume.
- Root cause: nothing checks the number of keys web3signer will load before the change merges.

## 4. Detection

\`LinethL2SignerKeysMissing\` (critical) fired 1 min after the restart and paged the on-call.

## 5. Response and recovery

| time | event / action |
|---|---|
| ${t(-418)} | web3signer restarts with 2 keys; the alert fires |
| ${t(-414)} | declared SEV2 (bob) |
| ${t(-401)} | decision: restore the previous Secret and restart web3signer |
| ${t(-392)} | 4 keys loaded; blob submission resumes |

## 6. Lessons learned

- **Went well:** the alert paged within a minute and the rollback was one command.
- **Went badly:** the rotation had no rollback step written down.
- **Lucky:** the sequencer key was not among the missing ones, so L2 blocks kept coming.

## 7. Action items

| # | action | type | priority | owner | status |
|---|---|---|---|---|---|
| A1 | Validate the key count in CI before a web3signer Secret change merges | prevent | P1 | bob | open |
| A2 | Page on LinethL2SignerKeysMissing (critical) instead of a ticket | detect | P2 | alice | done |
| A3 | Key rotations go through a CHG with a rollback step | process | P2 | bob | open |
`,
  }];
}
