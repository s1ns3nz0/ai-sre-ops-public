import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayLabel, dstChangeWithin, fmtOffset, hhmm, offsetMinutes, shiftAt, shiftWindow } from './time.ts';
import { shifts, validateShifts } from './shifts.ts';

test('offsets follow DST', () => {
  const summer = new Date('2026-10-13T07:42:00Z');
  const winter = new Date('2026-11-10T07:42:00Z');
  assert.equal(offsetMinutes('Asia/Seoul', summer), 540);
  assert.equal(offsetMinutes('America/New_York', summer), -240);
  assert.equal(offsetMinutes('America/New_York', winter), -300);
  assert.equal(offsetMinutes('Europe/Paris', summer), 120);
  assert.equal(offsetMinutes('Europe/Paris', winter), 60);
  assert.equal(fmtOffset(-240), '−4');
  assert.equal(fmtOffset(540), '+9');
  assert.equal(hhmm('Asia/Seoul', summer), '16:42');
});

test('DST warning inside the EU 10-25 / US 11-01 window', () => {
  const d = new Date('2026-10-20T00:00:00Z');
  assert.equal(dstChangeWithin('Europe/Paris', d), true);
  assert.equal(dstChangeWithin('America/New_York', d), false);
  assert.equal(dstChangeWithin('Asia/Seoul', d), false);
});

test('shifts.yaml is valid; shift and its window from the UTC hour', () => {
  const list = shifts();
  assert.deepEqual(shiftAt(new Date('2026-10-13T07:44:00Z'), list), { name: 'APAC', minutesLeft: 16 });
  assert.deepEqual(shiftAt(new Date('2026-10-13T23:00:00Z'), list), { name: 'US', minutesLeft: 60 });
  const w = shiftWindow(new Date('2026-10-13T09:30:00Z'), list);
  assert.equal(w.shift.id, 'eu');
  assert.equal(w.start.toISOString(), '2026-10-13T08:00:00.000Z');
  assert.equal(w.end.toISOString(), '2026-10-13T16:00:00.000Z');
  assert.equal(w.prev.id, 'apac');
  assert.equal(w.next.id, 'us');
  assert.equal(shiftWindow(new Date('2026-10-13T01:00:00Z'), list).prev.id, 'us');
  assert.match(validateShifts([{ id: 'a', name: 'A', start: 0, end: 10, roster: ['x'] }, { id: 'b', name: 'B', start: 12, end: 24, roster: [] }]).join(), /gap.*empty roster/);
});

test('each clock has its own date', () => {
  const d = new Date('2026-10-13T02:50:00Z');
  assert.equal(dayLabel('UTC', d), 'Tue 10-13');
  assert.equal(dayLabel('America/New_York', d), 'Mon 10-12');
  assert.equal(dayLabel('Asia/Seoul', d), 'Tue 10-13');
});
