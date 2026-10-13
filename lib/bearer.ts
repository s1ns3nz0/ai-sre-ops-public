import { timingSafeEqual } from 'node:crypto';

// Constant-time check of `Authorization: Bearer <token>` against a configured token; false when none is set.
export function bearerOk(header: string | null, token: string | undefined): boolean {
  if (!token || !header?.startsWith('Bearer ')) return false;
  const a = Buffer.from(header.slice(7)), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
