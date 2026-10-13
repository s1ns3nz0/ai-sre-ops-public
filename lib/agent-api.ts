import { bearerOk } from './bearer.ts';

// Guard for /api/agent/*: only the tool server (AGENT_API_TOKEN) may call it.
export function agentAuth(req: Request): Response | null {
  if (!process.env.AGENT_API_TOKEN) return Response.json({ error: 'AGENT_API_TOKEN not configured' }, { status: 503 });
  return bearerOk(req.headers.get('authorization'), process.env.AGENT_API_TOKEN) ? null : Response.json({ error: 'unauthorized' }, { status: 401 });
}
