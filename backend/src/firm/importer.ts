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
  bankAccountName?: string; bankName?: string; bankAccountNo?: string; bankIfsc?: string;
  addressLine1?: string; addressLine2?: string; city?: string; pincode?: string; constitution?: string; defaultTdsSection?: string; }
/** One thing wrong in an imported row, with what to change so the next import works. */
export interface ImportProblem { row: number; name: string; column: string; value: string; problem: string; fix: string }

const CONSTITUTION_WORDS: [RegExp, string][] = [
  [/^(individual|proprietor|proprietorship|sole)/, 'individual'], [/^huf|hindu undivided/, 'huf'], [/^llp|limited liability partnership/, 'llp'],
  [/^partnership|^firm/, 'partnership'], [/^(opc|one person)/, 'opc'], [/^(pvt|private)/, 'private_company'], [/^(public|ltd|limited)/, 'public_company'],
  [/^(aop|association of persons)/, 'aop'], [/^(boi|body of individuals)/, 'boi'], [/^trust/, 'trust'], [/^society/, 'society'], [/^co-?operative/, 'cooperative'],
  [/^(government|govt)/, 'government'], [/^local authority/, 'local_authority'], [/^(ajp|artificial juridical)/, 'ajp'], [/^foreign company/, 'foreign_company'], [/^other/, 'other'],
];
export const constitutionOf = (s: string) => { const t = s.trim().toLowerCase(); return t ? CONSTITUTION_WORDS.find(([re]) => re.test(t))?.[1] ?? null : undefined; };

export function parseContacts(csv: string): ImportResult<ContactRow> & { problems: ImportProblem[] } {
  const { idx, data } = table(csv, {
    name: ['name', 'partyname', 'contactname', 'customername', 'suppliername', 'ledgername', 'displayname'],
    kind: ['type', 'kind', 'partytype', 'contacttype'], gstin: ['gstin', 'gstno', 'gstnumber', 'gstinuin'], pan: ['pan', 'panno'],
    state: ['statecode', 'state', 'placeofsupply'], email: ['email', 'emailid'], phone: ['phone', 'mobile', 'phoneno', 'contactno'],
    bankAccountName: ['bankaccountname', 'accountholder', 'accountholdername'], bankName: ['bankname', 'bank'], bankAccountNo: ['bankaccountno', 'bankaccountnumber', 'accountno', 'accountnumber'],
    bankIfsc: ['ifsc', 'ifsccode', 'bankifsc'],
    address1: ['address', 'addressline1', 'address1', 'billingaddress', 'street'], address2: ['addressline2', 'address2'], city: ['city', 'town'],
    pincode: ['pincode', 'pin', 'postcode', 'zip', 'zipcode'], constitution: ['constitution', 'constitutionofbusiness', 'entitytype', 'businesstype'],
    tds: ['tdssection', 'defaulttdssection', 'tds'],
  }, ['name']);
  const rows: ContactRow[] = [], errors: string[] = [], problems: ImportProblem[] = [];
  data.forEach((r, i) => {
    const n = i + 2, name = cell(r, idx.name);
    const bad = (column: string, value: string, problem: string, fix: string) => problems.push({ row: n, name: name || '(no name)', column, value, problem, fix });
    const before = problems.length;
    if (!name) bad('Name', '', 'Name is empty', 'Type the customer or supplier name in the Name column.');
    const t = cell(r, idx.kind).toLowerCase();
    const kind = t.startsWith('sup') || t.startsWith('ven') || t.startsWith('cred') ? 'supplier' : t.startsWith('both') ? 'both' : 'customer';
    if (t && !/^(cus|deb|sup|ven|cred|both)/.test(t)) bad('Type', cell(r, idx.kind), 'Type is not recognised', 'Write Customer, Supplier or Both.');
    const gstin = cell(r, idx.gstin).toUpperCase().replace(/\s/g, '');
    if (gstin && !/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin)) bad('GSTIN', gstin, 'GSTIN is not 15 characters in the right pattern', 'A GSTIN is 2 digits (state), the 10-character PAN, 1 digit, Z and 1 check character, e.g. 27AAPFU0939F1ZV. Leave it empty for an unregistered party.');
    else if (gstin && !isValidGstin(gstin)) bad('GSTIN', gstin, 'GSTIN check digit is wrong (a character is mistyped)', 'Copy the GSTIN again from the GST portal (Search Taxpayer) or the party\'s invoice.');
    const pan = cell(r, idx.pan).toUpperCase().replace(/\s/g, '');
    if (pan && !/^[A-Z]{5}\d{4}[A-Z]$/.test(pan)) bad('PAN', pan, 'PAN is not in the right pattern', 'A PAN is 5 letters, 4 digits and 1 letter, e.g. AAACA1234A.');
    else if (pan && gstin && gstin.slice(2, 12) !== pan) bad('PAN', pan, 'PAN does not match the PAN inside the GSTIN', `Use ${gstin.slice(2, 12)} (characters 3 to 12 of the GSTIN), or correct the GSTIN.`);
    const stRaw = cell(r, idx.state), st = stRaw.slice(0, 2);
    if (stRaw && !/^\d{2}/.test(stRaw)) bad('State Code', stRaw, 'State must be the 2-digit GST state code', 'Use the code, e.g. 27 for Maharashtra, 29 for Karnataka, 07 for Delhi.');
    else if (stRaw && gstin && gstin.slice(0, 2) !== st) bad('State Code', stRaw, 'State code differs from the first two digits of the GSTIN', `Use ${gstin.slice(0, 2)}, or leave the state empty: it is taken from the GSTIN.`);
    const email = cell(r, idx.email);
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) bad('Email', email, 'Email address is not valid', 'Use one address like accounts@example.com (no spaces; separate addresses are not supported).');
    const phone = cell(r, idx.phone);
    if (phone && phone.length > 20) bad('Phone', phone, 'Phone is longer than 20 characters', 'Keep one number, e.g. 9876543210.');
    const ifsc = cell(r, idx.bankIfsc).toUpperCase(), acct = cell(r, idx.bankAccountNo).replace(/\s/g, '');
    if (ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) bad('IFSC', ifsc, 'IFSC code is not valid', '11 characters: 4 letters, 0, then 6 letters or digits, e.g. HDFC0000001.');
    if (acct && !/^\d{6,20}$/.test(acct)) bad('Bank Account Number', acct, 'Bank account number must be 6 to 20 digits', 'Digits only: remove letters, dashes and spaces. In Excel, format the column as Text so long numbers are not rounded.');
    const pin = cell(r, idx.pincode);
    if (pin && !/^[A-Za-z0-9 -]{3,12}$/.test(pin)) bad('PIN code', pin, 'PIN code looks wrong', 'Use the 6-digit PIN code, e.g. 411001.');
    const consRaw = cell(r, idx.constitution), cons = constitutionOf(consRaw);
    if (consRaw && cons === null) bad('Constitution', consRaw, 'Constitution is not recognised', 'Write one of: Individual, HUF, Partnership, LLP, Private company, Public company, OPC, AOP, BOI, Trust, Society, Co-operative, Government, Other.');
    const tds = cell(r, idx.tds).toUpperCase().replace(/\s/g, '');
    if (tds && !/^194[A-Z]{0,2}(\([A-Z0-9]+\))?$/.test(tds)) bad('TDS Section', tds, 'TDS section is not recognised', 'Write the section like 194C, 194J, 194J(a), 194H or 194I(b), or leave it empty.');
    if (problems.length > before) { errors.push(`Row ${n}: ${problems.slice(before).map((p) => p.problem).join('; ')}`); return; }
    rows.push({ kind, name, gstin: gstin || undefined, pan: pan || undefined, stateCode: /^\d{2}$/.test(st) ? st : undefined,
      email: email || undefined, phone: phone || undefined,
      bankAccountName: cell(r, idx.bankAccountName) || undefined, bankName: cell(r, idx.bankName) || undefined, bankAccountNo: acct || undefined, bankIfsc: ifsc || undefined,
      addressLine1: cell(r, idx.address1) || undefined, addressLine2: cell(r, idx.address2) || undefined, city: cell(r, idx.city) || undefined, pincode: pin || undefined,
      constitution: cons ?? undefined, defaultTdsSection: tds || undefined });
  });
  return { rows, errors, problems };
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
