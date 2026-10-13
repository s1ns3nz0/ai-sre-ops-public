import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchRunbooks, parseRunbook } from './runbooks.ts';

const MD = `---
id: prover-oom-loop
alerts: [LinethL2ProverLargeRetry, LinethL2ProverFailures]
components: [prover]
severity: critical
impact_slo: [settlement-freshness]
owner: s1ns3nz0
last_reviewed: 2026-10-13
automation_candidate: false
precedents: [INC-2026-10-11-11]
---
# Prover killed by memory pressure

## Meaning

The prover was killed
while proving.

## Quick mitigation

- [ ] Free memory first
- [ ] Rename the batch back

## Diagnosis

\`\`\`promql
sum by (state) (lineth_prover_requests)
\`\`\`

- a note that
  wraps
`;

test('runbook parsing: frontmatter, sections, steps, queries', () => {
  const r = parseRunbook('runbooks/prover-oom-loop.md', MD);
  assert.equal(r.id, 'prover-oom-loop');
  assert.equal(r.title, 'Prover killed by memory pressure');
  assert.deepEqual(r.alerts, ['LinethL2ProverLargeRetry', 'LinethL2ProverFailures']);
  assert.equal(r.automation_candidate, false);
  assert.deepEqual(r.sections.map((s) => s.title), ['Meaning', 'Quick mitigation', 'Diagnosis']);
  assert.deepEqual(r.sections[0].blocks, [{ kind: 'text', text: 'The prover was killed while proving.' }]);
  const steps = r.sections[1].blocks;
  assert.equal(steps.length, 2);
  assert.ok(steps.every((b) => b.kind === 'step' && b.key.length === 16));
  assert.notEqual((steps[0] as { key: string }).key, (steps[1] as { key: string }).key);
  assert.deepEqual(r.sections[2].blocks[0], { kind: 'code', lang: 'promql', text: 'sum by (state) (lineth_prover_requests)' });
  assert.deepEqual(r.sections[2].blocks[1], { kind: 'item', text: 'a note that wraps' });
  assert.equal(matchRunbooks([r], ['LinethL2ProverLargeRetry'], []).length, 1);
  assert.equal(matchRunbooks([r], [], ['prover']).length, 1);
  assert.equal(matchRunbooks([r], ['Other'], ['maru']).length, 0);
});
