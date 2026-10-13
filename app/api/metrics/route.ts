import { connection } from 'next/server';
import { pool } from '@/lib/db.ts';
import { openFollowUps, reliabilityRows } from '@/lib/priority.ts';
import { METRICS, summarize } from '@/lib/reliability.ts';
import { topology } from '@/lib/topology.ts';

// Prometheus text format (PRD F14): reliability numbers for a dashboard in lineth-observability. No secrets in here.
export async function GET() {
  await connection();
  const t = topology();
  const out: string[] = [
    '# HELP sreops_incident_duration_seconds Median and p90 of MTTD/MTTA/MTTM/MTTR over declared incidents.',
    '# TYPE sreops_incident_duration_seconds gauge',
  ];
  for (const days of [30, 90]) {
    const s = summarize(await reliabilityRows(pool(), t, days));
    for (const m of METRICS) for (const [q, v] of [['0.5', s[m].p50], ['0.9', s[m].p90]] as const) {
      if (v !== null) out.push(`sreops_incident_duration_seconds{metric="${m}",quantile="${q}",window="${days}d"} ${v / 1000}`);
    }
  }
  const { rows } = await pool().query<{ sev: number | null; state: string; n: number }>('SELECT sev, state, count(*)::int AS n FROM incidents GROUP BY sev, state');
  out.push('# HELP sreops_incidents Incidents by SEV and state.', '# TYPE sreops_incidents gauge');
  for (const r of rows) out.push(`sreops_incidents{sev="${r.sev ?? 'none'}",state="${r.state}"} ${r.n}`);
  const owed = await openFollowUps(pool());
  out.push('# HELP sreops_follow_ups_open Open postmortem follow-ups.', '# TYPE sreops_follow_ups_open gauge');
  out.push(`sreops_follow_ups_open ${owed.length}`);
  out.push('# HELP sreops_follow_ups_open_over_30d Open follow-ups older than 30 days.', '# TYPE sreops_follow_ups_open_over_30d gauge');
  out.push(`sreops_follow_ups_open_over_30d ${owed.filter((f) => Date.now() - new Date(f.created_at).getTime() > 30 * 86_400_000).length}`);
  return new Response(`${out.join('\n')}\n`, { headers: { 'content-type': 'text/plain; version=0.0.4' } });
}
