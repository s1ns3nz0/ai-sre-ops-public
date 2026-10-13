// Alert grouping and priority (PRD F8). Pure: topology + facts in, decisions out, so the rules are unit-testable.
//  - component: which topology node an alert is about (labels → SLO → the node's alerts list)
//  - join:      an alert joins the open incident that has an alert still firing on the same or a directly linked
//               component; several → the one whose latest alert started most recently; none → new candidate
//  - cause:     the member the others depend on (depends on no other member); ties → earliest firing
//  - score:     points with reasons; candidates with a firing critical alert are pinned above any score
import { ownerOf } from './prom.ts';
import type { Topology } from './topology.ts';

export function componentOf(t: Topology, labels: Record<string, string>): string | null {
  // ① Labels that name a workload: pod (owner by name shape), deployment/statefulset/service, job ("l2-maru"),
  //   instance host ("maru.lineth-l2.svc.cluster.local:9090").
  const host = /^([a-z0-9-]+)\.([a-z0-9-]+)\.svc/.exec(labels.instance ?? '');
  const ns = labels.namespace ?? host?.[2];
  const names = [labels.deployment, labels.statefulset, labels.service, host?.[1], labels.job?.replace(/^l[12]-/, '')].filter(Boolean) as string[];
  for (const n of t.nodes) {
    for (const w of n.workloads) {
      if (ns && w.ns !== ns) continue;
      if (names.includes(w.name)) return n.id;
      if (labels.pod && ownerOf(w.ns, labels.pod, [w])) return n.id;
    }
  }
  // ② An SLO burn alert is about the component that owns the SLO.
  if (labels.slo) {
    const n = t.nodes.find((x) => x.slos?.includes(labels.slo));
    if (n) return n.id;
  }
  // ③ The node's own alert list.
  return t.nodes.find((n) => n.alerts?.includes(labels.alertname))?.id ?? null;
}

export const adjacent = (t: Topology, a: string, b: string) =>
  a === b || t.edges.some((e) => (e.from === a && e.to === b) || (e.from === b && e.to === a));

export type OpenGroup = { id: string; firing: string[]; lastStart: Date };

export function pickGroup(t: Topology, comp: string, open: OpenGroup[]): string | null {
  const hits = open.filter((g) => g.firing.some((f) => adjacent(t, comp, f)));
  if (!hits.length) return null;
  return hits.reduce((a, b) => (b.lastStart > a.lastStart ? b : a)).id;
}

// a depends on b. Callers depend on what they call; an engine link is the other way round (consensus drives execution).
export function dependsOn(t: Topology, a: string, b: string): boolean {
  return t.edges.some((e) => (e.via === 'engine' ? e.to === a && e.from === b : e.from === a && e.to === b));
}

export function probableCause(t: Topology, members: { comp: string; firstAt: Date }[]): string | null {
  const comps = [...new Set(members.map((m) => m.comp))];
  if (!comps.length) return null;
  const first = (c: string) => Math.min(...members.filter((m) => m.comp === c).map((m) => m.firstAt.getTime()));
  const sinks = comps.filter((c) => !comps.some((o) => o !== c && dependsOn(t, c, o)));
  return (sinks.length ? sinks : comps).sort((a, b) => first(a) - first(b))[0];
}

// Components outside the group that depend on it, directly or not: what else is likely affected.
export function downstream(t: Topology, comps: string[]): string[] {
  const seen = new Set(comps);
  const out: string[] = [];
  for (let changed = true; changed;) {
    changed = false;
    for (const n of t.nodes) {
      if (seen.has(n.id)) continue;
      if ([...seen].some((s) => dependsOn(t, n.id, s))) { seen.add(n.id); out.push(n.id); changed = true; }
    }
  }
  return out;
}

export type ScorePart = { label: string; points: number; why: string };
export type Score = { total: number; pinned: boolean; parts: ScorePart[] };

export function score(t: Topology, g: {
  comps: string[]; slos: string[]; budgets: Map<string, number>; critical: boolean;
  openSince: Date; lastJoin: Date; now: Date;
}): Score {
  const w = (slo: string) => t.slo_weights?.[slo] ?? 1;
  const slo = g.slos.reduce((sum, s) => {
    const left = g.budgets.get(s);
    return left === undefined ? sum : sum + w(s) * Math.min(2, Math.max(0, 1 - left)) * 20;
  }, 0);
  const down = downstream(t, g.comps);
  const age = Math.min(20, Math.floor((g.now.getTime() - g.openSince.getTime()) / 600_000));
  const trend = g.now.getTime() - g.lastJoin.getTime() < 15 * 60_000 ? 10 : 0;
  const parts: ScorePart[] = [
    { label: 'SLO', points: Math.round(slo), why: g.slos.length ? g.slos.map((s) => `${s} ×${w(s)}, ${g.budgets.has(s) ? `${Math.round((g.budgets.get(s) ?? 0) * 100)}% budget left` : 'budget unknown'}`).join('; ') : 'no SLO involved' },
    { label: 'Impact', points: 5 * down.length, why: down.length ? `depends on it: ${down.join(', ')}` : 'nothing depends on it' },
    { label: 'Age', points: age, why: `1 per 10 min open, max 20` },
    { label: 'Trend', points: trend, why: trend ? 'a new alert joined in the last 15 min' : 'no new alert in 15 min' },
  ];
  return { total: parts.reduce((s, p) => s + p.points, 0), pinned: g.critical, parts };
}
