import { deadlinesBetween, Rule } from '../src/firm/deadlines';
import { parseAccounts, parseContacts, parseVouchers } from '../src/firm/importer';

const rules: Rule[] = [
  { code: 'GSTR1', title: 'GSTR-1', frequency: 'monthly', dueDay: 11, dueMonthOffset: 1, appliesWhen: 'gstin' },
  { code: 'GSTR3B', title: 'GSTR-3B', frequency: 'monthly', dueDay: 20, dueMonthOffset: 1, appliesWhen: 'gstin' },
  { code: 'TDS_PAY', title: 'TDS payment', frequency: 'monthly', dueDay: 7, dueMonthOffset: 1, appliesWhen: 'always' },
  { code: 'TDS_RETURN', title: 'TDS return', frequency: 'quarterly', dueDay: 31, dueMonthOffset: 1, appliesWhen: 'always' },
];

describe('compliance deadlines', () => {
  it('June period: GSTR-1 on 11 Jul, GSTR-3B on 20 Jul, TDS payment on 7 Jul', () => {
    const d = deadlinesBetween(rules, '2025-07-01', '2025-07-31', true);
    expect(d.filter((x) => x.period === '2025-06').map((x) => `${x.ruleCode}:${x.dueDate}`)).toEqual(['TDS_PAY:2025-07-07', 'GSTR1:2025-07-11', 'GSTR3B:2025-07-20']);
  });
  it('quarterly TDS returns: Q4 -> 31 May, Q1 -> 31 Jul, Q2 -> 31 Oct, Q3 -> 31 Jan', () => {
    const d = deadlinesBetween(rules, '2025-04-01', '2026-06-30', false).filter((x) => x.ruleCode === 'TDS_RETURN');
    expect(d.map((x) => x.dueDate)).toEqual(['2025-05-31', '2025-07-31', '2025-10-31', '2026-01-31', '2026-05-31']);
  });
  it('GST returns are skipped for clients without a GSTIN; the year rolls over correctly', () => {
    expect(deadlinesBetween(rules, '2026-01-01', '2026-01-31', false).map((x) => x.ruleCode)).toEqual(['TDS_PAY', 'TDS_RETURN']);
    expect(deadlinesBetween(rules, '2026-01-01', '2026-01-31', true).find((x) => x.ruleCode === 'GSTR3B')).toMatchObject({ period: '2025-12', dueDate: '2026-01-20' });
  });
  it('clips day 31 to month end (e.g. due day 31 in a 30-day month)', () => {
    const r: Rule[] = [{ ...rules[3], frequency: 'monthly', dueMonthOffset: 1 }];
    expect(deadlinesBetween(r, '2025-06-01', '2025-06-30', false)[0].dueDate).toBe('2025-06-30');
  });
});

describe('CSV importers', () => {
  it('contacts: maps common aliases, infers supplier, flags a bad GSTIN, keeps good rows', () => {
    const r = parseContacts('Party Name,Type,GST No,Mobile\nAcme,Customer,,99999\nSupply Co,Vendor,,\nBad Co,Customer,27AAPFU0939F1ZX,');
    expect(r.rows.map((x) => [x.name, x.kind])).toEqual([['Acme', 'customer'], ['Supply Co', 'supplier']]);
    expect(r.errors).toEqual([expect.stringMatching(/Row 4: invalid GSTIN/)]);
  });
  it('accounts: maps capital -> equity and rejects unknown types', () => {
    const r = parseAccounts('Code,Name,Type\n3001,Partner Capital,Capital\n9,Odd,Weird');
    expect(r.rows).toEqual([{ code: '3001', name: 'Partner Capital', type: 'equity', group: 'Imported' }]);
    expect(r.errors[0]).toMatch(/unknown account type/);
  });
  it('vouchers: groups rows by voucher number and checks each balances', () => {
    const ok = parseVouchers('Voucher No,Date,Ledger,Debit,Credit\nV1,01/04/2025,1000,"10,000.00",\nV1,01/04/2025,3000,,10000');
    expect(ok.errors).toEqual([]);
    expect(ok.rows[0]).toMatchObject({ date: '2025-04-01', lines: [{ account: '1000', debit: 1000000 }, { account: '3000', credit: 1000000 }] });
    const bad = parseVouchers('Voucher No,Date,Ledger,Debit,Credit\nV2,01/04/2025,1000,100,\nV2,01/04/2025,3000,,90');
    expect(bad.errors[0]).toMatch(/Voucher V2: debits 10000 and credits 9000/);
  });
  it('rejects files missing required columns with a helpful message', () => {
    expect(() => parseVouchers('a,b\n1,2')).toThrow(/Missing column/);
  });
});
