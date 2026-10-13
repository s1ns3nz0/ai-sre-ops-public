// The answer format the agents are told to use (lineth-l2-gitops apps/ai-sre-ops/agents.yaml):
// ## Conclusion / ## Evidence / ## Next step / ## Details, headings in English whatever the answer's language.
// Anything else (older answers, a model that ignored the format): first paragraph as conclusion, the rest as details.
export type Parsed = { conclusion: string; evidence: string; next: string; details: string };
const KEYS: Record<string, keyof Parsed> = { conclusion: 'conclusion', evidence: 'evidence', 'next step': 'next', details: 'details' };

export function parseAnswer(md: string): Parsed {
  const out: Parsed = { conclusion: '', evidence: '', next: '', details: '' };
  let cur: keyof Parsed | null = null;
  const pre: string[] = [];
  for (const line of md.split('\n')) {
    const h = line.match(/^#{1,4}\s*(conclusion|evidence|next step|details)\b/i);
    if (h) { cur = KEYS[h[1].toLowerCase()]; continue; }
    if (cur) out[cur] += `${line}\n`; else pre.push(line);
  }
  if (!cur) {
    const text = md.trim();
    const i = text.search(/\n\s*\n/);
    return { conclusion: i < 0 ? text : text.slice(0, i), evidence: '', next: '', details: i < 0 ? '' : text.slice(i).trim() };
  }
  const t = (s: string) => s.trim();
  return { conclusion: t(out.conclusion) || t(pre.join('\n')), evidence: t(out.evidence), next: t(out.next), details: t(out.details) };
}
