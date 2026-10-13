'use client';
import { useSyncExternalStore } from 'react';
import { REGIONS, type RegionId } from '@/lib/time.ts';

// The viewer's own region: a per-browser preference, defaulting from the browser time zone.
const KEY = 'sreops.region';
const listeners = new Set<() => void>();

function guess(): RegionId {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (tz.startsWith('America/')) return 'us';
  if (tz.startsWith('Europe/')) return 'eu';
  return 'apac';
}

function read(): RegionId {
  try {
    const v = localStorage.getItem(KEY);
    if (REGIONS.some((r) => r.id === v)) return v as RegionId;
  } catch {}
  return guess();
}

export function setRegion(id: RegionId) {
  try { localStorage.setItem(KEY, id); } catch {}
  listeners.forEach((l) => l());
}

export function useRegion(): RegionId | null {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    read,
    () => null, // server: unknown until hydrated
  );
}

// Re-render every `ms` (clocks). Returns null on the server so markup never mismatches.
export function useNow(ms = 1000): Date | null {
  return useSyncExternalStore(
    (l) => { const t = setInterval(l, ms); return () => clearInterval(t); },
    () => Math.floor(Date.now() / ms),
    () => null,
  ) === null ? null : new Date();
}
