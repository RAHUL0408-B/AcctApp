import { PoolClient } from 'pg';
import type { Line } from './ledger';

/** Insert one balanced journal entry (the database re-checks balance at commit). Closing entries are marked so profit reports can skip them. */
export async function insertEntry(c: PoolClient, orgId: number, uid: number, date: string, narration: string,
  reference: string | null, reversesId: number | null, lines: Line[], kind: 'normal' | 'closing' = 'normal') {
  const e = (await c.query('INSERT INTO journal_entries(org_id,entry_date,narration,reference,reverses_id,created_by,kind) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
    [orgId, date, narration, reference, reversesId, uid, kind])).rows[0];
  for (const l of lines) {
    await c.query('INSERT INTO journal_lines(entry_id,org_id,account_id,debit,credit,memo,tracking_option_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [e.id, orgId, l.accountId, l.debit, l.credit, l.memo ?? null, l.trackingOptionId ?? null]);
  }
  return Number(e.id);
}

/** Look up a system account (e.g. Debtors) by its code in this organization. */
export async function accountIdByCode(c: PoolClient, code: string): Promise<number> {
  const r = await c.query('SELECT id FROM accounts WHERE code=$1', [code]);
  if (!r.rowCount) throw new Error(`Required account ${code} is missing from the chart of accounts`);
  return Number(r.rows[0].id);
}

/** System accounts added after an organisation was created. They are created the first time a feature needs them. */
export const SYSTEM_ACCOUNTS = {
  '1200': { name: 'Inventory / Stock', type: 'asset', group: 'Current Assets' },
  '2130': { name: 'RCM CGST Payable', type: 'liability', group: 'GST Payable' },
  '2140': { name: 'RCM SGST Payable', type: 'liability', group: 'GST Payable' },
  '2150': { name: 'RCM IGST Payable', type: 'liability', group: 'GST Payable' },
  '2310': { name: 'Employee Reimbursements Payable', type: 'liability', group: 'Current Liabilities' },
  '3100': { name: 'Reserves and Surplus', type: 'equity', group: 'Capital' },
  '4300': { name: 'Foreign Exchange Gain / Loss', type: 'income', group: 'Other Income' },
  '5050': { name: 'Cost of Goods Sold', type: 'expense', group: 'Cost of Goods Sold' },
} as const;

/** Like accountIdByCode, but creates the account from SYSTEM_ACCOUNTS if this organisation does not have it yet. */
export async function ensureAccount(c: PoolClient, orgId: number, code: keyof typeof SYSTEM_ACCOUNTS): Promise<number> {
  const found = await c.query('SELECT id FROM accounts WHERE code=$1', [code]);
  if (found.rowCount) return Number(found.rows[0].id);
  const a = SYSTEM_ACCOUNTS[code];
  return Number((await c.query('INSERT INTO accounts(org_id,code,name,type,group_name) VALUES ($1,$2,$3,$4,$5) RETURNING id', [orgId, code, a.name, a.type, a.group])).rows[0].id);
}
