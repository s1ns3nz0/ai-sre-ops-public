import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAction } from './actions.ts';

test('action catalog: typed params become the exact command; anything outside the catalog is refused', () => {
  assert.equal(checkAction('restart_pod', { namespace: 'lineth-l2', pod: 'maru-0' }).command, 'kubectl -n lineth-l2 delete pod maru-0');
  assert.equal(checkAction('flux_reconcile', { kind: 'Kustomization', name: 'lineth-l2-execution' }).command, 'flux reconcile kustomization lineth-l2-execution -n flux-system');
  assert.throws(() => checkAction('restart_pod', { namespace: 'vault', pod: 'vault-0' }));
  assert.throws(() => checkAction('restart_pod', { namespace: 'lineth-l2', pod: 'maru-0; rm -rf /' }));
  assert.throws(() => checkAction('flux_reconcile', { kind: 'GitRepository', name: 'flux-system' }));
});
