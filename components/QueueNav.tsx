'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import type { Incident } from '@/lib/incidents.ts';
import { OPEN } from '@/lib/lifecycle.ts';
import { RAIL, SevBadge, StateBadge } from './badges.tsx';
import { Elapsed } from './Elapsed.tsx';

export type QueueMeta = { score: number; pinned: boolean; cause: string | null; why: string };

export function QueueNav({ items, suspected = [], meta = {} }: { items: Incident[]; suspected?: string[]; meta?: Record<string, QueueMeta> }) {
  const path = usePathname();
  const [tab, setTab] = useState<'open' | 'done'>('open');
  const open = items.filter((i) => OPEN.includes(i.state));
  const done = items.filter((i) => !OPEN.includes(i.state)).slice(0, 50);
  const shown = tab === 'open' ? open : done;
  const tabCls = (t: typeof tab) => `flex-1 h-8 rounded-md text-sm ${tab === t ? 'bg-surface border border-line font-medium' : 'text-sub hover:text-ink'}`;
  return (
    <nav className="p-3">
      <div role="tablist" className="mb-3 flex gap-1 rounded-lg bg-line/50 p-1">
        <button role="tab" aria-selected={tab === 'open'} className={tabCls('open')} onClick={() => setTab('open')}>Unresolved <span className="text-sub">{open.length}</span></button>
        <button role="tab" aria-selected={tab === 'done'} className={tabCls('done')} onClick={() => setTab('done')}>Resolved <span className="text-sub">{done.length}</span></button>
      </div>
      <div className="space-y-2">
        {shown.length ? shown.map((i) => <Item key={i.id} i={i} active={path === `/incidents/${i.id}`} suspect={suspected.includes(i.id)} m={meta[i.id]} />)
          : <p className="px-1 text-sm text-sub">{tab === 'open' ? 'Nothing unresolved.' : 'Nothing resolved yet.'}</p>}
      </div>
    </nav>
  );
}

function Item({ i, active, suspect, m }: { i: Incident; active: boolean; suspect: boolean; m?: QueueMeta }) {
  const sev = i.sev ?? i.sev_suggested;
  const firing = i.firing_count > 0;
  // Declared (being worked) incidents stand out in red; candidates stay neutral. The selected one is outlined blue.
  const declared = i.state === 'declared' || i.state === 'mitigated';
  const border = active ? 'border-[var(--link)] shadow-[0_0_0_1px_var(--link)]' : declared ? 'border-sev1/50' : 'border-line hover:border-ink/30';
  return (
    <Link href={`/incidents/${i.id}`} aria-current={active ? 'page' : undefined}
      className={`relative block overflow-hidden rounded-lg border pl-4 pr-3 py-2.5 ${border} ${declared ? 'bg-sev1/[0.07]' : 'bg-surface'}`}>
      <span className={`absolute inset-y-0 left-0 w-1 ${sev ? RAIL[sev] : 'bg-line'}`} aria-hidden />
      <div className="flex items-start gap-2">
        {firing && (
          <span className="relative mt-1.5 flex size-2 shrink-0" aria-label="alert firing">
            <span className="absolute inline-flex size-full rounded-full bg-sev1 opacity-75 motion-safe:animate-ping" />
            <span className="relative inline-flex size-2 rounded-full bg-sev1" />
          </span>
        )}
        <div className="min-w-0 flex-1 text-sm font-medium leading-snug line-clamp-2">{i.title}</div>
        {m && OPEN.includes(i.state) && <span className={`shrink-0 text-xs font-semibold tabular-nums ${m.pinned ? 'text-sev1' : 'text-sub'}`} title={`Priority score${m.pinned ? ' (pinned: critical alert firing)' : ''}\n${m.why}`}>{m.score}</span>}
      </div>
      {((m?.cause && OPEN.includes(i.state)) || i.open_follow_ups > 0) && (
        <div className="mt-1 text-xs text-sub">
          {m?.cause && OPEN.includes(i.state) && <>cause: <span className="font-medium text-ink">{m.cause}</span></>}
          {m?.cause && OPEN.includes(i.state) && i.open_follow_ups > 0 && ' · '}
          {i.open_follow_ups > 0 && (
            <span className={i.overdue_follow_ups ? 'font-medium text-sev2' : ''} title={i.overdue_follow_ups ? `${i.overdue_follow_ups} open over 30 days` : undefined}>
              {i.open_follow_ups} open follow-up{i.open_follow_ups === 1 ? '' : 's'}{i.overdue_follow_ups ? ` (${i.overdue_follow_ups} over 30 days)` : ''}
            </span>
          )}
        </div>
      )}
      <div className="mt-1.5 flex items-center gap-2 text-xs text-sub">
        <SevBadge sev={i.sev} suggested={i.sev_suggested} />
        {i.state !== 'candidate' && <StateBadge state={i.state} />}
        {suspect && <span className="rounded bg-sev3/15 px-1.5 font-medium text-sev3" title="A change touched these components in the 2 hours before detection">⚠ change</span>}
        <span className="ml-auto flex items-center gap-2">
          {firing && <span className="font-semibold text-sev1">{i.firing_count} firing</span>}
          <Elapsed from={i.detected_at} until={i.resolved_at ?? i.closed_at} />
        </span>
      </div>
    </Link>
  );
}
