'use client';
import { useRef, type ReactNode } from 'react';

// Native <dialog>: focus trap, Esc and backdrop come from the platform. Closes when a form inside is submitted.
// keepOpen: forms that show a result (e.g. a PR link) stay open after submit.
// trigger: custom button content (e.g. a checkbox row); label then becomes the accessible name.
export function Modal({ label, title, buttonClass, children, keepOpen = false, wide = false, trigger, disabled = false }: { label: string; title: string; buttonClass: string; children: ReactNode; keepOpen?: boolean; wide?: boolean; trigger?: ReactNode; disabled?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button type="button" className={buttonClass} disabled={disabled} aria-label={trigger ? label : undefined} onClick={() => ref.current?.showModal()}>{trigger ?? label}</button>
      <dialog
        ref={ref}
        onSubmit={() => { if (!keepOpen) ref.current?.close(); }}
        onClick={(e) => { if (e.target === ref.current) ref.current?.close(); }}
        className={`m-auto ${wide ? 'w-[min(48rem,calc(100vw-2rem))]' : 'w-[min(32rem,calc(100vw-2rem))]'} rounded-xl border border-line bg-surface p-0 text-left text-ink shadow-2xl backdrop:bg-ink/40`}
      >
        <div className="flex items-center border-b border-line px-5 py-3.5">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <button type="button" aria-label="Close" onClick={() => ref.current?.close()} className="ml-auto text-sub hover:text-ink text-lg leading-none">×</button>
        </div>
        <div className="max-h-[80vh] overflow-y-auto p-5">{children}</div>
      </dialog>
    </>
  );
}
