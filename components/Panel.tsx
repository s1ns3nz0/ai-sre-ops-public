import type { ReactNode } from 'react';

// A bordered block with a shaded header bar. Pages are stacks (or columns) of these, so sections never run together.
export function Panel({ title, count, aside, className = '', children }: { title: string; count?: number; aside?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={`overflow-hidden rounded-xl border border-line bg-surface ${className}`}>
      <header className="flex items-center gap-2 border-b border-line bg-canvas px-5 py-2.5">
        <h3 className="text-base font-semibold">{title}</h3>
        {count !== undefined && <span className="rounded-full bg-line px-2 text-xs font-medium text-ink/70">{count}</span>}
        {aside && <div className="ml-auto flex items-center gap-2">{aside}</div>}
      </header>
      {children}
    </section>
  );
}
