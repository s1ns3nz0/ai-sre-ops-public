// What the agents' tool server can read from the console (P2): compact, redacted views of an incident, a runbook
// and a component. Read-only; served by /api/agent/* to the tool server only (AGENT_API_TOKEN).
import type pg from 'pg';
import { duringIncident, incidentComponents, suspects } from './changes.ts';
import { checkpoints } from './checkpoints.ts';
import { chgs } from './chg.ts';
import { getIncident } from './incidents.ts';
import { redact } from './redact.ts';
import { matchRunbooks, runbooks, type Runbook } from './runbooks.ts';
import { stagesAt } from './stages.ts';
import { topology } from './topology.ts';

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') + 'Z' : null);
const clean = <T,>(x: T): T => JSON.parse(redact(JSON.stringify(x)));

export async function incidentBrief(c: pg.Pool, id: string) {
  const data = await getIncident(c, id);
  if (!data) return null;
  const { inc, alerts, timeline } = data;
  const t = topology();
  const names = [...new Set(alerts.map((a) => a.alertname))];
  const comps = incidentComponents(t, names);
  const list = (await chgs()).chgs;
  const detected = new Date(inc.detected_at);
  const [cps, before, during] = await Promise.all([
    checkpoints(c, id),
    suspects(c, t, names, detected, list),
    duringIncident(c, detected, inc.resolved_at ? new Date(inc.resolved_at) : new Date(), list),
  ]);
  const rbs = matchRunbooks(await runbooks(), names, [...comps.own, ...comps.deps]);
  return clean({
    id: inc.id, title: inc.title, state: inc.state, sev: inc.sev, sev_suggested: inc.sev_suggested,
    status_line: inc.status_line, impact: inc.impact, detected_at: iso(inc.detected_at), acked_by: inc.acked_by,
    roles: Object.fromEntries(Object.entries(inc.roles).map(([k, v]) => [k, v?.who])),
    components: comps,
    alerts: alerts.map((a) => ({ alertname: a.alertname, severity: a.severity, status: a.status, component: a.component, since: iso(a.starts_at), until: iso(a.ends_at), summary: (a.annotations as Record<string, string> | null)?.summary ?? '' })),
    checkpoint: cps[0] ? { at: iso(cps[0].created_at), status: cps[0].status_line, hypothesis: cps[0].hypothesis, action: cps[0].action, next_step: cps[0].next_step } : null,
    changes_before_detection: before.map((x) => ({ what: x.what, label: x.label, at: iso(x.at), components: x.components, failed: !!x.failed })),
    changes_during: during.slice(0, 10).map((x) => ({ what: x.what, label: x.label, at: iso(x.at), components: x.components, failed: !!x.failed })),
    runbooks: rbs.map((x) => ({ id: x.r.id, title: x.r.title, matched_alerts: x.by, matched_components: x.comps })),
    timeline: timeline.slice(0, 40).map((e) => ({ at: iso(e.at), kind: e.kind, actor: e.actor, body: JSON.stringify(e.body).slice(0, 400) })),
  });
}

function renderRunbook(r: Runbook): string {
  const lines = [`# ${r.title} (${r.id})`, `alerts: ${r.alerts.join(', ')}; components: ${r.components.join(', ')}; severity: ${r.severity}; precedents: ${r.precedents.join(', ')}`];
  let n = 0; // steps numbered across the runbook, as submit_briefing refers to them (lib/briefing.ts numberedSteps)
  for (const s of r.sections) {
    lines.push('', `## ${s.title}`);
    for (const b of s.blocks) {
      if (b.kind === 'code') lines.push('```' + b.lang, b.text, '```');
      else if (b.kind === 'step') lines.push(`- [ ] [step ${++n}] ${b.text}`);
      else if (b.kind === 'item') lines.push(`- ${b.text}`);
      else lines.push(b.text);
    }
  }
  return redact(lines.join('\n'));
}

// A runbook by id, or every runbook matching an alert or a component (full text).
export async function runbookText(q: { id?: string; alert?: string; component?: string }) {
  const all = await runbooks();
  const hit = q.id ? all.filter((r) => r.id === q.id)
    : matchRunbooks(all, q.alert ? [q.alert] : [], q.component ? [q.component] : []).map((x) => x.r);
  return { runbooks: hit.map((r) => ({ id: r.id, title: r.title, text: renderRunbook(r) })), available: all.map((r) => r.id) };
}

// A component from the catalog: what it is, what it talks to, what breaks when a link breaks, its stage now.
export async function componentBrief(c: pg.Pool, id: string) {
  const t = topology();
  const n = t.nodes.find((x) => x.id === id);
  if (!n) return null;
  const st = await stagesAt(c, t).catch(() => null);
  const edges = t.edges.filter((e) => e.from === id || e.to === id);
  return clean({
    id: n.id, role: n.role, group: n.group, workloads: n.workloads, alerts: n.alerts ?? [], slos: n.slos ?? [], flux: n.flux,
    when_broken: n.when_broken ?? null, logs: n.logs ?? [], precedents: n.precedents ?? [],
    stage_now: st?.nodes[id] ? { stage: st.nodes[id].stage, reasons: st.nodes[id].reasons.map((r) => r.text), ready: st.nodes[id].ready, desired: st.nodes[id].desired, restarts_1h: st.nodes[id].restarts1h } : null,
    links: edges.map((e) => ({ from: e.from, to: e.to, via: e.via, note: e.note ?? '', when_broken: e.when_broken ?? null })),
    components: t.nodes.map((x) => x.id),
  });
}
