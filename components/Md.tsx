import Link from 'next/link';
import type { ReactNode } from 'react';

// The Markdown agents and postmortems use: headings, lists, tables, **bold**, `code`, links (web or console only) and
// paragraphs. Nothing else is interpreted; text is rendered as text (no HTML).
function inline(s: string): ReactNode[] {
  return s.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\))/).map((p, i) => {
    if (p.startsWith('`') && p.endsWith('`') && p.length > 1) return <code key={i} className="rounded bg-line/60 px-1 text-[0.9em] break-all">{p.slice(1, -1)}</code>;
    if (p.startsWith('**') && p.endsWith('**') && p.length > 3) return <b key={i} className="font-semibold">{inline(p.slice(2, -2))}</b>;
    const l = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(p);
    // Links only to the web or inside the console; anything else stays text.
    if (l && l[2].startsWith('/')) return <Link key={i} href={l[2]} className="underline underline-offset-2">{inline(l[1])}</Link>;
    if (l && /^https?:\/\//.test(l[2])) return <a key={i} href={l[2]} target="_blank" rel="noreferrer" className="underline underline-offset-2">{inline(l[1])}</a>;
    return p;
  });
}

function Table({ rows }: { rows: string[] }) {
  const cells = (r: string) => r.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
  const [head, , ...body] = rows;
  return (
    <div className="my-2 overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead><tr className="border-b border-line text-left text-xs text-sub">{cells(head).map((c, i) => <th key={i} className="py-1 pr-3 font-medium">{inline(c)}</th>)}</tr></thead>
        <tbody>{body.map((r, k) => <tr key={k} className="border-b border-line/60 align-top">{cells(r).map((c, i) => <td key={i} className="py-1 pr-3">{inline(c)}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

export function Md({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let para: string[] = []; // consecutive lines are one paragraph (hard-wrapped source)
  let table: string[] = [];
  const closePara = () => { if (para.length) out.push(<p key={out.length} className="my-1.5">{inline(para.join(' '))}</p>); para = []; };
  const closeList = () => {
    if (!list) return;
    const L = list.ordered ? 'ol' : 'ul';
    out.push(<L key={out.length} className={`my-1 space-y-0.5 pl-5 ${list.ordered ? 'list-decimal' : 'list-disc'}`}>{list.items.map((t, i) => <li key={i}>{inline(t)}</li>)}</L>);
    list = null;
  };
  const closeTable = () => { if (table.length >= 2) out.push(<Table key={out.length} rows={table} />); else for (const r of table) out.push(<p key={out.length} className="my-1">{inline(r)}</p>); table = []; };
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (line.startsWith('|')) { closePara(); closeList(); table.push(line); continue; }
    closeTable();
    const h = line.match(/^#{1,4}\s+(.*)/);
    const b = line.match(/^\s*[-*]\s+(.*)/);
    const n = line.match(/^\s*\d+[.)]\s+(.*)/);
    if (b || n) {
      closePara();
      const ordered = !!n;
      if (list && list.ordered !== ordered) closeList();
      (list ??= { ordered, items: [] }).items.push((b ?? n)![1]);
      continue;
    }
    // An indented line continues the last list item.
    if (list && /^\s+\S/.test(line)) { list.items[list.items.length - 1] += ` ${line.trim()}`; continue; }
    closeList();
    if (h) { closePara(); out.push(<h4 key={out.length} className="mt-3 mb-1 text-sm font-semibold first:mt-0">{inline(h[1])}</h4>); }
    else if (line.trim()) para.push(line.trim());
    else closePara();
  }
  closePara();
  closeList();
  closeTable();
  return <div className="text-sm leading-relaxed">{out}</div>;
}

// One line of text with the inline marks (code, bold, links).
export function MdInline({ text }: { text: string }) {
  return <>{inline(text)}</>;
}
