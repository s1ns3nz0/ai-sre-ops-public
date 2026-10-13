'use client';
import { useState } from 'react';
import { draftPostmortemAction } from '@/app/(console)/postmortems/actions.ts';
import { button } from './ui.tsx';

// Opens the postmortem draft pull request for an incident.
export function DraftPostmortem({ incidentId, demo }: { incidentId: string; demo: boolean }) {
  const [r, setR] = useState<{ url: string } | { error: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (r && 'url' in r) return <a href={r.url} target="_blank" rel="noreferrer" className={button.quiet}>Draft PR opened ↗</a>;
  return (
    <span className="inline-flex items-center gap-2">
      <button disabled={busy || demo} title={demo ? 'Not in the demo: it would open a pull request in the real repository' : 'Writes a first draft from the timeline, decisions and follow-ups and opens it as a pull request'}
        className={`${button.primary} disabled:opacity-50`} onClick={async () => { setBusy(true); setR(await draftPostmortemAction(incidentId)); setBusy(false); }}>
        {busy ? 'Opening…' : 'Draft postmortem'}
      </button>
      {r && 'error' in r && <span className="text-xs text-sev1">{r.error}</span>}
    </span>
  );
}
