// lineth-tools: the MCP server AI SRE Ops agents use (P2). Read-only: Prometheus, Loki, Kubernetes state and logs
// in the lab namespaces, Flux status, and the console's incident/runbook/catalog views. The one write is
// submit_briefing, which only records the AI's briefing for the IC; nothing here changes the cluster.
// Every result is redacted and size-capped before it goes back to the model (and on to OpenRouter).
// Env: PROMETHEUS_URL, LOKI_URL, CONSOLE_URL, AGENT_API_TOKEN, K8S_API (default: in-cluster), PORT (8084).
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { ACTION_TYPES, ACTIONS } from '../lib/actions.ts';
import { redactCapped } from '../lib/redact.ts';
import { BriefingInput } from '../lib/briefing.ts';

const env = (k: string, d?: string) => process.env[k] ?? d ?? '';
const PROM = env('PROMETHEUS_URL', 'http://monitoring-kube-prometheus-prometheus.monitoring.svc:9090');
const LOKI = env('LOKI_URL', 'http://loki.logging.svc:3100');
const CONSOLE = env('CONSOLE_URL', 'http://host.docker.internal:3000');
const SA = '/var/run/secrets/kubernetes.io/serviceaccount';
const K8S = env('K8S_API', process.env.KUBERNETES_SERVICE_HOST ? `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT}` : 'http://127.0.0.1:8001');
const k8sToken = () => { try { return readFileSync(`${SA}/token`, 'utf8'); } catch { return ''; } };

// Lab namespaces only; vault holds key material.
export const READ_NAMESPACES = ['lineth-l2', 'local-l1', 'monitoring', 'logging', 'tracing', 'flux-system'] as const;
const ns = z.enum(READ_NAMESPACES);
const name = z.string().regex(/^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/);

async function getJson(url: string, headers: Record<string, string> = {}, timeout = 10_000) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}
const k8s = (path: string) => getJson(`${K8S}${path}`, k8sToken() ? { authorization: `Bearer ${k8sToken()}` } : {});
const consoleGet = (path: string) => getJson(`${CONSOLE}${path}`, { authorization: `Bearer ${env('AGENT_API_TOKEN')}` });
const out = (x: unknown) => ({ content: [{ type: 'text' as const, text: redactCapped(typeof x === 'string' ? x : JSON.stringify(x, null, 1)) }] });
const fail = (e: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: redactCapped(`error: ${(e as Error).message}`) }] });
const age = (t?: string) => (t ? `${Math.round((Date.now() - Date.parse(t)) / 60_000)}m ago` : null);

type Obj = { metadata: { name: string; namespace?: string; creationTimestamp?: string }; spec?: any; status?: any };
const SUMMARY: Record<string, (o: Obj) => unknown> = {
  pods: (o) => ({
    name: o.metadata.name, phase: o.status?.phase, node: o.spec?.nodeName, started: age(o.status?.startTime),
    containers: (o.status?.containerStatuses ?? []).map((c: any) => ({
      name: c.name, ready: c.ready, restarts: c.restartCount, state: Object.keys(c.state ?? {})[0],
      waiting: c.state?.waiting?.reason, last_terminated: c.lastState?.terminated ? { reason: c.lastState.terminated.reason, exit: c.lastState.terminated.exitCode, at: age(c.lastState.terminated.finishedAt) } : undefined,
      limits: o.spec?.containers?.find((s: any) => s.name === c.name)?.resources?.limits,
    })),
  }),
  deployments: (o) => ({ name: o.metadata.name, desired: o.spec?.replicas, ready: o.status?.readyReplicas ?? 0, updated: o.status?.updatedReplicas ?? 0, images: o.spec?.template?.spec?.containers?.map((c: any) => c.image), conditions: o.status?.conditions?.map((c: any) => `${c.type}=${c.status} ${c.reason ?? ''}`) }),
  statefulsets: (o) => ({ name: o.metadata.name, desired: o.spec?.replicas, ready: o.status?.readyReplicas ?? 0, updated: o.status?.updatedReplicas ?? 0, images: o.spec?.template?.spec?.containers?.map((c: any) => c.image) }),
  nodes: (o) => ({ name: o.metadata.name, conditions: o.status?.conditions?.filter((c: any) => c.status !== (c.type === 'Ready' ? 'True' : 'False')).map((c: any) => `${c.type}=${c.status} ${c.message ?? ''}`), allocatable: o.status?.allocatable, capacity: o.status?.capacity }),
  services: (o) => ({ name: o.metadata.name, type: o.spec?.type, ports: o.spec?.ports?.map((p: any) => `${p.name ?? ''}:${p.port}`) }),
  persistentvolumeclaims: (o) => ({ name: o.metadata.name, phase: o.status?.phase, capacity: o.status?.capacity?.storage }),
};
const API: Record<string, string> = { pods: '/api/v1', services: '/api/v1', persistentvolumeclaims: '/api/v1', nodes: '/api/v1', deployments: '/apis/apps/v1', statefulsets: '/apis/apps/v1' };

export function buildServer() {
  const s = new McpServer({ name: 'lineth-tools', version: '0.1.0' });

  s.registerTool('prom_query', {
    description: 'Run a read-only PromQL instant query (optionally at an RFC3339 time). Returns up to 50 series with their labels and value.',
    inputSchema: { expr: z.string().min(1).max(2000), time: z.string().optional() },
  }, async ({ expr, time }) => {
    try {
      const u = `${PROM}/api/v1/query?query=${encodeURIComponent(expr)}${time ? `&time=${encodeURIComponent(time)}` : ''}`;
      const r = (await getJson(u)).data.result as { metric: Record<string, string>; value: [number, string] }[];
      return out({ series: r.length, result: r.slice(0, 50).map((x) => ({ labels: x.metric, value: x.value[1] })) });
    } catch (e) { return fail(e); }
  });

  s.registerTool('prom_range', {
    description: 'PromQL range query over the last N minutes (max 1440). Per series: min, max, first, last and ~20 evenly spaced points. Use for trends ("is it still rising?").',
    inputSchema: { expr: z.string().min(1).max(2000), minutes: z.number().int().min(5).max(1440).default(60) },
  }, async ({ expr, minutes }) => {
    try {
      const end = Date.now() / 1000, start = end - minutes * 60, step = Math.max(15, Math.round((minutes * 60) / 120));
      const r = (await getJson(`${PROM}/api/v1/query_range?query=${encodeURIComponent(expr)}&start=${start}&end=${end}&step=${step}`)).data.result as { metric: Record<string, string>; values: [number, string][] }[];
      return out({ series: r.length, result: r.slice(0, 20).map((x) => {
        const v = x.values.map((p) => Number(p[1]));
        const pts = x.values.filter((_, i) => i % Math.max(1, Math.floor(x.values.length / 20)) === 0).map((p) => [new Date(p[0] * 1000).toISOString().slice(11, 16), p[1]]);
        return { labels: x.metric, min: Math.min(...v), max: Math.max(...v), first: v[0], last: v.at(-1), points: pts };
      }) });
    } catch (e) { return fail(e); }
  });

  s.registerTool('loki_query', {
    description: 'Search logs with LogQL over the last N minutes (max 360), newest first, up to 100 lines. Lab namespaces only; vault logs are refused.',
    inputSchema: { logql: z.string().min(1).max(2000), minutes: z.number().int().min(1).max(360).default(30), limit: z.number().int().min(1).max(100).default(50) },
  }, async ({ logql, minutes, limit }) => {
    if (/vault/i.test(logql)) return fail(new Error('vault logs are not available to agents'));
    try {
      const end = Date.now() * 1e6, start = end - minutes * 60e9;
      const r = (await getJson(`${LOKI}/loki/api/v1/query_range?query=${encodeURIComponent(logql)}&start=${start}&end=${end}&limit=${limit}&direction=backward`)).data.result as { stream: Record<string, string>; values: [string, string][] }[];
      const lines = r.flatMap((x) => x.values.map(([t, l]) => [Number(BigInt(t) / 1_000_000n), `${x.stream.pod ?? x.stream.app ?? ''} ${l}`] as const))
        .sort((a, b) => b[0] - a[0]).slice(0, limit).map(([t, l]) => `${new Date(t).toISOString().slice(11, 19)} ${l.slice(0, 500)}`);
      return out(lines.length ? lines.join('\n') : 'no lines');
    } catch (e) { return fail(e); }
  });

  s.registerTool('k8s_get', {
    description: `Summaries of Kubernetes objects (status only; never Secrets, ConfigMap data or env). kind: ${Object.keys(SUMMARY).join(', ')}. Namespaces: ${READ_NAMESPACES.join(', ')} (ignored for nodes). Omit name to list.`,
    inputSchema: { kind: z.enum(Object.keys(SUMMARY) as [string, ...string[]]), namespace: ns.optional(), name: name.optional() },
  }, async ({ kind, namespace, name: n }) => {
    try {
      if (kind !== 'nodes' && !namespace) throw new Error('namespace is required');
      const base = `${API[kind]}${kind === 'nodes' ? '' : `/namespaces/${namespace}`}/${kind}`;
      const r = await k8s(n ? `${base}/${n}` : base);
      return out(n ? SUMMARY[kind](r) : (r.items as Obj[]).map(SUMMARY[kind]));
    } catch (e) { return fail(e); }
  });

  s.registerTool('k8s_events', {
    description: 'Recent Kubernetes events in a namespace (newest first, up to 40), optionally only for one object name (e.g. a pod).',
    inputSchema: { namespace: ns, object: name.optional() },
  }, async ({ namespace, object }) => {
    try {
      const sel = object ? `?fieldSelector=${encodeURIComponent(`involvedObject.name=${object}`)}` : '';
      const items = (await k8s(`/api/v1/namespaces/${namespace}/events${sel}`)).items as any[];
      return out(items.sort((a, b) => Date.parse(b.lastTimestamp ?? b.eventTime ?? 0) - Date.parse(a.lastTimestamp ?? a.eventTime ?? 0)).slice(0, 40)
        .map((e) => ({ at: age(e.lastTimestamp ?? e.eventTime), type: e.type, reason: e.reason, object: `${e.involvedObject?.kind}/${e.involvedObject?.name}`, count: e.count, message: e.message })));
    } catch (e) { return fail(e); }
  });

  s.registerTool('k8s_logs', {
    description: 'Last lines of a container log (max 200). previous=true reads the crashed previous container (after an OOMKill or restart).',
    inputSchema: { namespace: ns, pod: name, container: name.optional(), tail: z.number().int().min(1).max(200).default(80), previous: z.boolean().default(false) },
  }, async ({ namespace, pod, container, tail, previous }) => {
    try {
      const q = new URLSearchParams({ tailLines: String(tail), ...(container ? { container } : {}), ...(previous ? { previous: 'true' } : {}) });
      const res = await fetch(`${K8S}/api/v1/namespaces/${namespace}/pods/${pod}/log?${q}`, { headers: k8sToken() ? { authorization: `Bearer ${k8sToken()}` } : {}, signal: AbortSignal.timeout(10_000) });
      const text = await res.text();
      if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 300)}`);
      return out(text.split('\n').map((l) => l.slice(0, 500)).join('\n') || 'empty');
    } catch (e) { return fail(e); }
  });

  s.registerTool('flux_status', {
    description: 'Flux Kustomizations and HelmReleases: ready, suspended, last applied revision and message. Use to spot failed or suspended deploys.',
    inputSchema: {},
  }, async () => {
    try {
      const ks = (await k8s('/apis/kustomize.toolkit.fluxcd.io/v1/namespaces/flux-system/kustomizations')).items as any[];
      const hr = (await k8s('/apis/helm.toolkit.fluxcd.io/v2/helmreleases')).items as any[];
      const row = (o: any) => { const r = o.status?.conditions?.find((c: any) => c.type === 'Ready'); return { kind: o.kind, name: o.metadata.name, namespace: o.metadata.namespace, ready: r?.status, suspended: !!o.spec?.suspend, revision: o.status?.lastAppliedRevision, message: r?.message?.slice(0, 200) }; };
      return out([...ks, ...hr].map(row));
    } catch (e) { return fail(e); }
  });

  s.registerTool('incident', {
    description: 'An incident from the AI SRE Ops console: state, SEV, alerts, components, latest checkpoint, changes before/during, matched runbooks, last 40 timeline events.',
    inputSchema: { id: z.number().int().positive() },
  }, async ({ id }) => { try { return out(await consoleGet(`/api/agent/incidents/${id}`)); } catch (e) { return fail(e); } });

  s.registerTool('runbook', {
    description: 'Full runbook text (Meaning, Impact, Quick mitigation, Diagnosis, Fix, Escalation) by id, or all runbooks matching an alert name or a component.',
    inputSchema: { id: z.string().max(100).optional(), alert: z.string().max(100).optional(), component: z.string().max(100).optional() },
  }, async (q) => {
    try { return out(await consoleGet(`/api/agent/runbooks?${new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][])}`)); } catch (e) { return fail(e); }
  });

  s.registerTool('component', {
    description: 'A component from the lab catalog: role, workloads, alerts, SLOs, what breaks when it or one of its links breaks (when_broken), its stage now, precedents.',
    inputSchema: { id: z.string().max(100) },
  }, async ({ id }) => { try { return out(await consoleGet(`/api/agent/components/${encodeURIComponent(id)}`)); } catch (e) { return fail(e); } });

  s.registerTool('submit_briefing', {
    description: `Submit the briefing the IC sees first: situation, impact now, likely cause with confidence, optional SEV suggestion, and up to 8 next steps. Each step points at a runbook step ([step N] from the runbook tool) when one exists, says do_now or not_needed with a short why, and may carry a PromQL query (read-only check) or ONE catalog action (${ACTION_TYPES.map((t) => `${t} (${ACTIONS[t].label})`).join('; ')}; params: restart_pod {namespace, pod}; flux_reconcile {kind: Kustomization|HelmRelease, name, namespace}). Nothing runs: actions get an Approve & run button for the IC. A new briefing replaces the previous one. Short sentences; the IC reads it during an incident.`,
    inputSchema: BriefingInput.shape,
  }, async (p) => {
    try {
      const res = await fetch(`${CONSOLE}/api/agent/briefings`, { method: 'POST', headers: { authorization: `Bearer ${env('AGENT_API_TOKEN')}`, 'content-type': 'application/json' }, body: JSON.stringify(p), signal: AbortSignal.timeout(10_000) });
      return out(await res.json());
    } catch (e) { return fail(e); }
  });
  return s;
}

// Stateless streamable HTTP: one server per request. Each tool call is logged (name, args, size) for audit.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(env('PORT', '8084'));
  createServer(async (req, res) => {
    if (req.url === '/healthz') { res.end('ok'); return; }
    if (!req.url?.startsWith('/mcp')) { res.statusCode = 404; res.end(); return; }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    if (body?.method === 'tools/call') console.log(JSON.stringify({ at: new Date().toISOString(), tool: body.params?.name, args: body.params?.arguments }));
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }).listen(port, () => console.log(`lineth-tools on :${port}/mcp`));
}
