// Import CSV exports from other accounting software. Column names are matched by common aliases.
import { parseCsv, parseDate } from '../common/csv';
import { rupeesToPaise } from '../money';
import { isValidGstin } from '../tax/gst';

export interface ImportResult<T> { rows: T[]; errors: string[]; }

type Alias = Record<string, string[]>;
function headerIndex(head: string[], aliases: Alias) {
  const h = head.map((x) => x.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const idx: Record<string, number> = {};
  for (const [key, names] of Object.entries(aliases)) idx[key] = h.findIndex((x) => names.includes(x));
  return idx;
}
const cell = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
function table(csv: string, aliases: Alias, required: string[]) {
  const rows = parseCsv(csv);
  if (rows.length < 2) throw new Error('The file has no data rows');
  const idx = headerIndex(rows[0], aliases);
  const missing = required.filter((k) => idx[k] < 0);
  if (missing.length) throw new Error(`Missing column(s): ${missing.join(', ')}. Accepted names include: ${missing.map((m) => aliases[m].slice(0, 3).join('/')).join('; ')}`);
  return { idx, data: rows.slice(1) };
}

export interface ContactRow { kind: 'customer' | 'supplier' | 'both'; name: string; gstin?: string; pan?: string; stateCode?: string; email?: string; phone?: string;
  bankAccountName?: string; bankName?: string; bankAccountNo?: string; bankIfsc?: string; }
export function parseContacts(csv: string): ImportResult<ContactRow> {
  const { idx, data } = table(csv, {
    name: ['name', 'partyname', 'contactname', 'customername', 'suppliername', 'ledgername', 'displayname'],
    kind: ['type', 'kind', 'partytype', 'contacttype'], gstin: ['gstin', 'gstno', 'gstnumber', 'gstinuin'], pan: ['pan', 'panno'],
    state: ['statecode', 'state', 'placeofsupply'], email: ['email', 'emailid'], phone: ['phone', 'mobile', 'phoneno', 'contactno'],
    bankAccountName: ['bankaccountname', 'accountholder', 'accountholdername'], bankName: ['bankname', 'bank'], bankAccountNo: ['bankaccountno', 'bankaccountnumber', 'accountno', 'accountnumber'],
    bankIfsc: ['ifsc', 'ifsccode', 'bankifsc'],
  }, ['name']);
  const rows: ContactRow[] = [], errors: string[] = [];
  data.forEach((r, i) => {
    const n = i + 2, name = cell(r, idx.name);
    if (!name) return errors.push(`Row ${n}: name is empty`);
    const t = cell(r, idx.kind).toLowerCase();
    const kind = t.startsWith('sup') || t.startsWith('ven') || t.startsWith('cred') ? 'supplier' : t.startsWith('both') ? 'both' : 'customer';
    const gstin = cell(r, idx.gstin).toUpperCase();
    if (gstin && !isValidGstin(gstin)) return errors.push(`Row ${n}: invalid GSTIN ${gstin}`);
    const st = cell(r, idx.state).slice(0, 2);
    const ifsc = cell(r, idx.bankIfsc).toUpperCase(), acct = cell(r, idx.bankAccountNo).replace(/\s/g, '');
    if (ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) return errors.push(`Row ${n}: invalid IFSC ${ifsc}`);
    if (acct && !/^\d{6,20}$/.test(acct)) return errors.push(`Row ${n}: bank account number must be 6-20 digits`);
    rows.push({ kind, name, gstin: gstin || undefined, pan: cell(r, idx.pan).toUpperCase() || undefined, stateCode: /^\d{2}$/.test(st) ? st : undefined,
      email: cell(r, idx.email) || undefined, phone: cell(r, idx.phone) || undefined,
      bankAccountName: cell(r, idx.bankAccountName) || undefined, bankName: cell(r, idx.bankName) || undefined, bankAccountNo: acct || undefined, bankIfsc: ifsc || undefined });
  });
  return { rows, errors };
}

export interface AccountRow { code: string; name: string; type: string; group: string; }
export function parseAccounts(csv: string): ImportResult<AccountRow> {
  const { idx, data } = table(csv, { code: ['code', 'accountcode', 'ledgercode', 'no'], name: ['name', 'accountname', 'ledgername', 'ledger'],
    type: ['type', 'accounttype', 'class'], group: ['group', 'parent', 'accountgroup', 'category'] }, ['code', 'name', 'type']);
  const map: Record<string, string> = { asset: 'asset', assets: 'asset', liability: 'liability', liabilities: 'liability', equity: 'equity', capital: 'equity',
    income: 'income', revenue: 'income', sales: 'income', expense: 'expense', expenses: 'expense', cost: 'expense' };
  const rows: AccountRow[] = [], errors: string[] = [];
  data.forEach((r, i) => {
    const type = map[cell(r, idx.type).toLowerCase()];
    if (!cell(r, idx.code) || !cell(r, idx.name)) return errors.push(`Row ${i + 2}: code and name are required`);
    if (!type) return errors.push(`Row ${i + 2}: unknown account type "${cell(r, idx.type)}"`);
    rows.push({ code: cell(r, idx.code), name: cell(r, idx.name), type, group: cell(r, idx.group) || 'Imported' });
  });
  return { rows, errors };
}

export interface VoucherLine { account: string; debit: number; credit: number; memo?: string }
export interface Voucher { key: string; date: string; narration: string; lines: VoucherLine[]; }
/** Journal vouchers / opening balances. Rows sharing a voucher number form one entry; each must balance. */
export function parseVouchers(csv: string): ImportResult<Voucher> {
  const { idx, data } = table(csv, {
    voucher: ['voucherno', 'vouchernumber', 'voucher', 'entryno', 'journalno', 'ref', 'reference'], date: ['date', 'voucherdate', 'txndate'],
    account: ['account', 'accountcode', 'ledger', 'ledgername', 'accountname', 'code'], debit: ['debit', 'dr', 'debitamount'], credit: ['credit', 'cr', 'creditamount'],
    narration: ['narration', 'description', 'memo', 'particulars'],
  }, ['date', 'account', 'debit', 'credit']);
  const groups = new Map<string, Voucher>(), errors: string[] = [];
  data.forEach((r, i) => {
    const n = i + 2;
    try {
      const key = cell(r, idx.voucher) || `row${n}`;
      const money = (s: string) => (s ? rupeesToPaise(s) : 0);
      const debit = money(cell(r, idx.debit)), credit = money(cell(r, idx.credit));
      if ((debit === 0) === (credit === 0)) throw new Error('each row needs exactly one of debit or credit');
      const v = groups.get(key) ?? { key, date: parseDate(cell(r, idx.date)), narration: cell(r, idx.narration) || `Imported ${key}`, lines: [] };
      v.lines.push({ account: cell(r, idx.account), debit, credit });
      groups.set(key, v);
    } catch (e) { errors.push(`Row ${n}: ${(e as Error).message}`); }
  });
  const rows = [...groups.values()];
  for (const v of rows) {
    const d = v.lines.reduce((s, l) => s + l.debit, 0), c = v.lines.reduce((s, l) => s + l.credit, 0);
    if (d !== c) errors.push(`Voucher ${v.key}: debits ${d} and credits ${c} paise do not match`);
    if (v.lines.length < 2) errors.push(`Voucher ${v.key}: needs at least two lines`);
  }
  return { rows, errors };
}
