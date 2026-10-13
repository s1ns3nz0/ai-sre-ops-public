import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemsFor, phasesBefore, template, validateTemplate } from './checklists.ts';

test('checklists.yaml is valid and filters by SEV', () => {
  const t = template();
  assert.deepEqual(validateTemplate(t), []);
  const sev1 = itemsFor(t, 1).map((i) => i.key);
  const sev4 = itemsFor(t, 4).map((i) => i.key);
  assert.ok(sev1.includes('comms-first') && !sev4.includes('comms-first'));
  assert.ok(sev4.includes('ic-pm-needed') && !sev1.includes('ic-pm-needed'));
  assert.ok(sev1.length > sev4.length);
});

test('transition warnings only cover phases up to the target', () => {
  assert.deepEqual(phasesBefore('mitigated'), ['declare', 'mitigate']);
  assert.deepEqual(phasesBefore('resolved'), ['declare', 'mitigate', 'resolve']);
  assert.deepEqual(phasesBefore('closed'), ['declare', 'mitigate', 'resolve', 'close']);
  assert.deepEqual(phasesBefore('declared'), []);
});

test('template validation catches mistakes', () => {
  const bad = { ic: [{ key: 'a', phase: 'later', text: 'x' }, { key: 'a', phase: 'declare', text: '' }], ops: [], comms: [], planning: [] };
  assert.equal(validateTemplate(bad as never).length, 3);
  const split = { ic: [{ key: 'b', phase: 'declare', text: 'Check (CHGs', 'Flux)': null }], ops: [], comms: [], planning: [] };
  assert.match(validateTemplate(split as never).join(), /quote text/);
});
