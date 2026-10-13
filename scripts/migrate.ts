// Applies db/schema.sql (idempotent). Usage: DATABASE_URL=... node scripts/migrate.ts
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const sql = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query(sql);
  console.log('schema applied');
} finally {
  await client.end();
}
