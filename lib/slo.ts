// SLO definitions (lineth-observability slos/definitions.json): validate and edit one entry. Pure: no I/O.
// The repo's CI regenerates the PrometheusRule from this file, so the UI only ever changes definitions.

export const SLO_DEFINITIONS_PATH = 'slos/definitions.json';

export type SloDef = {
  name: string; objective: number; kind: 'time' | 'event'; page: boolean; description: string; note?: string;
  sli?: string; good?: string; valid?: string; span_latency?: { workflow: string; le: string };
  records?: Record<string, string>; // overrides for generated recording rules, by record name
};

const WINDOWS = ['5m', '30m', '1h', '2h', '6h', '1d', '3d', '28d'];

// Recording rules the generator makes for an SLO of this kind (mirrors record_names() in gen-slo-rules.py).
export function recordNames(kind: SloDef['kind']): string[] {
  return [...(kind === 'time' ? ['slo:sli_good:bool1m'] : []), ...WINDOWS.map((w) => `slo:sli_error:ratio_rate${w}`),
    'slo:objective:ratio', 'slo:error_budget_remaining:ratio'];
}

const NAME = /^[a-z0-9][a-z0-9-]*$/;

export function parseDefinitions(text: string): SloDef[] {
  const d = JSON.parse(text);
  if (!Array.isArray(d)) throw new Error('definitions.json must be a list');
  return d as SloDef[];
}

// Mirrors load_slos() in gen-slo-rules.py, so a PR from the UI never breaks the generator.
export function validateSlo(s: SloDef): string[] {
  const errs: string[] = [];
  if (!NAME.test(s.name)) errs.push('Name must be lowercase letters, digits and dashes.');
  if (!(s.objective > 0 && s.objective < 1)) errs.push('Objective must be between 0 and 1 (e.g. 0.995).');
  if (!s.description?.trim()) errs.push('Description is required.');
  if (s.kind === 'time') {
    if (!s.sli?.trim()) errs.push('A time SLI needs a PromQL expression that is 1 for a good minute.');
  } else if (s.kind === 'event') {
    const span = s.span_latency;
    if (span) {
      if (!/^[a-z0-9-]+$/.test(span.workflow)) errs.push('Workflow must be lowercase letters, digits and dashes.');
      if (!/^\d+(\.\d+)?$/.test(span.le)) errs.push('Latency threshold must be a number of seconds.');
    } else {
      if (!s.good?.includes('[W]') || !s.valid?.includes('[W]')) errs.push('Good and valid expressions need the [W] window placeholder.');
    }
  } else errs.push('Kind must be time or event.');
  for (const v of [s.sli, s.good, s.valid, s.description, s.note]) if (v && v.length > 4000) errs.push('A field is too long.');
  const allowed = new Set(recordNames(s.kind));
  for (const [r, x] of Object.entries(s.records ?? {})) {
    if (!allowed.has(r)) errs.push(`${r} is not a recording rule of a ${s.kind} SLO.`);
    else if (typeof x !== 'string' || !x.trim()) errs.push(`${r}: the expression is empty (use Reset to go back to the generated one).`);
    else if (x.length > 4000) errs.push(`${r}: the expression is too long.`);
  }
  return errs;
}

// Keep only the fields that belong to the kind, in the file's key order.
export function clean(s: SloDef): SloDef {
  const out: SloDef = { name: s.name, objective: s.objective, kind: s.kind } as SloDef;
  if (s.kind === 'time') out.sli = s.sli;
  else if (s.span_latency) out.span_latency = s.span_latency;
  else { out.good = s.good; out.valid = s.valid; }
  out.page = s.page;
  out.description = s.description;
  if (s.note?.trim()) out.note = s.note;
  // Overrides that no longer apply to the kind are dropped, like the other kind's SLI fields.
  const allowed = new Set(recordNames(s.kind));
  const records = Object.fromEntries(Object.entries(s.records ?? {}).filter(([r]) => allowed.has(r)));
  if (Object.keys(records).length) out.records = records;
  return out;
}

// Several edits in one go (one pull request). Each is checked against the file as already changed by the earlier ones.
export function updateSlos(text: string, changes: { original: string; next: SloDef }[]): string {
  return changes.reduce((t, c) => updateSlo(t, c.original, c.next), text);
}

export function updateSlo(text: string, original: string, next: SloDef): string {
  const defs = parseDefinitions(text);
  const i = defs.findIndex((d) => d.name === original);
  if (i < 0) throw new Error(`${original} not found; the file changed since you opened it.`);
  if (next.name !== original && defs.some((d) => d.name === next.name)) throw new Error(`An SLO named ${next.name} already exists.`);
  defs[i] = clean(next);
  return `${JSON.stringify(defs, null, 2)}\n`;
}

// The SLI as a query to preview: time SLIs as-is, event SLIs as the good-event rate over 5m.
export function previewExpr(s: SloDef): string | null {
  if (s.kind === 'time') return s.sli?.trim() || null;
  if (s.span_latency) return null;
  return s.good ? s.good.replaceAll('[W]', '[5m]') : null;
}
