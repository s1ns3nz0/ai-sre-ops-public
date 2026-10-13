import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { Suspense } from 'react';
import { RunbookView } from '@/components/RunbookView.tsx';
import { repoUrl } from '@/lib/detection.ts';
import { runbooks } from '@/lib/runbooks.ts';

export default function RunbookPage({ params }: PageProps<'/runbooks/[id]'>) {
  return (
    <div className="min-h-full bg-surface">
      <div className="mx-auto max-w-4xl px-8 py-7">
        <Suspense fallback={<p className="text-sm text-sub">Loading…</p>}>
          <Body params={params} />
        </Suspense>
      </div>
    </div>
  );
}

// A runbook on its own (from the infrastructure drawers or the Detection list). Steps tick only inside an incident.
async function Body({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await connection(); // the runbook cache reads the clock
  const rb = (await runbooks()).find((r) => r.id === id);
  if (!rb) notFound();
  return (
    <>
      <p className="mb-4 text-sm text-sub">
        <Link href="/detection?tab=runbooks" className="underline underline-offset-2">Runbooks</Link> ·{' '}
        <a href={repoUrl(rb.path)} target="_blank" rel="noreferrer" className="underline underline-offset-2">{rb.path}</a>
        {' '}· steps are ticked from an incident's Runbook tab
      </p>
      <RunbookView rb={rb} grafana={process.env.GRAFANA_URL ?? null} range={{ from: 'now-1h', to: 'now' }} />
    </>
  );
}
