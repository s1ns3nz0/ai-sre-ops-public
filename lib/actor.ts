import { randomBytes } from 'node:crypto';
import { cookies, headers } from 'next/headers';

// oauth2-proxy sets X-Forwarded-User. The header is trusted, so the app must only be reachable through the proxy
// (ClusterIP Service + NetworkPolicy). Outside production there is no proxy and the actor is 'local'.
// The public demo's proxy sends the shared user "visitor"; each browser then gets its own name from a random cookie
// (visitor-1a2b3c), so the AI limit and the private chat are per browser. Only called from server actions, which may
// set the cookie.
export async function actor(): Promise<string> {
  const user = (await headers()).get('x-forwarded-user');
  if (user === 'visitor') return `visitor-${await visitorId()}`;
  if (user) return user.slice(0, 100);
  if (process.env.NODE_ENV === 'production') throw new Error('no authenticated user (X-Forwarded-User missing)');
  return 'local';
}

async function visitorId(): Promise<string> {
  const jar = await cookies();
  const v = jar.get('sre_vid')?.value;
  if (v && /^[0-9a-f]{6}$/.test(v)) return v;
  const id = randomBytes(3).toString('hex');
  jar.set('sre_vid', id, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 86_400, path: process.env.NEXT_PUBLIC_BASE_PATH || '/' });
  return id;
}
