import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { Suspense } from 'react';
import { Md, MdInline } from '@/components/Md.tsx';
import { isDemo } from '@/lib/demo.ts';
import { repoUrl } from '@/lib/detection.ts';
import { PM_STATUSES, lessons, postmortems, splitBody, timelineRows, type PmAction, type Postmortem, type Section } from '@/lib/postmortems.ts';

export default function PostmortemPage({ params }: PageProps<'/postmortems/[id]'>) {
  return (
    <div className="min-h-full bg-surface">
      <div className="mx-auto max-w-6xl px-8 py-7">
        <Suspense fallback={<p className="text-sm text-sub">Loading…</p>}><Body params={params} /></Suspense>
      </div>
    </div>
  );
}

const SEV: Record<number, string> = { 1: 'bg-sev1 text-white', 2: 'bg-sev2 text-white', 3: 'bg-sev3 text-white', 4: 'bg-sev4 text-white' };
const TYPE: Record<string, string> = { prevent: 'bg-[var(--link)]/12 text-[var(--link)]', detect: 'bg-sev3/20 text-ink', mitigate: 'bg-emerald-600/12 text-emerald-700', process: 'bg-line text-ink' };
const TYPE_LABEL: Record<string, string> = { prevent: 'Prevent', detect: 'Detect', mitigate: 'Mitigate', process: 'Process' };
const after = (s: string | undefined) => (s ?? '').replace(/^[^:]*:\s*/, '');

async function Body({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await connection();
  const p = (await postmortems()).find((x) => x.id === id);
  if (!p) notFound();
  const { facts, intro, sections } = splitBody(p.body);
  const done = p.actions.filter((a) => a.status !== 'open').length;
  const sample = isDemo() && p.id.endsWith('-16');

  return (
    <>
      <p className="text-sm text-sub"><Link href="/postmortems" className="underline underline-offset-2">Postmortems</Link> / {p.id}</p>

      {/* Header: what it is, where it stands in review, and the facts a reader wants first. */}
      <header className="mt-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className={`rounded px-1.5 py-0.5 font-semibold ${SEV[p.severity] ?? ''}`}>SEV{p.severity}</span>
          <span className="text-sub">{p.incident} · {p.date}</span>
        </div>
        <h1 className="mt-2 max-w-4xl text-[26px] font-semibold leading-snug tracking-tight"><MdInline text={p.title} /></h1>
        <Lifecycle status={p.status} />
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Fact label="Impact" value={facts.Duration ? <MdInline text={facts.Duration.split(';')[0].replace(/^impact\s+/i, '')} /> : p.duration || '—'} wide />
          <Fact label="Severity" value={<MdInline text={after(facts.Severity) || `SEV${p.severity}`} />} wide />
          <Fact label="Components" value={<span className="flex flex-wrap gap-1">{p.components.map((c) => <span key={c} className="rounded bg-canvas px-1.5 text-xs font-medium">{c}</span>)}</span>} />
          <Fact label="Authors" value={p.authors.join(', ')} />
        </div>
      </header>

      <div className="mt-7 grid gap-8 lg:grid-cols-[minmax(0,1fr)_17rem]">
        <main className="min-w-0 space-y-5">
          {intro && <p className="text-xs text-sub"><MdInline text={intro.replace(/\n/g, ' ')} /></p>}
          {sections.map((s) => <SectionView key={s.slug} s={s} p={p} />)}
        </main>

        {/* Sidebar: progress on the action items and a way around the document. */}
        <aside className="space-y-4 lg:sticky lg:top-4 lg:self-start">
          <section className="rounded-xl border border-line p-4">
            <h2 className="text-xs font-semibold text-sub">Action items</h2>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{done}<span className="text-base font-normal text-sub"> / {p.actions.length} done</span></p>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-line"><div className="h-full rounded-full bg-emerald-600" style={{ width: `${p.actions.length ? (done / p.actions.length) * 100 : 0}%` }} /></div>
            <ul className="mt-3 space-y-1 text-xs">
              {(['prevent', 'detect', 'mitigate', 'process'] as const).map((t) => {
                const all = p.actions.filter((a) => a.type === t);
                if (!all.length) return null;
                return <li key={t} className="flex items-center gap-2"><span className={`rounded px-1.5 ${TYPE[t]}`}>{TYPE_LABEL[t]}</span><span className="ml-auto tabular-nums text-sub">{all.filter((a) => a.status === 'open').length} open / {all.length}</span></li>;
              })}
            </ul>
          </section>
          <nav className="rounded-xl border border-line p-4" aria-label="Sections">
            <h2 className="text-xs font-semibold text-sub">In this postmortem</h2>
            <ol className="mt-2 space-y-1 text-sm">
              {sections.map((s) => <li key={s.slug}><a href={`#${s.slug}`} className="flex gap-2 hover:underline"><span className="w-4 shrink-0 text-sub">{s.n}</span>{s.title}</a></li>)}
            </ol>
          </nav>
          <div className="space-y-1 px-1 text-sm">
            {facts.Related && <p className="text-xs text-sub"><b className="font-medium text-ink">Related</b> <MdInline text={facts.Related} /></p>}
            {!sample && <a href={repoUrl(p.path)} target="_blank" rel="noreferrer" className="block text-xs underline underline-offset-2">Open in GitHub ↗</a>}
          </div>
        </aside>
      </div>
    </>
  );
}

// draft → reviewed → closed, the current one marked.
function Lifecycle({ status }: { status: Postmortem['status'] }) {
  const at = PM_STATUSES.indexOf(status);
  const hint: Record<string, string> = { draft: 'being written', reviewed: 'read by someone outside the incident', closed: 'no open P0/P1 action item' };
  return (
    <ol className="mt-4 flex flex-wrap items-center gap-2 text-xs" aria-label="Review status">
      {PM_STATUSES.map((s, i) => (
        <li key={s} className="flex items-center gap-2" aria-current={i === at ? 'step' : undefined}>
          {i > 0 && <span aria-hidden className={`h-px w-8 ${i <= at ? 'bg-ink' : 'bg-line'}`} />}
          <span className={`rounded-full px-2.5 py-1 ${i === at ? 'bg-ink text-white' : i < at ? 'bg-line/70 text-ink' : 'border border-line text-sub'}`} title={hint[s]}>
            {s[0].toUpperCase() + s.slice(1)}
          </span>
        </li>
      ))}
    </ol>
  );
}

function Fact({ label, value, wide = false }: { label: string; value: React.ReactNode; wide?: boolean }) {
  return (
    <div className={`rounded-xl border border-line px-4 py-3 ${wide ? 'lg:col-span-2' : ''}`}>
      <div className="text-xs text-sub">{label}</div>
      <div className="mt-1 text-sm font-medium leading-snug">{value}</div>
    </div>
  );
}

function SectionView({ s, p }: { s: Section; p: Postmortem }) {
  const head = <h2 className="flex items-baseline gap-2 text-lg font-semibold tracking-tight"><span className="text-sm font-normal text-sub">{s.n}</span>{s.title}</h2>;
  const card = (body: React.ReactNode) => <section id={s.slug} className="scroll-mt-4 rounded-xl border border-line px-5 py-4">{head}<div className="mt-3">{body}</div></section>;
  if (/^summary/i.test(s.title)) return (
    <section id={s.slug} className="scroll-mt-4 rounded-xl border-l-4 border-[var(--link)] bg-canvas px-5 py-4">
      {head}<div className="mt-2 text-[15px] leading-relaxed [&_.text-sm]:text-[15px]"><Md text={s.text} /></div>
    </section>
  );
  if (/^action items/i.test(s.title)) return card(<Actions actions={p.actions} />);
  if (/^lessons/i.test(s.title)) {
    const l = lessons(s.text);
    if (l) return card(
      <div className="grid gap-3 md:grid-cols-3">
        {([['Went well', l.well, 'border-emerald-600/40 bg-emerald-600/5'], ['Went badly', l.badly, 'border-sev1/30 bg-sev1/5'], ['Lucky', l.lucky, 'border-sev3/40 bg-sev3/10']] as const).map(([k, v, cls]) => (
          <div key={k} className={`rounded-lg border px-3 py-2.5 ${cls}`}>
            <div className="text-xs font-semibold">{k}</div>
            <p className="mt-1 text-sm leading-relaxed"><MdInline text={v || '—'} /></p>
          </div>
        ))}
      </div>,
    );
  }
  if (/^response/i.test(s.title)) {
    const rows = timelineRows(s.text);
    const rest = s.text.split('\n').filter((l) => !l.startsWith('|')).join('\n').trim();
    if (rows) return card(
      <>
        <ol className="relative ml-1 border-l border-line">
          {rows.map((r, i) => (
            <li key={i} className="relative pb-3 pl-5 last:pb-0">
              <span aria-hidden className="absolute -left-[5px] top-1.5 size-2.5 rounded-full border-2 border-surface bg-[var(--link)]" />
              <div className="font-mono text-xs text-sub">{r.time}</div>
              <div className="text-sm leading-relaxed"><MdInline text={r.what} /></div>
              {r.result && <div className="text-xs text-sub">→ <MdInline text={r.result} /></div>}
            </li>
          ))}
        </ol>
        {rest && <div className="mt-3"><Md text={rest} /></div>}
      </>,
    );
  }
  return card(<Md text={s.text} />);
}

function Actions({ actions }: { actions: PmAction[] }) {
  const rank = (a: PmAction) => (a.status === 'open' ? 0 : 1) * 10 + (Number(a.priority.slice(1)) || 9);
  return (
    <ul className="divide-y divide-line">
      {[...actions].sort((a, b) => rank(a) - rank(b)).map((a) => (
        <li key={a.id} className="flex items-start gap-3 py-2.5">
          <span className={`mt-0.5 w-7 shrink-0 text-xs font-bold ${a.priority === 'P0' ? 'text-sev1' : a.priority === 'P1' ? 'text-sev2' : 'text-sub'}`}>{a.priority}</span>
          <div className="min-w-0 flex-1">
            <p className={`text-sm leading-snug ${a.status !== 'open' ? 'text-sub' : 'font-medium'}`}><MdInline text={a.action} /></p>
            {a.note && a.note !== a.status && <p className="mt-0.5 text-xs text-sub"><MdInline text={a.note.replace(/^\*\*(done|open)\*\*\s*/i, '')} /></p>}
          </div>
          <span className={`shrink-0 rounded px-1.5 text-xs ${TYPE[a.type] ?? ''}`}>{TYPE_LABEL[a.type] ?? a.type}</span>
          <span className="w-20 shrink-0 text-right text-xs text-sub">{a.owner}</span>
          <span className={`w-14 shrink-0 text-right text-xs font-medium ${a.status === 'open' ? 'text-sev2' : 'text-emerald-700'}`}>{a.status === 'open' ? 'Open' : a.status === 'done' ? '✓ Done' : 'Dropped'}</span>
        </li>
      ))}
    </ul>
  );
}
