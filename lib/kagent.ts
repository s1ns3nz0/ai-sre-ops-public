// Kagent A2A client (P2). Sends one message to an agent with JSON-RPC `message/stream` and yields what the console
// needs: tool calls and results, streamed text, token usage, and the end state. Sub-agents appear as one tool call
// (named kagent__NS__<agent>); their own tool calls stay inside Kagent.
// Env: KAGENT_URL (lab: port-forward of svc/kagent-controller 8083), KAGENT_NAMESPACE (default kagent).

export type AgentEvent =
  | { type: 'context'; contextId: string }
  | { type: 'call'; author: string; id: string; name: string; args: unknown }
  | { type: 'result'; author: string; id: string; name: string; output: string }
  | { type: 'text'; author: string; text: string; partial: boolean }
  | { type: 'usage'; tokensIn: number; tokensOut: number }
  | { type: 'end'; state: 'completed' | 'failed' | 'canceled' | 'input-required'; error?: string; answer?: string };

export type Part = { kind: string; text?: string; data?: Record<string, unknown>; metadata?: Record<string, unknown> };
type Result = {
  kind?: string; contextId?: string; final?: boolean;
  status?: { state?: string; message?: { parts?: Part[]; metadata?: Record<string, unknown> } };
  artifact?: { parts?: Part[] };
};

const text = (parts: Part[] = []) => parts.filter((p) => p.kind === 'text').map((p) => p.text ?? '').join('');

// One SSE `data:` payload → the events in it. Pure, so it is tested on captured Kagent output.
export function toEvents(r: Result): AgentEvent[] {
  const out: AgentEvent[] = [];
  if (r.contextId) out.push({ type: 'context', contextId: r.contextId });
  if (r.kind === 'artifact-update') {
    const t = text(r.artifact?.parts);
    if (t) out.push({ type: 'end', state: 'completed', answer: t });
    return out;
  }
  const state = r.status?.state;
  const msg = r.status?.message;
  const md = msg?.metadata ?? {};
  const author = String(md.adk_author ?? '');
  if (state === 'working' && msg) {
    for (const p of msg.parts ?? []) {
      const d = p.data as { id?: string; name?: string; args?: unknown; response?: unknown } | undefined;
      // A call without arguments has no `args` key; adk_type says what the part is.
      if (d?.name && (p.metadata?.adk_type === 'function_call' || 'args' in d)) out.push({ type: 'call', author, id: String(d.id), name: d.name, args: d.args ?? {} });
      else if (d?.name && 'response' in d) {
        const res = d.response as { output?: unknown; result?: unknown } | undefined;
        const o = res?.output ?? res?.result ?? res;
        out.push({ type: 'result', author, id: String(d.id), name: d.name, output: typeof o === 'string' ? o : JSON.stringify(o) });
      } else if (p.kind === 'text' && p.text) out.push({ type: 'text', author, text: p.text, partial: md.adk_partial === true });
    }
    const u = md.adk_usage_metadata as { promptTokenCount?: number; candidatesTokenCount?: number } | undefined;
    if (u) out.push({ type: 'usage', tokensIn: u.promptTokenCount ?? 0, tokensOut: u.candidatesTokenCount ?? 0 });
  }
  if (r.final && state && state !== 'completed') {
    out.push({ type: 'end', state: state as 'failed', error: state === 'failed' ? text(msg?.parts).slice(0, 2000) : undefined });
  }
  return out;
}

export async function* streamAgent(agent: string, message: string, contextId: string | null, signal: AbortSignal): AsyncGenerator<AgentEvent> {
  const base = process.env.KAGENT_URL;
  if (!base) throw new Error('KAGENT_URL is not set');
  const ns = process.env.KAGENT_NAMESPACE ?? 'kagent';
  const res = await fetch(`${base}/api/a2a/${ns}/${agent}/`, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: crypto.randomUUID(), method: 'message/stream',
      params: { message: { role: 'user', kind: 'message', messageId: crypto.randomUUID(), ...(contextId ? { contextId } : {}), parts: [{ kind: 'text', text: message }] } },
    }),
  });
  if (!res.ok || !res.body) throw new Error(`Kagent ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const dec = new TextDecoder();
  let buf = '';
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buf += done ? dec.decode() + '\n' : dec.decode(value, { stream: true }); // flush a last line without a newline
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const j = JSON.parse(line.slice(5));
        if (j.error) { yield { type: 'end', state: 'failed', error: String(j.error.message ?? j.error).slice(0, 2000) }; return; }
        yield* toEvents(j.result ?? {});
      }
      if (done) return;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}
