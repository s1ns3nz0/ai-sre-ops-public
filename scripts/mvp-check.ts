// PRD §8 MVP acceptance: replays INC-2026-10-11-11 into a scratch database (created and dropped here, the dev data
// is not touched) and checks each criterion against the app's own code and the live Prometheus, at incident time.
// Criterion 9 is checked on the app's logic with simulated time; the live run is recorded in CHG-2026-10-13-01 (PIR).
// Usage: DATABASE_URL=... PROMETHEUS_URL=... node scripts/mvp-check.ts
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { addCheckpoint, wakeSweep } from '../lib/checkpoints.ts';
import { tx } from '../lib/db.ts';
import { ack, pageTick, setSev, transition } from '../lib/incidents.ts';
import { ingest, parsePayload } from '../lib/ingest.ts';
import { priorities } from '../lib/priority.ts';
import { query } from '../lib/prom.ts';
import { notifications } from '../lib/replay.ts';
import { runbooks } from '../lib/runbooks.ts';
import { duringIncident, suspects } from '../lib/changes.ts';
import { chgs } from '../lib/chg.ts';
import { firstSigns, stagesAt } from '../lib/stages.ts';
import { REGIONS, hhmm } from '../lib/time.ts';
import { topology } from '../lib/topology.ts';
import { openWatchdogIncident, watchdogCheck } from '../lib/watchdog.ts';

const base = process.env.DATABASE_URL;
if (!base) throw new Error('DATABASE_URL is required');
const name = 'sreops_mvp_check';
const admin = new pg.Client({ connectionString: base });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${name}`);
await admin.query(`CREATE DATABASE ${name}`);
const url = new URL(base);
url.pathname = `/${name}`;
const db = new pg.Pool({ connectionString: url.toString() });

const results: { n: number; ok: boolean; what: string; got: string }[] = [];
const check = (n: number, what: string, ok: boolean, got: string) => results.push({ n, ok, what, got });

try {
  await db.query(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  const t = topology();
  const fixture = JSON.parse(await readFile(new URL('../fixtures/inc-2026-10-11-11.json', import.meta.url), 'utf8'));
  // Each notification arrives at its own time, as Alertmanager would have sent it.
  for (const n of notifications(fixture.events)) await tx((c) => ingest(c, parsePayload(n.payload), new Date(n.at)), db);

  const incOf = async (alertname: string) => (await db.query<{ id: string }>(
    'SELECT incident_id::text AS id FROM alerts WHERE alertname = $1 ORDER BY starts_at LIMIT 1', [alertname])).rows[0].id;
  const id = await incOf('LinethL2FinalizationStalled');
  const inc10 = await incOf('LinethL2SequencerStalled');
  const names = (await db.query<{ alertname: string }>('SELECT DISTINCT alertname FROM alerts WHERE incident_id = $1', [id])).rows.map((r) => r.alertname);
  const inc = (await db.query<{ detected_at: Date; sev_suggested: number | null; state: string }>('SELECT detected_at, sev_suggested, state FROM incidents WHERE id = $1', [id])).rows[0];
  const at = new Date('2026-10-12T02:00:00Z'); // every INC-11 alert firing

  // 1. Four or more alerts in one candidate, probable cause prover; INC-10 kept apart.
  const prio = (await priorities(db, t, new Map(), [id], at)).get(id);
  check(1, 'INC-11 alerts in one candidate, cause prover', names.length >= 4 && inc.state === 'candidate' && prio?.cause === 'prover' && inc10 !== id,
    `${names.length} alerts in #${id} (${inc.state}), cause ${prio?.cause}, INC-10 in #${inc10}`);

  // 2. Map at incident time: prover red, coordinator orange, the coordinator→prover edge highlighted.
  const st = await stagesAt(db, t, at);
  const edge = t.edges.find((e) => e.from === 'coordinator' && e.to === 'prover')!;
  const es = st.edges[`${edge.from}>${edge.to}`];
  check(2, 'Map: prover breach, coordinator risk+, coordinator→prover edge marked',
    st.nodes.prover?.stage === 'breach' && ['risk', 'breach'].includes(st.nodes.coordinator?.stage ?? '') && !!es && es !== 'normal',
    `prover ${st.nodes.prover?.stage}, coordinator ${st.nodes.coordinator?.stage}, edge ${es}${st.error ? `, workloads: ${st.error}` : ''}`);

  // 3. The edge drawer: when_broken and the prover-oom-loop runbook.
  const rbs = (await runbooks()).filter((r) => r.components.some((c) => c === edge.from || c === edge.to));
  check(3, 'Edge drawer: when_broken + prover-oom-loop', !!edge.when_broken && rbs.some((r) => r.id === 'prover-oom-loop'),
    `when_broken ${edge.when_broken ? 'yes' : 'no'}, runbooks ${rbs.map((r) => r.id).join(', ') || 'none'}`);

  // 4. A yellow/orange sign before the first alert the postmortem lists under "4. Detection" (10-11 16:10 UTC).
  const signs = await firstSigns(db, t, prio?.comps ?? ['prover', 'coordinator'], inc.detected_at);
  const early = signs.filter((s) => s.at < new Date('2026-10-11T16:10:00Z') && ['slow', 'risk', 'breach'].includes(s.stage));
  check(4, 'Sign earlier than postmortem detection (10-11 16:10)', early.length > 0,
    early.map((s) => `${s.component} ${s.stage} at ${s.at.toISOString().slice(5, 16)}`).join('; ') || 'none');

  // 5. UTC and the regions: 07:42 UTC on 10-13 is 16:42 in Seoul, 03:42 ET (EDT), 09:42 CET (CEST).
  const d = new Date('2026-10-13T07:42:00Z');
  const got5 = REGIONS.map((r) => `${r.label} ${hhmm(r.tz, d)}`).join(', ');
  const want5: Record<string, string> = { 'Asia/Seoul': '16:42', 'America/New_York': '03:42', 'Europe/Berlin': '09:42', 'Europe/Paris': '09:42' };
  check(5, 'UTC + region times', REGIONS.every((r) => !want5[r.tz] || hhmm(r.tz, d) === want5[r.tz]) && hhmm('UTC', d) === '07:42', `UTC 07:42 → ${got5}`);

  // 6. SEV2 suggested; declaring pages on ntfy; ack records MTTA.
  await tx(async (c) => { await setSev(c, id, 2, 'mvp-check'); await transition(c, id, 'declared', 'mvp-check'); }, db);
  await tx((c) => pageTick(c, id), db); // no-op when declaring already paged
  const page = (await db.query<{ channel: string; priority: string }>(
    "SELECT channel, priority FROM pages WHERE incident_id = $1 AND kind = 'escalation' AND step > 0 ORDER BY sent_at LIMIT 1", [id])).rows[0];
  await tx((c) => ack(c, id, 'mvp-check'), db);
  const mtta = (await db.query<{ body: { mtta_s: number } }>("SELECT body FROM timeline WHERE incident_id = $1 AND kind = 'ack'", [id])).rows[0]?.body.mtta_s;
  check(6, 'SEV2 suggested → ntfy page → ack → MTTA', inc.sev_suggested === 2 && page?.channel === 'ntfy' && typeof mtta === 'number',
    `suggested SEV${inc.sev_suggested}, page ${page ? `${page.channel} ${page.priority}` : 'none'}, MTTA ${mtta ?? '—'} s`);

  // 7. CHG-2026-10-12-02 shown as a suspected change.
  const list = await chgs();
  const sus = await suspects(db, t, names, inc.detected_at, list.chgs);
  const chg2 = list.chgs.find((k) => k.id === 'CHG-2026-10-12-02');
  // CHG-02 started mid-incident (10-12 12:15, on traffic/observability): it shows under "During the incident".
  const during = await duringIncident(db, inc.detected_at, new Date('2026-10-12T15:10:00Z'), list.chgs);
  const ids = (l: typeof sus) => l.map((s) => s.label.split(' ')[0]).join(', ') || 'none';
  check(7, 'CHG-2026-10-12-02 shown as a change around the incident', [...sus, ...during].some((s) => s.label.startsWith('CHG-2026-10-12-02')),
    `before detection: ${ids(sus)}; during: ${ids(during)}; CHG-02 starts ${chg2?.window.start.toISOString().slice(5, 16) ?? '?'}`);

  // 8. Checkpoint wake condition "finalization stalled 30 min" pages when met (evaluated at incident time), quiet now.
  await tx((c) => addCheckpoint(c, id, {
    status_line: 'mvp-check', hypothesis: '', action: '', action_eta: null, next_step: '', handoff_to: '',
    wake_expr: 'max(changes(lineth_l2_rollup_finalized_block{l1_block_tag="latest"}[30m])) == 0',
  }, 'mvp-check'), db);
  const now8 = (await wakeSweep((e) => query(e), db)).map((r) => r.result).join(',');
  const then8 = (await wakeSweep((e) => query(e, at), db)).map((r) => r.result).join(',');
  const wakePage = (await db.query("SELECT 1 FROM pages WHERE incident_id = $1 AND kind = 'wake' AND channel = 'ntfy'", [id])).rowCount;
  check(8, 'Wake condition pages when met', then8 === 'fired' && wakePage === 1, `now: ${now8}; at incident time: ${then8}; wake pages ${wakePage}`);

  // 9 (logic only). A heartbeat, then 6 minutes of silence: a SEV2 incident opens and pages; a new heartbeat recovers it.
  const hb = new Date('2026-10-13T00:00:00Z');
  const wd = (status: string) => parsePayload({ version: '4', groupKey: '{}:{alertname="Watchdog"}', alerts: [{
    status, fingerprint: 'wd', labels: { alertname: 'Watchdog', severity: 'none' }, annotations: {}, startsAt: hb.toISOString(), endsAt: '0001-01-01T00:00:00Z' }] });
  await tx((c) => ingest(c, wd('firing'), hb), db);
  const r4 = await tx((c) => watchdogCheck(c, new Date(hb.getTime() + 4 * 60_000)), db);
  const r6 = await tx((c) => watchdogCheck(c, new Date(hb.getTime() + 6 * 60_000)), db);
  const wdId = await openWatchdogIncident(db);
  const wdPage = wdId ? (await db.query<{ channel: string }>("SELECT channel FROM pages WHERE incident_id = $1 AND kind = 'escalation' AND step > 0", [wdId])).rows[0] : undefined;
  check(9, 'Watchdog logic: silent 5 min → SEV2 page (simulated time)', r4 === 'ok' && r6 === 'opened' && wdPage?.channel === 'ntfy',
    `+4 min ${r4}, +6 min ${r6}, page ${wdPage?.channel ?? 'none'}`);
} finally {
  await db.end();
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.end();
}

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.n}. ${r.what}\n      ${r.got}`);
console.log('NOTE  9. Live run needs Prometheus stopped for real: 2026-10-13 paged 1 min 51 s after the stop (lineth-l2-gitops CHG-2026-10-13-01 PIR).');
process.exit(results.every((r) => r.ok) ? 0 : 1);
