'use server';
import { refresh } from 'next/cache';
import { actor } from '@/lib/actor.ts';
import { agentState, aiBackend, demoQuota, generalState, runAction, setAiEnabled, skipAction, startGeneral, startRun, stopRun, aiEnabled } from '@/lib/agent-runs.ts';
import { pool } from '@/lib/db.ts';

const idOk = (id: string) => { if (!/^\d+$/.test(String(id))) throw new Error('invalid id'); return String(id); };
const safe = async <T,>(fn: () => Promise<T>): Promise<T | { error: string }> => {
  try { return await fn(); } catch (e) { return { error: (e as Error).message.slice(0, 500) }; }
};

// Read by the Response tab and the chat panel while they are open (polling).
export async function agentStateAction(incidentId: string) {
  return safe(async () => ({ enabled: await aiEnabled(pool()), connected: !!aiBackend(), quota: await demoQuota(pool(), await actor()), ...(await agentState(pool(), idOk(incidentId))) }));
}

export async function respondAction(incidentId: string) {
  const who = await actor();
  return safe(() => startRun(pool(), idOk(incidentId), 'respond', who));
}

export async function askAction(incidentId: string, text: string) {
  const who = await actor();
  const t = String(text).trim().slice(0, 4000);
  if (!t) return { error: 'empty message' };
  return safe(() => startRun(pool(), idOk(incidentId), 'chat', who, t));
}

export async function stopAction(runId: string) {
  return safe(async () => { await actor(); return stopRun(idOk(runId)); });
}

export async function runActionAction(actionId: string) {
  const who = await actor();
  return safe(() => runAction(pool(), idOk(actionId), who));
}

export async function skipActionAction(actionId: string) {
  const who = await actor();
  return safe(() => skipAction(pool(), idOk(actionId), who));
}

export async function setAiAction(on: boolean) {
  await actor();
  await setAiEnabled(pool(), !!on);
  refresh();
}

// The ⌘K assistant: the asker's own conversation.
export async function generalStateAction() {
  return safe(async () => { const who = await actor(); return { enabled: await aiEnabled(pool()), connected: !!aiBackend(), quota: await demoQuota(pool(), who), runs: await generalState(pool(), who) }; });
}

export async function askGeneralAction(text: string, fresh: boolean) {
  const who = await actor();
  const t = String(text).trim().slice(0, 4000);
  if (!t) return { error: 'empty message' };
  return safe(() => startGeneral(pool(), who, t, !!fresh));
}
