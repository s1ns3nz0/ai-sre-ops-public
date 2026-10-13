'use client';
import { useState, useTransition } from 'react';
import { previewAction, saveAlertsAction, type FormResult } from '@/app/(console)/detection/actions.ts';
import type { AlertRule } from '@/lib/rules.ts';
import { useNow } from './region.ts';
import { button, Card, field } from './ui.tsx';

export type Live = { health: string; lastError?: string; state?: string; firing: number; lastEvaluation: string } | 'missing' | null;
export type RuleGroup = { path: string; group: string; href: string; rules: AlertRule[]; live: Record<string, Live> };

const SEV_CLS: Record<string, string> = { critical: 'bg-sev1 text-white', warning: 'bg-sev2 text-white', info: 'bg-sev4 text-white' };
const code = `${field} h-auto py-2 font-mono text-xs`;

type Fields = { alert: string; expr: string; for: string; severity: string; summary: string; description: string; runbook_url: string; dashboard_url: string };
type Draft = { key: string; path: string; group: string; original: string | null; f: Fields; removed: boolean };

const fieldsOf = (a?: AlertRule): Fields => ({
  alert: a?.alert ?? '', expr: a?.expr ?? '', for: a?.for ?? '', severity: a?.labels.severity ?? 'warning',
  summary: a?.annotations.summary ?? '', description: a?.annotations.description ?? '',
  runbook_url: a?.annotations.runbook_url ?? '', dashboard_url: a?.annotations.dashboard_url ?? '',
});
const keyOf = (path: string, group: string, alert: string) => `${path}::${group}::${alert}`;

// Relative time is computed in the browser only (useNow is null during SSR), so server and client markup match.
function Ago({ iso }: { iso: string }) {
  const now = useNow(5000);
  if (!now) return null;
  const s = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 1000));
  return <>, {s < 90 ? `${s}s ago` : `${Math.round(s / 60)}m ago`}</>;
}

function LiveCell({ live }: { live: Live }) {
  if (live === null) return <span className="text-sub">—</span>;
  if (live === 'missing') return <span className="rounded-md bg-sev2/10 px-2 py-0.5 text-xs text-sev2">Not deployed</span>;
  if (live.health !== 'ok') return <span className="rounded-md bg-sev1/10 px-2 py-0.5 text-xs text-sev1" title={live.lastError}>Error</span>;
  if (live.firing) return <span className="rounded-md bg-sev1 px-2 py-0.5 text-xs font-medium text-white">{live.firing} firing</span>;
  if (live.state === 'pending') return <span className="rounded-md bg-sev2/10 px-2 py-0.5 text-xs text-sev2">Pending</span>;
  return <span className="text-xs text-sub">OK<Ago iso={live.lastEvaluation} /></span>;
}

function Result({ state }: { state: FormResult }) {
  if (!state) return null;
  if (state.ok) return <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">Pull request opened: <a className="underline" href={state.url} target="_blank" rel="noreferrer">{state.url}</a></p>;
  return <ul className="rounded-lg bg-sev1/10 px-3 py-2 text-sm text-sev1">{state.errors.map((e) => <li key={e}>{e}</li>)}</ul>;
}

function RuleView({ f }: { f: Fields }) {
  const link = (label: string, href: string) => href && <a href={href} target="_blank" rel="noreferrer" className="underline underline-offset-2">{label}</a>;
  return (
    <dl className="grid gap-3 text-sm">
      <div><dt className="text-xs text-sub">Expression</dt><dd><code className="mt-0.5 block whitespace-pre-wrap break-all rounded-md bg-canvas px-3 py-2 text-xs">{f.expr}</code></dd></div>
      {f.description && <div><dt className="text-xs text-sub">Description</dt><dd>{f.description}</dd></div>}
      {(f.runbook_url || f.dashboard_url) && (
        <div className="flex items-center gap-4 text-xs">
          {link('Runbook', f.runbook_url)}
          {f.dashboard_url && <a href={f.dashboard_url} target="_blank" rel="noreferrer" className={`${button.quiet} ml-auto`}>Go to dashboard</a>}
        </div>
      )}
    </dl>
  );
}

function RuleEditor({ f, set }: { f: Fields; set: (p: Partial<Fields>) => void }) {
  const [pv, setPv] = useState<string | null>(null);
  const input = (k: keyof Fields, label: string, extra = {}) => (
    <label className="grid gap-1">{label}<input value={f[k]} onChange={(e) => set({ [k]: e.target.value })} className={field} {...extra} /></label>
  );
  return (
    <div className="grid gap-3 text-sm">
      {input('alert', 'Name', { placeholder: 'LinethL2Something' })}
      <label className="grid gap-1">Expression (PromQL)
        <textarea rows={3} value={f.expr} onChange={(e) => { set({ expr: e.target.value }); setPv(null); }} className={code} />
      </label>
      <div className="flex items-center gap-2">
        <button type="button" className={button.quiet} onClick={async () => {
          const r = await previewAction(f.expr);
          setPv('error' in r ? `Error: ${r.error}` : `${r.series} series match right now${r.sample.length ? `, e.g. ${r.sample[0]}` : ''}`);
        }}>Preview</button>
        {pv && <span className={`break-all text-xs ${pv.startsWith('Error') ? 'text-sev1' : 'text-sub'}`}>{pv}</span>}
      </div>
      <div className="grid grid-cols-2 gap-3">
        {input('for', 'For', { placeholder: '5m' })}
        <label className="grid gap-1">Severity
          <select value={f.severity} onChange={(e) => set({ severity: e.target.value })} className={field}>
            {['critical', 'warning', 'info'].map((s) => <option key={s}>{s}</option>)}
          </select>
        </label>
      </div>
      {input('summary', 'Summary')}
      <label className="grid gap-1">Description<textarea rows={2} value={f.description} onChange={(e) => set({ description: e.target.value })} className={`${field} h-auto py-2`} /></label>
      <div className="grid grid-cols-2 gap-3">{input('runbook_url', 'Runbook URL')}{input('dashboard_url', 'Dashboard URL')}</div>
    </div>
  );
}

// All hand-written alert groups. Read-only until "Edit": then every rule becomes inputs, rules can be added or
// removed, and everything changed goes out as one pull request from the button at the top.
export function AlertRulesBoard({ groups }: { groups: RuleGroup[] }) {
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<FormResult>(null);
  const [pending, start] = useTransition();
  const [seq, setSeq] = useState(0);

  const orig = new Map(groups.flatMap((g) => g.rules.map((a) => [keyOf(g.path, g.group, a.alert), a] as const)));
  const draftOf = (g: RuleGroup, a: AlertRule): Draft =>
    drafts[keyOf(g.path, g.group, a.alert)] ?? { key: keyOf(g.path, g.group, a.alert), path: g.path, group: g.group, original: a.alert, f: fieldsOf(a), removed: false };
  const put = (d: Draft) => setDrafts((x) => ({ ...x, [d.key]: d }));
  const isChanged = (d: Draft) => d.original === null || d.removed || JSON.stringify(d.f) !== JSON.stringify(fieldsOf(orig.get(d.key)));
  const changed = Object.values(drafts).filter(isChanged);
  const toggle = (k: string) => setOpen((s) => { const x = new Set(s); if (x.has(k)) x.delete(k); else x.add(k); return x; });
  const total = groups.reduce((n, g) => n + g.rules.length, 0);

  const add = (g: RuleGroup) => {
    const key = `${g.path}::${g.group}::new:${seq}`;
    setSeq((n) => n + 1);
    put({ key, path: g.path, group: g.group, original: null, f: fieldsOf(), removed: false });
    setOpen((s) => new Set(s).add(key));
  };
  const cancel = () => { setEditing(false); setDrafts({}); setResult(null); };
  const save = () => start(async () => {
    const r = await saveAlertsAction(changed.map((d) => ({ path: d.path, group: d.group, original: d.original, rule: d.removed ? null : d.f })));
    setResult(r);
    if (r?.ok) { setEditing(false); setDrafts({}); }
  });

  const row = (g: RuleGroup, d: Draft) => {
    const isOpen = open.has(d.key);
    const tag = d.original === null ? ['New', 'bg-accent text-ink'] : d.removed ? ['Removed', 'bg-sev1 text-white'] : isChanged(d) ? ['Edited', 'bg-accent text-ink'] : null;
    return (
      <li key={d.key} className={`border-b border-line last:border-b-0 ${isOpen ? 'bg-canvas' : ''}`}>
        <div className="flex items-center gap-3 px-4">
          <button type="button" aria-expanded={isOpen} onClick={() => toggle(d.key)} className="flex min-w-0 flex-1 items-center gap-3 py-3 text-left">
            <span aria-hidden className={`text-xs text-sub transition-transform ${isOpen ? 'rotate-90' : ''}`}>▶</span>
            <span className={`shrink-0 rounded px-1.5 text-[11px] ${SEV_CLS[d.f.severity] ?? 'bg-line'}`}>{d.f.severity}</span>
            <span className={`min-w-0 ${d.removed ? 'text-sub line-through decoration-sub/50' : ''}`}>
              <span className="flex items-center gap-2 font-medium">{d.f.alert || <span className="text-sub">New rule</span>}
                {tag && <span className={`rounded px-1.5 text-[11px] font-semibold no-underline ${tag[1]}`}>{tag[0]}</span>}</span>
              <span className="block truncate text-xs text-sub">{d.f.summary}</span>
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-4">
              <span className="w-14 text-right text-xs text-sub">{d.f.for ? `for ${d.f.for}` : ''}</span>
              <span className="w-28 text-right">{d.original ? <LiveCell live={g.live[d.original] ?? null} /> : <span className="text-xs text-sub">after merge</span>}</span>
            </span>
          </button>
          {editing && (
            <button type="button" onClick={() => {
              if (d.original === null) setDrafts((x) => { const n = { ...x }; delete n[d.key]; return n; });
              else put({ ...d, removed: !d.removed });
            }} className="shrink-0 text-xs text-sub underline underline-offset-2 hover:text-sev1">{d.removed ? 'Undo remove' : 'Remove'}</button>
          )}
        </div>
        {isOpen && (
          <div className="border-t border-line bg-surface px-4 py-4 sm:pl-10">
            {editing && !d.removed ? <RuleEditor f={d.f} set={(p) => put({ ...d, f: { ...d.f, ...p } })} /> : <RuleView f={d.f} />}
          </div>
        )}
      </li>
    );
  };

  return (
    <div className="space-y-5">
      {/* Pinned only while editing (Open pull request stays reachable); otherwise it scrolls with the page. */}
      <div className={`flex flex-wrap items-center gap-3 py-2 ${editing ? 'sticky top-0 z-10 -mx-3 rounded-xl border border-line bg-surface/95 px-3 backdrop-blur' : ''}`}>
        {editing
          ? <span className="text-sm">Editing · <b>{changed.length}</b> rule{changed.length === 1 ? '' : 's'} changed</span>
          : <span className="text-sm text-sub">{total} hand-written alerts in {new Set(groups.map((g) => g.path)).size} files</span>}
        <span className="ml-auto flex gap-2">
          {editing ? (
            <>
              <button type="button" onClick={cancel} className={button.quiet}>Cancel</button>
              <button type="button" onClick={save} disabled={!changed.length || pending} className={`${button.primary} disabled:opacity-50`}>
                {pending ? 'Opening pull request…' : 'Open pull request'}
              </button>
            </>
          ) : <button type="button" onClick={() => { setEditing(true); setResult(null); }} className={button.primary}>Edit</button>}
        </span>
      </div>
      <Result state={result} />

      {groups.map((g) => (
        <Card key={g.path + g.group} title={g.group} aside={
          <span className="flex items-center gap-3">
            <a href={g.href} target="_blank" rel="noreferrer" className="text-sm text-sub underline underline-offset-2">{g.path}</a>
            {editing && <button type="button" onClick={() => add(g)} className={button.quiet}>+ Add rule</button>}
          </span>
        }>
          <ul className="-mx-4 border-t border-line">
            {g.rules.map((a) => row(g, draftOf(g, a)))}
            {Object.values(drafts).filter((d) => d.original === null && d.path === g.path && d.group === g.group).map((d) => row(g, d))}
          </ul>
        </Card>
      ))}
    </div>
  );
}
