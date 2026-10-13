// Loads and validates topology.yaml (components, their k8s workloads, and the links between them).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

export type Via = 'rpc' | 'ws' | 'engine' | 'signing' | 'state' | 'http' | 'file';
export type WhenBroken = { when_broken?: { symptoms: string; impact: string }; logs?: string[]; precedents?: string[] };
export type WorkloadRef = { ns: string; kind: 'Deployment' | 'StatefulSet'; name: string };
export type Group = { id: string; label: string; x: number; y: number; w: number; h: number };
export type Node = {
  id: string; label: string; role: string; group: string; x: number; y: number;
  workloads: WorkloadRef[]; alerts?: string[]; dashboard?: string;
  flux: string[]; // Flux Kustomization/HelmRelease names that deploy it
  slos?: string[]; // SLOs it owns
} & WhenBroken;
export type Edge = { from: string; to: string; via: Via; port?: number; note?: string } & WhenBroken;
export type Topology = { groups: Group[]; nodes: Node[]; edges: Edge[]; slo_weights?: Record<string, number> };

const VIAS: Via[] = ['rpc', 'ws', 'engine', 'signing', 'state', 'http', 'file'];

export function validate(t: Topology): string[] {
  const errs: string[] = [];
  const groups = new Set(t.groups.map((g) => g.id));
  const nodes = new Set<string>();
  for (const n of t.nodes) {
    if (nodes.has(n.id)) errs.push(`duplicate node ${n.id}`);
    nodes.add(n.id);
    if (!groups.has(n.group)) errs.push(`node ${n.id}: unknown group ${n.group}`);
    if (!n.workloads?.length) errs.push(`node ${n.id}: no workloads`);
    if (!n.flux?.length) errs.push(`node ${n.id}: no flux owner`);
  }
  const owned = t.nodes.flatMap((n) => n.slos ?? []);
  for (const s of new Set(owned)) if (owned.filter((x) => x === s).length > 1) errs.push(`SLO ${s} owned by more than one node`);
  for (const e of t.edges) {
    if (!nodes.has(e.from)) errs.push(`edge ${e.from}→${e.to}: unknown from`);
    if (!nodes.has(e.to)) errs.push(`edge ${e.from}→${e.to}: unknown to`);
    if (!VIAS.includes(e.via)) errs.push(`edge ${e.from}→${e.to}: unknown via ${e.via}`);
  }
  return errs;
}

let cached: Topology | null = null;

export function topology(): Topology {
  if (cached && process.env.NODE_ENV === 'production') return cached;
  const t = parse(readFileSync(path.join(process.cwd(), 'topology.yaml'), 'utf8') /* bundlers rewrite import.meta.url; cwd is the app root */) as Topology;
  const errs = validate(t);
  if (errs.length) throw new Error(`topology.yaml: ${errs.join('; ')}`);
  cached = t;
  return t;
}
