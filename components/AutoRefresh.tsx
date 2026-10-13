'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

// ponytail: 5 s polling via router.refresh; switch to SSE (PRD F7) when more than one viewer edits at once.
export function AutoRefresh({ ms = 5000 }: { ms?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible') router.refresh(); }, ms);
    return () => clearInterval(t);
  }, [router, ms]);
  return null;
}
