import { agentAuth } from '@/lib/agent-api.ts';
import { storeBriefing } from '@/lib/agent-runs.ts';
import { BriefingInput, checkBriefing } from '@/lib/briefing.ts';
import { pool } from '@/lib/db.ts';
import { runbooks } from '@/lib/runbooks.ts';

// The AI submits its briefing (tool submit_briefing). Checked against the runbooks and the action catalog, stored
// as the incident's newest version; its actions wait for the IC. Errors go back to the agent so it can fix them.
export async function POST(req: Request) {
  const denied = agentAuth(req);
  if (denied) return denied;
  try {
    const input = BriefingInput.parse(await req.json());
    const b = checkBriefing(input, await runbooks());
    const r = await storeBriefing(pool(), String(input.incident_id), b);
    return Response.json({ ...r, note: 'Stored and shown to the IC. Actions wait for the IC to approve; you cannot run them.' });
  } catch (e) {
    return Response.json({ error: (e as Error).message.slice(0, 1500) }, { status: 400 });
  }
}
