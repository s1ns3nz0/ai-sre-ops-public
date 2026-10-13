// executor: runs an approved action from the catalog (lib/actions.ts) and reports what changed (P2). Called only
// by the console after the IC clicks Run (EXECUTOR_TOKEN); agents have no route or credentials to it. Its
// ServiceAccount can delete pods in the lab namespaces and annotate Flux objects, nothing else.
// Env: EXECUTOR_TOKEN, K8S_API (default: in-cluster), PORT (8090).
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { checkAction, type ActionType } from '../lib/actions.ts';
import { bearerOk } from '../lib/bearer.ts';

const SA = '/var/run/secrets/kubernetes.io/serviceaccount';
const K8S = process.env.K8S_API ?? (process.env.KUBERNETES_SERVICE_HOST ? `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT}` : 'http://127.0.0.1:8001');
const auth = (): Record<string, string> => { try { return { authorization: `Bearer ${readFileSync(`${SA}/token`, 'utf8')}` }; } catch { return {}; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function k8s(method: string, path: string, body?: unknown, type = 'application/json') {
  const res = await fetch(`${K8S}${path}`, { method, headers: { ...auth(), ...(body ? { 'content-type': type } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

type Pod = { metadata: { uid: string }; status?: { phase?: string; startTime?: string; containerStatuses?: { name: string; ready: boolean; restartCount: number }[] } };
const podState = (p: Pod) => ({ uid: p.metadata.uid, phase: p.status?.phase, started: p.status?.startTime, ready: (p.status?.containerStatuses ?? []).every((c) => c.ready), restarts: (p.status?.containerStatuses ?? []).reduce((n, c) => n + c.restartCount, 0) });

const RUN: Record<ActionType, (p: Record<string, string>, log: string[]) => Promise<{ before: unknown; after: unknown }>> = {
  // Delete the pod; its controller recreates it. Waits up to 3 min for the new pod to be Ready.
  async restart_pod(p, log) {
    const path = `/api/v1/namespaces/${p.namespace}/pods/${p.pod}`;
    const before = podState(await k8s('GET', path));
    await k8s('DELETE', path);
    log.push(`deleted pod ${p.namespace}/${p.pod}`);
    for (let i = 0; i < 90; i++) {
      await sleep(2000);
      const now = await k8s('GET', path).catch(() => null) as Pod | null;
      if (now && now.metadata.uid !== before.uid && podState(now).ready) { log.push(`new pod ready after ${(i + 1) * 2}s`); return { before, after: podState(now) }; }
    }
    const now = await k8s('GET', path).catch(() => null) as Pod | null;
    log.push('new pod not ready after 180s');
    return { before, after: now ? podState(now) : 'missing' };
  },
  // Ask Flux to reconcile now (what `flux reconcile` does) and wait up to 3 min for it to be handled.
  async flux_reconcile(p, log) {
    const api = p.kind === 'Kustomization' ? '/apis/kustomize.toolkit.fluxcd.io/v1' : '/apis/helm.toolkit.fluxcd.io/v2';
    const path = `${api}/namespaces/${p.namespace}/${p.kind.toLowerCase()}s/${p.name}`;
    const ready = (o: any) => { const r = o.status?.conditions?.find((c: any) => c.type === 'Ready'); return { ready: r?.status, message: r?.message?.slice(0, 200), revision: o.status?.lastAppliedRevision }; };
    const before = ready(await k8s('GET', path));
    const at = new Date().toISOString();
    await k8s('PATCH', path, { metadata: { annotations: { 'reconcile.fluxcd.io/requestedAt': at } } }, 'application/merge-patch+json');
    log.push(`requested reconcile at ${at}`);
    for (let i = 0; i < 90; i++) {
      await sleep(2000);
      const o = await k8s('GET', path);
      if (o.status?.lastHandledReconcileAt === at) { log.push(`handled after ${(i + 1) * 2}s`); return { before, after: ready(o) }; }
    }
    log.push('not handled after 180s');
    return { before, after: ready(await k8s('GET', path)) };
  },
};

if (import.meta.url === `file://${process.argv[1]}`) {
  createServer(async (req, res) => {
    const send = (code: number, x: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(x)); };
    if (req.url === '/healthz') { res.end('ok'); return; }
    if (req.method !== 'POST' || req.url !== '/run') return send(404, { error: 'not found' });
    if (!bearerOk(req.headers.authorization ?? null, process.env.EXECUTOR_TOKEN)) return send(401, { error: 'unauthorized' });
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let a: { action_id: string; type: ActionType; params: unknown };
    let checked: ReturnType<typeof checkAction>;
    try {
      a = JSON.parse(Buffer.concat(chunks).toString());
      if (!(a.type in RUN)) throw new Error(`unknown action ${a.type}`);
      checked = checkAction(a.type, a.params); // validated again here: the executor trusts nobody's parameters
    } catch (e) { return send(400, { error: (e as Error).message.slice(0, 500) }); }
    const log: string[] = [];
    console.log(JSON.stringify({ at: new Date().toISOString(), action: a.action_id, command: checked.command }));
    try {
      const r = await RUN[a.type](checked.params, log);
      send(200, { ok: true, command: checked.command, ...r, log });
    } catch (e) {
      send(200, { ok: false, command: checked.command, error: (e as Error).message.slice(0, 500), log });
    }
  }).listen(Number(process.env.PORT ?? 8090), () => console.log(`executor on :${process.env.PORT ?? 8090}`));
}
