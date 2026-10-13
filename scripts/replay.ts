// Replays an incident fixture into the webhook, keeping the original timestamps.
// Usage: WEBHOOK_TOKEN=... node scripts/replay.ts [fixture] [--url http://localhost:3000/api/alertmanager] [--delay-ms 300]
import { readFile } from 'node:fs/promises';
import { notifications } from '../lib/replay.ts';

const args = process.argv.slice(2);
const opt = (name: string, def: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
const fixture = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')) ?? 'fixtures/inc-2026-10-11-11.json';
const url = opt('--url', 'http://localhost:3000/api/alertmanager');
const delay = Number(opt('--delay-ms', '300'));
const token = process.env.WEBHOOK_TOKEN;
if (!token) throw new Error('WEBHOOK_TOKEN is required');

const { events } = JSON.parse(await readFile(fixture, 'utf8'));
for (const n of notifications(events)) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(n.payload),
  });
  const alert = (n.payload.alerts as { labels: { alertname: string }; status: string }[])[0];
  console.log(`${n.at}  ${n.incident}  ${alert.status.padEnd(8)} ${alert.labels.alertname.padEnd(30)} → ${res.status} ${await res.text()}`);
  if (!res.ok) process.exit(1);
  await new Promise((r) => setTimeout(r, delay));
}
