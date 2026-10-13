'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { askGeneralAction, generalStateAction, stopAction } from '@/app/(console)/ai/actions.ts';
import type { Run } from '@/lib/agent-runs.ts';
import { Exchange, Quota } from './AgentPanel.tsx';
import { button } from './ui.tsx';

// The AI assistant, from any screen: the button at the bottom right or ⌘K / Ctrl+K. Ask anything (the lab,
// incidents, SLOs, how to do something); it is not tied to the screen. Your own conversation; New chat starts over.
export function AgentLauncher() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen((o) => !o); }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  if (!open) return (
    <button onClick={() => setOpen(true)} aria-label="Ask AI (⌘K)" title="Ask AI (⌘K)"
      className="fixed right-5 bottom-5 z-40 flex h-11 items-center gap-2 rounded-full bg-ink px-4 text-sm font-medium text-white shadow-lg hover:bg-ink/85">
      Ask AI <kbd className="rounded bg-white/15 px-1.5 text-[11px]">⌘K</kbd>
    </button>
  );
  return (
    <aside role="dialog" aria-label="Ask the AI"
      className="fixed right-5 bottom-5 z-40 flex h-[min(42rem,calc(100vh-7rem))] w-[min(28rem,calc(100vw-2.5rem))] flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-2xl">
      <Chat onClose={() => setOpen(false)} />
    </aside>
  );
}

function Chat({ onClose }: { onClose: () => void }) {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [connected, setConnected] = useState(true);
  const [quota, setQuota] = useState<{ used: number; limit: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState(false); // "New chat" pressed: the next question starts a new conversation
  const end = useRef<HTMLDivElement>(null);
  const load = useCallback(async () => {
    const r = await generalStateAction();
    if ('error' in r) setErr(r.error); else { setRuns(r.runs); setEnabled(r.enabled); setConnected(r.connected); setQuota(r.quota); }
  }, []);
  const cur = runs?.find((r) => r.status === 'running');
  useEffect(() => {
    load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, cur ? 1500 : 10000);
    return () => clearInterval(t);
  }, [load, cur]);
  const shown = fresh ? [] : runs ?? [];
  const last = shown.at(-1)?.answer.length ?? 0;
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [last, shown.length]);

  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true); setText('');
    try {
      const r = await askGeneralAction(t, fresh);
      if (r && typeof r === 'object' && 'error' in r) setErr(r.error); else { setErr(null); setFresh(false); }
      await load();
    } finally { setBusy(false); }
  };

  return (
    <>
      <header className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <b className="text-sm font-semibold">Ask AI</b>
        <button disabled={!shown.length || !!cur} onClick={() => setFresh(true)} className="ml-auto rounded-md px-2 py-0.5 text-xs text-sub hover:bg-canvas hover:text-ink disabled:opacity-40">New chat</button>
        <button onClick={onClose} aria-label="Close" className="px-1 text-sub hover:text-ink">×</button>
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
        {!enabled && <p className="rounded-lg bg-sev3/10 px-3 py-2 text-sm">{connected ? <>AI is off. Turn it on at <Link className="underline" href="/ai">/ai</Link>.</> : 'The AI agents are not connected in this deployment.'}</p>}
        {runs === null ? <p className="text-sm text-sub">Loading…</p> : !shown.length && (
          <div className="text-sm text-sub">
            <p>Ask anything about the lab: incidents, SLOs, alerts, components, how to do something. The AI reads live data; it changes nothing.</p>
            <p className="mt-2">e.g. “Which SLOs are at risk right now?”, “Show the prover memory trend”, “How do I restart maru safely?”</p>
          </div>
        )}
        {shown.map((r) => <Exchange key={r.id} r={r} compact />)}
        {cur && <button className={`${button.quiet} h-7`} onClick={async () => { await stopAction(cur.id); await load(); }}>Stop</button>}
        {err && <p role="alert" className="text-sm text-sev1">{err}</p>}
        <div ref={end} />
      </div>
      {enabled && (
        <form onSubmit={(e) => { e.preventDefault(); send(); }} className="border-t border-line p-3">
          <div className="flex items-end gap-2">
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} aria-label="Message to the AI" autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}
              placeholder={cur ? 'The AI is answering…' : 'Ask anything (Enter sends, Shift+Enter new line)'}
              className="min-h-10 flex-1 resize-y rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-ink/40" />
            <button disabled={busy || !!cur || !text.trim()} className={`${button.primary} h-10 disabled:opacity-40`}>Send</button>
          </div>
          <p className="mt-1 text-[11px] text-sub">Only you see this conversation.</p>
          <Quota q={quota} />
        </form>
      )}
    </>
  );
}
