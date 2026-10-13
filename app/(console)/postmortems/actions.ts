'use server';
import { refresh } from 'next/cache';
import { actor } from '@/lib/actor.ts';
import { pool } from '@/lib/db.ts';
import { isDemo } from '@/lib/demo.ts';
import { openPullRequest } from '@/lib/detection.ts';
import { draftFor, postmortems } from '@/lib/postmortems.ts';

// Drafts the postmortem for an incident from what the console recorded and opens it as a pull request in the
// repository; the incident links to it. Not in demo mode: sample data must not reach the real repository.
export async function draftPostmortemAction(incidentId: string): Promise<{ url: string } | { error: string }> {
  const who = await actor();
  if (!/^\d+$/.test(incidentId)) return { error: 'invalid incident' };
  if (isDemo()) return { error: 'Not in the demo: a draft opens a pull request in the real repository.' };
  try {
    const d = await draftFor(pool(), incidentId, await postmortems(), who);
    const url = await openPullRequest({ files: [{ path: d.path, text: d.text, baseSha: '' }], title: `${d.id}: postmortem draft for incident #${incidentId}`, body: `Drafted by AI SRE Ops from incident #${incidentId} (timeline, decisions, follow-ups). The authors fill in the TODO sections: summary, impact, root causes, lessons.`, slug: d.id, prefix: 'postmortem' });
    await pool().query('UPDATE incidents SET postmortem_id = $2, postmortem_pr = $3 WHERE id = $1', [incidentId, d.id, url]);
    refresh();
    return { url };
  } catch (e) {
    return { error: (e as Error).message.slice(0, 300) };
  }
}
