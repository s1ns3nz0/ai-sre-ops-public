// Region clocks (PRD F1). UTC is the only basis; regions are display only.

export const REGIONS = [
  { id: 'us', label: 'ET', tz: 'America/New_York' },
  { id: 'apac', label: 'KST', tz: 'Asia/Seoul' },
  { id: 'eu', label: 'CET', tz: 'Europe/Paris' },
] as const;
export type RegionId = (typeof REGIONS)[number]['id'];

// A shift in UTC hours (from shifts.yaml, read in lib/shifts.ts).
export type Shift = { id: string; name: string; start: number; end: number; roster: string[] };

// Offset of tz from UTC in minutes at instant d (DST-aware, from Intl).
export function offsetMinutes(tz: string, d: Date): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(d).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  return Math.round((asUtc - Math.floor(d.getTime() / 60000) * 60000) / 60000);
}

export function fmtOffset(min: number): string {
  const sign = min < 0 ? '−' : '+';
  const a = Math.abs(min);
  return `${sign}${Math.floor(a / 60)}${a % 60 ? `:${String(a % 60).padStart(2, '0')}` : ''}`;
}

export function hhmm(tz: string, d: Date): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
}

// "Tue 10-13" in tz: each clock shows its own date, since regions can be on different days.
export function dayLabel(tz: string, d: Date): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: '2-digit', day: '2-digit' }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.month}-${p.day}`;
}

export function shiftAt(d: Date, shifts: Shift[]): { name: string; minutesLeft: number } {
  const w = shiftWindow(d, shifts);
  return { name: w.shift.name, minutesLeft: Math.ceil((w.end.getTime() - d.getTime()) / 60000) };
}

// The shift running at d, with its start and end instants; prev/next are the neighbouring shifts.
export function shiftWindow(d: Date, shifts: Shift[]) {
  const h = d.getUTCHours();
  const i = shifts.findIndex((x) => h >= x.start && h < x.end);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const shift = shifts[i];
  return {
    shift, start: new Date(day + shift.start * 3600_000), end: new Date(day + shift.end * 3600_000),
    prev: shifts[(i - 1 + shifts.length) % shifts.length], next: shifts[(i + 1) % shifts.length],
  };
}

// True when tz changes its UTC offset within the next `days` days.
export function dstChangeWithin(tz: string, d: Date, days = 7): boolean {
  const now = offsetMinutes(tz, d);
  for (let i = 1; i <= days; i++) if (offsetMinutes(tz, new Date(d.getTime() + i * 86400000)) !== now) return true;
  return false;
}

// "42m", "5h 12m", "3d 4h".
export function fmtDuration(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60000));
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
