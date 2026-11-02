import { PoolClient } from 'pg';

/** Insert one balanced journal entry (the database re-checks balance at commit). */
export async function insertEntry(c: PoolClient, orgId: number, uid: number, date: string, narration: string,
  reference: string | null, reversesId: number | null, lines: { accountId: number; debit: number; credit: number; memo?: string }[]) {
  const e = (await c.query('INSERT INTO journal_entries(org_id,entry_date,narration,reference,reverses_id,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [orgId, date, narration, reference, reversesId, uid])).rows[0];
  for (const l of lines) {
    await c.query('INSERT INTO journal_lines(entry_id,org_id,account_id,debit,credit,memo) VALUES ($1,$2,$3,$4,$5,$6)',
      [e.id, orgId, l.accountId, l.debit, l.credit, l.memo ?? null]);
  }
  return Number(e.id);
}

/** Look up a system account (e.g. Debtors) by its code in this organization. */
export async function accountIdByCode(c: PoolClient, code: string): Promise<number> {
  const r = await c.query('SELECT id FROM accounts WHERE code=$1', [code]);
  if (!r.rowCount) throw new Error(`Required account ${code} is missing from the chart of accounts`);
  return Number(r.rows[0].id);
}
