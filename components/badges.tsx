import type { Sev, State } from '@/lib/lifecycle.ts';

// Severity is the only strong color in the app. Confirmed SEV = filled, suggested = outlined with "?".
const FILL: Record<Sev, string> = { 1: 'bg-sev1 text-white', 2: 'bg-sev2 text-white', 3: 'bg-sev3 text-white', 4: 'bg-sev4 text-white' };
const OUTLINE: Record<Sev, string> = { 1: 'border-sev1 text-sev1', 2: 'border-sev2 text-sev2', 3: 'border-sev3 text-sev3', 4: 'border-sev4 text-sub' };
export const RAIL: Record<Sev, string> = { 1: 'bg-sev1', 2: 'bg-sev2', 3: 'bg-sev3', 4: 'bg-sev4' };

export function SevBadge({ sev, suggested }: { sev: Sev | null; suggested?: Sev | null }) {
  const base = 'inline-flex items-center rounded-md px-1.5 h-5 text-xs font-semibold';
  // Solid = set by a person (on declare, or changed later); dashed with "suggested" = computed from the alerts,
  // not confirmed yet (candidates).
  if (sev) return <span className={`${base} ${FILL[sev]}`} title="Severity set by the incident commander">SEV{sev}</span>;
  if (suggested) return (
    <span className={`${base} gap-1 border border-dashed ${OUTLINE[suggested]}`} title="Suggested from the alerts' severity; set when the incident is declared">
      SEV{suggested}<span className="font-normal opacity-75">suggested</span>
    </span>
  );
  return <span className={`${base} border border-line text-sub`}>No SEV</span>;
}

const STATE_LABEL: Record<State, string> = {
  candidate: 'Candidate', declared: 'Declared', mitigated: 'Mitigated', resolved: 'Resolved',
  postmortem: 'Postmortem', closed: 'Closed', dismissed: 'Dismissed',
};
const STATE_DOT: Record<State, string> = {
  candidate: 'bg-sev4', declared: 'bg-sev1', mitigated: 'bg-sev2', resolved: 'bg-emerald-600',
  postmortem: 'bg-sky-600', closed: 'bg-sev4', dismissed: 'bg-sev4',
};

export function StateBadge({ state }: { state: State }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-1.5 h-5 text-xs text-ink">
      <span className={`size-1.5 rounded-full ${STATE_DOT[state]}`} />{STATE_LABEL[state]}
    </span>
  );
}

// Button text says what happens (PRD vocabulary), never "→ state".
export const ACTION_LABEL: Record<State, string> = {
  declared: 'Declare incident', mitigated: 'Mark mitigated', resolved: 'Mark resolved', postmortem: 'Start postmortem',
  closed: 'Close incident', dismissed: 'Dismiss', candidate: 'Candidate',
};
