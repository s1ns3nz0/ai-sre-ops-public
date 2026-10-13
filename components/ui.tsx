import type { ReactNode } from 'react';

export function Card({ title, aside, children, className = '' }: { title?: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-line bg-surface ${className}`}>
      {title && (
        <header className="flex items-center gap-3 px-4 pt-3.5 pb-2">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          {aside && <div className="ml-auto">{aside}</div>}
        </header>
      )}
      <div className={title ? 'px-4 pb-4' : 'p-4'}>{children}</div>
    </section>
  );
}

export const button = {
  primary: 'inline-flex shrink-0 items-center whitespace-nowrap h-8 rounded-lg bg-ink px-3 text-sm font-medium text-white hover:bg-ink/85',
  quiet: 'inline-flex shrink-0 items-center whitespace-nowrap h-8 rounded-lg border border-line bg-surface px-3 text-sm text-ink hover:border-ink/40',
  danger: 'inline-flex shrink-0 items-center whitespace-nowrap h-8 rounded-lg border border-sev1/40 bg-surface px-3 text-sm text-sev1 hover:border-sev1',
};

export const field = 'w-full h-8 rounded-lg border border-line bg-surface px-2.5 text-sm placeholder:text-sub/70 focus:border-ink/40 outline-none';
