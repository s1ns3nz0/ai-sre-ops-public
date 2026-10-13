import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redact, redactCapped } from './redact.ts';

test('redact: keys, credentials and private material go; ordinary operations text stays', () => {
  const cases: [string, RegExp][] = [
    ['-----BEGIN EC PRIVATE KEY-----\nMHcCAQEE\n-----END EC PRIVATE KEY-----', /^\[REDACTED private key\]$/],
    ['postgres://sreops:hunter2@db:5432/x', /postgres:\/\/\[REDACTED\]@db/],
    ['Authorization: Bearer abcdefghijklmnopqrstuvwxyz', /Bearer \[REDACTED\]/],
    ['DB_PASSWORD=s3cr3tvalue other=1', /DB_PASSWORD=\[REDACTED\] other=1/],
    ['"api_key": "abcd1234efgh"', /"api_key": "\[REDACTED\]"/],
    ['key sk-or-v1-0123456789abcdef0123456789', /key \[REDACTED token\]/],
    ['ghp_0123456789abcdefABCDEF0123', /\[REDACTED token\]/],
    ['signer 0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318', /signer \[REDACTED 32-byte hex\]/],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', /\[REDACTED jwt\]/],
  ];
  for (const [input, want] of cases) assert.match(redact(input), want, input);
  for (const keep of [
    'prover restartCount 48, lastState OOMKilled; batch 14832-14944 proved',
    'level=info msg="Execution engine not called in 120 seconds" block=20102',
    'from 0x8f3a2c1d to 0x9b2e (address, not a key)',
  ]) assert.equal(redact(keep), keep);
});

test('redactCapped: long output is cut and says so', () => {
  const out = redactCapped('x'.repeat(50), 20);
  assert.match(out, /^x{20}\n… \[30 more characters cut\]$/);
});
