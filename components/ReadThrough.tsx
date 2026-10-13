'use client';
import { createContext, useContext, useState, type ReactNode } from 'react';

// Handoff read-through (F5): the incoming person ticks every item; Acknowledge enables once all are ticked.
// Ticks live in the browser until the acknowledgement sends them; the server checks them again.
const Ctx = createContext<{ read: Set<string>; toggle: (k: string) => void; required: string[]; done: boolean; off: boolean } | null>(null);

// off: while the outgoing person is still writing (draft) there is nothing to tick yet.
export function ReadThrough({ required, done, off = false, children }: { required: string[]; done: string[] | null; off?: boolean; children: ReactNode }) {
  const [read, setRead] = useState<Set<string>>(new Set(done ?? []));
  const toggle = (k: string) => setRead((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  return <Ctx.Provider value={{ read, toggle, required, done: done !== null, off }}>{children}</Ctx.Provider>;
}

export function GotIt({ id }: { id: string }) {
  const c = useContext(Ctx)!;
  const on = c.read.has(id);
  if (c.off) return null;
  if (c.done) return on ? <span className="ml-auto shrink-0 text-xs text-emerald-700">✓ read</span> : null;
  return (
    <button type="button" onClick={() => c.toggle(id)} aria-pressed={on}
      className={`ml-auto inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-xs font-medium ${on ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-line text-sub hover:border-ink/40 hover:text-ink'}`}>
      <span aria-hidden>{on ? '✓' : '○'}</span>{on ? 'Read' : 'Got it'}
    </button>
  );
}

export function AckButton({ action, className }: { action: (f: FormData) => void; className: string }) {
  const c = useContext(Ctx)!;
  const n = c.required.filter((k) => c.read.has(k)).length;
  const all = n === c.required.length;
  return (
    <form action={action} className="flex items-center gap-2">
      {[...c.read].map((k) => <input key={k} type="hidden" name="read" value={k} />)}
      {c.required.length > 0 && <span className={`text-xs ${all ? 'text-emerald-700' : 'text-sub'}`}>{n} of {c.required.length} read</span>}
      <button disabled={!all} title={all ? undefined : 'Tick "Got it" on every item first'} className={`${className} disabled:cursor-not-allowed disabled:opacity-40`}>Acknowledge</button>
    </form>
  );
}
