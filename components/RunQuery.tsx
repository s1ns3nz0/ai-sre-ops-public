'use client';
import { useState } from 'react';
import { runQueryAction } from '@/app/(console)/incidents/[id]/actions.ts';

// A runbook ```promql block with a Run button (read-only, now).
export function RunQuery({ expr }: { expr: string }) {
  const [out, setOut] = useState<Awaited<ReturnType<typeof runQueryAction>> | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="rounded-lg border border-line">
      <div className="flex items-start gap-2 px-3 py-2">
        <code className="min-w-0 flex-1 whitespace-pre-wrap break-all text-xs">{expr}</code>
        <button type="button" disabled={busy} onClick={async () => { setBusy(true); setOut(await runQueryAction(expr)); setBusy(false); }}
          className="h-7 shrink-0 rounded-md bg-ink px-2.5 text-xs font-medium text-white disabled:opacity-60">{busy ? 'Running…' : 'Run'}</button>
      </div>
      {out && (
        <div className="border-t border-line px-3 py-2 text-xs">
          {'error' in out ? <span className="text-sev1">{out.error}</span>
            : !out.rows.length ? <span className="text-sub">No series right now.</span>
            : (
              <table className="w-full">
                <tbody>
                  {out.rows.map((r, i) => (
                    <tr key={i} className="align-top">
                      <td className="py-0.5 pr-3 text-sub break-all">{Object.entries(r.metric).filter(([k]) => k !== '__name__').map(([k, v]) => `${k}=${v}`).join(', ')}</td>
                      <td className="py-0.5 text-right font-medium tabular-nums">{Number(r.value).toLocaleString('en-US', { maximumFractionDigits: 4 })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </div>
      )}
    </div>
  );
}
