'use client';
import { useState, type ReactNode } from 'react';
import type { Event } from '@/lib/incidents.ts';
import { EventText } from './EventText.tsx';
import { Ts } from './Ts.tsx';

const TABS = { people: 'People', all: 'All', alerts: 'Alerts' } as const;
type Tab = keyof typeof TABS;
const isAlert = (k: string) => k === 'alert_firing' || k === 'alert_resolved';

// 16px stroke icons, one per event kind, so the kind reads before the text does.
const path: Record<string, ReactNode> = {
  page: <><path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8" /><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" /></>,
  ack: <path d="M20 6 9 17l-5-5" />,
  decision: <><path d="M4 22V4" /><path d="M4 4h13l-2 4 2 4H4" /></>,
  state: <><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></>,
  note: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
  checklist: <><rect x="3" y="3" width="18" height="18" rx="3" /><path d="m8 12 3 3 5-6" /></>,
  role: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
  sev: <><path d="M12 3 2 21h20z" /><path d="M12 10v5" /><path d="M12 18h.01" /></>,
  summary: <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></>,
  reopen: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></>,
  runbook: <><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z" /><path d="m9 10 2 2 4-4" /></>,
  change: <><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="M6 8.5v4a4 4 0 0 0 4 4h5.5" /></>,
  checkpoint: <><path d="M12 2v4" /><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2 2" /></>,
  wake: <><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2 2" /><path d="M5 3 2 6" /><path d="m22 6-3-3" /></>,
  wake_stopped: <><circle cx="12" cy="13" r="8" /><path d="M9 13h6" /></>,
};
const TONE: Record<string, string> = {
  page: 'bg-sev1 text-white', wake: 'bg-sev1 text-white', checkpoint: 'bg-ink text-white', change: 'bg-sev3/15 text-sev3', ack: 'bg-emerald-600 text-white', decision: 'bg-ink text-white', reopen: 'bg-sev1 text-white',
  alert_firing: 'bg-sev1/15 text-sev1', alert_resolved: 'bg-emerald-50 text-emerald-700',
};

function Icon({ kind }: { kind: string }) {
  const tone = TONE[kind] ?? 'bg-surface text-sub ring-1 ring-line';
  return (
    <span className={`relative z-[1] flex size-7 shrink-0 items-center justify-center rounded-full ${tone}`} aria-hidden>
      {isAlert(kind)
        ? <span className="size-2 rounded-full bg-current" />
        : <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">{path[kind] ?? path.note}</svg>}
    </span>
  );
}

// Newest first on a vertical rail. Default shows what people did; alert churn is one click away.
export function Updates({ events, actions }: { events: Event[]; actions?: ReactNode }) {
  const [tab, setTab] = useState<Tab>('people');
  const shown = events.filter((e) => (tab === 'all' ? true : tab === 'alerts' ? isAlert(e.kind) : !isAlert(e.kind)));
  return (
    <div>
      <div className="flex items-center gap-2">
      <div role="tablist" className="inline-flex rounded-lg border border-line p-0.5 text-sm">
        {(Object.keys(TABS) as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
            className={`h-7 px-3 rounded-md ${tab === t ? 'bg-ink text-white' : 'text-sub hover:text-ink'}`}>
            {TABS[t]}
          </button>
        ))}
      </div>
      {actions && <div className="ml-auto">{actions}</div>}
      </div>
      <ol className="relative mt-5 before:absolute before:inset-y-3 before:left-[13px] before:w-px before:bg-line">
        {shown.map((e) => <Entry key={e.id} e={e} />)}
        {!shown.length && <li className="text-sm text-sub">Nothing here yet.</li>}
      </ol>
    </div>
  );
}

function Entry({ e }: { e: Event }) {
  const meta = <span className="shrink-0 text-xs text-sub"><Ts at={e.at} /> · {e.actor}</span>;
  let body: ReactNode = <span className="text-sm"><EventText e={e} /></span>;
  if (e.kind === 'decision') {
    const b = e.body as Record<string, string>;
    body = (
      <div>
        <p className="font-medium">{b.decision}</p>
        <dl className="mt-1 grid gap-x-3 gap-y-0.5 text-sm sm:grid-cols-[6.5rem_1fr]">
          {b.reason && <><dt className="text-sub">Why</dt><dd>{b.reason}</dd></>}
          {b.alternatives && <><dt className="text-sub">Instead of</dt><dd>{b.alternatives}</dd></>}
          {b.revert_when && <><dt className="text-sub">Revert when</dt><dd>{b.revert_when}</dd></>}
        </dl>
      </div>
    );
  } else if (e.kind === 'note') {
    body = <p className="text-sm">{(e.body as { text: string }).text}</p>;
  }
  return (
    <li className="flex gap-3 pb-4">
      <Icon kind={e.kind} />
      <div className="min-w-0 flex-1 pt-1">
        <div className="flex items-baseline gap-3"><div className="min-w-0 flex-1">{body}</div>{meta}</div>
      </div>
    </li>
  );
}
