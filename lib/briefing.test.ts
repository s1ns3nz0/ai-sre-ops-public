import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BriefingInput, catalogAction, checkBriefing, numberedSteps } from './briefing.ts';
import { parseRunbook } from './runbooks.ts';

const rb = parseRunbook('runbooks/maru-heap-full.md', `---
id: maru-heap-full
---
# maru old-gen heap nearly full

## Quick mitigation

- [ ] Confirm old gen above 90% (see \`maru-heap-full\`)
- [ ] Restart maru: \`kubectl -n lineth-l2 delete pod maru-0\`

## Fix

- [ ] Find the leak
`);
const base = { incident_id: 3, situation: 's', impact: 'i', cause: 'c', confidence: 'medium' as const };

test('steps are numbered across the runbook, with their place in the section', () => {
  assert.deepEqual(numberedSteps(rb).map((x) => [x.n, x.section, x.pos, x.total]), [[1, 'Quick mitigation', 1, 2], [2, 'Quick mitigation', 2, 2], [3, 'Fix', 1, 1]]);
});

test('a step resolves to its runbook place and command; an action to the catalog command', () => {
  const b = checkBriefing(BriefingInput.parse({ ...base, items: [
    { runbook: 'maru-heap-full', step: 2, title: 'Restart maru', decision: 'not_needed', why: 'heap 28%',
      action: { type: 'restart_pod', params: { namespace: 'lineth-l2', pod: 'maru-0' }, risk_level: 'medium', expected: 'heap drops', verify: 'k8s_get' } },
    { runbook: 'maru-heap-full', step: 1, title: 'Check heap', decision: 'do_now', why: 'confirm', query: 'up' },
  ] }), [rb]);
  assert.equal(b.items[0].command, 'kubectl -n lineth-l2 delete pod maru-0');
  assert.equal(b.items[0].action?.summary, 'Restart pod maru-0 (lineth-l2)');
  assert.deepEqual([b.items[0].section, b.items[0].pos, b.items[0].total], ['Quick mitigation', 2, 2]);
  assert.equal(b.items[1].command, undefined);
});

test('rejects unknown runbooks, steps and actions outside the catalog', () => {
  const item = { title: 't', decision: 'do_now', why: 'w' };
  assert.throws(() => checkBriefing(BriefingInput.parse({ ...base, items: [{ ...item, runbook: 'nope', step: 1 }] }), [rb]), /no runbook/);
  assert.throws(() => checkBriefing(BriefingInput.parse({ ...base, items: [{ ...item, runbook: 'maru-heap-full', step: 9 }] }), [rb]), /no \[step 9\]/);
  assert.throws(() => BriefingInput.parse({ ...base, items: [{ ...item, action: { type: 'exec', params: {}, risk_level: 'low', expected: 'e', verify: 'v' } }] }));
  assert.throws(() => checkBriefing(BriefingInput.parse({ ...base, items: [{ ...item, action: { type: 'restart_pod', params: { namespace: 'vault', pod: 'x' }, risk_level: 'low', expected: 'e', verify: 'v' } }] }), [rb]));
});

test('a runbook command that is a catalog action gets the action even when the AI did not attach one', () => {
  const b = checkBriefing(BriefingInput.parse({ ...base, items: [
    { runbook: 'maru-heap-full', step: 2, title: 'Restart maru', decision: 'not_needed', why: 'heap 28%' },
    { runbook: 'maru-heap-full', step: 1, title: 'Check heap', decision: 'do_now', why: 'confirm' },
  ] }), [rb]);
  assert.equal(b.items[0].action?.type, 'restart_pod');
  assert.equal(b.items[0].command, 'kubectl -n lineth-l2 delete pod maru-0');
  assert.equal(b.items[1].command, undefined); // `maru-heap-full` is a name, not a command
  assert.deepEqual(catalogAction('flux reconcile kustomization lineth-l2-execution'), { type: 'flux_reconcile', params: { kind: 'Kustomization', name: 'lineth-l2-execution', namespace: 'flux-system' } });
  assert.equal(catalogAction('kubectl -n lineth-l2 delete pod maru-0 --force'), null);
  const vault = parseRunbook('r.md', '---\nid: v\n---\n# v\n## Q\n- [ ] Restart: `kubectl -n vault delete pod vault-0`\n');
  const v = checkBriefing(BriefingInput.parse({ ...base, items: [{ runbook: 'v', step: 1, title: 't', decision: 'do_now', why: 'w' }] }), [vault]);
  assert.equal(v.items[0].action, undefined); // outside the catalog's namespaces: copy only, never a button
  assert.equal(v.items[0].command, 'kubectl -n vault delete pod vault-0');
});
