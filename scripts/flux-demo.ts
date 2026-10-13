// Sends signed Flux notification events to the running app (/api/flux), as a Provider of type generic-hmac would.
// Demo data for F12: a deploy shortly before two replayed incidents and one failed reconcile. Usage: node scripts/flux-demo.ts
import { createHmac } from 'node:crypto';
import { pool } from '../lib/db.ts';

const app = process.env.APP_URL ?? 'http://localhost:3000';
const secret = process.env.FLUX_WEBHOOK_SECRET;
if (!secret) throw new Error('set FLUX_WEBHOOK_SECRET');
const db = pool();
const detected = async (alertname: string) => {
  const r = await db.query<{ detected_at: Date }>(
    'SELECT i.detected_at FROM alerts a JOIN incidents i ON i.id = a.incident_id WHERE a.alertname = $1 ORDER BY a.starts_at LIMIT 1', [alertname]);
  if (!r.rows[0]) throw new Error(`run "npm run replay" and "npm run demo" first (missing: ${alertname})`);
  return r.rows[0].detected_at.getTime();
};
const min = 60_000;

async function send(name: string, at: number, severity: 'info' | 'error', message: string, sha: string) {
  const body = JSON.stringify({
    involvedObject: { kind: 'Kustomization', namespace: 'flux-system', name, apiVersion: 'kustomize.toolkit.fluxcd.io/v1' },
    severity, timestamp: new Date(at).toISOString(), reason: severity === 'info' ? 'ReconciliationSucceeded' : 'ReconciliationFailed',
    message, metadata: { revision: `main@sha1:${sha}` }, reportingController: 'kustomize-controller', reportingInstance: 'kustomize-controller-0',
  });
  const res = await fetch(`${app}/api/flux`, { method: 'POST', body, headers: {
    'content-type': 'application/json', 'x-signature': `sha256=${createHmac('sha256', secret!).update(body).digest('hex')}` } });
  console.log(name, res.status, await res.text());
}

const fin = await detected('LinethL2FinalizationStalled');
await send('lineth-l2-proving', fin - 40 * min, 'info', 'Deployment/lineth-l2/prover configured', '3f9c2a1d8e7b6a5c4d3e2f1a0b9c8d7e6f5a4b3c');
const heap = await detected('LinethL2MaruHeapNearlyFull');
await send('lineth-l2-execution', heap - 25 * min, 'info', 'StatefulSet/lineth-l2/maru configured', '9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b');
await send('lineth-l2-execution', heap - 20 * min, 'error', 'StatefulSet/lineth-l2/maru dry-run failed: spec.template.spec.securityContext.runAsUser: Invalid value', '9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b');
await db.end();
