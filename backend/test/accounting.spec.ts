// Phase 2 end-to-end: GST invoices, TDS bills, payments, notes, bank reconciliation, reports, period lock.
import { auth, boot, mkGstin } from './helpers';

let ctx: Awaited<ReturnType<typeof boot>>;
let t: string, firmId: number, org: number, acc: (code: string) => number;
let custMH: number, custKA: number, supplier: number;
let inv1: any, inv2: any, bill: any, cn: any;
const post = (path: string, body: object) => ctx.http().post(`/api/orgs/${org}${path}`).set(auth(t)).send(body);
const get = (path: string) => ctx.http().get(`/api/orgs/${org}${path}`).set(auth(t));

beforeAll(async () => {
  ctx = await boot(54330);
  const u = await ctx.register('ca@firm.com', 'CA Firm');
  t = u.token; firmId = u.firmId;
  org = await ctx.newOrg(t, firmId, 'Sharma Traders', { gstin: '27AAPFU0939F1ZV' });
  acc = await ctx.accounts(t, org);
});
afterAll(async () => { await ctx?.stop(); });

describe('contacts and GSTIN', () => {
  it('rejects a GSTIN with a wrong check digit and derives state from a good one', async () => {
    await post('/contacts', { kind: 'customer', name: 'Bad', gstin: '27AAPFU0939F1ZX' }).expect(400);
    const r = await post('/contacts', { kind: 'customer', name: 'Acme Pvt Ltd', gstin: mkGstin('27ABCDE1234F1Z') }).expect(201);
    custMH = r.body.id;
    custKA = (await post('/contacts', { kind: 'customer', name: 'Walk-in Bengaluru', stateCode: '29' }).expect(201)).body.id;
    supplier = (await post('/contacts', { kind: 'supplier', name: 'Pro Advisors LLP', gstin: mkGstin('27AAAFP1234Q1Z') }).expect(201)).body.id;
    const list = (await get('/contacts').expect(200)).body;
    expect(list.find((c: any) => c.id === custMH).stateCode).toBe('27');
  });
  it('exposes tax configuration from tables', async () => {
    const rates = (await ctx.http().get('/api/config/gst-rates').set(auth(t)).expect(200)).body;
    expect(rates.map((r: any) => r.rateBp)).toEqual([0, 25, 300, 500, 1200, 1800, 2800]);
    const tds = (await ctx.http().get('/api/config/tds-sections').set(auth(t)).expect(200)).body;
    expect(tds.find((s: any) => s.code === '194J').rateOtherBp).toBe(1000);
  });
});

describe('sales documents', () => {
  it('intra-state invoice: Rs 1,000 @18% -> CGST 90 + SGST 90 = 1,180 and numbered INV/25-26/0001', async () => {
    const r = await post('/documents', { docType: 'invoice', contactId: custMH, issueDate: '2025-06-01', dueDate: '2025-06-15',
      lines: [{ description: 'Widgets', hsnSac: '8471', quantity: 2, rate: 50000, gstRateBp: 1800 }] }).expect(201);
    inv1 = r.body;
    expect(inv1).toMatchObject({ number: 'INV/25-26/0001', subtotal: 100000, cgst: 9000, sgst: 9000, igst: 0, total: 118000 });
  });
  it('inter-state invoice to Karnataka uses IGST', async () => {
    const r = await post('/documents', { docType: 'invoice', contactId: custKA, issueDate: '2025-06-02',
      lines: [{ description: 'Service', hsnSac: '9983', quantity: 1, rate: 200000, gstRateBp: 1200 }] }).expect(201);
    inv2 = r.body;
    expect(inv2).toMatchObject({ number: 'INV/25-26/0002', igst: 24000, cgst: 0, total: 224000 });
  });
  it('rejects unconfigured GST rate, wrong account type, wrong contact kind, bad HSN', async () => {
    const base = { docType: 'invoice', contactId: custMH, issueDate: '2025-06-03' };
    const line = { description: 'x', quantity: 1, rate: 100, gstRateBp: 1800 };
    await post('/documents', { ...base, lines: [{ ...line, gstRateBp: 1700 }] }).expect(400);
    await post('/documents', { ...base, lines: [{ ...line, accountId: acc('5500') }] }).expect(400);
    await post('/documents', { ...base, contactId: supplier, lines: [line] }).expect(400);
    await post('/documents', { ...base, lines: [{ ...line, hsnSac: 'ABC' }] }).expect(400);
  });
  it('posted a balanced journal: debtors 1,18,000 against sales and output GST', async () => {
    const tb = (await get('/trial-balance').expect(200)).body;
    const by = (code: string) => tb.accounts.find((a: any) => a.code === code);
    expect(tb.balanced).toBe(true);
    expect(by('1100').debit).toBe(118000 + 224000);
    expect(by('2100').credit).toBe(9000);
    expect(by('2120').credit).toBe(24000);
  });
});

describe('purchase bill with TDS', () => {
  it('Rs 60,000 professional fee @18% GST with 194J TDS 10% on Rs 60,000 = Rs 6,000', async () => {
    const r = await post('/documents', { docType: 'bill', contactId: supplier, issueDate: '2025-06-05', supplierRef: 'PA/101', tdsSection: '194J',
      lines: [{ description: 'Audit fee', hsnSac: '9982', quantity: 1, rate: 6000000, gstRateBp: 1800, accountId: acc('5530') }] }).expect(201);
    bill = r.body;
    expect(bill).toMatchObject({ subtotal: 6000000, cgst: 540000, sgst: 540000, total: 7080000, tdsAmount: 600000, netPayable: 6480000 });
    const tb = (await get('/trial-balance').expect(200)).body;
    expect(tb.balanced).toBe(true);
    expect(tb.accounts.find((a: any) => a.code === '2000').credit).toBe(6480000);
    expect(tb.accounts.find((a: any) => a.code === '2200').credit).toBe(600000);
    expect(tb.accounts.find((a: any) => a.code === '1300').debit).toBe(540000);
  });
  it('TDS only on bills, and unknown sections are rejected', async () => {
    await post('/documents', { docType: 'invoice', contactId: custMH, issueDate: '2025-06-05', tdsSection: '194J', lines: [{ description: 'x', quantity: 1, rate: 100, gstRateBp: 0 }] }).expect(400);
    await post('/documents', { docType: 'bill', contactId: supplier, issueDate: '2025-06-05', tdsSection: '999Z', lines: [{ description: 'x', quantity: 1, rate: 100, gstRateBp: 0 }] }).expect(400);
  });
});

describe('payments, notes and voids', () => {
  let bank: number;
  beforeAll(() => { bank = acc('1010'); });

  it('accepts part payment, refuses overpayment, tracks outstanding', async () => {
    await post(`/documents/${inv1.id}/payments`, { date: '2025-06-10', amount: 50000, accountId: bank }).expect(201);
    const over = await post(`/documents/${inv1.id}/payments`, { date: '2025-06-10', amount: 100000, accountId: bank }).expect(400);
    expect(over.body.message).toMatch(/exceeds/);
    expect((await get(`/documents/${inv1.id}`).expect(200)).body.outstanding).toBe(68000);
    await post(`/documents/${inv1.id}/payments`, { date: '2025-06-10', amount: 1000, accountId: acc('4000') }).expect(400); // not a bank account
  });
  it('credit note reduces what the customer owes (Rs 100 + 18% = Rs 118)', async () => {
    const r = await post('/documents', { docType: 'credit_note', contactId: custMH, originalDocId: inv1.id, issueDate: '2025-06-20',
      lines: [{ description: 'Returned goods', quantity: 1, rate: 10000, gstRateBp: 1800, accountId: acc('4010') }] }).expect(201);
    cn = r.body;
    expect(cn).toMatchObject({ number: 'CN/25-26/0001', total: 11800 });
    expect((await get(`/documents/${inv1.id}`).expect(200)).body.outstanding).toBe(56200);
    await post('/documents', { docType: 'credit_note', contactId: custMH, originalDocId: inv1.id, issueDate: '2025-06-21', lines: [{ description: 'Too big', quantity: 1, rate: 9000000, gstRateBp: 0, accountId: acc('4010') }] }).expect(400);
  });
  it('pays the bill net of TDS: only Rs 64,800 is owed to the supplier', async () => {
    await post(`/documents/${bill.id}/payments`, { date: '2025-06-25', amount: 6480000, accountId: bank }).expect(201);
    expect((await get(`/documents/${bill.id}`).expect(200)).body.outstanding).toBe(0);
  });
  it('void: refused when payments exist; allowed otherwise via reversal; books stay balanced', async () => {
    await post(`/documents/${inv1.id}/void`, { date: '2025-06-26', reason: 'x' }).expect(409);
    await post(`/documents/${inv2.id}/void`, { date: '2025-06-26', reason: 'Entered twice' }).expect(201);
    await post(`/documents/${inv2.id}/void`, { date: '2025-06-26', reason: 'again' }).expect(409);
    expect((await get(`/documents/${inv2.id}`).expect(200)).body.status).toBe('void');
    expect((await get('/trial-balance').expect(200)).body.balanced).toBe(true);
  });
});

describe('bank import and reconciliation', () => {
  let bankId: number, txns: any[];
  const csv = 'Date,Narration,Debit,Credit\n10/06/2025,NEFT from Acme,,500\n12/06/2025,Bank charges,15.50,\n';

  it('creates a bank account on COA 1010 and imports a CSV statement, ignoring duplicates on re-import', async () => {
    bankId = (await post('/bank-accounts', { name: 'HDFC Current', accountId: acc('1010') }).expect(201)).body.id;
    expect((await post(`/bank-accounts/${bankId}/import`, { csv }).expect(201)).body).toEqual({ imported: 2, skippedDuplicates: 0 });
    expect((await post(`/bank-accounts/${bankId}/import`, { csv }).expect(201)).body).toEqual({ imported: 0, skippedDuplicates: 2 });
    await post(`/bank-accounts/${bankId}/import`, { csv: 'junk\n1' }).expect(400);
    txns = (await get(`/bank-accounts/${bankId}/transactions`).expect(200)).body;
    expect(txns.map((x: any) => x.amount)).toEqual([50000, -1550]);
  });
  it('suggests the matching ledger entry and reconciles it (once)', async () => {
    const sug = (await get(`/bank-transactions/${txns[0].id}/suggestions`).expect(200)).body;
    expect(sug).toHaveLength(1);
    await post(`/bank-transactions/${txns[0].id}/reconcile`, { entryId: 999999 }).expect(400);
    await post(`/bank-transactions/${txns[0].id}/reconcile`, { entryId: sug[0].id }).expect(201);
    await post(`/bank-transactions/${txns[0].id}/reconcile`, { entryId: sug[0].id }).expect(409);
  });
  it('books an unmatched bank charge to an expense account and reconciles it', async () => {
    await post(`/bank-transactions/${txns[1].id}/categorize`, { accountId: acc('5560') }).expect(201);
    const acct = (await get('/bank-accounts').expect(200)).body[0];
    expect(acct.unreconciled).toBe(0);
    const lines = (await get(`/reports/ledger/${acc('5560')}`).expect(200)).body;
    expect(lines.closingBalance).toBe(1550);
  });
  it('unreconcile reopens the line without touching the ledger', async () => {
    await post(`/bank-transactions/${txns[0].id}/unreconcile`, {}).expect(201);
    expect((await get(`/bank-accounts/${bankId}/transactions?status=unreconciled`).expect(200)).body).toHaveLength(1);
  });
});

describe('reports', () => {
  it('P&L: income 90,000 (sales 1,00,000 less returns 10,000, voided sale nets to zero); expenses Rs 60,000 + bank charges', async () => {
    const p = (await get('/reports/pnl?from=2025-04-01&to=2026-03-31').expect(200)).body;
    expect(p.income.total).toBe(90000);
    expect(p.expenses.total).toBe(6000000 + 1550);
    expect(p.netProfit).toBe(90000 - 6001550);
  });
  it('balance sheet balances (assets = liabilities + equity incl. profit)', async () => {
    const b = (await get('/reports/balance-sheet?asOf=2026-03-31').expect(200)).body;
    expect(b.balanced).toBe(true);
    expect(b.assets.total).toBe(b.liabilities.total + b.equity.total);
  });
  it('ledger statement has opening balance and running balance', async () => {
    const l = (await get(`/reports/ledger/${acc('1100')}?from=2025-06-15`).expect(200)).body;
    expect(l.openingBalance).toBe(118000 + 224000 - 50000); // inv1 + inv2 less the part payment (the void is dated after 15 June)
    expect(l.closingBalance).toBe(56200);
  });
  it('aged receivables at 1 Aug 2025: Acme owes Rs 562 and it is 47 days overdue (31-60 bucket)', async () => {
    const a = (await get('/reports/aged-receivables?asOf=2025-08-01').expect(200)).body;
    expect(a.totals).toMatchObject({ total: 56200, days31to60: 56200, over90: 0 });
    expect(a.contacts).toHaveLength(1);
  });
  it('aged payables: bill fully paid so nothing outstanding', async () => {
    expect((await get('/reports/aged-payables?asOf=2025-08-01').expect(200)).body.totals.total).toBe(0);
  });
  it('GSTR-1: invoice in B2B, credit note in CDNR, HSN summary nets the return; voided invoice excluded', async () => {
    const g = (await get('/reports/gstr1?from=2025-06-01&to=2025-06-30').expect(200)).body;
    expect(g.b2b.map((x: any) => x.number)).toEqual(['INV/25-26/0001']);
    expect(g.b2cs).toEqual([]);
    expect(g.cdnr.map((x: any) => x.number)).toEqual(['CN/25-26/0001']);
    const h = g.hsn.find((x: any) => x.hsn === '8471');
    expect(h).toMatchObject({ taxable: 100000, cgst: 9000 });
  });
  it('GSTR-3B: output tax net of credit note, ITC from the bill, per-head payable', async () => {
    const g = (await get('/reports/gstr3b?from=2025-06-01&to=2025-06-30').expect(200)).body;
    expect(g.section31a_outwardTaxable).toMatchObject({ taxable: 90000, cgst: 8100, sgst: 8100, igst: 0 });
    expect(g.section4_itcAvailable).toMatchObject({ cgst: 540000, sgst: 540000 });
    expect(g.netTaxPayable.cgst).toBe(8100 - 540000);
  });
});

describe('period lock, roles and tenancy', () => {
  it('locking the period blocks new invoices dated inside it', async () => {
    await post('/lock', { through: '2025-06-30' }).expect(201);
    const r = await post('/documents', { docType: 'invoice', contactId: custMH, issueDate: '2025-06-25', lines: [{ description: 'late', quantity: 1, rate: 100, gstRateBp: 0 }] }).expect(400);
    expect(r.body.message).toMatch(/locked/);
    await post('/documents', { docType: 'invoice', contactId: custMH, issueDate: '2025-07-02', lines: [{ description: 'ok', quantity: 1, rate: 100, gstRateBp: 0 }] }).expect(201);
  });
  it('client users can read but not create documents; another firm cannot see them', async () => {
    const client = await ctx.register('client@acme.com');
    await ctx.http().post('/api/members').set(auth(t)).send({ firmId, email: 'client@acme.com', role: 'client', orgId: org }).expect(201);
    await ctx.http().get(`/api/orgs/${org}/documents`).set(auth(client.token)).expect(200);
    await ctx.http().post(`/api/orgs/${org}/documents`).set(auth(client.token)).send({}).expect(403);
    const other = await ctx.register('rival@firm.com');
    await ctx.http().get(`/api/orgs/${org}/documents`).set(auth(other.token)).expect(404);
    await ctx.http().get(`/api/orgs/${org}/reports/gstr1`).set(auth(other.token)).expect(404);
  });
});
