'use server';
import { refresh } from 'next/cache';
import { redirect } from 'next/navigation';
import { actor } from '@/lib/actor.ts';
import { pool, tx } from '@/lib/db.ts';
import { acknowledge, collect, ensureDraft, handoff, markReady, setIncidentNote, setNote } from '@/lib/handoff.ts';

export async function prepareAction() {
  await actor();
  const id = await ensureDraft(pool());
  redirect(`/handoff?id=${id}`);
}

export async function noteAction(id: string, f: FormData) {
  await actor();
  await tx((c) => setNote(c, id, String(f.get('note') ?? '')));
  refresh();
}

export async function incidentNoteAction(id: string, incidentId: string, f: FormData) {
  await actor();
  await tx((c) => setIncidentNote(c, id, incidentId, String(f.get('note') ?? '')));
  refresh();
}

export async function readyAction(id: string) {
  const who = await actor();
  const h = await handoff(pool(), id);
  if (!h) throw new Error('handoff not found');
  const data = await collect(pool(), h.shift_start, h.shift_end);
  await tx((c) => markReady(c, id, who, data));
  refresh();
}

export async function ackAction(id: string, f: FormData) {
  const who = await actor();
  const h = await handoff(pool(), id);
  if (!h) throw new Error('handoff not found');
  const reads = f.getAll('read').map((v) => String(v).slice(0, 40)).slice(0, 200);
  const data = h.data ? null : await collect(pool(), h.shift_start, h.shift_end);
  await tx((c) => acknowledge(c, id, who, data, reads));
  refresh();
}
