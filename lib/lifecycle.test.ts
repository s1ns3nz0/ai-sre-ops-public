import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedNext, suggestSev, transitionError } from './lifecycle.ts';

test('forward path only, with reopen from resolved', () => {
  assert.equal(transitionError('candidate', 'declared', 2), null);
  assert.equal(transitionError('declared', 'mitigated', 2), null);
  assert.match(transitionError('declared', 'resolved', 2)!, /not allowed/);
  assert.match(transitionError('closed', 'declared', 2)!, /not allowed/);
  assert.equal(transitionError('resolved', 'declared', 2), null);
});

test('declaring needs a SEV', () => {
  assert.match(transitionError('candidate', 'declared', null)!, /SEV/);
});

test('SEV1-2 cannot skip postmortem, SEV3-4 can', () => {
  assert.deepEqual(allowedNext('resolved', 2), ['postmortem', 'declared']);
  assert.deepEqual(allowedNext('resolved', 3), ['postmortem', 'closed', 'declared']);
});

test('SEV suggestion takes the worst alert', () => {
  assert.equal(suggestSev([]), null);
  assert.equal(suggestSev([{ alertname: 'X', severity: 'warning' }]), 3);
  assert.equal(suggestSev([{ alertname: 'X', severity: 'warning' }, { alertname: 'Y', severity: 'critical' }]), 2);
  assert.equal(suggestSev([{ alertname: 'LinethL2SequencerStalled', severity: 'critical' }]), 1);
});
