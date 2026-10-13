// Runbooks (PRD F6) from lineth-observability runbooks/*.md: frontmatter + six sections. Parsed into blocks the UI
// renders: text, steps (`- [ ]`, ticked per incident onto the timeline), queries (```promql run read-only,
// ```logql open Grafana Explore). Only this restricted format is supported; generators/check-runbooks.py enforces it.
import { createHash } from 'node:crypto';
import { listRepoDir, readRepoFile } from './detection.ts';

export type Block =
  | { kind: 'text'; text: string }
  | { kind: 'item'; text: string }
  | { kind: 'step'; key: string; text: string }
  | { kind: 'code'; lang: string; text: string };
export type Runbook = {
  id: string; title: string; path: string; alerts: string[]; components: string[]; severity: string; impact_slo: string[];
  owner: string; last_reviewed: string; automation_candidate: boolean; precedents: string[];
  sections: { title: string; blocks: Block[] }[];
};

function frontmatter(src: string): Record<string, string | string[] | boolean> {
  const out: Record<string, string | string[] | boolean> = {};
  for (const line of src.split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const k = line.slice(0, i).trim(), v = line.slice(i + 1).trim();
    out[k] = v.startsWith('[') && v.endsWith(']') ? v.slice(1, -1).split(',').map((x) => x.trim()).filter(Boolean) : v === 'true' ? true : v === 'false' ? false : v;
  }
  return out;
}

// A step's key is stable across edits elsewhere in the file: section + its text.
export const stepKey = (section: string, text: string) => createHash('sha256').update(`${section}\n${text}`).digest('hex').slice(0, 16);

export function parseRunbook(path: string, md: string): Runbook {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(md);
  const fm = m ? frontmatter(m[1]) : {};
  const body = m ? md.slice(m[0].length) : md;
  const list = (k: string) => (Array.isArray(fm[k]) ? (fm[k] as string[]) : []);
  const rb: Runbook = {
    id: String(fm.id ?? path.replace(/^.*\/|\.md$/g, '')), title: (/^# (.+)$/m.exec(body)?.[1] ?? String(fm.id ?? path)).replaceAll('`', ''), path,
    alerts: list('alerts'), components: list('components'), severity: String(fm.severity ?? ''), impact_slo: list('impact_slo'),
    owner: String(fm.owner ?? ''), last_reviewed: String(fm.last_reviewed ?? ''), automation_candidate: fm.automation_candidate === true,
    precedents: list('precedents'), sections: [],
  };
  let sec: Runbook['sections'][number] | null = null;
  let para: string[] = [];
  const flush = () => { if (sec && para.length) sec.blocks.push({ kind: 'text', text: para.join(' ') }); para = []; };
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const h = /^## (.+)$/.exec(l);
    if (h) { flush(); sec = { title: h[1], blocks: [] }; rb.sections.push(sec); continue; }
    if (!sec) continue;
    const fence = /^```(\w*)$/.exec(l);
    if (fence) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && lines[i] !== '```'; i++) code.push(lines[i]);
      sec.blocks.push({ kind: 'code', lang: fence[1], text: code.join('\n') });
      continue;
    }
    const step = /^- \[[ xX]\] (.+)$/.exec(l);
    if (step) { flush(); sec.blocks.push({ kind: 'step', key: stepKey(sec.title, step[1]), text: step[1] }); continue; }
    const item = /^- (.+)$/.exec(l);
    if (item) { flush(); sec.blocks.push({ kind: 'item', text: item[1] }); continue; }
    if (/^\s+\S/.test(l) && sec.blocks.at(-1)?.kind === 'item' && !para.length) { (sec.blocks.at(-1) as { text: string }).text += ` ${l.trim()}`; continue; }
    if (!l.trim()) { flush(); continue; }
    para.push(l.trim());
  }
  flush();
  return rb;
}

// ponytail: 60 s in-process cache, like the other repo reads.
const rc = globalThis as unknown as { runbookCache?: { at: number; v: Runbook[] } };
export async function runbooks(): Promise<Runbook[]> {
  if (rc.runbookCache && Date.now() - rc.runbookCache.at < 60_000) return rc.runbookCache.v;
  const paths = await listRepoDir('runbooks', '.md').catch(() => [] as string[]);
  const v = await Promise.all(paths.filter((p) => !/README/i.test(p)).map(async (p) => parseRunbook(p, (await readRepoFile(p)).text)));
  rc.runbookCache = { at: Date.now(), v };
  return v;
}

// Runbooks for an incident or component: by alert name first, then by component.
export function matchRunbooks(all: Runbook[], alertnames: string[], components: string[]) {
  return all
    .map((r) => ({ r, by: r.alerts.filter((a) => alertnames.includes(a)), comps: r.components.filter((c) => components.includes(c)) }))
    .filter((x) => x.by.length || x.comps.length)
    .sort((a, b) => b.by.length - a.by.length || b.comps.length - a.comps.length);
}
