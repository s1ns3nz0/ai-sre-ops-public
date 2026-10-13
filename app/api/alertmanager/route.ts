import { timingSafeEqual } from 'node:crypto';
import { tx } from '@/lib/db.ts';
import { isDemo } from '@/lib/demo.ts';
import { ingest, parsePayload } from '@/lib/ingest.ts';

const MAX_BYTES = 1_000_000;

function authorized(header: string | null): boolean {
  const token = process.env.WEBHOOK_TOKEN;
  if (!token || !header?.startsWith('Bearer ')) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Alertmanager receiver: webhook_configs.url = <app>/api/alertmanager, http_config.authorization.credentials = WEBHOOK_TOKEN.
export async function POST(req: Request) {
  if (isDemo()) return Response.json({ ignored: 'demo mode: the console shows the seeded scenario' }, { status: 202 });
  if (!process.env.WEBHOOK_TOKEN) return Response.json({ error: 'WEBHOOK_TOKEN not configured' }, { status: 503 });
  if (!authorized(req.headers.get('authorization'))) return Response.json({ error: 'unauthorized' }, { status: 401 });
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BYTES) return Response.json({ error: 'payload too large' }, { status: 413 });
  const raw = await req.text();
  if (Buffer.byteLength(raw) > MAX_BYTES) return Response.json({ error: 'payload too large' }, { status: 413 });
  let payload;
  try {
    payload = parsePayload(JSON.parse(raw));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
  const result = await tx((c) => ingest(c, payload));
  return Response.json(result);
}
