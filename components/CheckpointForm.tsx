'use client';
import { useActionState, useState } from 'react';
import { checkpointAction, type CheckpointResult } from '@/app/(console)/incidents/[id]/actions.ts';
import { previewAction } from '@/app/(console)/detection/actions.ts';
import type { Checkpoint } from '@/lib/checkpoints.ts';
import { button, field } from './ui.tsx';

// Prefilled from the last checkpoint, so writing the next one is an edit, not a blank page.
export function CheckpointForm({ id, last }: { id: string; last: Checkpoint | null }) {
  const [state, action, pending] = useActionState<CheckpointResult, FormData>(checkpointAction.bind(null, id), null);
  const [expr, setExpr] = useState(last?.wake_state === 'watching' ? last.wake_expr : '');
  const [pv, setPv] = useState<string | null>(null);
  const area = `${field} h-auto py-2`;
  return (
    <form action={action} className="grid gap-3 text-sm">
      <label className="grid gap-1">Status, in one line<input name="status_line" required maxLength={300} defaultValue={last?.status_line} className={field} /></label>
      <label className="grid gap-1">Current hypothesis<textarea name="hypothesis" rows={2} defaultValue={last?.hypothesis} className={area} /></label>
      <div className="grid gap-3 sm:grid-cols-[1fr_13rem]">
        <label className="grid gap-1">Action in progress<input name="action" defaultValue={last?.action} className={field} /></label>
        <label className="grid gap-1">Expected to finish (UTC)<input type="datetime-local" name="action_eta" defaultValue={last?.action_eta ? new Date(last.action_eta).toISOString().slice(0, 16) : ''} className={field} /></label>
      </div>
      <label className="grid gap-1">Wake me when (PromQL, pages once when it returns any series)
        <textarea name="wake_expr" rows={3} value={expr} onChange={(e) => { setExpr(e.target.value); setPv(null); }}
          placeholder='e.g. changes(lineth_l2_finalized_block[30m]) == 0' className={`${area} font-mono text-xs`} />
      </label>
      {expr.trim() && (
        <div className="flex items-center gap-2">
          <button type="button" className="text-xs text-sub underline underline-offset-2 hover:text-ink" onClick={async () => {
            const r = await previewAction(expr);
            setPv('error' in r ? `Error: ${r.error}` : r.series ? `Matches now (${r.series} series): it would page right away` : 'Does not match now: will wake you when it does');
          }}>Check now</button>
          {pv && <span className={`text-xs ${pv.startsWith('Does not') ? 'text-emerald-700' : 'text-sev1'}`}>{pv}</span>}
        </div>
      )}
      <label className="grid gap-1">Next step<input name="next_step" defaultValue={last?.next_step} className={field} /></label>
      <label className="grid gap-1">Handing over to (optional)<input name="handoff_to" maxLength={100} defaultValue={last?.handoff_to} className={field} /></label>
      {state && !state.ok && <ul className="text-sm text-sev1">{state.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      {state?.ok && <p className="text-sm text-emerald-700">Checkpoint saved.{state.warning && <span className="block text-sev2">{state.warning}</span>}</p>}
      <button disabled={pending} className={`${button.primary} justify-self-end disabled:opacity-60`}>{pending ? 'Saving…' : 'Save checkpoint'}</button>
    </form>
  );
}
