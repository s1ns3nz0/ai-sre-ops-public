// Demo data on top of `npm run replay`: works two replayed incidents like an operator would and adds one live alert.
// Content follows INC-2026-10-11-11 / INC-10; operator actions are stamped "now". Usage: node scripts/demo.ts
import { addCheckpoint } from '../lib/checkpoints.ts';
import { pool, tx } from '../lib/db.ts';
import { ack, addFollowUp, addItem, addNote, checklist, createIssue, followUps, setFollowUpDone, setRole, setSev, setSummary, toggleItem, transition } from '../lib/incidents.ts';
import { ingest, parsePayload } from '../lib/ingest.ts';

const db = pool();
// The incident an alert was grouped into.
const idOf = async (alertname: string) => {
  const r = await db.query<{ id: string }>('SELECT incident_id::text AS id FROM alerts WHERE alertname = $1 ORDER BY starts_at LIMIT 1', [alertname]);
  if (!r.rows[0]) throw new Error(`run "npm run replay" first (missing: ${alertname})`);
  return r.rows[0].id;
};
const hour = 3600_000;

// INC-11: finalization halt, worked and mitigated, catch-up running.
const fin = await idOf('LinethL2FinalizationStalled');
await tx(async (c) => {
  await setSev(c, fin, 2, 's1ns3nz0');
  await transition(c, fin, 'declared', 's1ns3nz0');
  await ack(c, fin, 's1ns3nz0');
  await setSummary(c, fin, {
    status_line: 'Prover memory freed, parked batches requeued; catch-up in progress',
    impact: 'L2 → L1 finalization stopped 27 h (16,852 blocks); 376 withdrawals unclaimable until catch-up',
    next_update_at: new Date(Date.now() + hour),
  }, 's1ns3nz0');
  await setRole(c, fin, 'ops', 's1ns3nz0', 'requeue .large batches; watch node MemAvailable during each proof', 's1ns3nz0');
  await setRole(c, fin, 'comms', 's1ns3nz0', 'withdrawal delay notice every 1 h (SEV2)', 's1ns3nz0');
  await addNote(c, fin, 'note', { text: 'prover restartCount 48, lastState OOMKilled; 22 batches parked as .large; coordinator gapOverflow=4001' }, 's1ns3nz0');
  await addNote(c, fin, 'decision', {
    decision: 'Suspend lineth-l2-explorer (blockscout) to free memory for the prover',
    alternatives: 'raise kind node memory (needs restart)', reason: 'MemAvailable 6.4 → 8.8 GiB, enough for one 113-block batch',
    revert_when: 'finalized head within 1,000 blocks of L2 head',
  }, 's1ns3nz0');
  await transition(c, fin, 'mitigated', 's1ns3nz0');
  await addNote(c, fin, 'decision', {
    decision: 'Pause synthetic traffic (l2-load, l2-users) during catch-up',
    alternatives: 'keep traffic, ~31 h catch-up', reason: 'halves block production; catch-up ~15–17 h',
    revert_when: 'backlog < 10 batches',
  }, 's1ns3nz0');
  await setRole(c, fin, 'planning', 's1ns3nz0', 'follow-ups: prover memory request 10Gi, blocks-limit 60, page on ProverLargeRetry', 's1ns3nz0');
});

// Work part of #2's checklist (with how each was handled), plus one item the operator added during the incident.
const NOTES: Record<string, string> = {
  'ops-changes': 'CHG-2026-10-12-02 (l2-load r2) in progress; no Flux change on prover/coordinator in 24 h. Not a deploy regression.',
  'ops-runbook': 'No runbook for ProverLargeRetry yet; used the INC-08 notes (prover OOM, .large parking).',
  'ops-mitigate': 'Suspended blockscout for memory, renamed 22 .large batches back to .json. Batch 14832-14944 proved, finalization moved.',
  'ic-rollback': 'Fix forward: nothing to roll back, the cause is memory headroom on the node.',
};
await tx(async (c) => {
  const items = await checklist(c, fin);
  for (const key of ['ic-confirm', 'ic-assign', 'ic-next-update', 'ic-rollback', 'ops-changes', 'ops-runbook', 'ops-mitigate', 'ops-decisions', 'comms-first']) {
    const i = items.find((x) => x.template_key === key);
    if (i) await toggleItem(c, fin, i.id, 's1ns3nz0', NOTES[key] ?? '');
  }
  await addItem(c, fin, 'ops', 'resolve', 'Watch node MemAvailable through the whole catch-up', 's1ns3nz0');
});

// INC-10: sequencer halt (maru heap OOM), fixed by restart → resolved → postmortem (SEV1 requires it).
const seq = await idOf('LinethL2SequencerStalled');
await tx(async (c) => {
  await setSev(c, seq, 1, 's1ns3nz0');
  await transition(c, seq, 'declared', 's1ns3nz0');
  await addNote(c, seq, 'decision', {
    decision: 'Restart maru-0', alternatives: 'wait for heap dump', reason: 'blocks stopped 4.5 h; restart resets the heap in seconds',
    revert_when: 'n/a',
  }, 's1ns3nz0');
  await transition(c, seq, 'mitigated', 's1ns3nz0');
  await addNote(c, seq, 'note', { text: 'head 20102 → 20109 within 5 s of maru-0 Ready; l2-traffic ok' }, 's1ns3nz0');
  await transition(c, seq, 'resolved', 's1ns3nz0');
  await transition(c, seq, 'postmortem', 's1ns3nz0');
});

// A live alert that is still firing now, so the queue shows a red "firing" card.
await tx((c) => ingest(c, parsePayload({
  version: '4',
  groupKey: '{}:{alertname="LinethL2MaruHeapNearlyFull", network="lineth-local-l2", severity="warning"}',
  alerts: [{
    status: 'firing', fingerprint: 'demo-maru-heap',
    labels: { alertname: 'LinethL2MaruHeapNearlyFull', severity: 'warning', network: 'lineth-local-l2', cluster: 'lineth-local' },
    annotations: { summary: 'Maru old gen above 90% of max for 10 minutes' },
    startsAt: new Date(Date.now() - 12 * 60_000).toISOString(), endsAt: '0001-01-01T00:00:00Z',
  }],
})));

// A checkpoint on #1 (F13), so handoffs and the Summary tab show where the catch-up stands.
await tx((c) => addCheckpoint(c, fin, {
  status_line: 'Catch-up running; finalized head ~1,200 blocks behind', hypothesis: 'Prover OOM on large batches; memory freed by suspending blockscout',
  action: 'Requeued 22 .large batches', action_eta: new Date(Date.now() + 3 * hour), wake_expr: 'max(lineth_l2_head_block) - max(lineth_l2_rollup_finalized_block{l1_block_tag="latest"}) > 5000',
  next_step: 'Resume l2-load and the explorer when the backlog is under 10 batches', handoff_to: 'EU on-call',
}, 's1ns3nz0'));

// Follow-ups (F14): INC-11's postmortem action items and INC-10's next steps; some already have (mock) issues.
const FU: [string, string, 'prevent' | 'detect' | 'mitigate', 'P0' | 'P1' | 'P2', boolean, boolean][] = [
  [fin, 'Route alerts to a person (Telegram receiver; critical pages)', 'detect', 'P0', true, false],
  [fin, 'Prover memory request ~10 Gi (measured peak); check the node fits it', 'prevent', 'P0', true, false],
  [fin, 'Raise bonsai-historical-block-limit permanently and alert when the proven gap nears it', 'prevent', 'P0', true, true],
  [fin, 'Lower conflation blocks-limit or run large mode by default', 'prevent', 'P1', false, false],
  [fin, 'LinethL2ProverLargeRetry to critical: a parked batch always needs a human', 'detect', 'P1', false, false],
  [fin, 'Alert when node MemAvailable < prover peak + margin while requests are pending', 'detect', 'P1', false, false],
  [fin, 'Alert on prover restarts', 'detect', 'P2', false, false],
  [seq, '-XX:+ExitOnOutOfMemoryError so a full heap restarts maru in minutes', 'mitigate', 'P0', true, true],
  [seq, 'LinethL2MaruHeapNearlyFull: old gen > 90% for 10m', 'detect', 'P0', true, true],
  [seq, 'Find the maru heap leak (run without the OTel agent, or a heap dump)', 'prevent', 'P1', false, false],
  [seq, 'A receiver someone sees: second incident in a day where alerts fired unseen', 'detect', 'P0', false, false],
];
await tx(async (c) => {
  for (const [id, action, type, priority] of FU) await addFollowUp(c, id, { action, type, priority, owner: 's1ns3nz0' }, 's1ns3nz0');
  for (const id of [fin, seq]) {
    for (const f of await followUps(c, id)) {
      const spec = FU.find((x) => x[0] === id && x[1] === f.action)!;
      if (spec[4]) await createIssue(c, id, f.id, 's1ns3nz0');
      if (spec[5]) await setFollowUpDone(c, id, f.id, true, 's1ns3nz0');
    }
  }
});

console.log(`demo data: #${fin} mitigated (SEV2), #${seq} postmortem (SEV1), live maru heap alert`);
await db.end();
