import assert from 'node:assert/strict';
import { test } from 'node:test';
import type pg from 'pg';
import { demoQuery, snapshot } from './demo-prom.ts';

const db = { query: async () => ({ rows: [{ alertname: 'LinethL2MessagesStuck', severity: 'warning' }] }) } as unknown as pg.Pool;
const a = new Date('2026-10-13T12:00:00Z');
const v = async (expr: string) => (await demoQuery(db, a, expr, a)).map((r) => [r.metric, Number(r.value[1])]);

test('scenario values for known queries; trailing comparisons filter like PromQL', async () => {
  assert.deepEqual(await v('max(jvm_memory_used_bytes{job="l2-maru"}) / max(jvm_memory_max_bytes{job="l2-maru"})'), [[{ job: 'l2-maru' }, 0.31]]);
  assert.equal((await v('max(lineth_prover_oldest_request_age_seconds{state="pending"}) > 300')).length, 0);
  assert.equal((await v('max(lineth_prover_oldest_request_age_seconds{state="pending"}) > 60')).length, 1);
  assert.equal((await v('time() - max(kube_cronjob_status_last_successful_time{cronjob="db-backup"}) > 26 * 3600')).length, 0);
  assert.deepEqual((await v('ALERTS{alertstate="firing"}'))[0][0], { alertstate: 'firing', alertname: 'LinethL2MessagesStuck', severity: 'warning' });
  assert.equal((await v('slo:error_budget_remaining:ratio{slo="settlement-freshness"}')).length, 1);
  const fin = await v('max(lineth_l2_rollup_finalized_block{l1_block_tag="latest"})');
  assert.equal((fin[0][0] as Record<string, string>).l1_block_tag, 'latest');
  assert.ok(Number.isInteger(fin[0][1]));
  assert.deepEqual(await v('absent_over_time(up{job="besu"}[2m])'), []);
});

test('the metadata snapshot loads', () => {
  const s = snapshot();
  assert.ok(Object.keys(s.metrics).length > 1000);
  assert.ok(s.metrics.up);
});
