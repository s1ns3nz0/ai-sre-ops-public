// Postmortems (Google SRE practice) from lineth-observability postmortems/PM-*.md: YAML frontmatter (status,
// severity, components, authors, action items) + the blameless write-up. The repo is the source of truth; the
// console lists them, shows which incidents still owe one and tracks the action items. A draft for an incident is
// generated here and opened as a pull request.
import type pg from 'pg';
import { parse } from 'yaml';
import { listRepoDir, readRepoFile } from './detection.ts';
import { anchor, demoPostmortems, isDemo } from './demo.ts';
import { pool } from './db.ts';

export const PM_STATUSES = ['draft', 'reviewed', 'closed'] as const;
export const ACTION_TYPES = ['prevent', 'detect', 'mitigate', 'process'] as const;
export type PmAction = { id: string; type: (typeof ACTION_TYPES)[number]; priority: string; owner: string; status: 'open' | 'done' | 'dropped'; action: string; note: string };
export type Postmortem = {
  id: string; incident: string; title: string; status: (typeof PM_STATUSES)[number]; severity: number; date: string;
  incident_state: string; components: string[]; themes: string[]; authors: string[]; actions: PmAction[]; path: string; body: string; duration: string;
  summary: string; // the Summary section's first paragraph
};

// Pure: one file → a postmortem, or null when it has no valid frontmatter (generators/check-postmortems.py keeps
// the repo clean; the console skips what it cannot read).
export function parsePostmortem(path: string, text: string): Postmortem | null {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return null;
  let fm: Record<string, unknown>;
  try { fm = parse(m[1]) as Record<string, unknown>; } catch { return null; }
  if (typeof fm.id !== 'string' || !PM_STATUSES.includes(fm.status as never)) return null;
  const body = text.slice(m[0].length);
  const duration = /^\| Duration \| (.*) \|$/m.exec(body)?.[1] ?? '';
  const list = (k: string) => (Array.isArray(fm[k]) ? (fm[k] as unknown[]).map(String) : []);
  return {
    id: fm.id, incident: String(fm.incident ?? ''), title: String(fm.title ?? ''), status: fm.status as Postmortem['status'],
    severity: Number(fm.severity), date: String(fm.date ?? ''), incident_state: String(fm.incident_state ?? ''),
    components: list('components'), themes: list('themes'), authors: list('authors'), actions: (Array.isArray(fm.actions) ? fm.actions : []) as PmAction[],
    path, body, duration, summary: summaryOf(body),
  };
}

// The first paragraph of the Summary section, as one line.
function summaryOf(body: string): string {
  const sec = /^## (?:\d+\. )?Summary\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(body)?.[1] ?? '';
  return sec.trim().split(/\n\s*\n/)[0]?.replace(/\s+/g, ' ').trim() ?? '';
}

// ponytail: 60 s in-process cache, like the runbooks.
const g = globalThis as unknown as { pmCache?: { at: number; v: Postmortem[] } };
export async function postmortems(): Promise<Postmortem[]> {
  if (g.pmCache && Date.now() - g.pmCache.at < 60_000) return g.pmCache.v;
  const paths = (await listRepoDir('postmortems', '.md')).filter((p) => /\/PM-[^/]+\.md$/.test(p));
  const repo = (await Promise.all(paths.map(async (p) => parsePostmortem(p, (await readRepoFile(p)).text)))).filter((x) => x !== null);
  const v = [...(isDemo() ? demoPostmortems(await anchor(pool())) : []), ...repo].sort((a, b) => b.id.localeCompare(a.id));
  g.pmCache = { at: Date.now(), v };
  return v;
}

// Incidents that owe a postmortem (every SEV1–2 once resolved) and have none linked yet, or only a draft.
export type Due = { id: string; title: string; sev: number; state: string; resolved_at: Date | null; postmortem_id: string | null; postmortem_pr: string | null };
export async function due(db: pg.Pool, list: Postmortem[]): Promise<Due[]> {
  const rows = (await db.query<Due>(
    `SELECT id::text, title, sev, state, resolved_at, postmortem_id, postmortem_pr FROM incidents
     WHERE sev <= 2 AND state IN ('resolved', 'postmortem', 'closed') ORDER BY resolved_at`)).rows;
  const byId = new Map(list.map((p) => [p.id, p]));
  return rows.filter((r) => !r.postmortem_id || byId.get(r.postmortem_id)?.status === 'draft' || !byId.has(r.postmortem_id));
}

// The next postmortem number: the repo numbers incidents globally (PM-<date>-NN).
export function nextNumber(list: Postmortem[]): string {
  const n = Math.max(0, ...list.map((p) => Number(/-(\d{2})$/.exec(p.id)?.[1] ?? 0)));
  return String(n + 1).padStart(2, '0');
}

const md = (s: string) => s.replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
const hm = (d: Date | null | undefined) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '—');
const dur = (a: Date | null, b: Date | null) => (a && b ? `${Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60_000)} min` : '—');

// A first draft from what the console recorded: the timeline, decisions, checkpoints and follow-ups. The authors
// still write the summary, root causes and lessons; the draft says where.
export async function draftFor(db: pg.Pool, incidentId: string, list: Postmortem[], author: string): Promise<{ id: string; path: string; text: string }> {
  const inc = (await db.query<{ title: string; sev: number | null; impact: string; status_line: string; detected_at: Date; declared_at: Date | null; acked_at: Date | null; mitigated_at: Date | null; resolved_at: Date | null; roles: Record<string, { who: string }> }>(
    'SELECT title, sev, impact, status_line, detected_at, declared_at, acked_at, mitigated_at, resolved_at, roles FROM incidents WHERE id = $1', [incidentId])).rows[0];
  if (!inc) throw new Error('no such incident');
  const comps = (await db.query<{ c: string }>('SELECT DISTINCT component AS c FROM alerts WHERE incident_id = $1 AND component IS NOT NULL ORDER BY 1', [incidentId])).rows.map((r) => r.c);
  const alerts = (await db.query<{ alertname: string; severity: string; starts_at: Date }>('SELECT alertname, severity, min(starts_at) AS starts_at FROM alerts WHERE incident_id = $1 GROUP BY 1, 2 ORDER BY 3', [incidentId])).rows;
  const events = (await db.query<{ at: Date; kind: string; actor: string; body: Record<string, string> }>(
    `SELECT at, kind, actor, body FROM timeline WHERE incident_id = $1 AND kind IN ('state', 'sev', 'decision', 'note', 'checkpoint', 'action_run', 'action_result', 'ack')
     ORDER BY at`, [incidentId])).rows;
  const fus = (await db.query<{ action: string; type: string; priority: string; owner: string; done_at: Date | null; issue_number: number | null }>(
    'SELECT action, type, priority, owner, done_at, issue_number FROM follow_ups WHERE incident_id = $1 ORDER BY id', [incidentId])).rows;
  const date = new Date(inc.detected_at).toISOString().slice(0, 10);
  const nn = nextNumber(list);
  const id = `PM-${date}-${nn}`;
  const slug = inc.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
  const authors = [...new Set([inc.roles?.ic?.who, author].filter(Boolean))] as string[];
  const actions = fus.map((f, i) => ({ id: `A${i + 1}`, type: f.type, priority: f.priority, owner: f.owner, status: f.done_at ? 'done' : 'open', action: f.action, note: f.issue_number ? `issue #${f.issue_number}` : '' }));
  const line = (e: (typeof events)[number]) => {
    const b = e.body;
    const what = e.kind === 'state' ? `${b.from} → ${b.to}` : e.kind === 'sev' ? `SEV ${b.from ?? '—'} → ${b.to}` : e.kind === 'decision' ? `Decision: ${b.decision}${b.reason ? ` (why: ${b.reason})` : ''}`
      : e.kind === 'checkpoint' ? `Checkpoint: ${b.status_line}` : e.kind === 'ack' ? 'Page acknowledged' : e.kind === 'action_run' ? `Ran \`${b.command}\`` : e.kind === 'action_result' ? `Action result: ${b.ok ? 'ok' : `failed (${b.error})`}` : String(b.text ?? '');
    return `| ${hm(e.at)} | ${md(what)} (${e.actor}) |`;
  };
  const fm = ['---', `id: ${id}`, `incident: INC-${date}-${nn}`, `title: ${JSON.stringify(inc.title)}`, 'status: draft', `severity: ${inc.sev ?? 3}`, `date: ${date}`,
    'incident_state: resolved', `components: [${comps.join(', ')}]`, `authors: [${authors.join(', ')}]`,
    actions.length ? 'actions:' : 'actions: []', ...actions.map((a) => `  - ${JSON.stringify(a)}`), '---'];
  const text = `${fm.join('\n')}
# Postmortem: ${inc.title} (INC-${date}-${nn})

Blameless postmortem: it describes what the system and the process allowed, not who to blame. Drafted by AI SRE Ops
from console incident #${incidentId}; the sections marked TODO are for the authors. Times UTC.

| | |
|---|---|
| Status | draft — incident **resolved** ${hm(inc.resolved_at)} |
| Severity | SEV-${inc.sev ?? 3} |
| Authors | ${authors.join(', ')} |
| Duration | detected ${hm(inc.detected_at)} → resolved ${hm(inc.resolved_at)} (${dur(inc.detected_at, inc.resolved_at)}); acknowledged after ${dur(inc.detected_at, inc.acked_at)}; mitigated after ${dur(inc.detected_at, inc.mitigated_at)} |
| Related | console incident #${incidentId} |

## 1. Summary

TODO: what happened, in a few sentences a newcomer can follow. Last status: ${md(inc.status_line || '—')}

## 2. Impact

| what | how much |
|---|---|
| user-facing effect | ${md(inc.impact || 'TODO')} |
| SLOs / error budgets | TODO |

## 3. Root causes and trigger

TODO: the trigger and the root causes; ask "why" until the answer is something we can change.

## 4. Detection

| alert | severity | first fired |
|---|---|---|
${alerts.map((a) => `| ${a.alertname} | ${a.severity} | ${hm(a.starts_at)} |`).join('\n') || '| — | | |'}

## 5. Response and recovery

| time | event / action |
|---|---|
${events.map(line).join('\n') || '| — | |'}

## 6. Lessons learned

- **Went well:** TODO
- **Went badly:** TODO
- **Lucky:** TODO

## 7. Action items

| # | action | type | priority | owner | status |
|---|---|---|---|---|---|
${actions.map((a) => `| ${a.id} | ${md(a.action)} | ${a.type} | ${a.priority} | ${a.owner} | ${a.status}${a.note ? ` (${a.note})` : ''} |`).join('\n') || '| | TODO | | | | |'}
`;
  return { id, path: `postmortems/${id}-${slug}.md`, text };
}

// The write-up split for display: the facts table at the top, the numbered sections, the response timeline and
// the three lessons lists. Pure; anything that does not match is shown as Markdown.
export type Section = { n: string; title: string; text: string; slug: string };
export function splitBody(body: string): { facts: Record<string, string>; intro: string; sections: Section[] } {
  const lines = body.replace(/^# .*\n/, '').split('\n');
  const facts: Record<string, string> = {};
  const intro: string[] = [];
  const sections: Section[] = [];
  for (const line of lines) {
    const h = /^## (?:(\d+)\. )?(.+)$/.exec(line);
    if (h) { sections.push({ n: h[1] ?? '', title: h[2].trim(), text: '', slug: h[2].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') }); continue; }
    if (sections.length) { sections[sections.length - 1].text += `${line}\n`; continue; }
    const f = /^\| ([A-Z][\w ]+) \| (.*) \|$/.exec(line);
    if (f) facts[f[1].trim()] = f[2].trim(); else if (!/^\|[\s|-]*\|$/.test(line)) intro.push(line);
  }
  return { facts, intro: intro.join('\n').trim(), sections: sections.map((s) => ({ ...s, text: s.text.trim() })) };
}

// "| time | event | result |" tables → rows, when the first column is a time.
export function timelineRows(text: string): { time: string; what: string; result: string }[] | null {
  const rows = text.split('\n').filter((l) => l.startsWith('|'));
  if (rows.length < 3 || !/^\|\s*time/i.test(rows[0])) return null;
  const cells = (r: string) => r.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim());
  return rows.slice(2).map((r) => { const c = cells(r); return { time: c[0] ?? '', what: c[1] ?? '', result: c.slice(2).join(' · ') }; });
}

// "- **Went well:** …" bullets → the three lists Google SRE postmortems keep.
export function lessons(text: string): { well: string; badly: string; lucky: string } | null {
  const get = (k: string) => new RegExp(`\\*\\*${k}:\\*\\*\\s*([\\s\\S]*?)(?=\\n- \\*\\*|$)`).exec(text)?.[1].replace(/\s+/g, ' ').trim() ?? '';
  const out = { well: get('Went well'), badly: get('Went badly'), lucky: get('Lucky') };
  return out.well || out.badly || out.lucky ? out : null;
}
