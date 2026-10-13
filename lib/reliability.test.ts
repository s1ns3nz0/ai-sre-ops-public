import { test } from 'node:test';
import assert from 'node:assert/strict';
import { durations, quantile, repeats, summarize, type ReliabilityRow } from './reliability.ts';

const t = (h: number) => new Date(Date.UTC(2026, 9, 11, h));
const row = (id: string, cause: string | null, o: Partial<ReliabilityRow> = {}): ReliabilityRow => ({
  id, title: id, sev: 2, state: 'closed', cause, detected_at: t(0), declared_at: t(1), mitigated_at: t(2), resolved_at: t(5), first_page_at: t(1), acked_at: null, ...o,
});

test('durations follow the definitions; missing stamps are null', () => {
  assert.deepEqual(durations(row('a', null)), { mttd: 3600_000, mtta: null, mttm: 3600_000, mttr: 5 * 3600_000 });
});

test('quantiles and summary', () => {
  assert.equal(quantile([], 0.5), null);
  assert.equal(quantile([5, 1, 3], 0.5), 3);
  assert.equal(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);
  const s = summarize([row('a', null), row('b', null, { declared_at: t(3), mitigated_at: t(4) })]);
  assert.equal(s.mttd.n, 2);
  assert.equal(s.mttd.p90, 3 * 3600_000);
  assert.equal(s.mtta.n, 0);
});

test('repeats: same cause within 30 days', () => {
  const day = 86_400_000;
  const r = repeats([
    row('inc8', 'prover'), row('inc11', 'prover', { detected_at: new Date(t(0).getTime() + day) }),
    row('inc10', 'maru'), row('old', 'maru', { detected_at: new Date(t(0).getTime() - 60 * day) }),
  ]);
  assert.deepEqual(r.map((x) => [x.cause, x.incidents.map((i) => i.id)]), [['prover', ['inc8', 'inc11']]]);
});
