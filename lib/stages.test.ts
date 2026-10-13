import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colorOf, decide, edgeStage } from './stages.ts';
import type { Threshold } from './detection.ts';

const th = (steps: Threshold['steps'], panel = 'Heap Utilization'): Threshold => ({ dashboard: 'd', panel, expr: 'x', unit: 'percent', steps, source: '80% / 95% of max heap.' });
const up = [{ value: null, color: 'green' }, { value: 80, color: 'yellow' }, { value: 95, color: 'red' }];
const down = [{ value: null, color: 'red' }, { value: 1, color: 'green' }]; // "bigger is better" (peers)
const w = (ready: number, desired = 1, restarts1h = 0) => ({ ns: 'n', kind: 'Deployment' as const, name: 'prover', ready, desired, restarts1h });

test('threshold colour', () => {
  assert.equal(colorOf(up, 50), 'green');
  assert.equal(colorOf(up, 80), 'yellow');
  assert.equal(colorOf(up, 99), 'red');
  assert.equal(colorOf(down, 0), 'red');
  assert.equal(colorOf(down, 3), 'green');
});

test('stage: worst signal wins, every signal is a reason', () => {
  assert.equal(decide({ alerts: [], workloads: [w(1)], missing: false, panels: [] }).stage, 'normal');
  assert.equal(decide({ alerts: [], workloads: [w(1)], missing: false, panels: [{ t: th(up), value: 85 }] }).stage, 'slow');
  assert.equal(decide({ alerts: [], workloads: [w(1, 1, 3)], missing: false, panels: [{ t: th(up), value: 85 }] }).stage, 'risk');
  const b = decide({ alerts: [{ component: 'prover', severity: 'critical', alertname: 'A', summary: '' }], workloads: [w(1)], missing: false, panels: [{ t: th(up), value: 85 }] });
  assert.equal(b.stage, 'breach');
  assert.deepEqual(b.reasons.map((r) => r.stage), ['breach', 'slow']);
  assert.equal(decide({ alerts: [], workloads: [w(0)], missing: false, panels: [] }).stage, 'breach');
  assert.equal(decide({ alerts: [], workloads: [w(0, 0)], missing: false, panels: [] }).stage, 'off');
  assert.equal(decide({ alerts: [], workloads: [], missing: true, panels: [] }).stage, 'unknown');
});

test('a link is in trouble when its dependency is and the dependent is affected', () => {
  const e = { from: 'coordinator', to: 'prover', via: 'file' as const };
  assert.equal(edgeStage(e, { prover: { stage: 'breach' }, coordinator: { stage: 'risk' } }), 'breach');
  assert.equal(edgeStage(e, { prover: { stage: 'breach' }, coordinator: { stage: 'normal' } }), null);
  assert.equal(edgeStage(e, { prover: { stage: 'normal' }, coordinator: { stage: 'breach' } }), null);
  const engine = { from: 'maru', to: 'sequencer', via: 'engine' as const }; // sequencer depends on maru
  assert.equal(edgeStage(engine, { maru: { stage: 'risk' }, sequencer: { stage: 'breach' } }), 'risk');
});
