'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { agentStateAction, askAction, respondAction, stopAction } from '@/app/(console)/ai/actions.ts';
import { parseAnswer } from '@/lib/answer.ts';
import type { Action, Run, Step, StoredBriefing } from '@/lib/agent-runs.ts';
import { Briefing } from './Briefing.tsx';
import { Elapsed } from './Elapsed.tsx';
import { Md } from './Md.tsx';
import { Ts } from './Ts.tsx';
import { button } from './ui.tsx';

type State = { enabled: boolean; connected: boolean; quota: { used: number; limit: number } | null; runs: Run[]; actions: Action[]; briefing: StoredBriefing | null; doneSteps: string[] };

// Sub-agents as the console names them. Old runs carry the pre-rename Kagent names.
const SUB: Record<string, string> = { ai_investigate: 'Investigate', 'ai-investigate': 'Investigate', investigator: 'Investigate', ai_plan: 'Plan', 'ai-plan': 'Plan', mitigation_planner: 'Plan', 'mitigation-planner': 'Plan' };
const subAgent = (name: string) => (name.startsWith('kagent__NS__') ? SUB[name.slice(12)] ?? name.slice(12) : null);
const stepLabel = (x: Step) => { const sub = subAgent(x.name); return sub ? `AI · ${sub}` : x.name === 'submit_briefing' ? 'writing the briefing' : x.name; };
const oneLine = (s: string, n = 110) => { const t = s.replace(/[#*`]/g, '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
const asked = (r: Run) => r.prompt.replace(/^\[[^\]]*\]\s*/, '');
// Chat the IC sees: questions people asked (not the automatic response, not the console's verify requests).
const isChat = (r: Run) => r.kind === 'chat' && r.asked_by !== 'console';
const CHAT_SHOWN = 3;
const SUGGEST = ['Is it still happening?', 'What changed before it started?', 'What should the next shift watch?'];

// The incident's AI in the Response tab: the briefing, then questions about this incident.
export function AgentPanel({ incidentId, live, sev = null }: { incidentId: string; live: boolean; sev?: number | null }) {
  const [s, setS] = useState<State | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [allChat, setAllChat] = useState(false);
  const load = useCallback(async () => {
    const r = await agentStateAction(incidentId);
    if ('error' in r) setErr(r.error); else { setS(r); setErr(null); }
  }, [incidentId]);
  const running = !!s && (s.runs.some((r) => r.status === 'running') || s.actions.some((a) => a.status === 'running'));
  useEffect(() => {
    load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, running ? 1500 : 6000);
    return () => clearInterval(t);
  }, [load, running]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      const r = await fn();
      if (r && typeof r === 'object' && 'error' in r) setErr(String((r as { error: string }).error));
      await load();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const send = () => { const t = text.trim(); if (!t) return; setText(''); act(() => askAction(incidentId, t)); };

  if (!s) return <p className="p-4 text-sm text-sub">{err ?? 'Loading…'}</p>;
  const cur = s.runs.find((r) => r.status === 'running');
  const lastFailed = [...s.runs].reverse().find((r) => !isChat(r));
  const chats = s.runs.filter(isChat);

  const composer = live && s.enabled && (
    <form onSubmit={(e) => { e.preventDefault(); send(); }}>
      <div className="flex items-end gap-2">
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} aria-label="Message to the AI"
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}
          placeholder={cur ? 'The AI is working. You can ask once it finishes.' : 'Ask the AI about this incident (Enter sends, Shift+Enter new line)'}
          className="min-h-10 flex-1 resize-y rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-ink/40" />
        <button disabled={busy || !!cur || !text.trim()} className={`${button.primary} h-10 disabled:opacity-40`}>Send</button>
      </div>
      <p className="mt-1 text-[11px] text-sub">Everyone on this incident sees this thread. The AI reads the lab; changes run only when you approve them.</p>
      <Quota q={s.quota} />
    </form>
  );
  const off = !s.enabled && <p className="rounded-lg bg-sev3/10 px-3 py-2 text-sm">{s.connected
    ? <>AI is off. It does not run until it is turned on at <Link className="underline" href="/ai">/ai</Link>.</>
    : 'The AI agents are not connected in this deployment; the briefing and answers shown are part of the sample data.'}</p>;
  const working = cur && (
    <div className="flex items-center gap-3 rounded-lg bg-canvas px-3 py-2 text-sm">
      <span className="motion-safe:animate-pulse">AI is working</span>
      <span className="text-sub">{cur.steps.length ? stepLabel(cur.steps.at(-1)!) : 'reading the incident'} · <Elapsed from={cur.started_at} /></span>
      <button className={`${button.quiet} ml-auto h-7`} onClick={() => act(() => stopAction(cur.id))}>Stop</button>
    </div>
  );

  // Response tab: the briefing, then the chat (the latest few exchanges).
  return (
    <div className="max-w-4xl space-y-4">
      {off}
      {working}
      {s.briefing
        ? <Briefing incidentId={incidentId} b={s.briefing} sev={sev} actions={s.actions} doneSteps={s.doneSteps} live={live} busy={busy} act={act}
            refresh={live && s.enabled && !cur && <button disabled={busy} className="underline-offset-2 hover:text-ink hover:underline" onClick={() => act(() => respondAction(incidentId))}>Ask for a new briefing</button>} />
        : !cur && (
          <div className="rounded-xl border border-dashed border-line px-4 py-6 text-sm">
            <p>{live ? 'No AI briefing yet. Declaring the incident asks the AI for one: situation, likely cause and the next runbook steps.' : 'The AI did not brief this incident.'}</p>
            {lastFailed?.status === 'failed' && <p className="mt-1 text-sev1">Last attempt failed: {lastFailed.error}</p>}
            {live && s.enabled && <button disabled={busy} className={`${button.primary} mt-3`} onClick={() => act(() => respondAction(incidentId))}>Ask the AI for a briefing</button>}
          </div>
        )}
      <section className="space-y-3 pt-2">
        <h3 className="text-sm font-semibold">Ask the AI</h3>
        {chats.length > CHAT_SHOWN && !allChat && <button className="text-xs text-sub underline-offset-2 hover:text-ink hover:underline" onClick={() => setAllChat(true)}>Show {chats.length - CHAT_SHOWN} earlier</button>}
        {(allChat ? chats : chats.slice(-CHAT_SHOWN)).map((r) => <Exchange key={r.id} r={r} />)}
        {!chats.length && live && s.enabled && (
          <div className="flex flex-wrap items-center gap-1.5 text-sm">
            <span className="text-sub">Try:</span>
            {SUGGEST.map((q) => <button key={q} type="button" onClick={() => setText(q)} className="rounded-full border border-line px-2.5 py-0.5 text-[13px] hover:border-ink/40">{q}</button>)}
          </div>
        )}
        {composer}
        {err && <p role="alert" className="text-sm text-sev1">{err}</p>}
      </section>
    </div>
  );
}

export function Exchange({ r, compact = false }: { r: Run; compact?: boolean }) {
  const a = parseAnswer(r.answer);
  const done = r.status !== 'running';
  return (
    <div className="space-y-1.5">
      <div className="ml-auto w-fit max-w-[90%]">
        <div className="mb-0.5 text-right text-[11px] text-sub">{r.asked_by} · <Ts at={r.started_at} /></div>
        <p className="rounded-lg bg-canvas px-3 py-2 text-sm whitespace-pre-wrap">{asked(r)}</p>
      </div>
      <div className="rounded-lg border border-line px-3 py-2">
        <div className="mb-0.5 text-[11px] text-sub"><b className="font-semibold text-ink">AI</b>{done && r.tool_calls > 0 && <> · {r.tool_calls} tool call{r.tool_calls === 1 ? '' : 's'}</>}</div>
        {!done && <p className="text-sm text-sub motion-safe:animate-pulse">{r.answer ? oneLine(r.answer, 200) : 'Thinking…'}</p>}
        {done && a.conclusion && <div className={compact ? 'text-sm' : 'text-sm font-medium'}><Md text={a.conclusion} /></div>}
        {done && a.evidence && <div className="mt-1 text-ink/85"><Md text={a.evidence} /></div>}
        {done && a.next && <p className="mt-1 text-sm"><b className="font-semibold">Next step </b>{oneLine(a.next, 300)}</p>}
        {r.status === 'failed' && <p className="text-sm text-sev1">Failed: {r.error}</p>}
        {r.status === 'stopped' && <p className="text-sm text-sev2">Stopped: {r.error}</p>}
        {done && (a.details || r.steps.length > 0) && (
          <details className="mt-1 text-sm">
            <summary className="cursor-pointer text-xs text-sub hover:text-ink">Details</summary>
            {a.details && <div className="mt-1"><Md text={a.details} /></div>}
            {r.steps.length > 0 && (
              <ul className="mt-1 space-y-0.5 border-l border-line pl-3 text-xs text-sub">
                {r.steps.map((x) => <li key={x.id}>{stepLabel(x)} <span className="opacity-80">{oneLine(subAgent(x.name) ? String((x.args as { request?: string })?.request ?? '') : JSON.stringify(x.args), 100)}</span></li>)}
              </ul>
            )}
          </details>
        )}
      </div>
    </div>
  );
}

// Demo mode: AI requests are limited per person per day.
export function Quota({ q }: { q: { used: number; limit: number } | null }) {
  if (!q) return null;
  const left = Math.max(0, q.limit - q.used);
  return <p className={`mt-1 text-[11px] ${left ? 'text-sub' : 'font-medium text-sev1'}`}>Demo: AI use is limited to {q.limit} requests per person per day · {left ? `${left} left` : 'none left today'}</p>;
}
