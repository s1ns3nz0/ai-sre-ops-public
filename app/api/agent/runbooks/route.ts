import { agentAuth } from '@/lib/agent-api.ts';
import { runbookText } from '@/lib/agent-data.ts';

export async function GET(req: Request) {
  const denied = agentAuth(req);
  if (denied) return denied;
  const u = new URL(req.url);
  const v = (k: string) => u.searchParams.get(k)?.slice(0, 100) || undefined;
  return Response.json(await runbookText({ id: v('id'), alert: v('alert'), component: v('component') }));
}
