import { test } from 'node:test';
import assert from 'node:assert/strict';
import { componentOf, dependsOn, downstream, pickGroup, probableCause, score } from './grouping.ts';
import { topology } from './topology.ts';

const t = topology();

test('component from labels, then SLO, then the alerts list', () => {
  assert.equal(componentOf(t, { alertname: 'LinethL2ScrapeFailed', job: 'l2-maru', instance: 'maru.lineth-l2.svc.cluster.local:9090' }), 'maru');
  assert.equal(componentOf(t, { alertname: 'LinethL2ScrapeFailed', job: 'l2-coordinator-postgres' }), 'coordinator');
  assert.equal(componentOf(t, { alertname: 'X', namespace: 'lineth-l2', pod: 'prover-6d8f9c7b5d-x2k4q' }), 'prover');
  assert.equal(componentOf(t, { alertname: 'LinethL2SLOBurnRatePage', slo: 'block-production' }), 'sequencer');
  assert.equal(componentOf(t, { alertname: 'LinethL2ProverLargeRetry' }), 'prover');
  assert.equal(componentOf(t, { alertname: 'Unknown' }), null);
});

test('join: firing on the same or a linked component; newest wins', () => {
  const at = (h: number) => new Date(Date.UTC(2026, 9, 11, h));
  const open = [{ id: 'c1', firing: ['coordinator', 'prover'], lastStart: at(17) }, { id: 'c2', firing: ['maru', 'sequencer'], lastStart: at(19) }];
  assert.equal(pickGroup(t, 'prover', open), 'c1');
  assert.equal(pickGroup(t, 'l2-node-besu', open), 'c2'); // linked to both; c2 is newer
  assert.equal(pickGroup(t, 'blockscout', open), null);
});

test('cause = the member the others depend on', () => {
  assert.equal(dependsOn(t, 'coordinator', 'prover'), true);
  assert.equal(dependsOn(t, 'sequencer', 'maru'), true); // engine link: maru drives sequencer
  const at = (m: number) => new Date(Date.UTC(2026, 9, 11, 16, m));
  assert.equal(probableCause(t, [{ comp: 'coordinator', firstAt: at(0) }, { comp: 'prover', firstAt: at(30) }]), 'prover');
  assert.equal(probableCause(t, [{ comp: 'maru', firstAt: at(0) }, { comp: 'sequencer', firstAt: at(5) }, { comp: 'l2-node-besu', firstAt: at(9) }]), 'maru');
  assert.ok(downstream(t, ['prover']).includes('coordinator'));
});

test('score: weighted SLO burn, impact, age, trend; critical pins', () => {
  const now = new Date('2026-10-11T20:00:00Z');
  const s = score(t, { comps: ['prover', 'coordinator'], slos: ['settlement-freshness'], budgets: new Map([['settlement-freshness', -0.9]]),
    critical: true, openSince: new Date('2026-10-11T16:10:00Z'), lastJoin: new Date('2026-10-11T19:55:00Z'), now });
  assert.equal(s.parts[0].points, 76); // 2 × 1.9 × 20
  assert.equal(s.parts[2].points, 20);
  assert.equal(s.parts[3].points, 10);
  assert.equal(s.pinned, true);
  assert.equal(s.total, s.parts.reduce((a, p) => a + p.points, 0));
});
