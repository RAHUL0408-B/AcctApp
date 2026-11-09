// Compliance checks with worked examples: MSME 43B(h), the 180-day ITC rule, GSTR-2B matching, duplicate supplier bills.
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { auth, boot, mkGstin } from './helpers';
import { addDays, invoiceKey, itcToReverse, msmeBill, msmeLimitDays, parseGstr2b } from '../src/compliance/checks';

const dataDir = mkdtempSync(join(tmpdir(), 'acctapp-data-'));
process.env.DATA_DIR = dataDir;
process.env.WORKER = 'off';

describe('43B(h) rules, worked by hand', () => {
  const bill = (date: string, agreedDays: number | null = null) => ({ date, subtotal: 100000, total: 118000, payable: 118000, agreedDays });
  it('allows 15 days, or the agreed days up to 45', () => {
    expect([msmeLimitDays(null), msmeLimitDays(30), msmeLimitDays(60)]).toEqual([15, 30, 45]);
  });
  it('a bill of 10 March paid on 20 March is on time; nothing is lost', () => {
    const r = msmeBill(bill('2026-03-10'), [{ date: '2026-03-20', amount: 118000 }], '2026-03-31', '2026-04-15');
    expect(r).toMatchObject({ payBy: '2026-03-25', status: 'paid_on_time', disallowed: 0 });
  });
  it('unpaid at 31 March after the limit: the Rs 1,000 expense (not the GST) is not allowed this year', () => {
    const r = msmeBill(bill('2026-03-10'), [], '2026-03-31', '2026-04-15');
    expect(r).toMatchObject({ status: 'overdue', unpaid: 118000, disallowed: 100000 });
  });
  it('paid late but before 31 March: allowed in the same year', () => {
    expect(msmeBill(bill('2026-03-10'), [{ date: '2026-03-28', amount: 118000 }], '2026-03-31', '2026-04-15')).toMatchObject({ status: 'paid_late', disallowed: 0 });
  });
  it('a bill of 25 March paid on 5 April is still on time (limit 9 April), so allowed this year', () => {
    expect(msmeBill(bill('2026-03-25'), [{ date: '2026-04-05', amount: 118000 }], '2026-03-31', '2026-05-01')).toMatchObject({ payBy: '2026-04-09', status: 'paid_on_time', disallowed: 0 });
  });
  it('a bill of 25 March paid on 20 April is late and after year-end: not allowed this year', () => {
    expect(msmeBill(bill('2026-03-25'), [{ date: '2026-04-20', amount: 118000 }], '2026-03-31', '2026-05-01')).toMatchObject({ status: 'paid_late', disallowed: 100000 });
  });
  it('half paid on time: only the unpaid half is not allowed', () => {
    expect(msmeBill(bill('2026-03-10'), [{ date: '2026-03-15', amount: 59000 }], '2026-03-31', '2026-04-15').disallowed).toBe(50000);
  });
  it('before the limit nothing is lost yet', () => {
    expect(msmeBill(bill('2026-03-10'), [], '2026-03-31', '2026-03-20')).toMatchObject({ status: 'due', daysLeft: 5, disallowed: 0 });
  });
  it('30 agreed days on a 1 March bill means pay by 31 March', () => {
    expect(msmeBill(bill('2026-03-01', 30), [], '2026-03-31', '2026-03-20').payBy).toBe('2026-03-31');
  });
});

describe('180-day rule and invoice numbers', () => {
  it('reverses the GST in proportion to what is unpaid: half of Rs 180 on a Rs 1,180 bill with Rs 590 unpaid', () => {
    expect(itcToReverse(18000, 118000, 59000)).toBe(9000);
    expect(itcToReverse(18000, 118000, 118000)).toBe(18000);
  });
  it('treats INV/0042, inv-42 and INV 42 as one invoice number, but not INV/420', () => {
    expect(invoiceKey('INV/0042')).toBe(invoiceKey('inv-42'));
    expect(invoiceKey('INV 42')).toBe(invoiceKey('INV/0042'));
    expect(invoiceKey('INV/420')).not.toBe(invoiceKey('INV/42'));
    expect(invoiceKey('2026/0001')).toBe('20261');
  });
  it('counts days on the calendar, across months and years', () => {
    expect(addDays('2026-01-31', 180)).toBe('2026-07-30');
    expect(addDays('2026-12-20', 15)).toBe('2027-01-04');
  });
});

describe('reading GSTR-2B files', () => {
  it('reads the portal JSON: period, invoices, amounts in paise, credit availability', () => {
    const r = parseGstr2b(JSON.stringify({ data: { rtnprd: '102026', docdata: { b2b: [{ ctin: '29AAACB1234C1Z5', trdnm: 'Bengaluru Supplies', inv: [
      { inum: 'BS/001', dt: '05-10-2026', val: 1180, itcavl: 'Y', rev: 'N', items: [{ txval: 1000, igst: 180, cgst: 0, sgst: 0, cess: 0 }] },
      { inum: 'BS/002', dt: '06-10-2026', val: 590, itcavl: 'N', rev: 'Y', items: [{ txval: 500, igst: 90 }] }] }] } } }));
    expect(r.period).toBe('2026-10');
    expect(r.lines).toHaveLength(2);
    expect(r.lines[0]).toMatchObject({ gstin: '29AAACB1234C1Z5', invoiceNo: 'BS/001', date: '2026-10-05', taxable: 100000, igst: 18000, itcAvailable: true, reverseCharge: false });
    expect(r.lines[1]).toMatchObject({ itcAvailable: false, reverseCharge: true });
  });
  it('reads a CSV with the portal column names, skipping lines without a GSTIN', () => {
    const r = parseGstr2b('GSTIN of supplier,Trade/Legal name,Invoice number,Invoice Date,Taxable Value (₹),Integrated Tax(₹),Central Tax(₹),State/UT Tax(₹),Cess(₹)\n27AAPFU0939F1ZV,"Pune Paper, LLP",P-7,12/10/2026,"2,000.00",0,180,180,0\nTotal,,,,2000,0,180,180,0\n');
    expect(r.lines).toEqual([expect.objectContaining({ gstin: '27AAPFU0939F1ZV', supplierName: 'Pune Paper, LLP', invoiceNo: 'P-7', date: '2026-10-12', taxable: 200000, cgst: 18000, sgst: 18000 })]);
    expect(r.skipped).toBe(1);
    expect(() => parseGstr2b('a,b,c\n1,2,3')).toThrow(/header row/);
  });
});

describe('compliance checks through the API', () => {
  let ctx: Awaited<ReturnType<typeof boot>>, t: string, org: number, bank: number;
  const base = () => `/api/orgs/${org}`;
  const post = (p: string, b: object) => ctx.http().post(base() + p).set(auth(t)).send(b);
  const get = (p: string) => ctx.http().get(base() + p).set(auth(t));
  const today = new Date().toISOString().slice(0, 10);
  const daysAgo = (n: number) => addDays(today, -n);
  const line = (rate: number) => ({ description: 'Goods', quantity: 1, rate, gstRateBp: 1800 });
  const bill = async (contactId: number, issueDate: string, rate: number, supplierRef?: string, extra: object = {}) => {
    const r = await post('/documents', { docType: 'bill', contactId, issueDate, lines: [line(rate)], ...(supplierRef ? { supplierRef } : {}), ...extra });
    if (r.status !== 201) throw new Error(`bill dated ${issueDate} refused (${r.status}): ${JSON.stringify(r.body)}`);
    return r.body.id as number;
  };
  const pay = async (id: number, date: string, amount: number) => {
    const r = await post(`/documents/${id}/payments`, { date, amount, accountId: bank });
    if (r.status !== 201) throw new Error(`payment of ${amount} on ${date} refused (${r.status}): ${JSON.stringify(r.body)}`);
  };

  beforeAll(async () => {
    ctx = await boot(54352);
    const u = await ctx.register('ca@compliance.com', 'Compliance CA');
    t = u.token;
    org = await ctx.newOrg(t, u.firmId, 'Compliance Traders', { gstin: '27AAPFU0939F1ZV' });
    bank = (await ctx.accounts(t, org))('1010');
  });
  afterAll(async () => { await ctx?.stop(); rmSync(dataDir, { recursive: true, force: true }); });

  it('stores MSME details on a supplier and checks the Udyam number', async () => {
    await post('/contacts', { kind: 'supplier', name: 'Bad Udyam', udyamNo: 'UDYAM-12345' }).expect(400);
    const id = (await post('/contacts', { kind: 'supplier', name: 'Tiny Works', stateCode: '27', msmeType: 'micro', udyamNo: 'udyam-mh-26-0012345', msmeAgreedDays: 30 }).expect(201)).body.id;
    const c = (await get('/contacts').expect(200)).body.find((x: any) => x.id === id);
    expect(c).toMatchObject({ msmeType: 'micro', udyamNo: 'UDYAM-MH-26-0012345', msmeAgreedDays: 30 });
  });

  it('43B(h): shows on-time, overdue and not-yet-due bills to micro and small suppliers, with the expense at risk', async () => {
    const small = (await post('/contacts', { kind: 'supplier', name: 'Small Fab', gstin: mkGstin('27AAACS1234S1Z'), msmeType: 'small' } /* registered, so its bills carry GST */).expect(201)).body.id;
    const medium = (await post('/contacts', { kind: 'supplier', name: 'Medium Co', stateCode: '27', msmeType: 'medium' }).expect(201)).body.id;
    const onTime = await bill(small, daysAgo(40), 100000);
    await pay(onTime, daysAgo(35), 118000);
    const overdue = await bill(small, daysAgo(30), 200000);              // 15 days passed, unpaid
    await bill(small, daysAgo(3), 50000);                                 // 12 days left
    await bill(medium, daysAgo(60), 100000);                              // medium enterprises are not covered
    const r = (await get(`/compliance/msme?asOf=${today}`).expect(200)).body;
    const fyStart = Number(today.slice(5, 7)) >= 4 ? Number(today.slice(0, 4)) : Number(today.slice(0, 4)) - 1;
    const inYear = (d: string) => d >= `${fyStart}-04-01`;
    const rows = r.rows.filter((x: any) => x.supplier === 'Small Fab' && inYear(x.date));
    const byId = Object.fromEntries(rows.map((x: any) => [x.id, x]));
    if (inYear(daysAgo(40))) expect(byId[onTime]).toMatchObject({ status: 'paid_on_time', disallowed: 0 });
    if (inYear(daysAgo(30))) expect(byId[overdue]).toMatchObject({ status: 'overdue', unpaid: 236000, disallowed: 200000 });
    expect(r.rows.some((x: any) => x.supplier === 'Medium Co')).toBe(false);
    expect(r.suppliersWithoutStatus).toEqual([]);
    await post('/contacts', { kind: 'supplier', name: 'Unknown Status', stateCode: '27' }).expect(201);
    expect((await get('/compliance/msme').expect(200)).body.suppliersWithoutStatus.map((x: any) => x.name)).toEqual(['Unknown Status']);
    await get('/compliance/msme?fy=26').expect(400);
  });

  it('180 days: reverses the credit on the unpaid part, lists bills about to cross, ignores paid bills', async () => {
    const s = (await post('/contacts', { kind: 'supplier', name: 'Slow Pay Ltd', gstin: mkGstin('27AAACT1234T1Z') }).expect(201)).body.id;
    const old = await bill(s, daysAgo(200), 100000);           // Rs 1,180 with Rs 180 GST
    await pay(old, daysAgo(190), 59000);                       // half paid
    await bill(s, daysAgo(170), 100000);                       // reaches 180 days in 10 days
    const paid = await bill(s, daysAgo(250), 100000);
    await pay(paid, daysAgo(240), 118000);
    const r = (await get(`/compliance/itc-180?asOf=${today}`).expect(200)).body;
    const mine = r.rows.filter((x: any) => x.supplier === 'Slow Pay Ltd');
    expect(mine.map((x: any) => [x.status, x.unpaid, x.reverse])).toEqual([['reverse', 59000, 9000], ['soon', 118000, 18000]]);
    expect(r.totals.reverseNow).toBeGreaterThanOrEqual(9000);
  });

  it('refuses the same supplier bill twice (also across two contacts with one GSTIN) unless confirmed', async () => {
    const g = mkGstin('27AAACD1234E1Z');
    const a = (await post('/contacts', { kind: 'supplier', name: 'Dup Traders', gstin: g }).expect(201)).body.id;
    const b = (await post('/contacts', { kind: 'supplier', name: 'Dup Traders (old)', gstin: g }).expect(201)).body.id;
    await bill(a, daysAgo(5), 1000, 'DT/0042');
    const r = await post('/documents', { docType: 'bill', contactId: a, issueDate: daysAgo(4), supplierRef: 'dt-42', lines: [line(1000)] }).expect(409);
    expect(r.body.message).toMatch(/Possible duplicate: bill .* already has supplier bill no\. DT\/0042/);
    await post('/documents', { docType: 'bill', contactId: b, issueDate: daysAgo(4), supplierRef: 'DT 42', lines: [line(1000)] }).expect(409);
    await post('/documents', { docType: 'bill', contactId: a, issueDate: daysAgo(4), supplierRef: 'DT/0042', lines: [line(1000)], allowDuplicate: true }).expect(201);
    await post('/documents', { docType: 'bill', contactId: a, issueDate: daysAgo(4), supplierRef: 'DT/0043', lines: [line(1000)] }).expect(201);
  });

  it('GSTR-2B: matches despite differently written numbers, finds tax differences, portal-only and books-only invoices', async () => {
    // its own organisation, so bills from the other tests this month do not count
    const mainOrg = org;
    org = await ctx.newOrg(t, (await ctx.http().get('/api/orgs').set(auth(t))).body[0].firmId, 'GSTR-2B Traders', { gstin: '27AAPFU0939F1ZV' });
    const g1 = mkGstin('29AAACM1234M1Z'), g2 = mkGstin('27AAACN1234N1Z'), g3 = mkGstin('24AAACP1234P1Z');
    const m = (await post('/contacts', { kind: 'supplier', name: 'Match Mills', gstin: g1 }).expect(201)).body.id;
    const n = (await post('/contacts', { kind: 'supplier', name: 'Never Filed', gstin: g2 }).expect(201)).body.id;
    const period = today.slice(0, 7);
    const d = `${period}-01`;
    const ok = await bill(m, d, 100000, 'MM/0042');            // IGST 180
    const off = await bill(m, d, 200000, 'MM/0043');           // IGST 360 in books, supplier reports 300
    await bill(n, d, 50000, 'NF-9');                           // supplier never filed
    const json = { data: { rtnprd: `${period.slice(5)}${period.slice(0, 4)}`, docdata: { b2b: [
      { ctin: g1, trdnm: 'Match Mills', inv: [{ inum: 'mm-42', dt: '01-01-2026', items: [{ txval: 1000, igst: 180 }] }, { inum: 'MM 43', dt: '01-01-2026', items: [{ txval: 2000, igst: 300 }] }] },
      { ctin: g3, trdnm: 'Stranger Ltd', inv: [{ inum: 'S-1', dt: '02-01-2026', items: [{ txval: 500, igst: 90 }] }] }] } } };
    const up = (await post('/compliance/gstr2b', { fileName: '2b.json', content: JSON.stringify(json) }).expect(201)).body;
    expect(up).toMatchObject({ period, lines: 3 });
    const r = (await get(`/compliance/gstr2b/${up.id}`).expect(200)).body;
    expect(r.counts).toEqual({ matched: 1, mismatch: 1, only_2b: 1, only_books: 1 });
    expect(r.rows.find((x: any) => x.status === 'matched').billId).toBe(ok);
    const mis = r.rows.find((x: any) => x.status === 'mismatch');
    expect(mis).toMatchObject({ billId: off, difference: 6000 });                // Rs 60 more in books than reported
    expect(r.rows.find((x: any) => x.status === 'only_books')).toMatchObject({ supplier: 'Never Filed', difference: 9000 });
    expect(r.tax.atRisk).toBe(15000);                                          // Rs 90 never filed + Rs 60 under-reported
    expect(r.chase.map((c: any) => c.supplier)).toEqual(['Never Filed', 'Match Mills']);
    // a second upload for the same month replaces the first
    const again = (await post('/compliance/gstr2b', { fileName: '2b-v2.json', content: JSON.stringify(json) }).expect(201)).body;
    expect((await get('/compliance/gstr2b').expect(200)).body.filter((x: any) => x.period === period)).toHaveLength(1);
    await get(`/compliance/gstr2b/${up.id}`).expect(404);
    await ctx.http().delete(`${base()}/compliance/gstr2b/${again.id}`).set(auth(t)).expect(200);
    await post('/compliance/gstr2b', { fileName: 'x.txt', content: 'not a gstr file at all' }).expect(400);
    await post('/compliance/gstr2b', { fileName: 'x.csv', content: 'GSTIN of supplier,Invoice number\n' }).expect(400);
    org = mainOrg;
  });

  it('exports both checks to Excel and PDF and raises alerts in notifications', async () => {
    for (const r of ['msme-43bh', 'itc-180']) for (const format of ['xlsx', 'pdf'])
      expect((await get(`/export/${r}?format=${format}&asOf=${today}`).expect(200)).headers['content-type']).toMatch(format === 'pdf' ? /pdf/ : /sheet/);
    const keys = (await get('/notifications').expect(200)).body.items.map((i: any) => i.key);
    expect(keys).toEqual(expect.arrayContaining(['itc-180']));
  });
});
