// Seeds the demo database (DEMO=1 mode, lib/demo.ts) with one shift's worth of incident response on the Lineth
// L2, placed relative to now. Alerts go through the real ingest path (grouping, SEV suggestion); people's actions
// through the same functions the console calls, then their timestamps are moved to the scenario's time.
// Recreates the demo database each run. Usage: DATABASE_URL=... node scripts/demo-seed.ts
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { addCheckpoint } from '../lib/checkpoints.ts';
import { recordChange } from '../lib/changes.ts';
import { demoDbUrl } from '../lib/demo.ts';
import { ack, addFollowUp, addItem, addNote, checklist, createIssue, followUps, setRole, setRunbookStep, setSev, setSummary, toggleItem, transition } from '../lib/incidents.ts';
import { ingest, parsePayload } from '../lib/ingest.ts';
import { ensureDraft, setIncidentNote, setNote } from '../lib/handoff.ts';
import { BriefingInput, checkBriefing, numberedSteps } from '../lib/briefing.ts';
import { storeBriefing } from '../lib/agent-runs.ts';
import { runbooks } from '../lib/runbooks.ts';
import { parseRunbook } from '../lib/runbooks.ts';
import { topology } from '../lib/topology.ts';

const base = process.env.DATABASE_URL;
if (!base) throw new Error('DATABASE_URL is required');
const url = demoDbUrl(base);
const name = new URL(url).pathname.slice(1);
const admin = new pg.Client({ connectionString: base });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${name}`);
await admin.end();
const db = new pg.Pool({ connectionString: url });
await db.query(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));

const A = new Date(Math.floor(Date.now() / 60_000) * 60_000); // the anchor: "now" of the scenario
const T = (min: number) => new Date(A.getTime() + min * 60_000);
const t = topology();
// timestamptz columns, to move what a step wrote to the scenario's time.
const cols = (await db.query<{ table_name: string; column_name: string }>(
  "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND data_type = 'timestamp with time zone'")).rows;

// Runs fn in one transaction and stamps everything it wrote at `min` minutes from the anchor.
async function at<R>(min: number, fn: (c: pg.PoolClient) => Promise<R>): Promise<R> {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    // What this step wrote: between the transaction's now() and the wall clock now. Times set on purpose in the
    // scenario's past or future (detected_at, next_update_at, action_eta) fall outside and stay.
    const end = (await c.query<{ e: Date }>('SELECT clock_timestamp() AS e')).rows[0].e;
    for (const x of cols) await c.query(`UPDATE ${x.table_name} SET ${x.column_name} = $1 WHERE ${x.column_name} BETWEEN now() AND $2`, [T(min), end]);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

// An Alertmanager notification for one alert, firing at `from` (and resolved at `to`, if given).
const fired: Record<string, { labels: Record<string, string>; annotations: Record<string, string>; from: number }> = {};
async function fire(min: number, alertname: string, severity: string, summary: string, extra: Record<string, string> = {}) {
  const labels = { alertname, severity, network: 'lineth-local-l2', ...extra };
  fired[alertname] = { labels, annotations: { summary }, from: min };
  await at(min, (c) => ingest(c, parsePayload({ version: '4', groupKey: `{}:{alertname="${alertname}"}`, alerts: [{
    status: 'firing', fingerprint: `demo-${alertname}`, labels, annotations: { summary }, startsAt: T(min).toISOString(), endsAt: '0001-01-01T00:00:00Z' }] }), T(min)));
}
async function resolve(min: number, alertname: string) {
  const f = fired[alertname];
  await at(min, (c) => ingest(c, parsePayload({ version: '4', groupKey: `{}:{alertname="${alertname}"}`, alerts: [{
    status: 'resolved', fingerprint: `demo-${alertname}`, labels: f.labels, annotations: f.annotations, startsAt: T(f.from).toISOString(), endsAt: T(min).toISOString() }] }), T(min)));
}
const idOf = async (alertname: string) => (await db.query<{ id: string }>('SELECT incident_id::text AS id FROM alerts WHERE alertname = $1 LIMIT 1', [alertname])).rows[0].id;
const flux = (min: number, name: string, ok: boolean, message: string, revision: string, kind = 'Kustomization') =>
  recordChange(db, { at: T(min), severity: ok ? 'info' : 'error', kind, namespace: 'flux-system', name, reason: ok ? 'ReconciliationSucceeded' : 'ReconciliationFailed', message, revision: `main@sha1:${revision}` }, t);
const tick = async (c: pg.PoolClient, id: string, runbook: string, steps: number[], who: string) => {
  const rb = parseRunbook(`runbooks/${runbook}.md`, await readFile(new URL(`../.repos/lineth-observability/runbooks/${runbook}.md`, import.meta.url), 'utf8'));
  for (const n of steps) { const s = numberedSteps(rb).find((x) => x.n === n)!; await setRunbookStep(c, id, runbook, s.key, s.text, true, who); }
};
const done = async (c: pg.PoolClient, id: string, notes: Record<string, string>, who: string) => {
  const items = await checklist(c, id);
  for (const [key, note] of Object.entries(notes)) { const i = items.find((x) => x.template_key === key); if (i) await toggleItem(c, id, i.id, who, note); }
};

// ── Earlier in the shift: web3signer lost its keys after a key rotation (SEV2, resolved, postmortem due) ──
await flux(-425, 'lineth-l2-signing', true, 'Deployment/lineth-l2/web3signer configured', '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432');
await fire(-418, 'LinethL2SignerKeysMissing', 'critical', 'L2 web3signer has fewer than 4 keys loaded');
const signer = await idOf('LinethL2SignerKeysMissing');
await at(-414, async (c) => { await setSev(c, signer, 2, 'bob'); await transition(c, signer, 'declared', 'bob'); });
await at(-413, (c) => ack(c, signer, 'bob'));
await at(-405, (c) => addNote(c, signer, 'note', { text: 'web3signer started with 2 of 4 keys: the new key files were mounted under the old Secret name.' }, 'bob'));
await at(-401, (c) => addNote(c, signer, 'decision', { decision: 'Restore the previous key Secret and restart web3signer', alternatives: 'fix the mount and keep the new keys', reason: 'fastest way back to 4 keys; the rotation can be redone in a window', revert_when: 'rotation re-planned' }, 'bob'));
await at(-398, (c) => transition(c, signer, 'mitigated', 'bob'));
await resolve(-392, 'LinethL2SignerKeysMissing');
await at(-385, async (c) => {
  await setSummary(c, signer, { status_line: 'All 4 keys loaded since 01:28; blob submission caught up', impact: 'Blob submissions to L1 paused 26 min', next_update_at: null }, 'bob');
  await transition(c, signer, 'resolved', 'bob');
  await transition(c, signer, 'postmortem', 'bob');
  await c.query('UPDATE incidents SET postmortem_id = $2 WHERE id = $1', [signer, `PM-${A.toISOString().slice(0, 10)}-16`]); // lib/demo.ts demoPostmortems
  const f = await addFollowUp(c, signer, { action: 'Validate the key count in CI before a web3signer Secret change merges', type: 'prevent', priority: 'P1', owner: 'bob' }, 'bob');
  void f;
});

// ── The main incident: prover OOM loop after a heap change; finalization lags (SEV2, mitigated, catch-up) ──
await flux(-345, 'lineth-l2-proving', true, 'Deployment/lineth-l2/prover configured', '4e1c9a27b8d6f5e4c3b2a1908f7e6d5c4b3a2918');
await fire(-302, 'LinethL2ProverFailures', 'critical', 'Prover requests failing');
await fire(-298, 'LinethL2ProverBacklog', 'warning', 'Prover requests waiting > 5 minutes');
await fire(-288, 'LinethL2FinalizationStalled', 'critical', 'No L2 finalization reached L1 for 20 minutes');
await fire(-276, 'LinethL2WorkflowStuck', 'warning', 'A finalization workflow is stuck in stage wait', { workflow: 'finalization', stage: 'wait' });
const prover = await idOf('LinethL2ProverFailures');
await at(-281, async (c) => { await setSev(c, prover, 2, 'alice'); await transition(c, prover, 'declared', 'alice'); });
await at(-279, (c) => ack(c, prover, 'alice'));
await at(-274, async (c) => {
  await setRole(c, prover, 'ops', 'bob', 'prover memory and batch requeue', 'alice');
  await setRole(c, prover, 'comms', 'carol', 'withdrawal delay notice every hour', 'alice');
  await setSummary(c, prover, { status_line: 'Prover OOM-killed on every large batch since the heap change', impact: 'Finalization on L1 stopped; withdrawals delayed', next_update_at: T(-214) }, 'alice');
});
await at(-262, (c) => addNote(c, prover, 'note', { text: 'prover restartCount 6, lastState OOMKilled at 21.9 of 24 GiB; 9 batches parked as .large' }, 'bob'));
await at(-256, (c) => addNote(c, prover, 'decision', { decision: 'Roll back the prover heap tuning (CHG-02)', alternatives: 'raise the container limit to 28 GiB (node has no headroom)', reason: 'OOMs started 45 min after -Xmx went to 23g; the 24 GiB limit leaves no off-heap room', revert_when: 'large batches prove under the old heap' }, 'alice'));
await flux(-158, 'lineth-l2-proving', false, 'Deployment/lineth-l2/prover dry-run failed: spec.template.spec.containers[0].env[2].value: Invalid value: "-Xmx20g "', 'b7d03f1e2c4a5b6978d0e1f2a3b4c5d6e7f80912');
await flux(-151, 'lineth-l2-proving', true, 'Deployment/lineth-l2/prover configured', 'b7d03f1e2c4a5b6978d0e1f2a3b4c5d6e7f80912');
await at(-247, async (c) => {
  await addCheckpoint(c, prover, {
    status_line: 'Rollback PR open; prover still OOM on large batches', hypothesis: 'heap 23g + off-heap > 24 GiB limit (high confidence)',
    action: 'merge the rollback, then requeue the 9 parked batches', action_eta: T(-170), next_step: 'Confirm the first large batch proves after the rollback',
    handoff_to: '', wake_expr: 'increase(kube_pod_container_status_restarts_total{namespace="lineth-l2",container="prover"}[15m]) > 1',
  }, 'alice');
  await tick(c, prover, 'prover-oom-loop', [1, 2], 'bob');
});
await resolve(-168, 'LinethL2ProverFailures');
await resolve(-150, 'LinethL2FinalizationStalled'); // finalization moves again: the catch-up has started
await resolve(-140, 'LinethL2ProverBacklog');
await resolve(-64, 'LinethL2WorkflowStuck');
await at(-166, (c) => transition(c, prover, 'mitigated', 'alice'));
await at(-160, (c) => addNote(c, prover, 'note', { text: 'Batch 18412-18525 proved in 11 min on the old heap; 9 parked batches requeued' }, 'bob'));
await at(-122, (c) => addNote(c, prover, 'decision', { decision: 'Suspend blockscout to give the prover memory during catch-up', alternatives: 'catch up with blockscout running (~6 h)', reason: 'frees 3.1 GiB; catch-up ~2.5 h', revert_when: 'finalized head within 100 blocks of the L2 head' }, 'alice'));
await flux(-61, 'lineth-l2-explorer', true, 'Deployment/lineth-l2/blockscout scaled to 0', 'c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0');
await at(-58, async (c) => {
  await addCheckpoint(c, prover, {
    status_line: 'Catch-up running: finalized head 840 blocks behind, closing ~6 blocks/min', hypothesis: 'cause confirmed: heap change; rolled back',
    action: 'watch the catch-up; blockscout stays suspended', action_eta: T(80), next_step: 'Resume blockscout when the finalized head is within 100 blocks',
    handoff_to: 'dave', wake_expr: 'max(changes(lineth_l2_rollup_finalized_block{l1_block_tag="latest"}[30m])) == 0',
  }, 'alice');
  await setSummary(c, prover, { status_line: 'Catch-up running: finalized head 840 blocks behind, ETA 2 h', impact: 'Withdrawals delayed ~4 h; no funds at risk', next_update_at: T(45) }, 'alice');
  await done(c, prover, {
    'ic-confirm': 'FinalizationStalled + ProverFailures, finalized head stopped at 18,410', 'ic-assign': 'bob ops, carol comms',
    'ops-changes': 'CHG-02 heap tuning 45 min before the first OOM: the suspect', 'ops-runbook': 'prover-oom-loop', 'ops-mitigate': 'rolled back the heap, requeued 9 batches',
    'comms-first': 'status page: withdrawals delayed', 'ops-decisions': 'rollback, then suspend blockscout',
  }, 'alice');
  await addItem(c, prover, 'ops', 'resolve', 'Resume blockscout after catch-up', 'alice');
  await addFollowUp(c, prover, { action: 'Load-test heap changes against .large batches before rollout', type: 'prevent', priority: 'P1', owner: 'bob' }, 'alice');
  await addFollowUp(c, prover, { action: 'Page when the prover restarts more than twice in 30 min', type: 'detect', priority: 'P1', owner: 'alice' }, 'alice');
  const f = (await followUps(c, prover))[0];
  await createIssue(c, prover, f.id, 'alice');
});

// ── Bridge messages stuck on the postman; declared SEV3, nobody wrote a checkpoint yet ──
await fire(-104, 'LinethL2MessagesStuck', 'warning', 'Bridge messages in flight but nothing claimed for 45 minutes');
await fire(-97, 'LinethL2MessagesNeedAttention', 'warning', 'Bridge messages in CLAIMED_REVERTED', { status: 'CLAIMED_REVERTED' });
const msgs = await idOf('LinethL2MessagesStuck');
await at(-92, async (c) => { await setSev(c, msgs, 3, 'dave'); await transition(c, msgs, 'declared', 'dave'); });
await at(-91, async (c) => { await setSummary(c, msgs, { status_line: 'Claims reverting with nonce too low; postman retrying', impact: 'Some deposits delayed; no funds at risk', next_update_at: T(30) }, 'dave'); });
await at(-88, (c) => addNote(c, msgs, 'note', { text: '14 L1→L2 claims reverted with "nonce too low"; postman retries every 5 min' }, 'dave'));

// ── New, not looked at yet ──
await fire(-34, 'LinethL2LivenessTxMissing', 'warning', 'Sequencer liveness txs missing');

// The AI briefing on the main incident, through the same check and store as submit_briefing.
const b = checkBriefing(BriefingInput.parse({
  incident_id: Number(prover),
  situation: 'Prover was OOM-killed on every large batch for ~2 h after the heap change (CHG-02); rolled back, catch-up running.',
  impact: 'L2 finalization on L1 is 840 blocks behind; withdrawals delayed ~4 h. No funds at risk.',
  cause: 'The -Xmx 23g heap plus off-heap memory exceeded the 24 GiB container limit; the rollback stopped the OOMs.',
  confidence: 'high', sev: { sev: 2, why: 'finalization stalled ~2 h; the settlement-freshness budget fell to 39%' },
  items: [
    { runbook: 'prover-oom-loop', step: 3, title: 'Watch the catch-up rate', decision: 'do_now', why: 'finalized head closing ~6 blocks/min; 840 to go', query: 'max(lineth_l2_rollup_finalized_block{l1_block_tag="latest"})' },
    { title: 'Resume blockscout when the finalized head is within 100 blocks', decision: 'do_now', why: 'suspended to free 3.1 GiB; users have no explorer meanwhile' },
    { title: 'Restart the prover', decision: 'not_needed', why: 'no restart since the rollback (restartCount stable for 2 h)',
      action: { type: 'restart_pod', params: { namespace: 'lineth-l2', pod: 'prover-6d9f7c5b8d-x4k2p' }, risk_level: 'medium', expected: 'fresh JVM; ~2 min without proofs', rollback: 'none needed', verify: 'k8s_get pods: prover Ready, restartCount +1' } },
  ],
}), await runbooks());
const { version } = await storeBriefing(db, prover, b);
await db.query('UPDATE agent_briefings SET created_at = $2 WHERE incident_id = $1 AND version = $3', [prover, T(-50), version]);
await db.query("UPDATE timeline SET at = $2 WHERE incident_id = $1 AND kind = 'briefing'", [prover, T(-50)]);
await db.query('UPDATE agent_actions SET proposed_at = $2 WHERE incident_id = $1', [prover, T(-50)]);

// Questions people asked the AI on the main incident.
const ask = async (min: number, who: string, q: string, answer: string, steps: [string, unknown, string][], took = 40) => {
  const id = (await db.query<{ id: string }>(
    `INSERT INTO agent_runs (incident_id, kind, prompt, asked_by, status, answer, tool_calls, tokens_in, tokens_out, started_at, ended_at, agent)
     VALUES ($1, 'chat', $2, $3, 'done', $4, $5, $6, $7, $8, $9, 'ai-respond') RETURNING id::text`,
    [prover, `[${who}, incident #${prover}] ${q}`, who, answer, steps.length, 14000 + steps.length * 6000, 380, T(min), new Date(T(min).getTime() + took * 1000)])).rows[0].id;
  for (const [k, [name, args, result]] of steps.entries())
    await db.query('INSERT INTO agent_steps (run_id, at, author, call_id, name, args, result) VALUES ($1, $2, $3, $4, $5, $6, $7)', [id, new Date(T(min).getTime() + (k + 1) * 5000), 'ai_respond', `demo-${id}-${k}`, name, JSON.stringify(args), result]);
};
await ask(-44, 'alice', 'Will the catch-up finish before the US shift starts?',
  `## Conclusion
Probably not: at the current rate the finalized head reaches the L2 head around 14:15 UTC, about 1 h 45 min into the US shift.
## Evidence
- Finalized head 840 blocks behind (prom_query)
- Closing ~6 blocks/min over the last 30 min (prom_range)
- Prover proving each large batch in 10–12 min with no restarts since the rollback (k8s_get)
## Next step
Hand the catch-up to dave with the blockscout resume condition in the checkpoint.
## Details
- Resuming synthetic traffic now would add ~40% more blocks to prove and push the ETA past 15:00 UTC.`,
  [['incident', { id: 2 }, '{"id":"2","state":"mitigated","sev":2}'], ['prom_query', { expr: 'max(lineth_l2_rollup_finalized_block{l1_block_tag="latest"})' }, '[{"value":"18902"}]'], ['prom_range', { expr: 'deriv(lineth_l2_rollup_finalized_block[30m])' }, '~0.1 blocks/s'], ['k8s_get', { kind: 'pods', namespace: 'lineth-l2' }, 'prover-6d9f7c5b8d-x4k2p Running, restarts 6 (last 2 h ago)']], 38);
await ask(-12, 'dave', 'What should I watch during my shift?',
  `## Conclusion
Two things: the catch-up rate (a stall pages you) and the bridge claims on #3.
## Evidence
- Wake condition on #2 pages if finalization does not move for 30 min (checkpoint)
- 14 L1→L2 claims reverted with "nonce too low" since 11:10 UTC (incident #3)
- settlement-freshness error budget is down to 39%, so a new stall would burn it fast
## Next step
Take IC on #3 and ask AI · Investigate to check the postman's L2 nonce.
## Details
- Blockscout stays suspended until the finalized head is within 100 blocks; resuming it early slows the prover.`,
  [['incident', { id: 2 }, '{"id":"2","state":"mitigated"}'], ['incident', { id: 3 }, '{"id":"3","state":"declared","sev":3}'], ['kagent__NS__ai_investigate', { request: 'Is anything else at risk on the L2 right now?' }, '## Findings\n- postman claims reverting (nonce too low)\n- settlement-freshness budget at 39%']], 52);

// Time to acknowledge was measured on the wall clock while seeding; recompute it on the scenario's times.
await db.query(`UPDATE timeline t SET body = jsonb_set(t.body, '{mtta_s}', to_jsonb(round(extract(epoch FROM i.acked_at - p.first))::int))
  FROM incidents i, LATERAL (SELECT min(sent_at) AS first FROM pages WHERE incident_id = i.id AND kind = 'escalation' AND step > 0) p
  WHERE t.kind = 'ack' AND t.incident_id = i.id`);
await db.query("INSERT INTO settings (key, value) VALUES ('demo_anchor', $1)", [A.toISOString()]);
// This shift's handoff, drafted by the outgoing IC.
await at(-5, async (c) => {
  const id = await ensureDraft(c, A);
  await setNote(c, id, 'Quiet apart from the prover catch-up. Synthetic traffic stays paused (CHG-04) until the catch-up is done.');
  await setIncidentNote(c, id, prover, 'Catch-up should finish around the start of your shift. Resume blockscout when the finalized head is within 100 blocks.');
  await setIncidentNote(c, id, msgs, 'Claims still revert with "nonce too low"; nobody has looked at the postman nonce yet.');
});
const n = await db.query<{ id: string; title: string; state: string; sev: number | null }>('SELECT id::text, title, state, sev FROM incidents ORDER BY id');
for (const r of n.rows) console.log(`#${r.id} ${r.state.padEnd(10)} SEV${r.sev ?? '?'} ${r.title}`);
console.log(`demo database ${name} seeded; anchor ${A.toISOString()}. Run the console with DEMO=1.`);
await db.end();
