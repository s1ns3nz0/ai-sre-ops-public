// The fixed catalog of changes the AI may put in a briefing (P2). Typed parameters, no free-form commands. They are
// stored by the console; only the executor runs them, and only after the IC clicks Approve & run. Shared by the console,
// the tool server (validates proposals) and the executor (runs them).
import { z } from 'zod';

export const ACTION_NAMESPACES = ['lineth-l2', 'local-l1'] as const;
const k8sName = z.string().regex(/^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/, 'a Kubernetes object name');

export const ACTIONS = {
  restart_pod: {
    label: 'Restart pod',
    params: z.object({ namespace: z.enum(ACTION_NAMESPACES), pod: k8sName }),
    command: (p: { namespace: string; pod: string }) => `kubectl -n ${p.namespace} delete pod ${p.pod}`,
    summary: (p: { namespace: string; pod: string }) => `Restart pod ${p.pod} (${p.namespace})`,
  },
  flux_reconcile: {
    label: 'Reconcile Flux object',
    params: z.object({ kind: z.enum(['Kustomization', 'HelmRelease']), name: k8sName, namespace: k8sName.default('flux-system') }),
    command: (p: { kind: string; name: string; namespace: string }) => `flux reconcile ${p.kind.toLowerCase()} ${p.name} -n ${p.namespace}`,
    summary: (p: { kind: string; name: string; namespace: string }) => `Reconcile Flux ${p.kind} ${p.name}`,
  },
} as const;

export type ActionType = keyof typeof ACTIONS;
export const ACTION_TYPES = Object.keys(ACTIONS) as ActionType[];

// Validates the params against the action's schema and returns the exact command shown to the IC.
export function checkAction(type: ActionType, params: unknown): { params: Record<string, string>; command: string } {
  const a = ACTIONS[type];
  const p = a.params.parse(params) as Record<string, string>;
  return { params: p, command: (a.command as (x: Record<string, string>) => string)(p) };
}

// What the action does, in words, from its type and params (never from model text).
export function actionSummary(type: string, params: Record<string, string>): string {
  const a = ACTIONS[type as ActionType];
  return a ? (a.summary as (x: Record<string, string>) => string)(params) : type;
}
