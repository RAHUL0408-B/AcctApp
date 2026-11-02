import { Pool, PoolClient, types } from 'pg';

// Return DATE columns as plain 'YYYY-MM-DD' strings. A JS Date would shift by the server's timezone (e.g. IST is UTC+5:30).
types.setTypeParser(1082, (v: string) => v);

let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/acctapp',
    });
  }
  return pool;
}

export async function closePool() {
  await pool?.end();
  pool = undefined;
}

/** Run work in a transaction without tenant scoping (for users, firms, memberships). */
export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await getPool().connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** Run work in a transaction locked to one organization (row-level security enforced). */
export async function withOrg<T>(orgId: number, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return tx(async (c) => {
    await c.query('SET LOCAL ROLE app_user');
    await c.query("SELECT set_config('app.org_id', $1, true)", [String(orgId)]);
    return fn(c);
  });
}
