import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { componentsOf, incidentComponents, oneLinePerDeploy, parseFluxEvent, verifySignature } from './changes.ts';
import { parseChg } from './chg.ts';
import { topology } from './topology.ts';

const event = {
  involvedObject: { kind: 'Kustomization', namespace: 'flux-system', name: 'lineth-l2-proving' },
  severity: 'info', timestamp: '2026-10-12T12:20:00Z', reason: 'ReconciliationSucceeded',
  message: 'Deployment/lineth-l2/prover configured', metadata: { revision: 'main@sha1:0123456789abcdef' }, reportingController: 'kustomize-controller',
};

test('Flux generic-hmac signature', () => {
  const body = JSON.stringify(event);
  const sig = `sha256=${createHmac('sha256', 's3cret').update(body).digest('hex')}`;
  assert.equal(verifySignature(body, sig, 's3cret'), true);
  assert.equal(verifySignature(body, sig, 'other'), false);
  assert.equal(verifySignature(`${body} `, sig, 's3cret'), false);
  assert.equal(verifySignature(body, null, 's3cret'), false);
  assert.equal(verifySignature(body, 'md5=00', 's3cret'), false);
});

test('Flux event validation and component mapping', () => {
  const e = parseFluxEvent(event);
  assert.equal(e.name, 'lineth-l2-proving');
  assert.equal(e.revision, 'main@sha1:0123456789abcdef');
  assert.throws(() => parseFluxEvent({ ...event, severity: 'warn' }), /severity/);
  assert.throws(() => parseFluxEvent({ ...event, timestamp: 'x' }), /timestamp/);
  assert.throws(() => parseFluxEvent({ ...event, involvedObject: { kind: 'Kustomization' } }), /name/);
  const t = topology();
  assert.deepEqual(componentsOf(t, 'lineth-l2-proving'), ['prover']);
  assert.deepEqual(componentsOf(t, 'lineth-l2-execution').sort(), ['l2-node-besu', 'maru', 'sequencer', 'shomei']);
  assert.deepEqual(componentsOf(t, 'flux-system'), []);
  // Finalization alert belongs to coordinator; coordinator calls the prover, so a prover change is a suspect too.
  const c = incidentComponents(t, ['LinethL2FinalizationStalled']);
  assert.deepEqual(c.own, ['coordinator']);
  assert.ok(c.deps.includes('prover'));
});

test('CHG frontmatter', () => {
  const text = `---\nid: CHG-2026-10-12-02\nstatus: implementing\nrisk: medium\nwindow:\n  start: 2026-10-12T12:15:00Z\n  end: 2026-10-13T12:15:00Z\ncomponents: [traffic, observability]\n---\n# CHG-2026-10-12-02 — l2-load r2\n`;
  const c = parseChg('docs/changes/x.md', text);
  assert.ok(c && !('error' in c));
  assert.equal(c.title, 'l2-load r2');
  assert.equal(c.window.end?.toISOString(), '2026-10-13T12:15:00.000Z');
  assert.equal(parseChg('x.md', '# no frontmatter'), null);
  const bad = parseChg('x.md', text.replace('implementing', 'doing'));
  assert.ok(bad && 'error' in bad && /status/.test(bad.error));
});

test('one line per deploy, with where it ended up', () => {
  const ev = (min: number, failed: boolean) => ({ what: 'flux' as const, label: 'Kustomization lineth-l2-execution main@9a8b7c6', at: new Date(Date.UTC(2026, 9, 13, 1, min)), components: ['maru'], failed });
  assert.deepEqual(oneLinePerDeploy([ev(48, false), ev(53, true)]).map((x) => [x.status, x.failed]), [['applied, then failed', true]]);
  assert.equal(oneLinePerDeploy([ev(48, true), ev(53, false)])[0].status, 'applied after a failure');
  assert.equal(oneLinePerDeploy([ev(48, false)])[0].status, 'applied');
});
