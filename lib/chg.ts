// CHG records from lineth-l2-gitops docs/changes/CHG-*.md, read from their YAML frontmatter (PRD F12):
//   id, status, risk, window {start, end?}, components (topology node ids). Files without frontmatter are skipped.
// Source: GITOPS_REPO_DIR (local clone) or the GitHub contents API (GITOPS_REPO + GITOPS_GITHUB_TOKEN).
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { pool } from './db.ts';
import { anchor, demoChgs, isDemo } from './demo.ts';

export const CHG_STATUSES = ['draft', 'reviewed', 'approved', 'implementing', 'pir', 'closed'] as const;
export type Chg = {
  id: string; title: string; status: (typeof CHG_STATUSES)[number]; risk: 'low' | 'medium' | 'high';
  window: { start: Date; end: Date | null }; components: string[]; file: string; href: string;
};

const REPO = () => process.env.GITOPS_REPO ?? 's1ns3nz0/lineth-l2-gitops';
const DIR = 'docs/changes';

// Pure: frontmatter + first heading → Chg, or an error naming what is wrong.
export function parseChg(file: string, text: string): Chg | { error: string } | null {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return null;
  let fm: Record<string, unknown>;
  try { fm = parse(m[1]) as Record<string, unknown>; } catch (e) { return { error: `${file}: ${(e as Error).message}` }; }
  const w = (fm.window ?? {}) as Record<string, unknown>;
  const start = new Date(String(w.start ?? ''));
  const end = w.end ? new Date(String(w.end)) : null;
  const errs: string[] = [];
  if (typeof fm.id !== 'string' || !/^CHG-\d{4}-\d{2}-\d{2}-\d{2}$/.test(fm.id)) errs.push('id');
  if (!CHG_STATUSES.includes(fm.status as Chg['status'])) errs.push('status');
  if (!['low', 'medium', 'high'].includes(fm.risk as string)) errs.push('risk');
  if (Number.isNaN(start.getTime()) || (end && Number.isNaN(end.getTime()))) errs.push('window');
  if (!Array.isArray(fm.components) || fm.components.some((x) => typeof x !== 'string')) errs.push('components');
  if (errs.length) return { error: `${file}: invalid ${errs.join(', ')}` };
  const heading = /^# (.+)$/m.exec(text.slice(m[0].length))?.[1] ?? '';
  return {
    id: fm.id as string, title: heading.replace(/^CHG-[\d-]+\s*[—-]\s*/, ''), status: fm.status as Chg['status'],
    risk: fm.risk as Chg['risk'], window: { start, end }, components: fm.components as string[], file,
    href: `https://github.com/${REPO()}/blob/main/${file}`,
  };
}

async function files(): Promise<{ file: string; text: string }[]> {
  const local = process.env.GITOPS_REPO_DIR;
  if (local) {
    const names = (await readdir(path.join(local, DIR))).filter((n) => /^CHG-.*\.md$/.test(n));
    return Promise.all(names.map(async (n) => ({ file: `${DIR}/${n}`, text: await readFile(path.join(local, DIR, n), 'utf8') })));
  }
  const token = process.env.GITOPS_GITHUB_TOKEN;
  if (!token) return [];
  const gh = async <T,>(p: string) => {
    const r = await fetch(`https://api.github.com/repos/${REPO()}${p}`, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000), cache: 'no-store' });
    if (!r.ok) throw new Error(`GitHub ${r.status}`);
    return r.json() as Promise<T>;
  };
  const list = (await gh<{ name: string; path: string; type: string }[]>(`/contents/${DIR}`)).filter((f) => f.type === 'file' && /^CHG-.*\.md$/.test(f.name));
  return Promise.all(list.map(async (f) => ({ file: f.path, text: Buffer.from((await gh<{ content: string }>(`/contents/${f.path}`)).content, 'base64').toString('utf8') })));
}

// ponytail: 60 s in-process cache; CHGs change a few times a day.
const g = globalThis as unknown as { chgCache?: { at: number; v: { chgs: Chg[]; errors: string[] } } };

export async function chgs(): Promise<{ chgs: Chg[]; errors: string[] }> {
  if (isDemo()) return { chgs: demoChgs(await anchor(pool())), errors: [] };
  if (g.chgCache && Date.now() - g.chgCache.at < 60_000) return g.chgCache.v;
  const out = { chgs: [] as Chg[], errors: [] as string[] };
  try {
    for (const f of await files()) {
      const c = parseChg(f.file, f.text);
      if (c && 'error' in c) out.errors.push(c.error);
      else if (c) out.chgs.push(c);
    }
  } catch (e) {
    out.errors.push(`cannot read CHGs: ${(e as Error).message}`);
  }
  g.chgCache = { at: Date.now(), v: out };
  return out;
}

export const inProgress = (list: Chg[], now = new Date()) =>
  list.filter((c) => c.status === 'implementing' && c.window.start <= now && (!c.window.end || c.window.end >= now));
