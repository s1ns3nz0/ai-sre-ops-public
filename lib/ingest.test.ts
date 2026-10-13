import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { tx } from './db.ts';
import { ingest, parsePayload } from './ingest.ts';
import { ack, addFollowUp, addItem, checklist, createIssue, followUps, merge, setFollowUpDone, pageTick, runbookSteps, setRunbookStep, split, triageSweep, getIncident, listIncidents, setRole, setSev, toggleItem, transition } from './incidents.ts';
import { notifications } from './replay.ts';
import { monitor, recordPromReady, setMaintenance, watchdogCheck } from './watchdog.ts';
import { addCheckpoint, checkpoints, fireWakeByHand, wakeSweep } from './checkpoints.ts';
import { duringIncident, parseFluxEvent, recordChange, suspects } from './changes.ts';
import { topology } from './topology.ts';
import { acknowledge, ensureDraft, handoff, handoffSweep, markReady, setNote } from './handoff.ts';

test('webhook payload validation rejects bad input', () => {
  assert.throws(() => parsePayload(null), /object/);
  assert.throws(() => parsePayload({ version: '3', groupKey: 'g', alerts: [] }), /version 4/);
  assert.throws(() => parsePayload({ version: '4', groupKey: 'g', alerts: [{ status: 'firing', fingerprint: 'f', labels: {}, startsAt: 'x', endsAt: 'x' }] }), /alertname/);
  assert.throws(() => parsePayload({ version: '4', groupKey: 'g', alerts: [{ status: 'firing', fingerprint: 'f', labels: { alertname: 'A', n: 1 }, startsAt: '2026-01-01T00:00:00Z', endsAt: '0001-01-01T00:00:00Z' }] }), /must be a string/);
  const ok = parsePayload({ version: '4', groupKey: 'g', alerts: [{ status: 'firing', fingerprint: 'f', labels: { alertname: 'A' }, startsAt: '2026-01-01T00:00:00Z', endsAt: '0001-01-01T00:00:00Z' }] });
  assert.equal(ok.alerts[0].endsAt, null);
});

// DB tests run where DATABASE_URL is set (docker compose `test` service); skipped otherwise.
const url = process.env.DATABASE_URL;
const schema = `t_${process.pid}`;
let db: pg.Pool;

before(async () => {
  if (!url) return;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  db = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  await db.query(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
});

after(async () => {
  if (!url) return;
  await db.query(`DROP SCHEMA ${schema} CASCADE`);
  await db.end();
});

const post = (payload: unknown) => tx((c) => ingest(c, parsePayload(payload)), db);
// The incident an alert landed in (its first occurrence).
const incOf = async (alertname: string) =>
  (await db.query<{ id: string }>('SELECT incident_id::text AS id FROM alerts WHERE alertname = $1 ORDER BY starts_at, received_at LIMIT 1', [alertname])).rows[0].id;
// A fresh candidate on no known component (its own Alertmanager group), for tests that need one to work on.
const fresh = async (name: string) => {
  await post({ version: '4', groupKey: `{}:{alertname="${name}"}`, alerts: [{ status: 'firing', fingerprint: name, labels: { alertname: name, severity: 'warning' },
    annotations: { summary: name }, startsAt: new Date().toISOString(), endsAt: '0001-01-01T00:00:00Z' }] });
  return incOf(name);
};

test('INC-2026-10-11-11 replay: candidates, SEV suggestions, idempotency, reopen', { skip: !url }, async () => {
  const { events } = JSON.parse(await readFile(new URL('../fixtures/inc-2026-10-11-11.json', import.meta.url), 'utf8'));
  const ns = notifications(events);
  for (const n of ns) await post(n.payload);
  for (const n of ns) await post(n.payload); // Alertmanager repeats notifications

  const list = await listIncidents(db);
  // Topology grouping (F8, PRD §8): each incident is one candidate, and the two stay apart although they overlap in time.
  assert.equal(list.length, 2);
  assert.equal(list.reduce((s, i) => s + i.alert_count, 0), events.length);
  assert.ok(list.every((i) => i.state === 'candidate' && i.firing_count === 0));
  for (const tag of ['INC-11', 'INC-10']) {
    const ids = new Set(await Promise.all((events as { incident: string; alertname: string; labels: { slo?: string } }[])
      .filter((e) => e.incident === tag).map(async (e) => (await db.query<{ id: string }>(
        "SELECT incident_id::text AS id FROM alerts WHERE alertname = $1 AND coalesce(labels->>'slo', '') = $2", [e.alertname, e.labels.slo ?? ''])).rows[0].id)));
    assert.equal(ids.size, 1, `${tag} is one candidate`);
  }
  const fin = list.find((i) => i.sev_suggested === 2)!;
  const seq = list.find((i) => i !== fin)!;
  assert.equal(fin.id, await incOf('LinethL2ProverLargeRetry'));
  assert.equal(seq.id, await incOf('LinethL2SequencerStalled'));
  assert.equal(seq.sev_suggested, 1);
  assert.equal(fin.detected_at.toISOString(), '2026-10-11T16:10:00.000Z');
  await assert.rejects(tx((c) => transition(c, fin.id, 'declared', 'op'), db), /SEV/);
  await tx(async (c) => { await setSev(c, fin.id, 2, 'op'); await transition(c, fin.id, 'declared', 'op'); }, db);
  // Declaring copied the SEV2 checklist; raising to SEV1 adds only what newly applies; toggles and adds are logged.
  const sev2 = await checklist(db, fin.id);
  assert.ok(sev2.length > 0 && sev2.every((i) => i.template_key && !i.done_at));
  await tx((c) => setSev(c, fin.id, 1, 'op'), db);
  const sev1 = await checklist(db, fin.id);
  assert.ok(sev1.length >= sev2.length);
  assert.equal(new Set(sev1.map((i) => i.template_key)).size, sev1.length);
  await tx((c) => toggleItem(c, fin.id, sev1[0].id, 'op', 'Checked CHG list; nothing deployed'), db);
  assert.equal((await checklist(db, fin.id)).find((i) => i.id === sev1[0].id)!.note, 'Checked CHG list; nothing deployed');
  await tx((c) => addItem(c, fin.id, 'ops', 'mitigate', 'Requeue .large batches', 'op'), db);
  const after1 = await checklist(db, fin.id);
  assert.equal(after1.find((i) => i.id === sev1[0].id)!.done_by, 'op');
  assert.ok(after1.some((i) => i.template_key === null && i.added_by === 'op'));
  await tx((c) => toggleItem(c, fin.id, sev1[0].id, 'op'), db);
  assert.equal((await checklist(db, fin.id)).find((i) => i.id === sev1[0].id)!.done_at, null);
  assert.equal((await getIncident(db, fin.id))!.timeline.filter((e) => e.kind === 'checklist').length, 3);
  await tx((c) => setSev(c, fin.id, 2, 'op'), db);

  await tx((c) => transition(c, fin.id, 'mitigated', 'op'), db);
  await tx((c) => transition(c, fin.id, 'resolved', 'op'), db);
  await assert.rejects(tx((c) => transition(c, fin.id, 'closed', 'op'), db), /postmortem/);
  const declared = (await getIncident(db, fin.id))!;
  assert.equal(declared.inc.roles.ic?.who, 'op');

  // Same group fires again within 24 h of resolve → reopened, not a new incident.
  const again = ns.find((n) => (n.payload.alerts as { labels: { alertname: string } }[])[0].labels.alertname === 'LinethL2FinalizationStalled')!;
  const p = structuredClone(again.payload) as { alerts: { startsAt: string }[] };
  p.alerts[0].startsAt = new Date(Date.now() + 60_000).toISOString();
  await post(p);
  const after = (await getIncident(db, fin.id))!;
  assert.equal(after.inc.state, 'declared');
  assert.equal(after.inc.resolved_at, null);
  assert.ok(after.timeline.some((e) => e.kind === 'reopen'));
  assert.equal((await listIncidents(db)).length, 2);

  // Review fixes: SEV is frozen after resolve; manual reopen keeps declared_at and clears later stamps;
  // an alert that started before the resolve opens a new candidate instead of reopening; blank role clears the slot.
  await tx((c) => transition(c, fin.id, 'mitigated', 'op'), db);
  await tx((c) => transition(c, fin.id, 'resolved', 'op'), db);
  await assert.rejects(tx((c) => setSev(c, fin.id, 4, 'op'), db), /cannot change/);
  const declaredAt = (await getIncident(db, fin.id))!.inc.declared_at;
  await tx((c) => transition(c, fin.id, 'declared', 'op'), db);
  const re = (await getIncident(db, fin.id))!.inc;
  assert.equal(re.state, 'declared');
  assert.deepEqual(re.declared_at, declaredAt);
  assert.equal(re.mitigated_at, null);
  await tx((c) => transition(c, fin.id, 'mitigated', 'op'), db);
  await tx((c) => transition(c, fin.id, 'resolved', 'op'), db);
  const old = structuredClone(again.payload) as { alerts: { startsAt: string; fingerprint: string }[] };
  old.alerts[0].startsAt = '2026-10-12T00:00:00Z';
  old.alerts[0].fingerprint = 'late-delivery';
  await post(old);
  assert.equal((await getIncident(db, fin.id))!.inc.state, 'resolved');
  assert.equal((await listIncidents(db)).length, 3);

  await tx((c) => setRole(c, fin.id, 'ic', '  ', '', 'op'), db);
  assert.equal((await getIncident(db, fin.id))!.inc.roles.ic, undefined);
  await assert.rejects(tx((c) => transition(c, 'x1', 'declared', 'op'), db), /invalid incident id/);
});

test('paging: declare pages, escalation is time-based, ack stops it and records MTTA', { skip: !url }, async () => {
  const seq = await incOf('LinethL2SequencerStalled');
  await tx(async (c) => { await setSev(c, seq, 1, 'op'); await transition(c, seq, 'declared', 'op'); }, db);
  const first = (await getIncident(db, seq))!.pages;
  assert.deepEqual(first.map((p) => [p.step, p.channel, p.priority]), [[1, 'ntfy', 'high']]);

  const t0 = new Date(first[0].sent_at).getTime();
  const at = (min: number) => new Date(t0 + min * 60_000);
  assert.equal(await tx((c) => pageTick(c, seq, at(4)), db), null);
  assert.equal((await tx((c) => pageTick(c, seq, at(5)), db))?.priority, 'urgent');
  assert.equal((await tx((c) => pageTick(c, seq, at(5)), db)), null); // same step never twice
  assert.equal((await tx((c) => pageTick(c, seq, at(15)), db))?.channel, 'slack');

  await tx((c) => ack(c, seq, 'op'), db);
  await tx((c) => ack(c, seq, 'op2'), db); // second ack is a no-op
  assert.equal(await tx((c) => pageTick(c, seq, at(30)), db), null);
  const done = (await getIncident(db, seq))!;
  assert.equal(done.inc.acked_by, 'op');
  assert.equal(done.pages.length, 3);
  assert.equal(done.timeline.filter((e) => e.kind === 'ack').length, 1);

  // SEV3: one Slack notice, nothing to acknowledge.
  const slow = await fresh('TestSlowBurn');
  await tx(async (c) => { await setSev(c, slow, 3, 'op'); await transition(c, slow, 'declared', 'op'); }, db);
  assert.deepEqual((await getIncident(db, slow))!.pages.map((p) => [p.step, p.channel]), [[0, 'slack']]);
  await assert.rejects(tx((c) => ack(c, slow, 'op'), db), /nothing to acknowledge/);
});

test('watchdog: heartbeat only, silent 5 min opens one paged SEV2, recovery mitigates, maintenance pauses', { skip: !url }, async () => {
  const before = (await listIncidents(db)).length;
  const wd = (startsAt: string) => ({ version: '4', groupKey: '{}:{alertname="Watchdog"}', alerts: [{ status: 'firing', fingerprint: 'wd', labels: { alertname: 'Watchdog', severity: 'none' }, annotations: {}, startsAt, endsAt: '0001-01-01T00:00:00Z' }] });
  assert.equal(await tx((c) => watchdogCheck(c), db), 'never');
  const t0 = new Date();
  await tx((c) => ingest(c, parsePayload(wd(t0.toISOString())), t0), db);
  assert.equal((await listIncidents(db)).length, before); // no incident for the heartbeat
  assert.deepEqual((await monitor(db)).last_seen, t0);
  const at = (min: number) => new Date(t0.getTime() + min * 60_000);
  assert.equal(await tx((c) => watchdogCheck(c, at(4)), db), 'ok');

  await tx((c) => setMaintenance(c, at(30), 'op'), db);
  assert.equal(await tx((c) => watchdogCheck(c, at(6)), db), 'maintenance');
  await tx((c) => setMaintenance(c, null, 'op'), db);

  assert.equal(await tx((c) => watchdogCheck(c, at(6)), db), 'opened');
  assert.equal(await tx((c) => watchdogCheck(c, at(7)), db), 'silent'); // one incident, not one per check
  const inc = (await listIncidents(db)).find((i) => i.title.startsWith('Alert pipeline silent'))!;
  const full = (await getIncident(db, inc.id))!;
  assert.equal(full.inc.state, 'declared');
  assert.equal(full.inc.sev, 2);
  assert.equal(full.inc.roles.ic, undefined);
  assert.equal(full.pages[0]?.channel, 'ntfy');
  await tx((c) => ack(c, inc.id, 'op'), db);
  assert.equal((await getIncident(db, inc.id))!.inc.roles.ic?.who, 'op');

  await tx((c) => ingest(c, parsePayload(wd(t0.toISOString())), at(8)), db);
  assert.equal(await tx((c) => watchdogCheck(c, at(8)), db), 'recovered');
  assert.equal((await getIncident(db, inc.id))!.inc.state, 'mitigated');

  // Prometheus readiness: not ready for 2 minutes pages sooner than the Watchdog would, as a new incident even
  // though the earlier one is still mitigated; ready again mitigates it.
  await recordPromReady(db, at(8));
  await tx((c) => ingest(c, parsePayload(wd(t0.toISOString())), at(9)), db);
  assert.equal(await tx((c) => watchdogCheck(c, at(9.5)), db), 'ok');
  assert.equal(await tx((c) => watchdogCheck(c, at(10.5)), db), 'opened');
  const down = (await listIncidents(db)).find((i) => i.title.startsWith('Alert pipeline down'))!;
  assert.notEqual(down.id, inc.id);
  assert.equal((await getIncident(db, down.id))!.pages[0]?.channel, 'ntfy');
  await recordPromReady(db, at(11));
  assert.equal(await tx((c) => watchdogCheck(c, at(11)), db), 'recovered');
  assert.equal((await getIncident(db, down.id))!.inc.state, 'mitigated');
});

test('checkpoint wake condition: watched, pages once when it matches, replaced by a newer one, stops on resolve', { skip: !url }, async () => {
  const id = await fresh('TestLongRunning');
  const cp = { status_line: 'Catch-up running', hypothesis: 'prover memory', action: 'requeue batches', action_eta: null, next_step: 'watch backlog', handoff_to: '' };
  await assert.rejects(tx((c) => addCheckpoint(c, id, { ...cp, wake_expr: 'x' }, 'op'), db), /declared or mitigated/);
  await tx(async (c) => { await setSev(c, id, 3, 'op'); await transition(c, id, 'declared', 'op'); }, db);

  let matches = 0;
  const q = async (expr: string) => (expr === 'backlog_stalled' && matches ? [{ metric: { job: 'coordinator' }, value: [0, '1'] as [number, string] }] : []);
  await tx((c) => addCheckpoint(c, id, { ...cp, wake_expr: 'backlog_stalled' }, 'op'), db);
  assert.deepEqual((await wakeSweep(q, db)).map((r) => r.result), ['quiet']);
  matches = 1;
  assert.deepEqual((await wakeSweep(q, db)).map((r) => r.result), ['fired']);
  assert.deepEqual(await wakeSweep(q, db), []); // fires once
  const fired = (await getIncident(db, id))!;
  assert.equal(fired.pages.filter((p) => p.step < 0).length, 1);
  assert.equal(fired.timeline.filter((e) => e.kind === 'wake').length, 1);

  // A new checkpoint arms a new condition and stops the old one if still watching; errors are kept and retried.
  await tx((c) => addCheckpoint(c, id, { ...cp, wake_expr: 'other' }, 'op'), db);
  await tx((c) => addCheckpoint(c, id, { ...cp, wake_expr: 'third' }, 'op'), db);
  const [k3, k2] = await checkpoints(db, id);
  assert.equal(k3.wake_state, 'watching');
  assert.equal(k2.wake_state, 'stopped');
  assert.deepEqual((await wakeSweep(async () => { throw new Error('Prometheus 503'); }, db)).map((r) => r.result), ['error']);
  assert.equal((await checkpoints(db, id))[0].wake_error, 'Prometheus 503');

  // By hand: same effect as a match (fired, one urgent page, logged as manual); nothing left to fire after.
  assert.equal(await tx((c) => fireWakeByHand(c, id, 'op'), db), true);
  assert.equal((await checkpoints(db, id))[0].wake_state, 'fired');
  const byHand = (await getIncident(db, id))!.timeline.filter((e) => e.kind === 'wake');
  assert.equal(byHand.length, 2);
  assert.equal(byHand.filter((e) => (e.body as { manual?: boolean }).manual).length, 1);
  await assert.rejects(tx((c) => fireWakeByHand(c, id, 'op'), db), /no wake condition/);
  await tx((c) => addCheckpoint(c, id, { ...cp, wake_expr: 'fourth' }, 'op'), db);

  await tx((c) => transition(c, id, 'mitigated', 'op'), db);
  await tx((c) => transition(c, id, 'resolved', 'op'), db);
  assert.deepEqual((await wakeSweep(q, db)).map((r) => r.result), ['stopped']);
  assert.ok((await getIncident(db, id))!.timeline.some((e) => e.kind === 'wake_stopped'));
});

test('change correlation: Flux events map to components; changes in the 2 h before detection are suspects', { skip: !url }, async () => {
  const t = topology();
  const fin = (await getIncident(db, await incOf('LinethL2FinalizationStalled')))!.inc;
  const detected = new Date(fin.detected_at);
  const ev = (name: string, minutesBefore: number, severity = 'info') => parseFluxEvent({
    involvedObject: { kind: 'Kustomization', namespace: 'flux-system', name }, severity, reason: 'ReconciliationSucceeded', message: 'configured',
    timestamp: new Date(detected.getTime() - minutesBefore * 60_000).toISOString(), metadata: { revision: `main@sha1:${minutesBefore}abc` },
  });
  assert.equal(await recordChange(db, ev('lineth-l2-proving', 30), t), true);
  assert.equal(await recordChange(db, ev('lineth-l2-proving', 30), t), false); // redelivery
  await recordChange(db, ev('lineth-l2-explorer', 10), t); // unrelated component
  await recordChange(db, ev('lineth-l2-settlement', 180), t); // too early
  const chg = { id: 'CHG-2026-10-11-01', title: 'coordinator config', status: 'implementing' as const, risk: 'low' as const,
    window: { start: new Date(detected.getTime() - 3600_000), end: null }, components: ['coordinator'], file: 'f', href: 'h' };
  const s = await suspects(db, t, ['LinethL2FinalizationStalled'], detected, [chg]);
  assert.deepEqual(s.map((x) => [x.what, x.components.join()]), [['flux', 'prover'], ['chg', 'coordinator']]);

  // During the incident: anything that starts after detection and by `until`, on any component.
  await recordChange(db, ev('lineth-l2-explorer', -60), t); // 1 h after detection, unrelated component
  const load = { ...chg, id: 'CHG-2026-10-12-02', components: ['traffic'], window: { start: new Date(detected.getTime() + 2 * 3600_000), end: null } };
  const d = await duringIncident(db, detected, new Date(detected.getTime() + 3 * 3600_000), [chg, load]);
  assert.deepEqual(d.map((x) => x.what === 'chg' ? x.label.split(' ')[0] : x.label.split(' ')[1]), ['CHG-2026-10-12-02', 'lineth-l2-explorer']);
  assert.deepEqual(await duringIncident(db, detected, new Date(detected.getTime() + 30 * 60_000), [load]), []);
});

test('merge, split, and the 15-minute page for an unhandled critical candidate', { skip: !url }, async () => {
  const a = await fresh('TestMergeA');
  const b = await fresh('TestMergeB');
  await tx((c) => merge(c, a, b, 'op'), db);
  assert.equal((await getIncident(db, a))!.inc.state, 'dismissed');
  const into = (await getIncident(db, b))!;
  assert.equal(into.alerts.length, 2);
  assert.ok(into.timeline.some((e) => e.kind === 'merge'));
  await assert.rejects(tx((c) => merge(c, b, b, 'op'), db), /itself/);

  const keyOf = (x: { fingerprint: string; starts_at: Date }) => `${x.fingerprint}|${new Date(x.starts_at).toISOString()}`;
  await assert.rejects(tx((c) => split(c, b, into.alerts.map(keyOf), 'op'), db), /at least one/);
  const nid = await tx((c) => split(c, b, [keyOf(into.alerts[0])], 'op'), db);
  assert.equal((await getIncident(db, nid))!.alerts.length, 1);
  assert.equal((await getIncident(db, b))!.alerts.length, 1);

  // Critical and firing, created 15+ minutes ago, still a candidate → one triage page.
  await post({ version: '4', groupKey: '{}:{alertname="TestCritical"}', alerts: [{ status: 'firing', fingerprint: 'crit', labels: { alertname: 'TestCritical', severity: 'critical' },
    annotations: { summary: 'crit' }, startsAt: new Date().toISOString(), endsAt: '0001-01-01T00:00:00Z' }] });
  const crit = await incOf('TestCritical');
  const later = new Date(Date.now() + 16 * 60_000);
  assert.equal(await triageSweep(db, new Date()), 0);
  assert.ok(await triageSweep(db, later) >= 1);
  assert.equal(await triageSweep(db, later), 0);
  assert.deepEqual((await getIncident(db, crit))!.pages.map((p) => [p.kind, p.step]), [['triage', 1]]);
});

test('runbook steps tick and untick onto the timeline', { skip: !url }, async () => {
  const id = await fresh('TestRunbook');
  const key = '0123456789abcdef';
  await tx((c) => setRunbookStep(c, id, 'prover-oom-loop', key, 'Free memory first', true, 'op'), db);
  await tx((c) => setRunbookStep(c, id, 'prover-oom-loop', key, 'Free memory first', true, 'op'), db); // no double tick
  assert.equal((await runbookSteps(db, id)).length, 1);
  await tx((c) => setRunbookStep(c, id, 'prover-oom-loop', key, 'Free memory first', false, 'op'), db);
  assert.equal((await runbookSteps(db, id)).length, 0);
  assert.equal((await getIncident(db, id))!.timeline.filter((e) => e.kind === 'runbook').length, 2);
  await assert.rejects(tx((c) => setRunbookStep(c, id, 'bad id!', key, 'x', true, 'op'), db), /invalid/);
});

test('follow-ups: mock issues, and closing waits until every follow-up has one', { skip: !url }, async () => {
  const id = await fresh('TestFollowUps');
  await tx(async (c) => { await setSev(c, id, 3, 'op'); await transition(c, id, 'declared', 'op'); await transition(c, id, 'mitigated', 'op'); await transition(c, id, 'resolved', 'op'); }, db);
  await tx((c) => addFollowUp(c, id, { action: 'Prover memory request 10Gi', type: 'prevent', priority: 'P0', owner: 'op' }, 'op'), db);
  await assert.rejects(tx((c) => addFollowUp(c, id, { action: 'x', type: 'other', priority: 'P0', owner: '' }, 'op'), db), /type/);
  await assert.rejects(tx((c) => transition(c, id, 'closed', 'op'), db), /no issue/);
  const [f] = await followUps(db, id);
  await tx((c) => createIssue(c, id, f.id, 'op'), db);
  await tx((c) => createIssue(c, id, f.id, 'op'), db); // once
  const [g] = await followUps(db, id);
  assert.equal(g.issue_number, 1000 + Number(f.id));
  assert.deepEqual(g.issue_labels, [`incident:#${id}`, 'type:prevent']);
  await tx((c) => setFollowUpDone(c, id, f.id, true, 'op'), db);
  assert.ok((await followUps(db, id))[0].done_at);
  await tx((c) => transition(c, id, 'closed', 'op'), db);
  assert.equal((await getIncident(db, id))!.inc.state, 'closed');
  assert.equal((await getIncident(db, id))!.timeline.filter((e) => e.kind === 'follow_up').length, 3);
});

test('handoff: draft 30 min before the shift ends, ready freezes, ack; unacknowledged 15 min after the end pages once', { skip: !url }, async () => {
  const at = (iso: string) => new Date(iso);
  await handoffSweep(db, at('2026-10-13T07:20:00Z')); // 40 min before APAC ends: no draft yet
  assert.equal((await db.query('SELECT 1 FROM handoffs')).rowCount, 0);
  await handoffSweep(db, at('2026-10-13T07:31:00Z'));
  const id = (await db.query<{ id: string }>('SELECT id::text FROM handoffs')).rows[0].id;
  assert.equal(await ensureDraft(db, at('2026-10-13T07:45:00Z')), id); // idempotent
  const h = (await handoff(db, id))!;
  assert.deepEqual([h.shift_id, h.to_shift_id, h.status, h.shift_end.toISOString()], ['apac', 'eu', 'draft', '2026-10-13T08:00:00.000Z']);
  await tx((c) => setNote(c, id, 'watch maru heap'), db);
  const data = { from: '', to: '', incidents: [], alerts: [], worse: [], slo: [], chgs: [], flux: [] };
  await tx((c) => markReady(c, id, 'op', data), db);
  await assert.rejects(tx((c) => markReady(c, id, 'op', data), db), /ready/);
  await handoffSweep(db, at('2026-10-13T08:10:00Z')); // within 15 min: no page
  assert.equal((await handoff(db, id))!.paged_at, null);
  await handoffSweep(db, at('2026-10-13T08:16:00Z'));
  const paged = (await handoff(db, id))!.paged_at;
  assert.ok(paged);
  await handoffSweep(db, at('2026-10-13T08:20:00Z'));
  assert.deepEqual((await handoff(db, id))!.paged_at, paged); // once
  await assert.rejects(tx((c) => acknowledge(c, id, 'op2', null, []), db), /not everything was read yet: note/);
  await tx((c) => acknowledge(c, id, 'op2', null, ['note']), db);
  const done = (await handoff(db, id))!;
  assert.deepEqual(done.reads, ['note']);
  assert.equal(done.status, 'acked');
  assert.equal(done.acked_by, 'op2');
  assert.equal(done.note, 'watch maru heap');
  await assert.rejects(tx((c) => setNote(c, id, 'x'), db), /acknowledged/);
});
