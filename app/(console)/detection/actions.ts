'use server';
import { actor } from '@/lib/actor.ts';
import { labelValues, metricDetail, metricsWithLabel, openPullRequest, preview, readRepoFile } from '@/lib/detection.ts';
import { deleteAlert, parseRuleFile, upsertAlert, validateAlert, type AlertRule } from '@/lib/rules.ts';
import { SLO_DEFINITIONS_PATH, updateSlos, validateSlo, type SloDef } from '@/lib/slo.ts';

export type FormResult = { ok: true; url: string } | { ok: false; errors: string[] } | null;

// Trust boundary: the edit-mode payload comes from the browser, so rebuild each definition from known fields only.
const s4k = (v: unknown) => (typeof v === 'string' ? v.slice(0, 4000) : '');
function toSloDef(x: unknown): SloDef {
  const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
  const span = o.span_latency as Record<string, unknown> | undefined;
  const rec = o.records && typeof o.records === 'object' ? Object.entries(o.records as Record<string, unknown>).slice(0, 20) : [];
  return {
    name: s4k(o.name).trim(), objective: Number(o.objective), kind: o.kind === 'event' ? 'event' : 'time', page: o.page === true,
    description: s4k(o.description).trim(), note: s4k(o.note).trim() || undefined,
    sli: o.sli === undefined ? undefined : s4k(o.sli).trim(), good: o.good === undefined ? undefined : s4k(o.good).trim(),
    valid: o.valid === undefined ? undefined : s4k(o.valid).trim(),
    span_latency: span ? { workflow: s4k(span.workflow).trim(), le: s4k(String(span.le ?? '')).trim() } : undefined,
    records: rec.length ? Object.fromEntries(rec.map(([k, v]) => [k.slice(0, 100), s4k(v).trim()])) : undefined,
  };
}
const safePath = (p: string) => /^alerts\/[\w.-]+\.yaml$/.test(p); // hand-written rule files only

// Read-only: one metric's metadata, series count and label values for the inventory row.
export async function metricDetailAction(name: string) {
  try {
    return await metricDetail(String(name).slice(0, 300));
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export async function labelValuesAction(label: string) {
  return labelValues(String(label).slice(0, 200)).catch(() => [] as string[]);
}

export async function metricsWithLabelAction(label: string, value: string) {
  return metricsWithLabel(String(label).slice(0, 200), String(value).slice(0, 500)).catch(() => [] as string[]);
}

export async function previewAction(expr: string) {
  if (!expr.trim() || expr.length > 4000) return { error: 'Enter an expression (up to 4000 characters).' };
  return preview(expr);
}

// Every alert rule changed in edit mode (added, edited, renamed, removed; possibly across files) goes into one PR.
// Trust boundary: rebuild each rule from known fields; labels other than severity come from the file, not the browser.
export async function saveAlertsAction(raw: unknown): Promise<FormResult> {
  if (!Array.isArray(raw) || !raw.length || raw.length > 100) return { ok: false, errors: ['Nothing to save.'] };
  const changes = raw.map((x: unknown) => {
    const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    const r = o.rule && typeof o.rule === 'object' ? o.rule as Record<string, unknown> : null;
    const v = (k: string, max: number) => (r && typeof r[k] === 'string' ? (r[k] as string).slice(0, max).trim() : '');
    return {
      path: s4k(o.path).slice(0, 200), group: s4k(o.group).slice(0, 200), original: s4k(o.original).slice(0, 200) || null,
      rule: r ? {
        alert: v('alert', 200), expr: v('expr', 4000), for: v('for', 20) || undefined, labels: { severity: v('severity', 20) },
        annotations: { summary: v('summary', 500), description: v('description', 2000), runbook_url: v('runbook_url', 500), dashboard_url: v('dashboard_url', 500) },
      } satisfies AlertRule : null,
    };
  });
  if (changes.some((c) => !safePath(c.path) || !c.group || (!c.rule && !c.original))) {
    return { ok: false, errors: ['Only hand-written files under alerts/ can be edited here.'] };
  }
  const errors = changes.flatMap((c) => (c.rule ? validateAlert(c.rule).map((e) => `${c.rule!.alert || c.original || 'new rule'}: ${e}`) : []));
  if (errors.length) return { ok: false, errors };
  try {
    const files = [];
    for (const path of [...new Set(changes.map((c) => c.path))]) {
      const { text, sha } = await readRepoFile(path);
      if (!sha) return { ok: false, errors: ['Read-only mode: set DETECTION_GITHUB_TOKEN to open pull requests.'] };
      const parsed = parseRuleFile(path, text);
      let next = text;
      for (const c of changes.filter((x) => x.path === path)) {
        const g = parsed.groups.find((x) => x.name === c.group);
        if (!g) return { ok: false, errors: [`Group ${c.group} no longer exists in ${path}.`] };
        if (!c.rule) { next = deleteAlert(next, c.group, c.original!); continue; }
        // Keep the labels the rule (or its group) already carries; the editor only sets severity.
        const base = (c.original ? g.alerts.find((a) => a.alert === c.original)?.labels : g.alerts[0]?.labels) ?? {};
        next = upsertAlert(next, c.group, c.original, { ...c.rule, labels: { ...base, severity: c.rule.labels.severity } });
      }
      files.push({ path, text: next, baseSha: sha });
    }
    const line = (c: (typeof changes)[number]) => !c.rule ? `- remove \`${c.original}\``
      : !c.original ? `- add \`${c.rule.alert}\``
      : c.original !== c.rule.alert ? `- rename \`${c.original}\` to \`${c.rule.alert}\`` : `- update \`${c.rule.alert}\``;
    const one = changes.length === 1 ? (changes[0].rule?.alert ?? changes[0].original!) : null;
    const url = await openPullRequest({
      files, slug: one ? `alert-${one}` : `alerts-${changes.length}`,
      title: one ? `detection: ${line(changes[0]).slice(2).split(' ')[0]} ${one}` : `detection: change ${changes.length} alert rules`,
      body: `${changes.map((c) => `${line(c)} (${c.path}, group ${c.group})`).join('\n')}\n\nOpened from AI SRE Ops by ${await actor()}.`,
    });
    return { ok: true, url };
  } catch (e) {
    return { ok: false, errors: [(e as Error).message] };
  }
}

// Edit one SLO definition; the repo's CI regenerates the PrometheusRule into the same PR.
// Every SLO changed in edit mode goes into one pull request on slos/definitions.json.
export async function saveSlosAction(raw: unknown): Promise<FormResult> {
  if (!Array.isArray(raw) || !raw.length || raw.length > 50) return { ok: false, errors: ['Nothing to save.'] };
  const changes = raw.map((c: { original?: unknown; next?: unknown }) => ({ original: s4k(c?.original).slice(0, 100), next: toSloDef(c?.next) }));
  const errors = changes.flatMap((c) => validateSlo(c.next).map((e) => `${c.next.name || c.original}: ${e}`));
  if (errors.length) return { ok: false, errors };
  try {
    const { text, sha } = await readRepoFile(SLO_DEFINITIONS_PATH);
    if (!sha) return { ok: false, errors: ['Read-only mode: set DETECTION_GITHUB_TOKEN to open pull requests.'] };
    const names = changes.map((c) => c.original);
    const url = await openPullRequest({
      files: [{ path: SLO_DEFINITIONS_PATH, text: updateSlos(text, changes), baseSha: sha }],
      slug: `slo-${names.length === 1 ? names[0] : `${names.length}-slos`}`,
      title: `slos: update ${names.length === 1 ? names[0] : `${names.length} SLOs`}`,
      body: `Updates these SLO definitions:\n${changes.map((c) => `- \`${c.original}\`${c.original !== c.next.name ? ` (renamed to \`${c.next.name}\`)` : ''}${c.next.records ? ` with ${Object.keys(c.next.records).length} recording rule override(s)` : ''}`).join('\n')}\n\nThe SLO rules workflow regenerates \`slos/lineth-l2-slos.yaml\` into this PR.\n\nOpened from AI SRE Ops by ${await actor()}.`,
    });
    return { ok: true, url };
  } catch (e) {
    return { ok: false, errors: [(e as Error).message] };
  }
}
