import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toEvents, type Part } from './kagent.ts';

// Shapes captured from Kagent 0.10.3 (ir-lead on incident #3).
const md = { adk_author: 'ir_lead', adk_session_id: 'ctx1' };
const working = (parts: Part[], extra = {}) => ({ kind: 'status-update', contextId: 'ctx1', final: false, status: { state: 'working', message: { kind: 'message', parts, metadata: { ...md, ...extra } } } });

test('tool call and result, including a sub-agent', () => {
  assert.deepEqual(toEvents(working([{ kind: 'data', data: { id: 't1', name: 'incident', args: { id: 3 } } }]))[1],
    { type: 'call', author: 'ir_lead', id: 't1', name: 'incident', args: { id: 3 } });
  assert.deepEqual(toEvents(working([{ kind: 'data', data: { id: 't1', name: 'incident', response: { output: '{"id":"3"}' } } }]))[1],
    { type: 'result', author: 'ir_lead', id: 't1', name: 'incident', output: '{"id":"3"}' });
  assert.deepEqual(toEvents(working([{ kind: 'data', data: { id: 't3', name: 'flux_status' }, metadata: { adk_type: 'function_call' } }]))[1],
    { type: 'call', author: 'ir_lead', id: 't3', name: 'flux_status', args: {} });
  const sub = toEvents(working([{ kind: 'data', data: { id: 't2', name: 'kagent__NS__investigator', response: { result: '## Findings' } } }]))[1];
  assert.equal(sub.type === 'result' && sub.output, '## Findings');
});

test('partial text, usage, answer and failure', () => {
  assert.deepEqual(toEvents(working([{ kind: 'text', text: 'Pha' }], { adk_partial: true }))[1], { type: 'text', author: 'ir_lead', text: 'Pha', partial: true });
  assert.deepEqual(toEvents(working([{ kind: 'text', text: 'Phase' }], { adk_usage_metadata: { promptTokenCount: 1603, candidatesTokenCount: 66 } })).slice(1),
    [{ type: 'text', author: 'ir_lead', text: 'Phase', partial: false }, { type: 'usage', tokensIn: 1603, tokensOut: 66 }]);
  assert.deepEqual(toEvents({ kind: 'artifact-update', contextId: 'ctx1', artifact: { parts: [{ kind: 'text', text: 'done' }] } }),
    [{ type: 'context', contextId: 'ctx1' }, { type: 'end', state: 'completed', answer: 'done' }]);
  assert.deepEqual(toEvents({ kind: 'status-update', final: true, status: { state: 'failed', message: { parts: [{ kind: 'text', text: 'LLM error: 402' }] } } }),
    [{ type: 'end', state: 'failed', error: 'LLM error: 402' }]);
  assert.deepEqual(toEvents({ kind: 'status-update', final: true, status: { state: 'completed' } }), []);
});
