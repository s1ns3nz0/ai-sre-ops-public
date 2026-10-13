// Starts the 30 s platform timer once per server process: paging escalation (F10), the Watchdog check (F11)
// IC wake conditions (F13)
// unhandled critical candidates (F8) and shift handoffs (F5).
// ponytail: in-process timer; pages and the Watchdog incident are deduplicated in the DB, so extra replicas only
// add redundant checks.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs' || process.env.NEXT_PHASE === 'phase-production-build' || process.env.PAGING_TICK === 'off') return;
  const g = globalThis as unknown as { pagingTimer?: NodeJS.Timeout };
  if (g.pagingTimer) return;
  const { pageSweep, triageSweep } = await import('./lib/incidents.ts');
  const { watchdogSweep } = await import('./lib/watchdog.ts');
  const { wakeSweep } = await import('./lib/checkpoints.ts');
  const { query } = await import('./lib/prom.ts');
  const { handoffSweep } = await import('./lib/handoff.ts');
  // Demo mode: the watchdog and wake conditions read the live lab; paging, triage and handoffs run on the scenario.
  const demo = process.env.DEMO === '1';
  const run = async () => { if (!demo) await watchdogSweep(); await pageSweep(); await triageSweep(); if (!demo) await wakeSweep(query); await handoffSweep(); };
  g.pagingTimer = setInterval(() => run().catch((e: Error) => console.error('platform timer:', e.message)), 30_000);
  g.pagingTimer.unref();
}
