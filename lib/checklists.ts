// Role checklists: the default template (checklists.yaml) and which phases a transition expects done.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import type { Sev, State } from './lifecycle.ts';

export const PHASES = ['declare', 'mitigate', 'resolve', 'close'] as const;
export type Phase = (typeof PHASES)[number];
export const PHASE_LABEL: Record<Phase, string> = {
  declare: 'Right after declaring', mitigate: 'Before mitigation', resolve: 'Before resolving', close: 'Before closing',
};
export const CHECKLIST_ROLES = ['ic', 'ops', 'comms', 'planning'] as const;
export type ChecklistRole = (typeof CHECKLIST_ROLES)[number];
export type TemplateItem = { key: string; phase: Phase; text: string; sev?: Sev[] };
export type Template = Record<ChecklistRole, TemplateItem[]>;

export function validateTemplate(t: Template): string[] {
  const errs: string[] = [];
  const keys = new Set<string>();
  for (const role of CHECKLIST_ROLES) {
    for (const i of t[role] ?? []) {
      // An unquoted comma in a flow mapping silently splits the text into an extra key; catch that.
      const extra = Object.keys(i).filter((k) => !['key', 'phase', 'text', 'sev'].includes(k));
      if (extra.length) errs.push(`${i.key}: unexpected ${extra.join(', ')} (quote text that contains commas)`);
      if (!i.key || keys.has(i.key)) errs.push(`${role}: missing or duplicate key ${i.key}`);
      keys.add(i.key);
      if (!PHASES.includes(i.phase)) errs.push(`${i.key}: unknown phase ${i.phase}`);
      if (!i.text?.trim()) errs.push(`${i.key}: empty text`);
      if (i.sev && !i.sev.every((s) => [1, 2, 3, 4].includes(s))) errs.push(`${i.key}: sev must be 1–4`);
    }
  }
  return errs;
}

export function template(): Template {
  const t = parse(readFileSync(path.join(process.cwd(), 'checklists.yaml'), 'utf8')) as Template;
  const errs = validateTemplate(t);
  if (errs.length) throw new Error(`checklists.yaml: ${errs.join('; ')}`);
  return t;
}

export function itemsFor(t: Template, sev: Sev): (TemplateItem & { role: ChecklistRole })[] {
  return CHECKLIST_ROLES.flatMap((role) => (t[role] ?? []).filter((i) => !i.sev || i.sev.includes(sev)).map((i) => ({ ...i, role })));
}

// Phases that should be done before entering `to` (the warning on a transition lists only these).
export function phasesBefore(to: State): Phase[] {
  const upto: Partial<Record<State, Phase>> = { mitigated: 'mitigate', resolved: 'resolve', postmortem: 'resolve', closed: 'close' };
  const last = upto[to];
  return last ? PHASES.slice(0, PHASES.indexOf(last) + 1) : [];
}

// The phase an incident in `state` is working on now (shown first in the Roles tab).
export function currentPhase(state: State): Phase {
  return state === 'declared' ? 'mitigate' : state === 'mitigated' ? 'resolve' : state === 'resolved' || state === 'postmortem' ? 'close' : 'declare';
}
