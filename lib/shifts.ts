// Shifts from shifts.yaml (server only). The pure helpers live in lib/time.ts so the clock bar can use them too.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import type { Shift } from './time.ts';

export function validateShifts(list: Shift[]): string[] {
  const errs: string[] = [];
  const sorted = [...list].sort((a, b) => a.start - b.start);
  if (!sorted.length) errs.push('no shifts');
  let at = 0;
  for (const s of sorted) {
    if (s.start !== at) errs.push(`gap or overlap before ${s.id} (${at}:00 → ${s.start}:00)`);
    if (!(s.end > s.start && s.end <= 24)) errs.push(`${s.id}: end must be after start and at most 24`);
    if (!Array.isArray(s.roster) || !s.roster.length) errs.push(`${s.id}: empty roster`);
    at = s.end;
  }
  if (at !== 24) errs.push('shifts must end at 24:00');
  return errs;
}

export function shifts(): Shift[] {
  const list = (parse(readFileSync(path.join(process.cwd(), 'shifts.yaml'), 'utf8')) as { shifts: Shift[] }).shifts;
  const errs = validateShifts(list);
  if (errs.length) throw new Error(`shifts.yaml: ${errs.join('; ')}`);
  return [...list].sort((a, b) => a.start - b.start);
}
