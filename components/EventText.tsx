import Link from 'next/link';
import type { Event } from '@/lib/incidents.ts';

export function EventText({ e }: { e: Pick<Event, 'kind' | 'body'> }) {
  const b = e.body as Record<string, string | null>;
  switch (e.kind) {
    case 'alert_firing': return <><span className="text-red-500">firing</span> <code className="text-xs">{b.alertname}</code> {b.summary}</>;
    case 'alert_resolved': return <><span className="text-green-600">resolved</span> <code className="text-xs">{b.alertname}</code></>;
    case 'state': return <>state <b>{b.from}</b> → <b>{b.to}</b></>;
    case 'sev': return <>SEV {b.from ?? '—'} → <b>{b.to}</b></>;
    case 'role': return b.who ? <>{b.role}: <b>{b.who}</b> {b.doing && `— ${b.doing}`}</> : <>{b.role}: cleared</>;
    case 'summary': return <>summary: {b.status_line}</>;
    case 'reopen': return <span className="text-red-500">reopened: {b.reason}</span>;
    case 'note': return <>{b.text}</>;
    case 'page': {
      const raw = e.body as { step: number; channel: string; priority: string; kind?: string };
      if (raw.kind === 'triage') return <span className="text-sev1">Paged via ntfy: critical candidate unhandled for 15 minutes (mock)</span>;
      if (raw.step === 0) return <>Posted to Slack (SEV3, no page)</>;
      return <span className="text-sev1">Paged via {raw.channel === 'ntfy' ? 'ntfy' : 'Slack'}{raw.priority === 'urgent' && ', urgent'} (step {raw.step}, mock)</span>;
    }
    case 'change': {
      const c = e.body as { object_kind: string; object_name: string; revision: string; severity: string; message: string };
      return <><span className={c.severity === 'error' ? 'text-sev1' : 'text-sev3'}>{c.severity === 'error' ? 'Flux failed' : 'Deployed'}</span> {c.object_kind} <b>{c.object_name}</b> {c.revision.replace(/sha1:([0-9a-f]{7})[0-9a-f]+/, '$1')}<br /><span className="text-sub">{c.message.split('\n')[0]}</span></>;
    }
    case 'follow_up': {
      const f = e.body as { action: string; added?: boolean; issue?: number; done?: boolean; type?: string; priority?: string };
      if (f.added) return <>Follow-up added ({f.priority} {f.type}): {f.action}</>;
      if (f.issue) return <>Issue #{f.issue} created (mock) for: {f.action}</>;
      return <>Follow-up {f.done ? 'done' : 'reopened'}: {f.action}</>;
    }
    case 'runbook': return <>{(e.body as { done: boolean }).done ? '✓' : 'Unticked'} {b.text} <span className="text-sub">({b.runbook})</span></>;
    case 'merge': return b.into ? <>Merged into <Link className="underline" href={`/incidents/${b.into}`}>#{b.into}</Link> ({String(b.alerts)} alerts)</> : <>Merged in <Link className="underline" href={`/incidents/${b.from}`}>#{b.from}</Link> ({String(b.alerts)} alerts)</>;
    case 'split': return b.to ? <>Moved {String(b.alerts)} alerts to new candidate <Link className="underline" href={`/incidents/${b.to}`}>#{b.to}</Link></> : <>Split from <Link className="underline" href={`/incidents/${b.from}`}>#{b.from}</Link> ({String(b.alerts)} alerts)</>;
    case 'checkpoint': return <><b>Checkpoint:</b> {b.status_line}{b.wake_expr && <><br /><span className="text-sub">Wake when <code className="text-xs">{b.wake_expr}</code></span></>}{b.handoff_to && <><br /><span className="text-sub">Handed to {b.handoff_to}</span></>}</>;
    case 'wake': return (e.body as { manual?: boolean }).manual
      ? <span className="text-sev1">Wake alarm sent by hand, paged the IC via ntfy (mock)</span>
      : <span className="text-sev1">Wake condition met ({String((e.body as { series: number }).series)} series), paged the IC via ntfy</span>;
    case 'wake_stopped': return <>Stopped watching the wake condition ({b.reason})</>;
    case 'ack': {
      const s = Number((e.body as { mtta_s: number }).mtta_s);
      return <>Acknowledged the page, {s < 90 ? `${s}s` : `${Math.round(s / 60)}m`} after it was sent</>;
    }
    case 'checklist': {
      const who = { ic: 'IC', ops: 'Ops', comms: 'Comms', planning: 'Planning' }[b.role as string] ?? b.role;
      const raw = e.body as Record<string, unknown>;
      if (raw.added) return <>{who} added to checklist: {b.text}</>;
      if (raw.noteEdited) return <>{who} updated the note on {b.text}{b.note && <>: <i>{b.note}</i></>}</>;
      return <>{who} {raw.done ? '✓' : 'reopened'} {b.text}{b.note && <><br /><span className="text-sub">How: {b.note}</span></>}</>;
    }
    case 'decision': return <><b>Decision:</b> {b.decision}{b.alternatives && <> · alt: {b.alternatives}</>}{b.reason && <> · why: {b.reason}</>}{b.revert_when && <> · revert when: {b.revert_when}</>}</>;
    case 'agent_run': return <>AI {b.status === 'done' ? 'answered' : b.status} ({String((e.body as { tool_calls: number }).tool_calls)} tool calls){b.error && <>: <span className="text-sev1">{b.error}</span></>}. <span className="text-sub">See Response.</span></>;
    case 'briefing': return <>AI briefing v{String((e.body as { version: number }).version)}: {b.situation} <span className="text-sub">({String((e.body as { steps: number }).steps)} next steps, see Response)</span></>;
    case 'action_proposed': return <>Proposed action #{b.action}: <code className="text-xs">{b.command}</code><br /><span className="text-sub">{b.reason}</span></>;
    case 'action_run': return <>Approved and ran action #{b.action}: <code className="text-xs">{b.command}</code></>;
    case 'action_skipped': return <>Skipped action #{b.action}: <code className="text-xs">{b.command}</code></>;
    case 'action_result': return (e.body as { ok: boolean }).ok
      ? <>Action #{b.action} done: {((e.body as { log: string[] }).log ?? []).join('; ')}</>
      : <span className="text-sev1">Action #{b.action} failed: {b.error}</span>;
    default: return <>{e.kind}</>;
  }
}
