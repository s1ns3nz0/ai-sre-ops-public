'use client';
import { useState, useTransition } from 'react';
import { previewAction, saveSlosAction, type FormResult } from '@/app/(console)/detection/actions.ts';
import { clean, type SloDef } from '@/lib/slo.ts';
import { button, Card, field } from './ui.tsx';

export type SloRow = {
  def: SloDef | null; name: string;
  budget: number | null; sli1h: number | null;
  alerts: { name: string; expr: string; severity: string; window: string; burn: string; firing: number }[];
  records: { name: string; expr: string }[];
};

const pct = (x: number, d = 1) => `${(x * 100).toFixed(d).replace(/\.0+$/, '')}%`;
const same = (a: SloDef, b: SloDef) => JSON.stringify(clean(a)) === JSON.stringify(clean(b));
const code = `${field} h-auto py-2 font-mono text-xs`;

function Result({ state }: { state: FormResult }) {
  if (!state) return null;
  if (state.ok) return <p className="text-sm text-emerald-800">Pull request opened: <a className="underline" href={state.url} target="_blank" rel="noreferrer">{state.url}</a></p>;
  return <ul className="text-sm text-sev1">{state.errors.map((e) => <li key={e}>{e}</li>)}</ul>;
}

// Runs the expression read-only against Prometheus and says how many series it returns now.
function Preview({ expr }: { expr: () => string | null }) {
  const [out, setOut] = useState<string | null>(null);
  const run = async () => {
    const e = expr();
    if (!e) return setOut('Trace SLIs are built by the generator; nothing to preview here.');
    const r = await previewAction(e);
    setOut('error' in r ? `Error: ${r.error}` : `${r.series} series right now${r.sample.length ? `, e.g. ${r.sample[0]}` : ''}`);
  };
  return (
    <span className="flex min-w-0 items-center gap-2">
      <button type="button" onClick={run} className="text-xs text-sub underline underline-offset-2 hover:text-ink">Preview</button>
      {out && <span className={`truncate text-xs ${out.startsWith('Error') ? 'text-sev1' : 'text-sub'}`} title={out}>{out}</span>}
    </span>
  );
}

function DefinitionEditor({ d, set }: { d: SloDef; set: (p: Partial<SloDef>) => void }) {
  const mode = d.span_latency ? 'span' : 'expr';
  return (
    <div className="grid gap-3 text-sm">
      <div className="grid gap-3 sm:grid-cols-[1fr_9rem_13rem]">
        <label className="grid gap-1">Name<input value={d.name} onChange={(e) => set({ name: e.target.value })} className={field} /></label>
        <label className="grid gap-1">Objective<input type="number" step="0.0001" min="0.5" max="0.99999" value={d.objective} onChange={(e) => set({ objective: Number(e.target.value) })} className={field} /></label>
        <label className="grid gap-1">Kind
          <select value={d.kind} onChange={(e) => set({ kind: e.target.value as SloDef['kind'], ...(e.target.value === 'time' ? { sli: d.sli ?? '' } : d.span_latency ? {} : { good: d.good ?? '', valid: d.valid ?? '' }) })} className={field}>
            <option value="time">time (good minutes)</option><option value="event">event (good / valid)</option>
          </select>
        </label>
      </div>
      {d.kind === 'time' ? (
        <label className="grid gap-1">SLI: PromQL, 1 when the minute is good
          <textarea rows={3} value={d.sli ?? ''} onChange={(e) => set({ sli: e.target.value })} className={code} />
        </label>
      ) : (
        <>
          <div className="flex gap-1 text-xs">
            {(['expr', 'span'] as const).map((m) => (
              <button key={m} type="button" onClick={() => set(m === 'span' ? { span_latency: d.span_latency ?? { workflow: '', le: '' } } : { span_latency: undefined, good: d.good ?? '', valid: d.valid ?? '' })}
                className={`h-7 rounded-md px-2.5 ${mode === m ? 'bg-ink text-white' : 'border border-line text-sub'}`}>
                {m === 'expr' ? 'Good / valid expressions' : 'Trace latency (span metrics)'}
              </button>
            ))}
          </div>
          {mode === 'expr' ? (
            <>
              <label className="grid gap-1">Good events, with [W] as the window<textarea rows={2} value={d.good ?? ''} onChange={(e) => set({ good: e.target.value })} className={code} /></label>
              <label className="grid gap-1">Valid events<textarea rows={2} value={d.valid ?? ''} onChange={(e) => set({ valid: e.target.value })} className={code} /></label>
            </>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <label className="grid gap-1">Workflow<input value={d.span_latency!.workflow} onChange={(e) => set({ span_latency: { ...d.span_latency!, workflow: e.target.value } })} className={field} /></label>
              <label className="grid gap-1">Within (seconds)<input value={d.span_latency!.le} onChange={(e) => set({ span_latency: { ...d.span_latency!, le: e.target.value } })} className={field} /></label>
            </div>
          )}
        </>
      )}
      <Preview expr={() => (d.kind === 'time' ? d.sli?.trim() || null : d.span_latency ? null : d.good?.replaceAll('[W]', '[5m]') || null)} />
      <label className="flex items-center gap-2"><input type="checkbox" checked={d.page} onChange={(e) => set({ page: e.target.checked })} className="size-4 accent-ink" />Page on fast burn (14.4x / 6x). Off: tickets only, for low-volume SLIs.</label>
      <label className="grid gap-1">Description<textarea rows={2} value={d.description} onChange={(e) => set({ description: e.target.value })} className={`${field} h-auto py-2`} /></label>
      <label className="grid gap-1">Note for reviewers (optional)<textarea rows={2} value={d.note ?? ''} onChange={(e) => set({ note: e.target.value })} className={`${field} h-auto py-2`} /></label>
    </div>
  );
}

function ReadOnlyDefinition({ d }: { d: SloDef }) {
  const sli = d.kind === 'time' ? d.sli : d.span_latency ? `trace latency: ${d.span_latency.workflow} within ${d.span_latency.le}s` : `good: ${d.good}\nvalid: ${d.valid}`;
  return (
    <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[7rem_1fr]">
      <dt className="text-sub">Objective</dt><dd>{pct(d.objective, 2)}, {d.kind === 'time' ? 'good minutes' : 'good / valid events'}{d.page ? ', pages on fast burn' : ', tickets only'}</dd>
      <dt className="text-sub">SLI</dt><dd><code className="block whitespace-pre-wrap break-all text-xs">{sli}</code></dd>
      <dt className="text-sub">Description</dt><dd>{d.description}</dd>
      {d.note && <><dt className="text-sub">Note</dt><dd className="text-sub">{d.note}</dd></>}
    </dl>
  );
}

// SLO → definition → generated recording rules (burn-rate alerts only show as the firing count). "Edit" switches every SLO to inputs; all changes go out
// together as one pull request on slos/definitions.json, and CI regenerates the rules from it.
export function SloBoard({ rows, editable }: { rows: SloRow[]; editable: boolean }) {
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, SloDef>>({});
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<FormResult>(null);
  const [pending, start] = useTransition();

  const draft = (r: SloRow) => drafts[r.name] ?? r.def!;
  const patch = (r: SloRow, p: Partial<SloDef>) => setDrafts((d) => ({ ...d, [r.name]: { ...(d[r.name] ?? r.def!), ...p } }));
  const changed = rows.filter((r) => r.def && drafts[r.name] && !same(drafts[r.name], r.def));
  const toggle = (n: string) => setOpen((s) => { const x = new Set(s); if (x.has(n)) x.delete(n); else x.add(n); return x; });
  const stop = () => { setEditing(false); setDrafts({}); setResult(null); };
  const save = () => start(async () => {
    const r = await saveSlosAction(changed.map((x) => ({ original: x.name, next: clean(drafts[x.name]) })));
    setResult(r);
    if (r?.ok) { setEditing(false); setDrafts({}); }
  });

  // Typing the generated text back clears the override, unless the file already had one for that rule.
  const setRecord = (r: SloRow, name: string, value: string, generated: string) => {
    const records = { ...(draft(r).records ?? {}) };
    if (value === generated && !r.def?.records?.[name]) delete records[name];
    else records[name] = value;
    patch(r, { records });
  };
  const resetRecord = (r: SloRow, name: string) => {
    const records = { ...(draft(r).records ?? {}) };
    delete records[name];
    patch(r, { records });
  };

  return (
    <Card title="Service level objectives" aside={
      <div className="flex items-center gap-3">
        {editing ? (
          <>
            <span className="text-sm">Editing · <b>{changed.length}</b> SLO{changed.length === 1 ? '' : 's'} changed</span>
            <button type="button" onClick={stop} className={button.quiet}>Cancel</button>
            <button type="button" onClick={save} disabled={!changed.length || pending} className={`${button.primary} disabled:opacity-50`}>
              {pending ? 'Opening pull request…' : 'Open pull request'}
            </button>
          </>
        ) : (
          <>
            <span className="text-sm text-sub">{rows.length} SLOs</span>
            <button type="button" disabled={!editable} title={editable ? undefined : 'Read-only until slos/definitions.json is on main'}
              onClick={() => { setEditing(true); setResult(null); }} className={`${button.primary} disabled:opacity-50`}>Edit</button>
          </>
        )}
      </div>
    }>
      {result && <div className="mb-3"><Result state={result} /></div>}
      <ul className="-mx-4 border-t border-line">
        {rows.map((r) => {
          const isOpen = open.has(r.name);
          const firing = r.alerts.reduce((n, a) => n + a.firing, 0);
          const tone = r.budget === null ? 'text-sub' : r.budget <= 0 ? 'text-sev1' : r.budget < 0.25 ? 'text-sev2' : 'text-ink';
          const edited = changed.includes(r);
          const d = r.def ? draft(r) : null;
          return (
            <li key={r.name} className="border-b border-line last:border-b-0">
              <button type="button" aria-expanded={isOpen} onClick={() => toggle(r.name)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-sev4/5">
                <span aria-hidden className={`text-xs text-sub transition-transform ${isOpen ? 'rotate-90' : ''}`}>▶</span>
                <span className="min-w-0">
                  <span className="flex items-center gap-2 font-medium">{r.name}{edited && <span className="rounded bg-accent px-1.5 text-[11px] font-semibold text-ink">Edited</span>}</span>
                  <span className="block truncate text-xs text-sub">{r.def?.description}</span>
                </span>
                <span className="ml-auto flex shrink-0 items-center gap-5 text-sm">
                  <span className="w-16 text-right text-sub">{r.def ? pct(r.def.objective, 2) : '—'}</span>
                  <span className="w-20 text-right text-xs text-sub">{r.def?.kind ?? ''}{r.def?.page ? ', pages' : ''}</span>
                  <span className={`w-24 text-right font-medium ${tone}`} title="Error budget left, 28 days">{r.budget === null ? '—' : `${pct(r.budget, 0)} left`}</span>
                  <span className="w-16 text-right">{firing ? <span className="rounded-md bg-sev1 px-2 py-0.5 text-xs text-white">{firing} firing</span> : <span className="text-xs text-sub">quiet</span>}</span>
                </span>
              </button>

              {isOpen && (
                <div className="space-y-6 border-t border-line px-4 py-5 sm:pl-10">
                  <section>
                    <h3 className="mb-3 text-sm font-semibold">Definition</h3>
                    {!d ? <p className="text-sm text-sub">No definition found for this SLO.</p>
                      : editing ? <DefinitionEditor d={d} set={(p) => patch(r, p)} /> : <ReadOnlyDefinition d={d} />}
                  </section>

                  <section>
                    <h3 className="text-sm font-semibold">Recording rules <span className="font-normal text-sub">{r.records.length}</span></h3>
                    <p className="mb-2 text-xs text-sub">Generated from the definition. An edited formula is kept as an override for this SLO only.</p>
                    <ul className="divide-y divide-line">
                      {r.records.map((x) => {
                        const ov = d?.records?.[x.name];
                        const wasOv = !!r.def?.records?.[x.name];
                        return (
                          <li key={x.name} className="py-2">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-xs">{x.name}</span>
                              {ov !== undefined && <span className="rounded bg-ink px-1.5 text-[11px] text-white">Customized</span>}
                              {wasOv && ov === undefined && <span className="text-[11px] text-sev2">Back to generated after merge</span>}
                              {editing && ov !== undefined && <button type="button" onClick={() => resetRecord(r, x.name)} className="ml-auto text-xs text-sub underline underline-offset-2 hover:text-ink">Reset to generated</button>}
                            </div>
                            {editing && d ? (
                              <div className="mt-1 grid gap-1">
                                <textarea rows={2} aria-label={x.name} value={ov ?? x.expr} onChange={(e) => setRecord(r, x.name, e.target.value, x.expr)} className={code} />
                                <Preview expr={() => (ov ?? x.expr).trim() || null} />
                              </div>
                            ) : <code className="mt-0.5 block break-all text-xs text-sub">{x.expr}</code>}
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                </div>
              )}
            </li>
          );
        })}
      </ul>

    </Card>
  );
}
