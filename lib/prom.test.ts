import { test } from 'node:test';
import assert from 'node:assert/strict';
import { health, ownerOf } from './prom.ts';
import { topology, validate } from './topology.ts';

const w = { ns: 'lineth-l2', kind: 'Deployment' as const, name: 'prover', desired: 1, ready: 1, restarts1h: 0 };

test('workload health', () => {
  assert.equal(health(w), 'ok');
  assert.equal(health({ ...w, restarts1h: 3 }), 'degraded');
  assert.equal(health({ ...w, desired: 2 }), 'degraded');
  assert.equal(health({ ...w, ready: 0 }), 'down');
  assert.equal(health({ ...w, desired: 0, ready: 0 }), 'off');
});

test('pods map to their workload by name shape', () => {
  const ws = [
    { ns: 'lineth-l2', kind: 'Deployment' as const, name: 'coordinator' },
    { ns: 'lineth-l2', kind: 'StatefulSet' as const, name: 'coordinator-postgres' },
    { ns: 'lineth-l2', kind: 'Deployment' as const, name: 'prover' },
  ];
  assert.equal(ownerOf('lineth-l2', 'coordinator-postgres-0', ws)?.name, 'coordinator-postgres');
  assert.equal(ownerOf('lineth-l2', 'coordinator-7d9f5c6b8-abcde', ws)?.name, 'coordinator');
  assert.equal(ownerOf('lineth-l2', 'prover-557d645ff7-ghpfj', ws)?.name, 'prover');
  assert.equal(ownerOf('lineth-l2', 'prover-files-cleanup-29863697-l8tw7', ws), undefined); // CronJob pod
  assert.equal(ownerOf('local-l1', 'coordinator-postgres-0', ws), undefined);
});

test('topology.yaml is valid', () => {
  const t = topology();
  assert.deepEqual(validate(t), []);
  assert.match(validate({ ...t, edges: [{ from: 'x', to: 'prover', via: 'rpc' }] }).join(), /unknown from/);
});
