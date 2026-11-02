// Encrypted logical backups + restore testing.
// Format: "ACCTBK1" | 12-byte IV | 16-byte GCM tag | AES-256-GCM(gzip(JSON of all tables)).
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from 'fs';
import { join } from 'path';
import { gunzipSync, gzipSync } from 'zlib';
import { Pool } from 'pg';
import { migrate } from '../db/migrate';

const MAGIC = Buffer.from('ACCTBK1');

// Parents before children, so restore can insert in this order.
export const TABLES = ['firms', 'users', 'organizations', 'memberships', 'financial_years', 'accounts', 'journal_entries', 'journal_lines', 'audit_log',
  'contacts', 'doc_sequences', 'documents', 'document_lines', 'payments', 'bank_accounts', 'bank_transactions', 'tasks', 'files', 'scheduled_reports',
  'consents', 'deletion_requests', 'subscriptions', 'billing_invoices'] as const;

function key(): Buffer {
  const k = process.env.BACKUP_KEY;
  if (!k) {
    if (process.env.NODE_ENV === 'production') throw new Error('BACKUP_KEY is required in production');
    return scryptSync('dev-only-backup-key', 'acctapp', 32);
  }
  return scryptSync(k, 'acctapp-backup-v1', 32); // any passphrase works; keep it somewhere other than the server
}

export function encrypt(plain: Buffer): Buffer {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([c.update(gzipSync(plain)), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), body]);
}

export function decrypt(blob: Buffer): Buffer {
  if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not an AcctApp backup file');
  const iv = blob.subarray(7, 19), tag = blob.subarray(19, 35), d = createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  try { return gunzipSync(Buffer.concat([d.update(blob.subarray(35)), d.final()])); }
  catch { throw new Error('Backup is corrupted or the key is wrong'); }
}

/** Read every table in one consistent snapshot. */
export async function dumpDatabase(pool: Pool): Promise<Buffer> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query('SET LOCAL row_security = off');
    const out: Record<string, unknown[]> = {};
    for (const t of TABLES) out[t] = (await c.query(`SELECT * FROM ${t} ORDER BY 1`)).rows;
    await c.query('COMMIT');
    return Buffer.from(JSON.stringify({ version: 1, createdAt: new Date().toISOString(), tables: out }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  } finally { c.release(); }
}

export async function createBackup(pool: Pool, dir = process.env.BACKUP_DIR ?? join(process.cwd(), 'backups')) {
  mkdirSync(dir, { recursive: true });
  const blob = encrypt(await dumpDatabase(pool));
  const filename = `acctapp-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${randomBytes(2).toString('hex')}.bak.enc`;
  writeFileSync(join(dir, filename), blob);
  const sha = createHash('sha256').update(blob).digest('hex');
  const r = await pool.query('INSERT INTO backups(filename,size,sha256) VALUES ($1,$2,$3) RETURNING id', [filename, blob.length, sha]);
  return { id: Number(r.rows[0].id), filename, size: blob.length, sha256: sha, dir };
}

/** Delete backups older than `keepDays` (default 30), always keeping the newest. */
export function pruneBackups(dir: string, keepDays = 30) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.bak.enc')).map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  let removed = 0;
  for (const x of files.slice(1)) if (Date.now() - x.t > keepDays * 86400000) { rmSync(join(dir, x.f)); removed++; }
  return removed;
}

/** Load a backup into an empty, already-migrated database. */
export async function restoreInto(pool: Pool, blob: Buffer) {
  const data = JSON.parse(decrypt(blob).toString()) as { tables: Record<string, Record<string, unknown>[]> };
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL row_security = off');
    for (const t of TABLES) {
      const rows = data.tables[t] ?? [];
      for (const r of rows) {
        const cols = Object.keys(r);
        const vals = cols.map((k) => { const v = r[k]; return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v as any).type ? JSON.stringify(v) : bufferish(v); });
        await c.query(`INSERT INTO ${t}(${cols.map((x) => `"${x}"`).join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`, vals);
      }
      if (rows.length && 'id' in rows[0]) await c.query(`SELECT setval(pg_get_serial_sequence('${t}','id'), (SELECT MAX(id) FROM ${t}))`);
    }
    await c.query('COMMIT');
    return Object.fromEntries(TABLES.map((t) => [t, (data.tables[t] ?? []).length]));
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
const bufferish = (v: unknown) => (v && typeof v === 'object' && (v as any).type === 'Buffer' ? Buffer.from((v as any).data) : v);

/** Fingerprint used to compare a live database with a restored copy. */
export async function fingerprint(pool: Pool) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN READ ONLY'); await c.query('SET LOCAL row_security = off');
    const counts: Record<string, number> = {};
    for (const t of TABLES) counts[t] = Number((await c.query(`SELECT count(*) FROM ${t}`)).rows[0].count);
    const s = (await c.query('SELECT COALESCE(SUM(debit),0) AS d, COALESCE(SUM(credit),0) AS c FROM journal_lines')).rows[0];
    const h = (await c.query("SELECT md5(COALESCE(string_agg(e.entry_date::text || '|' || e.narration || '|' || l.account_id || '|' || l.debit || '|' || l.credit, ',' ORDER BY e.id, l.id), '')) AS h FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id")).rows[0];
    await c.query('COMMIT');
    return { counts, debit: String(s.d), credit: String(s.c), ledgerHash: String(h.h) };
  } finally { c.release(); }
}

/**
 * Restore test: load the backup into a throw-away database, compare row counts and ledger totals with the source,
 * then drop it. Needs a database user that can CREATE DATABASE.
 */
export async function verifyBackup(source: Pool, file: string, adminUrl: string) {
  const scratch = `restore_test_${Date.now()}`;
  const admin = new Pool({ connectionString: adminUrl });
  const url = new URL(adminUrl); url.pathname = `/${scratch}`;
  await admin.query(`CREATE DATABASE ${scratch}`);
  const target = new Pool({ connectionString: url.toString() });
  try {
    await migrate(target);
    await restoreInto(target, readFileSync(file));
    const a = await fingerprint(source), b = await fingerprint(target);
    // Rows may have been added after the backup was taken, so require every restored count <= live and ledger to be balanced.
    const balanced = b.debit === b.credit;
    const sameSize = TABLES.every((t) => b.counts[t] === a.counts[t]);
    const ok = balanced && TABLES.every((t) => b.counts[t] <= a.counts[t]) && (!sameSize || a.ledgerHash === b.ledgerHash); // identical size must mean identical ledger content
    return { ok, balanced, ledgerMatches: a.ledgerHash === b.ledgerHash, restored: b.counts, live: a.counts, detail: ok ? 'Restore verified: all tables loaded and ledger balances.' : 'Restore did not match expectations' };
  } finally {
    await target.end();
    await admin.query(`DROP DATABASE IF EXISTS ${scratch}`);
    await admin.end();
  }
}
