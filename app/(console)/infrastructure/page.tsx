import { connection } from 'next/server';
import Link from 'next/link';
import { Suspense } from 'react';
import { TopologyMap } from '@/components/TopologyMap.tsx';
import { pool } from '@/lib/db.ts';
import { stagesAt } from '@/lib/stages.ts';
import { topology } from '@/lib/topology.ts';
import { runbooks } from '@/lib/runbooks.ts';
import { button, field } from '@/components/ui.tsx';

export default function InfrastructurePage({ searchParams }: PageProps<'/infrastructure'>) {
  return (
    <div className="mx-auto max-w-[1280px] px-8 py-7">
      <h1 className="text-2xl font-semibold tracking-tight">Infrastructure</h1>
      <p className="mt-1 text-sm text-sub">How the L2 rollup and the local L1 talk to each other, and each component's impact stage. Select a component or a link for why and what breaks.</p>
      <div className="mt-5">
        <Suspense fallback={<p className="text-sm text-sub">Loading…</p>}>
          <Map searchParams={searchParams} />
        </Suspense>
      </div>
    </div>
  );
}

// ?at=<ISO>: the map as it was then (Prometheus at that instant, alerts firing then). Prometheus keeps 30 days.
async function Map({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection(); // stages read the clock (live cache)
  const sp = await searchParams;
  const raw = typeof sp.at === 'string' ? sp.at : '';
  const iso = /(Z|[+-]\d\d:?\d\d)$/.test(raw) ? raw : `${raw}Z`; // the form sends datetime-local, which is UTC here
  const at = raw && !Number.isNaN(Date.parse(iso)) ? new Date(iso) : undefined;
  const t = topology();
  const [{ nodes, edges, error }, rbs] = await Promise.all([stagesAt(pool(), t, at), runbooks()]);
  const rbList = rbs.map((r) => ({ id: r.id, title: r.title, alerts: r.alerts, components: r.components }));
  return (
    <>
      <form className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <label className="flex items-center gap-2">View at (UTC)
          <input type="datetime-local" name="at" defaultValue={at ? at.toISOString().slice(0, 16) : ''} className={`${field} w-52`} />
        </label>
        <button className={button.quiet}>Show</button>
        {at && <Link href="/infrastructure" className="text-sub underline underline-offset-2">Back to now</Link>}
        {at && <span className="ml-auto rounded-md bg-ink px-2 py-0.5 text-xs text-white">Viewing {at.toISOString().slice(0, 16).replace('T', ' ')} UTC</span>}
      </form>
      {error && <p className="mb-3 text-sm text-sev1">Cannot reach Prometheus ({error}); components show as unknown.</p>}
      <TopologyMap topology={t} status={nodes} edges={edges} runbooks={rbList} grafana={process.env.GRAFANA_URL ?? null} at={at ? at.toISOString() : null} />
    </>
  );
}
