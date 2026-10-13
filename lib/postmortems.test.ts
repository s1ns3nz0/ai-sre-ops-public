import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextNumber, parsePostmortem } from './postmortems.ts';

const pm = `---
id: PM-2026-10-11-10
incident: INC-2026-10-11-10
title: "maru Java heap exhausted"
status: reviewed
severity: 1
date: 2026-10-11
incident_state: mitigated
components: [maru, sequencer]
authors: [s1ns3nz0, Claude]
actions:
  - {"id": "A1", "type": "mitigate", "priority": "P0", "owner": "s1ns3nz0", "status": "done", "action": "Exit on OOM", "note": "done"}
  - {"id": "A3", "type": "prevent", "priority": "P1", "owner": "s1ns3nz0", "status": "open", "action": "Find the leak", "note": "open"}
---
# Postmortem: maru Java heap exhausted (INC-2026-10-11-10)

| | |
|---|---|
| Duration | impact 19:54 → 00:29 (4 h 36 min) |
`;

test('frontmatter, action items and the duration line', () => {
  const p = parsePostmortem('postmortems/PM-2026-10-11-10-maru.md', pm)!;
  assert.equal(p.status, 'reviewed');
  assert.equal(p.severity, 1);
  assert.deepEqual(p.components, ['maru', 'sequencer']);
  assert.deepEqual(p.actions.map((a) => [a.id, a.status]), [['A1', 'done'], ['A3', 'open']]);
  assert.equal(p.duration, 'impact 19:54 → 00:29 (4 h 36 min)');
  assert.equal(nextNumber([p]), '11');
  assert.equal(p.summary, '');
});

test('no or invalid frontmatter is skipped', () => {
  assert.equal(parsePostmortem('x.md', '# no frontmatter'), null);
  assert.equal(parsePostmortem('x.md', pm.replace('status: reviewed', 'status: published')), null);
});

test('summary is the first paragraph of the Summary section', () => {
  const p = parsePostmortem('x.md', pm.replace('| Duration |', '## 1. Summary\n\nMaru leaked heap\nand stopped.\n\nSecond paragraph.\n\n## 2. Impact\n\n| Duration |'))!;
  assert.equal(p.summary, 'Maru leaked heap and stopped.');
});

test('the write-up splits into facts, sections, a timeline and lessons', async () => {
  const { splitBody, timelineRows, lessons } = await import('./postmortems.ts');
  const body = `# Postmortem: x\n\nBlameless.\n\n| | |\n|---|---|\n| Status | reviewed |\n| Duration | 4 h |\n\n## 1. Summary\n\nIt broke.\n\n## 5. Response and recovery\n\n| time | event / action | result |\n|---|---|---|\n| 04:17 | restart | ok |\n\n## 6. Lessons learned\n\n- **Went well:** fast\n  rollback.\n- **Went badly:** no alert.\n- **Lucky:** quiet hour.\n`;
  const s = splitBody(body);
  assert.deepEqual(s.facts, { Status: 'reviewed', Duration: '4 h' });
  assert.equal(s.intro, 'Blameless.');
  assert.deepEqual(s.sections.map((x) => [x.n, x.title, x.slug]), [['1', 'Summary', 'summary'], ['5', 'Response and recovery', 'response-and-recovery'], ['6', 'Lessons learned', 'lessons-learned']]);
  assert.deepEqual(timelineRows(s.sections[1].text), [{ time: '04:17', what: 'restart', result: 'ok' }]);
  assert.deepEqual(lessons(s.sections[2].text), { well: 'fast rollback.', badly: 'no alert.', lucky: 'quiet hour.' });
  assert.equal(timelineRows('| what | how much |\n|---|---|\n| a | b |'), null);
});
