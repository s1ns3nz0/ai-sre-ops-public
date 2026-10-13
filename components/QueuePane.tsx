'use client';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';

const KEY = 'queue-collapsed';

// The queue stays beside incidents and the overview; the map and detection pages get the full width.
// It folds to a thin strip on the left and opens again from it. The choice is remembered per browser.
export function QueuePane({ children }: { children: ReactNode }) {
  const path = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try { setCollapsed(localStorage.getItem(KEY) === '1'); } catch { /* storage blocked: stay open */ }
  }, []);
  const set = (v: boolean) => {
    setCollapsed(v);
    try { localStorage.setItem(KEY, v ? '1' : '0'); } catch { /* ignore */ }
  };
  if (path.startsWith('/infrastructure') || path.startsWith('/detection') || path.startsWith('/changes') || path.startsWith('/reliability') || path.startsWith('/handoff')) return null;

  if (collapsed) {
    return (
      <button type="button" onClick={() => set(false)} aria-label="Show incident queue" title="Show incident queue"
        className="group flex w-10 shrink-0 flex-col items-center gap-3 border-r border-line bg-canvas py-3 text-sub hover:bg-line/40 hover:text-ink">
        <span aria-hidden className="text-lg leading-none">»</span>
        <span className="text-xs font-medium tracking-wide [writing-mode:vertical-rl]">Incident queue</span>
      </button>
    );
  }
  return (
    <aside className="w-80 shrink-0 overflow-y-auto border-r border-line">
      <div className="flex items-center px-4 pt-3 text-xs font-medium text-sub">
        Incident queue
        <button type="button" onClick={() => set(true)} aria-label="Hide incident queue" title="Hide incident queue"
          className="ml-auto flex size-7 items-center justify-center rounded-md text-lg leading-none hover:bg-line/60 hover:text-ink">«</button>
      </div>
      {children}
    </aside>
  );
}
