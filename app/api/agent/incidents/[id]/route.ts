import { agentAuth } from '@/lib/agent-api.ts';
import { incidentBrief } from '@/lib/agent-data.ts';
import { pool } from '@/lib/db.ts';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = agentAuth(req);
  if (denied) return denied;
  const { id } = await params;
  if (!/^\d{1,10}$/.test(id)) return Response.json({ error: 'bad id' }, { status: 400 });
  const b = await incidentBrief(pool(), id);
  return b ? Response.json(b) : Response.json({ error: 'not found' }, { status: 404 });
}
