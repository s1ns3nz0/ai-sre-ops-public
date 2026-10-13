'use client';
import type { ReactNode } from 'react';
import { Modal } from './Modal.tsx';

const ROLE_CHIP: Record<string, string> = { IC: 'bg-ink text-white', Ops: 'bg-[var(--link)] text-white', Comms: 'bg-sev3 text-white', Planning: 'bg-emerald-600 text-white' };

// A lifecycle step. With checklist items still open it asks first (and lists them); it never blocks.
export function TransitionButton({ label, className, action, open }: {
  label: string; className: string; action: () => Promise<void>; open: { role: string; text: string }[];
}): ReactNode {
  if (!open.length) return <form action={action}><button className={className}>{label}</button></form>;
  return (
    <Modal label={label} title={`${label}?`} buttonClass={className}>
      <p className="text-sm">{open.length} checklist item{open.length === 1 ? ' is' : 's are'} still open, by role:</p>
      <div className="mt-3 max-h-80 space-y-2.5 overflow-y-auto">
        {[...new Set(open.map((i) => i.role))].map((role) => {
          const list = open.filter((i) => i.role === role);
          return (
            <section key={role} className="overflow-hidden rounded-lg border border-line">
              <header className="flex items-center gap-2 border-b border-line bg-canvas px-3 py-1.5">
                <span className={`rounded px-1.5 text-xs font-semibold ${ROLE_CHIP[role] ?? 'bg-line text-ink'}`}>{role}</span>
                <span className="text-xs text-sub">{list.length} open</span>
              </header>
              <ul className="divide-y divide-line text-sm">
                {list.map((i, k) => (
                  <li key={k} className="flex items-start gap-2 px-3 py-1.5">
                    <span aria-hidden className="mt-1 size-3 shrink-0 rounded-sm border border-sub/60" />{i.text}
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
      <form action={action} className="mt-4 flex justify-end">
        <button className={className}>{label} anyway</button>
      </form>
    </Modal>
  );
}
