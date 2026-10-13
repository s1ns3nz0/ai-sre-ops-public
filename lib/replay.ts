// Turns an incident fixture into the Alertmanager webhook notifications it would have produced, in time order.
import { createHash } from 'node:crypto';

export type FixtureEvent = {
  incident: string; alertname: string; severity: string; labels: Record<string, string>;
  summary: string; startsAt: string; endsAt?: string;
};

const BASE = { cluster: 'lineth-local', network: 'lineth-local-l2' };

export function notifications(events: FixtureEvent[]) {
  const out: { at: string; incident: string; payload: Record<string, unknown> }[] = [];
  for (const e of events) {
    const labels: Record<string, string> = { alertname: e.alertname, severity: e.severity, ...BASE, ...e.labels };
    const fingerprint = createHash('sha256').update(JSON.stringify(Object.entries(labels).sort())).digest('hex').slice(0, 16);
    // Same shape as the real route: group_by [alertname, network, severity].
    const groupKey = `{}:{alertname="${e.alertname}", network="${BASE.network}", severity="${e.severity}"}`;
    const alert = (status: string, endsAt: string) => ({
      status, labels, annotations: { summary: e.summary }, startsAt: e.startsAt, endsAt, generatorURL: '', fingerprint,
    });
    const payload = (status: string, endsAt: string) => ({
      version: '4', groupKey, status, receiver: 'platform', groupLabels: {}, commonLabels: labels, commonAnnotations: {},
      externalURL: '', alerts: [alert(status, endsAt)],
    });
    out.push({ at: e.startsAt, incident: e.incident, payload: payload('firing', '0001-01-01T00:00:00Z') });
    if (e.endsAt) out.push({ at: e.endsAt, incident: e.incident, payload: payload('resolved', e.endsAt) });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}
