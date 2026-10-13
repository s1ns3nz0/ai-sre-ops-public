'use client';
import { fmtDuration } from '@/lib/time.ts';
import { useNow } from './region.ts';

// Time since `from` (or `from`→`until` once finished). Hover shows the UTC start.
export function Elapsed({ from, until }: { from: Date | string; until?: Date | string | null }) {
  const now = useNow(30_000);
  const start = new Date(from);
  const end = until ? new Date(until) : now;
  return (
    <span title={`${start.toISOString().slice(0, 16).replace('T', ' ')} UTC`}>
      {end ? fmtDuration(end.getTime() - start.getTime()) : '…'}
    </span>
  );
}

// "in 48m" / "12m overdue" relative to now.
export function Until({ at }: { at: Date | string }) {
  const now = useNow(30_000);
  if (!now) return <span>…</span>;
  const diff = new Date(at).getTime() - now.getTime();
  return diff >= 0 ? <span>in {fmtDuration(diff)}</span> : <span className="font-medium text-sev1">{fmtDuration(-diff)} overdue</span>;
}
