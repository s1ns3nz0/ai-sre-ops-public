'use server';
import { refresh } from 'next/cache';
import { actor } from '@/lib/actor.ts';
import { tx } from '@/lib/db.ts';
import { setMaintenance } from '@/lib/watchdog.ts';

// Planned maintenance: pause the Watchdog page for N minutes (0 ends it now).
export async function maintenanceAction(f: FormData) {
  const who = await actor();
  const min = Number(f.get('minutes'));
  if (!Number.isInteger(min) || min < 0 || min > 24 * 60) throw new Error('minutes must be 0–1440');
  await tx((c) => setMaintenance(c, min ? new Date(Date.now() + min * 60_000) : null, who));
  refresh();
}
