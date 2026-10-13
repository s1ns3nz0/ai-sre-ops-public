import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_STEP, duePage } from './paging.ts';

const MIN = 60_000;

test('SEV1–2 escalate ntfy → ntfy urgent → Slack', () => {
  assert.deepEqual(duePage(2, { sent: 0, sinceFirst: 0, notified: false }), { step: 1, channel: 'ntfy', priority: 'high' });
  assert.equal(duePage(2, { sent: 1, sinceFirst: 4 * MIN, notified: false }), null);
  assert.deepEqual(duePage(1, { sent: 1, sinceFirst: 5 * MIN, notified: false }), { step: 2, channel: 'ntfy', priority: 'urgent' });
  assert.equal(duePage(1, { sent: 2, sinceFirst: 14 * MIN, notified: false }), null);
  assert.equal(duePage(1, { sent: 2, sinceFirst: 15 * MIN, notified: false })?.channel, 'slack');
  assert.equal(duePage(1, { sent: 3, sinceFirst: 30 * MIN, notified: false })?.step, 4);
  assert.equal(duePage(1, { sent: MAX_STEP, sinceFirst: 999 * MIN, notified: false }), null);
});

test('SEV3 posts to Slack once, SEV4 and unset never page', () => {
  assert.deepEqual(duePage(3, { sent: 0, sinceFirst: 0, notified: false }), { step: 0, channel: 'slack', priority: 'default' });
  assert.equal(duePage(3, { sent: 0, sinceFirst: 0, notified: true }), null);
  assert.equal(duePage(4, { sent: 0, sinceFirst: 0, notified: false }), null);
  assert.equal(duePage(null, { sent: 0, sinceFirst: 0, notified: false }), null);
});
