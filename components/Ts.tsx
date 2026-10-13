'use client';
import { REGIONS, hhmm } from '@/lib/time.ts';

const day = (tz: string, d: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, month: '2-digit', day: '2-digit' }).format(d);

// UTC only on screen ("10-11 17:57 UTC"); hover shows the three regions. Region offsets live in the top bar.
export function Ts({ at }: { at: Date | string | null }) {
  if (!at) return <span className="text-muted">—</span>;
  const d = new Date(at);
  const title = REGIONS.map((x) => `${x.label} ${day(x.tz, d)} ${hhmm(x.tz, d)}`).join(' · ');
  return (
    <time dateTime={d.toISOString()} title={title} className="whitespace-nowrap">
      {day('UTC', d)} {hhmm('UTC', d)} UTC
    </time>
  );
}
