import Link from 'next/link';
import { connection } from 'next/server';
import { Suspense } from 'react';
import { DraftPostmortem } from '@/components/DraftPostmortem.tsx';
import { MdInline } from '@/components/Md.tsx';
import { Ts } from '@/components/Ts.tsx';
import { pool } from '@/lib/db.ts';
import { isDemo } from '@/lib/demo.ts';
import { repoUrl } from '@/lib/detection.ts';
import { ACTION_TYPES, due, postmortems, type Postmortem } from '@/lib/postmortems.ts';

export default function PostmortemsPage({ searchParams }: PageProps<'/postmortems'>) {
  return (
    <div className="min-h-full bg-surface">
      <div className="mx-auto max-w-6xl px-8 py-7">
        <h1 className="text-2xl font-semibold tracking-tight">Postmortems</h1>
        <p className="mt-1 text-sm text-sub">
          Blameless write-ups of what the system and the process allowed, with action items that prevent, detect or mitigate a
          recurrence. The <a href={repoUrl('postmortems')} target="_blank" rel="noreferrer" className="underline underline-offset-2">GitHub repository</a> is
          the single source of truth; drafts open as pull requests.
        </p>
        <Suspense fallback={<p className="mt-6 text-sm text-sub">Loading…</p>}>
          <Body searchParams={searchParams} />
        </Suspense>
      </div>
    </div>
  );
}

const STATUS: Record<Postmortem['status'], string> = { draft: 'bg-sev3/20 text-ink', reviewed: 'bg-[var(--link)]/15 text-[var(--link)]', closed: 'bg-emerald-600/15 text-emerald-700' };
const SEV: Record<number, string> = { 1: 'bg-sev1 text-white', 2: 'bg-sev2 text-white', 3: 'bg-sev3 text-white', 4: 'bg-sev4 text-white' };
const TABS = [['all', 'Postmortems'], ['due', 'Due'], ['actions', 'Action items']] as const;

async function Body({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  const sp = await searchParams;
  const tab = TABS.some(([t]) => t === sp.tab) ? (sp.tab as string) : 'all';
  const q = typeof sp.q === 'string' ? sp.q.trim().toLowerCase() : '';
  const list = await postmortems().catch((e: Error) => e);
  if (list instanceof Error) return <p className="mt-6 text-sm text-sev1">Cannot read the postmortems: {list.message}</p>;
  const owed = await due(pool(), list);
  const actions = list.flatMap((p) => p.actions.map((a) => ({ ...a, pm: p })));
  const open = actions.filter((a) => a.status === 'open');
  const count = { all: list.length, due: owed.length, actions: open.length } as Record<string, number>;
  return (
    <>
      <nav className="mt-5 flex gap-1 border-b border-line" aria-label="Postmortem views">
        {TABS.map(([t, label]) => (
          <Link key={t} href={t === 'all' ? '/postmortems' : `/postmortems?tab=${t}`} aria-current={tab === t ? 'page' : undefined}
            className={`-mb-px inline-flex h-10 items-center gap-2 border-b-2 px-3 text-sm ${tab === t ? 'border-ink font-medium' : 'border-transparent text-sub hover:text-ink'}`}>
            {label}<span className={`rounded-full px-1.5 text-xs ${t === 'due' && count.due ? 'bg-sev1 text-white' : 'bg-line/70 text-sub'}`}>{count[t]}</span>
          </Link>
        ))}
      </nav>

      {tab === 'all' && <Overview list={list} sp={sp} />}

      {tab === 'due' && (
        <div className="mt-4">
          <p className="text-sm text-sub">Every SEV1–2 incident gets a postmortem once it is resolved. These have none yet, or only a draft.</p>
          {!owed.length ? <p className="mt-4 text-sm">Nothing due.</p> : (
            <table className="mt-3 w-full text-sm">
              <thead><tr className="text-left text-xs text-sub"><th className="py-2 font-normal">Incident</th><th className="font-normal">Resolved</th><th className="font-normal">Postmortem</th><th /></tr></thead>
              <tbody>
                {owed.map((i) => (
                  <tr key={i.id} className="border-t border-line align-middle">
                    <td className="py-2.5 pr-4"><Link href={`/incidents/${i.id}`} className="font-medium hover:underline">#{i.id} {i.title}</Link> <span className={`ml-1 rounded px-1.5 text-xs font-semibold ${SEV[i.sev]}`}>SEV{i.sev}</span></td>
                    <td className="pr-3 text-xs text-sub">{i.resolved_at ? <Ts at={i.resolved_at} /> : '—'}</td>
                    <td className="pr-3 text-sm">{i.postmortem_id ? <Link className="underline underline-offset-2" href={`/postmortems/${i.postmortem_id}`}>{i.postmortem_id} (draft)</Link> : <span className="text-sev1">none</span>}</td>
                    <td className="text-right">{i.postmortem_pr ? <a href={i.postmortem_pr} target="_blank" rel="noreferrer" className="text-sm underline underline-offset-2">Draft PR ↗</a> : !i.postmortem_id && <DraftPostmortem incidentId={i.id} demo={isDemo()} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === 'actions' && <Actions all={actions} type={typeof sp.type === 'string' ? sp.type : ''} showAll={sp.status === 'all'} />}
    </>
  );
}

function Actions({ all, type, showAll }: { all: (Postmortem['actions'][number] & { pm: Postmortem })[]; type: string; showAll: boolean }) {
  const rank = (p: string) => Number(p.slice(1)) || 9;
  const list = all.filter((a) => (showAll || a.status === 'open') && (!type || a.type === type))
    .sort((a, b) => Number(a.status !== 'open') - Number(b.status !== 'open') || rank(a.priority) - rank(b.priority) || a.pm.date.localeCompare(b.pm.date));
  const chip = (href: string, on: boolean, label: string) => <Link key={label} href={href} className={`rounded-full px-2.5 py-0.5 text-xs ${on ? 'bg-ink text-white' : 'border border-line text-sub hover:text-ink'}`}>{label}</Link>;
  const qs = (p: Record<string, string>) => `/postmortems?${new URLSearchParams({ tab: 'actions', ...(type ? { type } : {}), ...(showAll ? { status: 'all' } : {}), ...p })}`;
  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center gap-1.5">
        {chip(qs({ status: '' }).replace('&status=', ''), !showAll, 'Open')}{chip(qs({ status: 'all' }), showAll, 'All')}
        <span className="mx-2 h-4 w-px bg-line" />
        {chip(`/postmortems?tab=actions${showAll ? '&status=all' : ''}`, !type, 'Every type')}
        {ACTION_TYPES.map((t) => chip(`/postmortems?tab=actions&type=${t}${showAll ? '&status=all' : ''}`, type === t, t))}
      </div>
      <table className="mt-3 w-full text-sm">
        <thead><tr className="text-left text-xs text-sub"><th className="py-2 font-normal">Priority</th><th className="font-normal">Action</th><th className="font-normal">Type</th><th className="font-normal">Owner</th><th className="font-normal">Status</th><th className="font-normal">From</th></tr></thead>
        <tbody>
          {list.map((a) => (
            <tr key={`${a.pm.id}-${a.id}`} className="border-t border-line align-top">
              <td className={`py-2 pr-3 text-xs font-semibold ${a.priority === 'P0' ? 'text-sev1' : a.priority === 'P1' ? 'text-sev2' : 'text-sub'}`}>{a.priority}</td>
              <td className="py-2 pr-4"><MdInline text={a.action} /></td>
              <td className="py-2 pr-3 text-xs text-sub">{a.type}</td>
              <td className="py-2 pr-3 text-xs">{a.owner}</td>
              <td className={`py-2 pr-3 text-xs ${a.status === 'open' ? 'font-medium' : 'text-sub'}`}>{a.status}</td>
              <td className="py-2 text-xs"><Link className="hover:underline" href={`/postmortems/${a.pm.id}`}>{a.pm.id}</Link></td>
            </tr>
          ))}
        </tbody>
      </table>
      {!list.length && <p className="mt-4 text-sm text-sub">No action items match.</p>}
    </div>
  );
}

const THEME_LABEL: Record<string, string> = {
  'node-memory': 'Node memory', 'alert-routing': 'Alerts not reaching a person', 'startup-ordering': 'Startup ordering',
  'silent-failure': 'Running but not working', 'config-change': 'Config change', 'capacity-limit': 'Capacity limit',
  'observability-gap': 'Observability gap', 'upstream-bug': 'Upstream bug', 'chain-consensus': 'Chain consensus',
};
const SEV_BAR: Record<number, string> = { 1: 'bg-sev1', 2: 'bg-sev2', 3: 'bg-sev3', 4: 'bg-sev4' };

// The list as a dashboard: what keeps coming back, how the follow-up work is going, how often; then the cards.
function Overview({ list, sp }: { list: Postmortem[]; sp: Record<string, string | string[] | undefined> }) {
  const one = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : '');
  const q = one('q').trim().toLowerCase(), theme = one('theme'), sev = one('sev'), status = one('status');
  const qs = (p: Record<string, string>) => {
    const u = new URLSearchParams(Object.entries({ q: one('q'), theme, sev, status, ...p }).filter(([, v]) => v));
    return `/postmortems${u.size ? `?${u}` : ''}`;
  };
  // Repeated themes.
  const themes = [...list.flatMap((p) => p.themes).reduce((m, t) => m.set(t, (m.get(t) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]);
  const maxT = Math.max(1, ...themes.map(([, n]) => n));
  // Action items.
  const acts = list.flatMap((p) => p.actions);
  const done = acts.filter((a) => a.status === 'done').length, dropped = acts.filter((a) => a.status === 'dropped').length, open = acts.length - done - dropped;
  const urgent = acts.filter((a) => a.status === 'open' && (a.priority === 'P0' || a.priority === 'P1')).length;
  // How often: per day over a short span, per week over a longer one.
  const dates = list.map((p) => p.date).filter(Boolean).sort();
  const span = dates.length ? (Date.parse(dates.at(-1)!) - Date.parse(dates[0])) / 86_400_000 : 0;
  const byWeek = span > 21;
  const bucket = (d: string) => { if (!byWeek) return d.slice(5); const t = new Date(d); t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7)); return `wk ${t.toISOString().slice(5, 10)}`; };
  const buckets = [...new Set(dates.map(bucket))];
  const per = buckets.map((b) => ({ b, sevs: [1, 2, 3, 4].map((s) => list.filter((p) => p.date && bucket(p.date) === b && p.severity === s).length) }));
  const maxB = Math.max(1, ...per.map((x) => x.sevs.reduce((a, c) => a + c, 0)));

  const shown = list.filter((p) => (!q || `${p.id} ${p.incident} ${p.title} ${p.summary} ${p.components.join(' ')}`.toLowerCase().includes(q))
    && (!theme || p.themes.includes(theme)) && (!sev || String(p.severity) === sev) && (!status || p.status === status));
  const chip = (href: string, on: boolean, label: React.ReactNode, key: string) => (
    <Link key={key} href={href} scroll={false} className={`rounded-full px-2.5 py-0.5 text-xs ${on ? 'bg-ink text-white' : 'border border-line text-sub hover:text-ink'}`}>{label}</Link>
  );

  return (
    <div className="mt-5 space-y-5">
      <div className="grid gap-3 lg:grid-cols-3">
        <section className="rounded-xl border border-line p-4">
          <h2 className="text-sm font-semibold">What keeps coming back</h2>
          <p className="text-xs text-sub">Contributing factors across {list.length} postmortems. Select one to filter.</p>
          <ul className="mt-3 space-y-1.5">
            {themes.slice(0, 7).map(([t, n]) => (
              <li key={t}>
                <Link href={qs({ theme: theme === t ? '' : t })} scroll={false} className={`group block rounded-md px-1.5 py-1 ${theme === t ? 'bg-canvas' : 'hover:bg-canvas'}`}>
                  <span className="flex items-baseline text-[13px]"><span className={theme === t ? 'font-semibold' : ''}>{THEME_LABEL[t] ?? t}</span><span className="ml-auto tabular-nums text-sub">{n}</span></span>
                  <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-line"><span className="block h-full rounded-full bg-[var(--link)]" style={{ width: `${(n / maxT) * 100}%` }} /></span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
        <section className="rounded-xl border border-line p-4">
          <h2 className="text-sm font-semibold">Action items</h2>
          <p className="text-xs text-sub">What the postmortems asked for, and how much is done.</p>
          <p className="mt-3 text-3xl font-semibold tabular-nums">{acts.length ? Math.round((done / acts.length) * 100) : 0}%<span className="ml-1 text-sm font-normal text-sub">done</span></p>
          <div className="mt-2 flex h-2.5 overflow-hidden rounded-full bg-line">
            <span className="bg-emerald-600" style={{ width: `${(done / Math.max(1, acts.length)) * 100}%` }} />
            <span className="bg-sev2" style={{ width: `${(open / Math.max(1, acts.length)) * 100}%` }} />
          </div>
          <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
            <div><dt className="text-sub">Done</dt><dd className="text-base font-semibold tabular-nums text-emerald-700">{done}</dd></div>
            <div><dt className="text-sub">Open</dt><dd className="text-base font-semibold tabular-nums text-sev2">{open}</dd></div>
            <div><dt className="text-sub">Dropped</dt><dd className="text-base font-semibold tabular-nums">{dropped}</dd></div>
          </dl>
          <Link href="/postmortems?tab=actions" className={`mt-3 inline-block text-xs underline underline-offset-2 ${urgent ? 'font-medium text-sev1' : 'text-sub'}`}>{urgent} open P0/P1 →</Link>
        </section>
        <section className="rounded-xl border border-line p-4">
          <h2 className="text-sm font-semibold">How often</h2>
          <p className="text-xs text-sub">Postmortems per {byWeek ? 'week' : 'day'}, by severity.</p>
          <div className="mt-3 flex h-28 items-end gap-2">
            {per.map((x) => (
              <div key={x.b} className="flex min-w-0 flex-1 flex-col items-center gap-1">
                <div className="flex w-full max-w-10 flex-col-reverse overflow-hidden rounded-t" style={{ height: `${(x.sevs.reduce((a, c) => a + c, 0) / maxB) * 96}px` }} title={x.sevs.map((n, i) => n ? `SEV${i + 1}: ${n}` : '').filter(Boolean).join(', ')}>
                  {x.sevs.map((n, i) => n ? <span key={i} className={SEV_BAR[i + 1]} style={{ flexGrow: n }} /> : null)}
                </div>
                <span className="text-[10px] tabular-nums text-sub">{x.b}</span>
              </div>
            ))}
          </div>
          <div className="mt-2 flex gap-2 text-[10px] text-sub">{[1, 2, 3, 4].map((n) => <span key={n} className="inline-flex items-center gap-1"><span className={`size-2 rounded-sm ${SEV_BAR[n]}`} />SEV{n}</span>)}</div>
        </section>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <form className="w-full max-w-xs" action="/postmortems">
          {theme && <input type="hidden" name="theme" value={theme} />}{sev && <input type="hidden" name="sev" value={sev} />}{status && <input type="hidden" name="status" value={status} />}
          <input type="search" name="q" defaultValue={one('q')} placeholder="Search postmortems" aria-label="Search postmortems" className="h-8 w-full rounded-lg border border-line px-3 text-sm outline-none focus:border-ink/40" />
        </form>
        <span className="mx-1 h-4 w-px bg-line" />
        {chip(qs({ sev: '' }), !sev, 'Any SEV', 'sev-any')}{[1, 2, 3, 4].map((n) => chip(qs({ sev: String(n) }), sev === String(n), `SEV${n}`, `sev-${n}`))}
        <span className="mx-1 h-4 w-px bg-line" />
        {chip(qs({ status: '' }), !status, 'Any status', 'st-any')}{(['draft', 'reviewed', 'closed'] as const).map((st) => chip(qs({ status: st }), status === st, st, `st-${st}`))}
        {theme && <Link href={qs({ theme: '' })} scroll={false} className="rounded-full bg-[var(--link)]/15 px-2.5 py-0.5 text-xs text-[var(--link)]">{THEME_LABEL[theme] ?? theme} ×</Link>}
        <span className="ml-auto text-xs text-sub">{shown.length} of {list.length}</span>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {shown.map((p) => {
          const d = p.actions.filter((a) => a.status !== 'open').length;
          return (
            <Link key={p.id} href={`/postmortems/${p.id}`} className="group flex flex-col rounded-xl border border-line p-4 hover:border-ink/40">
              <div className="flex items-center gap-2 text-xs">
                <span className={`rounded px-1.5 font-semibold ${SEV[p.severity] ?? ''}`}>SEV{p.severity}</span>
                <span className={`rounded px-1.5 ${STATUS[p.status]}`}>{p.status}</span>
                <span className="ml-auto text-sub">{p.date}</span>
              </div>
              <h3 className="mt-2 font-semibold leading-snug group-hover:underline"><MdInline text={p.title} /></h3>
              {p.summary && <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-ink/75"><MdInline text={p.summary} /></p>}
              <div className="mt-2 flex flex-wrap gap-1">
                {p.themes.map((t) => <span key={t} className="rounded bg-[var(--link)]/10 px-1.5 text-[11px] text-[var(--link)]">{THEME_LABEL[t] ?? t}</span>)}
                {p.components.map((c) => <span key={c} className="rounded bg-canvas px-1.5 text-[11px] text-sub">{c}</span>)}
              </div>
              <div className="mt-auto flex items-center gap-2 pt-3 text-xs text-sub">
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-line"><span className="block h-full rounded-full bg-emerald-600" style={{ width: `${p.actions.length ? (d / p.actions.length) * 100 : 0}%` }} /></span>
                <span className="tabular-nums">{d}/{p.actions.length} actions</span>
              </div>
            </Link>
          );
        })}
      </div>
      {!shown.length && <p className="text-sm text-sub">No postmortem matches. <Link href="/postmortems" className="underline">Clear the filters</Link>.</p>}
    </div>
  );
}
