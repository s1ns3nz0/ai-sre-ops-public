// PrometheusRule files from lineth-observability: parse, edit one alert (keeping the rest of the file intact),
// and pull metric names out of PromQL for the metric inventory. Pure: no I/O.
import { isMap, isSeq, parseDocument, type YAMLMap, type YAMLSeq } from 'yaml';

export type AlertRule = {
  alert: string; expr: string; for?: string;
  labels: Record<string, string>; annotations: Record<string, string>;
};
export type RecordRule = { record: string; expr: string; labels: Record<string, string> };
export type RuleFile = {
  path: string; generated: boolean;
  groups: { name: string; alerts: AlertRule[]; records: RecordRule[] }[];
};

const strMap = (v: unknown) => Object.fromEntries(Object.entries((v ?? {}) as Record<string, unknown>).map(([k, x]) => [k, String(x)]));

export function parseRuleFile(path: string, text: string): RuleFile {
  const doc = parseDocument(text).toJS() as { spec?: { groups?: { name: string; rules?: Record<string, unknown>[] }[] } };
  return {
    path,
    generated: /^#\s*GENERATED/m.test(text.slice(0, 300)),
    groups: (doc.spec?.groups ?? []).map((g) => ({
      name: g.name,
      alerts: (g.rules ?? []).filter((r) => 'alert' in r).map((r) => ({
        alert: String(r.alert), expr: String(r.expr).trim(), for: r.for ? String(r.for) : undefined,
        labels: strMap(r.labels), annotations: strMap(r.annotations),
      })),
      records: (g.rules ?? []).filter((r) => 'record' in r).map((r) => ({ record: String(r.record), expr: String(r.expr).trim(), labels: strMap(r.labels) })),
    })),
  };
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DURATION = /^\d+(ms|s|m|h|d|w|y)$/;
const SEVERITIES = ['critical', 'warning', 'info'];

// Trust boundary for the edit form: everything here ends up in a PR on the detection repo.
export function validateAlert(r: AlertRule): string[] {
  const errs: string[] = [];
  if (!NAME.test(r.alert)) errs.push('Name must be letters, digits and underscores, starting with a letter.');
  if (!r.expr.trim()) errs.push('Expression is required.');
  if (r.expr.length > 4000) errs.push('Expression is too long.');
  if (r.for && !DURATION.test(r.for)) errs.push('"For" must be a duration such as 5m or 1h.');
  if (!SEVERITIES.includes(r.labels.severity)) errs.push(`Severity must be one of ${SEVERITIES.join(', ')}.`);
  if (!r.annotations.summary?.trim()) errs.push('Summary is required.');
  for (const [k, v] of Object.entries({ ...r.labels, ...r.annotations })) {
    if (!NAME.test(k)) errs.push(`Invalid key "${k}".`);
    if (v.length > 2000) errs.push(`"${k}" is too long.`);
  }
  return errs;
}

function rulesSeq(doc: ReturnType<typeof parseDocument>, group: string): YAMLSeq {
  const groups = doc.getIn(['spec', 'groups']);
  if (!isSeq(groups)) throw new Error('file has no spec.groups');
  const g = groups.items.find((x) => isMap(x) && x.get('name') === group) as YAMLMap | undefined;
  if (!g) throw new Error(`group ${group} not found`);
  const rules = g.get('rules');
  if (!isSeq(rules)) throw new Error(`group ${group} has no rules`);
  return rules;
}

const indexOf = (rules: YAMLSeq, name: string) => rules.items.findIndex((x) => isMap(x) && x.get('alert') === name);

function plainRule(r: AlertRule) {
  const plain: Record<string, unknown> = { alert: r.alert, expr: r.expr };
  if (r.for) plain.for = r.for;
  plain.labels = r.labels;
  const ann = Object.fromEntries(Object.entries(r.annotations).filter(([, v]) => v.trim()));
  if (Object.keys(ann).length) plain.annotations = ann;
  return plain;
}

// The new rule takes on the look of its neighbours (one-line labels, blank line before) so a PR diff shows
// only the rule that changed.
function toNode(doc: ReturnType<typeof parseDocument>, r: AlertRule, like: YAMLMap | undefined) {
  const node = doc.createNode(plainRule(r)) as YAMLMap;
  if (like) {
    node.spaceBefore = like.spaceBefore;
    for (const key of ['labels', 'annotations']) {
      const was = like.get(key, true) as YAMLMap | undefined;
      const now = node.get(key, true) as YAMLMap | undefined;
      if (was && now && isMap(was) && isMap(now)) now.flow = was.flow;
    }
  }
  return node;
}

const OUT = { lineWidth: 0, flowCollectionPadding: false } as const;
const isJson = (text: string) => text.trimStart().startsWith('{');

type JsonRules = { spec: { groups: { name: string; rules: Record<string, unknown>[] }[] } };
function jsonRules(text: string, group: string) {
  const doc = JSON.parse(text) as JsonRules;
  const g = doc.spec?.groups?.find((x) => x.name === group);
  if (!g) throw new Error(`group ${group} not found`);
  return { doc, rules: g.rules };
}
const jsonOut = (doc: unknown) => `${JSON.stringify(doc, null, 2)}\n`;

// Replace `original` (or append when null) in `group`. Comments and the other rules stay as they are.
export function upsertAlert(text: string, group: string, original: string | null, r: AlertRule): string {
  const clashMsg = `An alert named ${r.alert} already exists in ${group}.`;
  const missingMsg = `${original} not found in ${group}; the file changed since you opened it.`;
  if (isJson(text)) {
    const { doc, rules } = jsonRules(text, group);
    if (rules.some((x) => x.alert === r.alert) && r.alert !== original) throw new Error(clashMsg);
    if (original === null) rules.push(plainRule(r));
    else {
      const i = rules.findIndex((x) => x.alert === original);
      if (i < 0) throw new Error(missingMsg);
      rules[i] = plainRule(r);
    }
    return jsonOut(doc);
  }
  const doc = parseDocument(text);
  const rules = rulesSeq(doc, group);
  if (indexOf(rules, r.alert) >= 0 && r.alert !== original) throw new Error(clashMsg);
  if (original === null) rules.items.push(toNode(doc, r, rules.items.at(-1) as YAMLMap | undefined));
  else {
    const i = indexOf(rules, original);
    if (i < 0) throw new Error(missingMsg);
    rules.items[i] = toNode(doc, r, rules.items[i] as YAMLMap);
  }
  return doc.toString(OUT);
}

export function deleteAlert(text: string, group: string, name: string): string {
  if (isJson(text)) {
    const { doc, rules } = jsonRules(text, group);
    const i = rules.findIndex((x) => x.alert === name);
    if (i < 0) throw new Error(`${name} not found in ${group}.`);
    rules.splice(i, 1);
    return jsonOut(doc);
  }
  const doc = parseDocument(text);
  const rules = rulesSeq(doc, group);
  const i = indexOf(rules, name);
  if (i < 0) throw new Error(`${name} not found in ${group}.`);
  rules.items.splice(i, 1);
  return doc.toString(OUT);
}

const KEYWORDS = new Set(['and', 'or', 'unless', 'by', 'without', 'on', 'ignoring', 'group_left', 'group_right', 'bool', 'offset', 'inf', 'nan']);

// Metric names referenced by a PromQL expression. Approximate on purpose: drops strings, label matchers,
// grouping lists, ranges and function names, then keeps the remaining identifiers.
export function metricsIn(expr: string): string[] {
  const s = expr
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`/g, ' ')
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/\b(by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/(?<![\w:])\d[\w.]*/g, ' '); // numbers and durations (offset 10m, 1e3, 0.9)
  const out = new Set<string>();
  for (const m of s.matchAll(/[A-Za-z_:][A-Za-z0-9_:]*(?=\s*(\()?)/g)) {
    if (m[1] || KEYWORDS.has(m[0].toLowerCase()) || /^\d/.test(m[0])) continue;
    out.add(m[0]);
  }
  return [...out];
}

export type Source = 'custom exporter' | 'custom record' | 'upstream';
export const SERVICE_PREFIXES: [RegExp, string, Source][] = [
  [/^lineth_l2_/, 'lineth exporter', 'custom exporter'],
  [/^lineth_/, 'lineth workflows', 'custom exporter'],
  [/^slo:/, 'SLO rules', 'custom record'],
  [/^[a-z_]+:/, 'recording rules', 'custom record'],
  [/^lab_/, 'lab exporters', 'custom exporter'],
  [/^linea_/, 'linea coordinator / postman', 'upstream'],
  [/^shomei_/, 'shomei', 'upstream'],
  [/^(signing|eth2|web3signer)_/, 'web3signer', 'upstream'],
  [/^(besu|ethereum|txpool|rpc)_/, 'besu', 'upstream'],
  [/^(teku|beacon|validator|libp2p|discovery)_/, 'teku', 'upstream'],
  [/^maru_/, 'maru', 'upstream'],
  [/^(jvm|process|executors|vertx)_/, 'JVM runtime', 'upstream'],
  [/^(traces_|tempo_)/, 'tempo', 'upstream'],
  [/^(kube|kubelet)_/, 'kube-state-metrics', 'upstream'],
  [/^container_/, 'cAdvisor', 'upstream'],
  [/^node_/, 'node exporter', 'upstream'],
  [/^grafana_/, 'grafana', 'upstream'],
  [/^pg_/, 'postgres exporter', 'upstream'],
  [/^(prometheus|promhttp|scrape|up$|net_conntrack|prometheus_sd)/, 'prometheus', 'upstream'],
  [/^alertmanager_/, 'alertmanager', 'upstream'],
  [/^(apiserver|etcd|authentication|authorization|apiextensions|aggregator|admission|serviceaccount|watch_cache|kubernetes_|registered_metrics|rest_client|workqueue|dra_|field_validation)/, 'kubernetes control plane', 'upstream'],
  [/^coredns_/, 'coredns', 'upstream'],
  [/^(loki|promtail)_/, 'loki', 'upstream'],
  [/^(alloy|otelcol|remotecfg)_/, 'alloy / otel collector', 'upstream'],
  [/^(tetragon|kyverno)_/, 'security agents', 'upstream'],
  [/^(gotk|controller_runtime|flux)_/, 'flux', 'upstream'],
  [/^go_/, 'Go runtime', 'upstream'],
  [/^http_/, 'http (various)', 'upstream'],
];

export function classify(metric: string): { service: string; source: Source } {
  const hit = SERVICE_PREFIXES.find(([re]) => re.test(metric));
  return hit ? { service: hit[1], source: hit[2] } : { service: 'other', source: 'upstream' };
}
