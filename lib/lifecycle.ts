// Incident lifecycle (PRD F9). Pure: no I/O, so the rules are unit-testable.

export const STATES = ['candidate', 'declared', 'mitigated', 'resolved', 'postmortem', 'closed', 'dismissed'] as const;
export type State = (typeof STATES)[number];
export type Sev = 1 | 2 | 3 | 4;

const NEXT: Record<State, State[]> = {
  candidate: ['declared', 'dismissed'],
  declared: ['mitigated'],
  mitigated: ['resolved'],
  resolved: ['postmortem', 'closed', 'declared'], // declared = reopen on recurrence
  postmortem: ['closed'],
  closed: [],
  dismissed: [],
};

// Column stamped when an incident enters a state; the MTTx metrics read these.
export const STAMP: Partial<Record<State, string>> = {
  declared: 'declared_at',
  mitigated: 'mitigated_at',
  resolved: 'resolved_at',
  closed: 'closed_at',
};

export const OPEN: State[] = ['candidate', 'declared', 'mitigated'];

export function transitionError(from: State, to: State, sev: Sev | null): string | null {
  if (!NEXT[from].includes(to)) return `${from} → ${to} is not allowed`;
  if (to === 'declared' && from === 'candidate' && sev === null) return 'set a SEV before declaring';
  // SEV1–2 need a postmortem; SEV3–4 may close straight from resolved.
  if (from === 'resolved' && to === 'closed' && sev !== null && sev <= 2) return 'SEV1–2 must go through postmortem';
  // ponytail: no SLI-30min gate on mitigated → resolved yet; needs the Prometheus client (F4).
  return null;
}

export function allowedNext(from: State, sev: Sev | null): State[] {
  return NEXT[from].filter((to) => transitionError(from, to, sev) === null);
}

// Alert names that mean block production or funds are at risk (SEV1 per PRD F9).
const SEV1_ALERTS = new Set(['LinethL2SequencerStalled', 'LinethL2SignerKeysMissing']);

export type AlertLabels = Record<string, string>;

export function suggestSev(alerts: AlertLabels[]): Sev | null {
  if (!alerts.length) return null;
  let best: Sev = 4;
  for (const l of alerts) {
    const s: Sev = SEV1_ALERTS.has(l.alertname) ? 1 : l.severity === 'critical' ? 2 : l.severity === 'warning' ? 3 : 4;
    if (s < best) best = s;
  }
  return best;
}

// Same group firing again within 24 h of resolve reopens the incident instead of opening a new one.
export const REOPEN_WINDOW_MS = 24 * 3600 * 1000;
