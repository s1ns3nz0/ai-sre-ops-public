import pg from 'pg';
import { demoDbUrl, isDemo } from './demo.ts';

// One pool per process; dev hot-reload keeps it on globalThis. Demo mode (DEMO=1) uses the seeded demo database.
const g = globalThis as unknown as { pool?: pg.Pool };

export function pool(): pg.Pool {
  if (!g.pool) {
    const url = process.env.DATABASE_URL;
    g.pool = new pg.Pool({ connectionString: isDemo() && url ? demoDbUrl(url) : url });
    // An idle client dropped by the server (DB restart) must not crash the process; the pool reconnects.
    g.pool.on('error', (e) => console.error('pg pool:', e.message));
  }
  return g.pool;
}

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>, p: pg.Pool = pool()): Promise<T> {
  const c = await p.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
