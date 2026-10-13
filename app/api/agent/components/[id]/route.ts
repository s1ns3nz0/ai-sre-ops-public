import { agentAuth } from '@/lib/agent-api.ts';
import { componentBrief } from '@/lib/agent-data.ts';
import { pool } from '@/lib/db.ts';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = agentAuth(req);
  if (denied) return denied;
  const b = await componentBrief(pool(), (await params).id.slice(0, 100));
  return b ? Response.json(b) : Response.json({ error: 'unknown component' }, { status: 404 });
}
