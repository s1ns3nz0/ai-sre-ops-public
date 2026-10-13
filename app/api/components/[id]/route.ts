import { pool } from '@/lib/db.ts';
import { alertsNamed } from '@/lib/incidents.ts';
import { pods } from '@/lib/prom.ts';
import { topology } from '@/lib/topology.ts';

// Component drawer data: pods and resources (Prometheus), links (topology.yaml), alerts (DB), deep links.
export async function GET(_req: Request, { params }: RouteContext<'/api/components/[id]'>) {
  const { id } = await params;
  const t = topology();
  const node = t.nodes.find((n) => n.id === id);
  if (!node) return Response.json({ error: 'unknown component' }, { status: 404 });
  const label = (nid: string) => t.nodes.find((n) => n.id === nid)?.label ?? nid;
  const [podsResult, alerts] = await Promise.all([
    pods(node.workloads).then((p) => ({ pods: p, error: null }), (e: Error) => ({ pods: [], error: e.message })),
    alertsNamed(pool(), node.alerts ?? []),
  ]);
  const grafana = process.env.GRAFANA_URL;
  const podRe = node.workloads.map((w) => `${w.name}-.*`).join('|');
  const ns = node.workloads[0].ns;
  const panes = { a: { datasource: 'loki', queries: [{ refId: 'A', datasource: { type: 'loki', uid: 'loki' }, expr: `{namespace="${ns}", pod=~"${podRe}"}` }], range: { from: 'now-1h', to: 'now' } } };
  return Response.json({
    node,
    pods: podsResult.pods,
    promError: podsResult.error,
    out: t.edges.filter((e) => e.from === id).map((e) => ({ ...e, peer: e.to, peerLabel: label(e.to) })),
    in: t.edges.filter((e) => e.to === id).map((e) => ({ ...e, peer: e.from, peerLabel: label(e.from) })),
    alerts,
    links: grafana ? {
      dashboard: node.dashboard ? `${grafana}/d/${node.dashboard}` : null,
      logs: `${grafana}/explore?schemaVersion=1&panes=${encodeURIComponent(JSON.stringify(panes))}`,
    } : null,
  });
}
