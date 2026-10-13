import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDefinitions, previewExpr, updateSlo, updateSlos, validateSlo, type SloDef } from './slo.ts';

const defs: SloDef[] = [
  { name: 'block-production', objective: 0.995, kind: 'time', sli: 'changes(x[1m]) > bool 0', page: true, description: 'Blocks.' },
  { name: 'deposit-2m', objective: 0.95, kind: 'event', span_latency: { workflow: 'deposit', le: '120' }, page: false, description: 'Deposits.' },
];
const FILE = `${JSON.stringify(defs, null, 2)}\n`;

test('edit one SLO, keep the rest byte for byte', () => {
  const out = updateSlo(FILE, 'block-production', { ...defs[0], objective: 0.99 });
  assert.equal(out, FILE.replace('"objective": 0.995', '"objective": 0.99'));
  assert.throws(() => updateSlo(FILE, 'nope', defs[0]), /not found/);
  assert.throws(() => updateSlo(FILE, 'block-production', { ...defs[0], name: 'deposit-2m' }), /already exists/);
});

test('changing kind drops the other kind\'s fields', () => {
  const out = parseDefinitions(updateSlo(FILE, 'deposit-2m', { ...defs[1], span_latency: undefined, good: 'a[W]', valid: 'b[W]' }));
  assert.deepEqual(Object.keys(out[1]), ['name', 'objective', 'kind', 'good', 'valid', 'page', 'description']);
});

test('validation mirrors the generator', () => {
  assert.deepEqual(validateSlo(defs[0]), []);
  assert.deepEqual(validateSlo(defs[1]), []);
  assert.ok(validateSlo({ ...defs[0], objective: 1 }).length);
  assert.ok(validateSlo({ ...defs[0], sli: ' ' }).length);
  assert.ok(validateSlo({ ...defs[1], span_latency: undefined, good: 'a', valid: 'b' }).length);
  assert.ok(validateSlo({ ...defs[1], span_latency: { workflow: 'deposit', le: 'two' } }).length);
});

test('preview expression', () => {
  assert.equal(previewExpr(defs[0]), 'changes(x[1m]) > bool 0');
  assert.equal(previewExpr({ ...defs[1], span_latency: undefined, good: 'sum(increase(a[W]))', valid: 'v' }), 'sum(increase(a[5m]))');
});

test('recording rule overrides: validated per kind, kept in one batch, dropped when the kind changes', () => {
  const ov = { ...defs[0], records: { 'slo:sli_error:ratio_rate1h': '0 * vector(1)' } };
  assert.deepEqual(validateSlo(ov), []);
  assert.ok(validateSlo({ ...defs[0], records: { 'slo:nope': 'x' } }).length);
  assert.ok(validateSlo({ ...defs[0], records: { 'slo:sli_error:ratio_rate1h': ' ' } }).length);
  assert.ok(validateSlo({ ...defs[1], records: { 'slo:sli_good:bool1m': 'x' } }).length); // time-only rule
  const out = parseDefinitions(updateSlos(FILE, [
    { original: 'block-production', next: ov },
    { original: 'deposit-2m', next: { ...defs[1], objective: 0.9 } },
  ]));
  assert.deepEqual(out[0].records, ov.records);
  assert.equal(out[1].objective, 0.9);
  const asEvent = parseDefinitions(updateSlo(FILE, 'block-production', { ...ov, kind: 'event', good: 'a[W]', valid: 'b[W]' }));
  assert.deepEqual(asEvent[0].records, ov.records); // ratio_rate1h exists for event SLOs too
  const asEvent2 = parseDefinitions(updateSlo(FILE, 'block-production', { ...defs[0], kind: 'event', good: 'a[W]', valid: 'b[W]', records: { 'slo:sli_good:bool1m': 'x' } }));
  assert.equal(asEvent2[0].records, undefined);
});
