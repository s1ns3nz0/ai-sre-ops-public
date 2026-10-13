import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupAlerts, readItems, storyText, type HandoffData } from './handoff.ts';

test('alerts grouped by name; 3+ firings in a shift is flapping', () => {
  const a = (alertname: string, severity = 'warning', status = 'resolved') => ({ alertname, severity, status, incident_id: '1' });
  const g = groupAlerts([a('ProverFailures'), a('ProverFailures'), a('ProverFailures', 'warning', 'firing'), a('SequencerStalled', 'critical'), a('MaruHeap')]);
  assert.deepEqual(g.map((x) => [x.alertname, x.count, x.flapping, x.firing]), [
    ['ProverFailures', 3, true, 1], ['SequencerStalled', 1, false, 0], ['MaruHeap', 1, false, 0],
  ]);
});

test('read-through items: note, every incident, and the box of things in no incident', () => {
  const d: HandoffData = { from: '', to: '', slo: [], chgs: [], flux: [],
    incidents: [{ id: '1', title: 'a', sev: 2, state: 'mitigated', checkpoint: null, handoff_to: null, components: ['prover'], firing: [] },
      { id: '3', title: 'b', sev: null, state: 'candidate', checkpoint: null, handoff_to: null, components: ['maru'], firing: ['MaruHeap'] }],
    alerts: [{ alertname: 'MaruHeap', severity: 'warning', count: 1, firing: 1, flapping: false, incident_id: '3' }],
    worse: [{ component: 'maru', from: 'slow', to: 'risk', reason: null }] };
  assert.deepEqual(readItems(d, ''), ['inc:1', 'inc:3']);
  assert.deepEqual(readItems(d, 'watch it'), ['note', 'inc:1', 'inc:3']);
  assert.deepEqual(readItems({ ...d, worse: [...d.worse, { component: 'teku', from: 'normal', to: 'risk', reason: null }] }, ''), ['inc:1', 'inc:3', 'stray']);
});

test('story lines for the turning points', () => {
  assert.equal(storyText('state', { from: 'declared', to: 'mitigated' }), 'declared → mitigated');
  assert.equal(storyText('sev', { from: null, to: 1 }), 'SEV — → 1');
  assert.equal(storyText('decision', { decision: 'Restart maru-0', reason: 'heap full' }), 'Decision: Restart maru-0 (why: heap full)');
  assert.equal(storyText('checkpoint', { status_line: 'Catch-up running' }), 'Checkpoint: Catch-up running');
  assert.equal(storyText('merge', { into: '4' }), 'Merged into #4');
});
