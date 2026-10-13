'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { REGIONS, dayLabel, dstChangeWithin, fmtOffset, hhmm, offsetMinutes, shiftAt, type RegionId, type Shift } from '@/lib/time.ts';
import { setRegion, useNow, useRegion } from './region.ts';

const NAV = [
  { href: '/', label: 'Overview', match: (p: string) => p === '/' },
  { href: '/infrastructure', label: 'Infrastructure', match: (p: string) => p.startsWith('/infrastructure') },
  { href: '/detection', label: 'Detection', match: (p: string) => p.startsWith('/detection') },
  { href: '/incidents', label: 'Incidents', match: (p: string) => p.startsWith('/incidents') },
  { href: '/handoff', label: 'Handoff', match: (p: string) => p.startsWith('/handoff') },
  { href: '/reliability', label: 'Reliability', match: (p: string) => p.startsWith('/reliability') },
  { href: '/postmortems', label: 'Postmortems', match: (p: string) => p.startsWith('/postmortems') },
  { href: '/ai', label: 'AI', match: (p: string) => p.startsWith('/ai') },
];

export function TimeBar({ shifts }: { shifts: Shift[] }) {
  const now = useNow();
  const mine = useRegion();
  const path = usePathname();
  return (
    <header className="sticky top-0 z-10 bg-bar text-white/60">
      <div className="flex h-12 items-stretch gap-0 px-4 text-sm">
        <Link href="/" className="mr-5 flex items-center font-semibold tracking-tight text-white">AI SRE Ops</Link>
        {now ? (
          <>
            {/* One cell per clock: name and offset on top, the time large below. UTC is the reference. */}
            <Clock name="UTC" sub="reference" day={dayLabel('UTC', now)} time={hhmm('UTC', now)} title="Basis for every stored and computed time" utc />
            {REGIONS.map((r) => {
              const dst = dstChangeWithin(r.tz, now);
              const on = mine === r.id;
              return (
                <Clock key={r.id} name={r.label} sub={`UTC${fmtOffset(offsetMinutes(r.tz, now))}${dst ? ' ⚠ DST' : ''}`} day={dayLabel(r.tz, now)} time={hhmm(r.tz, now)} on={on}
                  title={dst ? `${r.label}: UTC offset changes within 7 days (DST)` : on ? `${r.label} is your region` : `Set ${r.label} as my region`}
                  onClick={() => setRegion(r.id as RegionId)} />
              );
            })}
            <span className="ml-auto flex items-center text-white/70">
              {(() => { const s = shiftAt(now, shifts); return <><b className="mr-1.5 font-medium text-white">{s.name} shift</b>{Math.floor(s.minutesLeft / 60)}h {s.minutesLeft % 60}m left</>; })()}
            </span>
          </>
        ) : (
          <span className="flex items-center">UTC …</span>
        )}
      </div>
      {/* The menu on its own light band: the page's main way around, so it reads before the banners below it. */}
      <nav aria-label="Main" className="flex h-11 items-stretch gap-1 border-b border-line bg-surface px-3 shadow-[0_1px_2px_rgb(0_0_0/0.04)]">
        {NAV.map((n) => {
          const active = n.match(path);
          return (
            <Link key={n.href} href={n.href} aria-current={active ? 'page' : undefined}
              className={`inline-flex items-center border-b-[3px] px-3 pt-[3px] text-[15px] transition-colors ${active ? 'border-[var(--link)] font-semibold text-ink' : 'border-transparent text-sub hover:bg-canvas hover:text-ink'}`}>
              {n.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}

function Clock({ name, sub, day, time, title, utc = false, on = false, onClick }: {
  name: string; sub: string; day: string; time: string; title: string; utc?: boolean; on?: boolean; onClick?: () => void;
}) {
  const body = (
    <>
      <span className="flex items-baseline gap-1.5 text-[11px] leading-none">
        <span className={`font-semibold ${on || utc ? 'text-white' : 'text-white/75'}`}>{name}</span>
        <span className="text-white/45">{sub}</span>
        {on && <span aria-label="my region" className="size-1.5 self-center rounded-full bg-accent" />}
      </span>
      <span className="mt-1 flex items-baseline gap-1.5 leading-none">
        <b className={`text-[17px] font-semibold tabular-nums ${on || utc ? 'text-accent' : 'text-white/85'}`}>{time}</b>
        <span className="text-[11px] text-white/45">{day}</span>
      </span>
    </>
  );
  const cls = `flex flex-col justify-center border-l border-white/10 px-3.5 text-left ${utc ? 'bg-white/[0.04]' : ''} ${on ? 'bg-white/10' : ''}`;
  return onClick
    ? <button type="button" onClick={onClick} title={title} aria-pressed={on} className={`${cls} hover:bg-white/[0.07]`}>{body}</button>
    : <span title={title} className={cls}>{body}</span>;
}
