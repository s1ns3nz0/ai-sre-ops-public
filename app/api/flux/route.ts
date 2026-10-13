import { isDemo } from '@/lib/demo.ts';
import { pool } from '@/lib/db.ts';
import { parseFluxEvent, recordChange, verifySignature } from '@/lib/changes.ts';
import { topology } from '@/lib/topology.ts';

const MAX_BYTES = 100_000;

// Flux notification receiver: Provider type generic-hmac, address <app>/api/flux, secret key `token` = FLUX_WEBHOOK_SECRET.
export async function POST(req: Request) {
  if (isDemo()) return Response.json({ ignored: 'demo mode: the console shows the seeded scenario' }, { status: 202 });
  const secret = process.env.FLUX_WEBHOOK_SECRET;
  if (!secret) return Response.json({ error: 'FLUX_WEBHOOK_SECRET not configured' }, { status: 503 });
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BYTES) return Response.json({ error: 'payload too large' }, { status: 413 });
  const raw = await req.text();
  if (Buffer.byteLength(raw) > MAX_BYTES) return Response.json({ error: 'payload too large' }, { status: 413 });
  if (!verifySignature(raw, req.headers.get('x-signature'), secret)) return Response.json({ error: 'bad signature' }, { status: 401 });
  let event;
  try {
    event = parseFluxEvent(JSON.parse(raw));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
  const stored = await recordChange(pool(), event, topology());
  return Response.json({ stored });
}
