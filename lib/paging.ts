// Paging policy (PRD F10). Pure: no I/O. Delivery is mocked: a "sent" page is a row in the pages table (the outbox
// the UI shows); nothing leaves the app. Swap in ntfy/Slack senders where pageTick() inserts the row.

export type Channel = 'ntfy' | 'slack';
export type Priority = 'default' | 'high' | 'urgent';
export type Page = { step: number; channel: Channel; priority: Priority };

const MIN = 60_000;
export const MAX_STEP = 6; // ponytail: Slack repeats stop after step 6 (~60 min); unbounded repeat when on-call is real

// When step n is due, measured from the first page. 1: ntfy now, 2: ntfy urgent at 5m, 3+: Slack every 15m from 15m.
export function stepAt(step: number): number {
  if (step <= 1) return 0;
  if (step === 2) return 5 * MIN;
  return (15 + (step - 3) * 15) * MIN;
}

const pageFor = (step: number): Page =>
  step === 1 ? { step, channel: 'ntfy', priority: 'high' }
  : step === 2 ? { step, channel: 'ntfy', priority: 'urgent' }
  : { step, channel: 'slack', priority: 'high' };

// What to send now. SEV1–2 page and escalate until acked; SEV3 gets one Slack post (step 0, no ack); SEV4 nothing.
// `sent` counts escalation pages (step ≥ 1) already sent, `sinceFirst` is ms since the first of them.
export function duePage(sev: number | null, s: { sent: number; sinceFirst: number; notified: boolean }): Page | null {
  if (sev === 3) return s.notified ? null : { step: 0, channel: 'slack', priority: 'default' };
  if (sev !== 1 && sev !== 2) return null;
  const step = s.sent + 1;
  if (step > MAX_STEP || s.sinceFirst < stepAt(step)) return null;
  return pageFor(step);
}
