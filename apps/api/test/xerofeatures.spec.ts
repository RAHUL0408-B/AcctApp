// Xero-parity features: settings, items, quotes/POs, email + reminders, repeating invoices, bank rules, fixed assets, dashboard, cash flow, statements.
import { auth, boot, mkGstin } from './helpers';
import { getPool } from '../src/db/db';
import { processOutbox } from '../src/firm/mailer';
import { runRecurring } from '../src/xero/xero.controller';

process.env.WORKER = 'off';
process.env.LOG_REQUESTS = 'off';

let ctx: Awaited<ReturnType<typeof boot>>;
let t: string, firmId: number, org: number, acc: (code: string) => number;
let cust: number, custNoEmail: number, supplier: number;
const base = () => `/api/orgs/${org}`;
const post = (p: string, b: object = {}) => ctx.http().post(`${base()}${p}`).set(auth(t)).send(b);
const get = (p: string) => ctx.http().get(`${base()}${p}`).set(auth(t));
const iso = (d = 0) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
const line = (rate = 50000, qty = 2, gst = 1800) => ({ description: 'Consulting', hsnSac: '9983', quantity: qty, rate, gstRateBp: gst });

beforeAll(async () => {
  ctx = await boot(54333);
  const u = await ctx.register('xero@ca.com', 'Xero CA');
  t = u.token; firmId = u.firmId;
  org = await ctx.newOrg(t, firmId, 'Parity Traders', { gstin: '27AAPFU0939F1ZV' });
  acc = await ctx.accounts(t, org);
  cust = (await post('/contacts', { kind: 'customer', name: 'Mailable Customer', email: 'cust@example.com', stateCode: '27' }).expect(201)).body.id;
  custNoEmail = (await post('/contacts', { kind: 'customer', name: 'No Email Customer', stateCode: '27' }).expect(201)).body.id;
  supplier = (await post('/contacts', { kind: 'supplier', name: 'Parts Supplier', gstin: mkGstin('27AAAFP1234Q1Z'), pan: 'AAAFP1234Q' }).expect(201)).body.id;
});
afterAll(async () => { await ctx?.stop(); });

describe('organisation settings', () => {
  it('shows and updates name, GSTIN and PAN; state follows the GSTIN; changes are audited with before/after', async () => {
    expect((await get('/settings').expect(200)).body).toMatchObject({ name: 'Parity Traders', stateCode: '27' });
    const g = mkGstin('29ABCDE1234F1Z');
    await ctx.http().put(`${base()}/settings`).set(auth(t)).send({ gstin: 'BAD' }).expect(400);
    await ctx.http().put(`${base()}/settings`).set(auth(t)).send({ name: 'Parity Traders LLP', gstin: g }).expect(200);
    expect((await get('/settings')).body).toMatchObject({ name: 'Parity Traders LLP', gstin: g, stateCode: '29' });
    const log = (await get('/audit')).body.find((l: any) => l.action === 'update' && l.entity === 'organization');
    expect(log.before_data.name).toBe('Parity Traders');
    expect(log.after_data.name).toBe('Parity Traders LLP');
    await ctx.http().put(`${base()}/settings`).set(auth(t)).send({ gstin: '27AAPFU0939F1ZV' }).expect(200); // back to Maharashtra for the rest
  });
});

describe('products and services', () => {
  it('creates items, rejects duplicates and unknown GST rates, archives', async () => {
    const id = (await post('/items', { code: 'CONS-01', name: 'Consulting hour', kind: 'service', hsnSac: '9983', saleRate: 150000, gstRateBp: 1800, salesAccountId: acc('4000') }).expect(201)).body.id;
    await post('/items', { code: 'CONS-01', name: 'Dup', kind: 'service' }).expect(409);
    await post('/items', { code: 'X', name: 'Bad rate', kind: 'goods', gstRateBp: 1700 }).expect(400);
    const list = (await get('/items').expect(200)).body;
    expect(list[0]).toMatchObject({ code: 'CONS-01', saleRate: 150000, gstRateBp: 1800, hsnSac: '9983' });
    await post(`/items/${id}/archive`).expect(201);
    expect((await get('/items')).body).toEqual([]);
  });
});

describe('quotes and purchase orders', () => {
  let quote: number;
  it('a quote does not touch the ledger until it is converted into an invoice', async () => {
    const q = (await post('/pre-documents', { kind: 'quote', contactId: cust, issueDate: '2025-06-01', lines: [line()] }).expect(201)).body;
    quote = q.id;
    expect(q).toMatchObject({ number: 'QU-0001', total: 118000 });
    expect((await get('/trial-balance')).body.accounts).toHaveLength(0);
    await post(`/pre-documents/${quote}/status`, { status: 'sent' }).expect(201);
    await post(`/pre-documents/${quote}/status`, { status: 'accepted' }).expect(201);
    const c = (await post(`/pre-documents/${quote}/convert`, { issueDate: '2025-06-05', dueDate: '2025-06-20' }).expect(201)).body;
    expect(c.number).toMatch(/^INV\/25-26\/0001$/);
    const tb = (await get('/trial-balance')).body;
    expect(tb.balanced).toBe(true);
    expect(tb.accounts.find((a: any) => a.code === '1100').debit).toBe(118000);
    expect((await get('/pre-documents?kind=quote')).body[0]).toMatchObject({ status: 'converted', convertedDocId: c.documentId });
    await post(`/pre-documents/${quote}/convert`, {}).expect(409);
    await post(`/pre-documents/${quote}/status`, { status: 'declined' }).expect(409);
  });
  it('declined quotes cannot be converted; GST on a quote matches the invoice rules (inter-state = IGST)', async () => {
    const ka = (await post('/contacts', { kind: 'customer', name: 'Bengaluru Buyer', stateCode: '29' })).body.id;
    const q = (await post('/pre-documents', { kind: 'quote', contactId: ka, issueDate: '2025-06-01', lines: [line(100000, 1, 1200)] }).expect(201)).body;
    expect(q.total).toBe(112000);
    await post(`/pre-documents/${q.id}/status`, { status: 'declined' }).expect(201);
    await post(`/pre-documents/${q.id}/convert`, {}).expect(409);
    await post('/pre-documents', { kind: 'quote', contactId: supplier, issueDate: '2025-06-01', lines: [line()] }).expect(400); // supplier is not a customer
  });
  it('a purchase order converts into a bill carrying the PO number as the supplier reference', async () => {
    const po = (await post('/pre-documents', { kind: 'purchase_order', contactId: supplier, issueDate: '2025-06-02', lines: [{ ...line(20000, 5, 1800), accountId: acc('5000') }] }).expect(201)).body;
    expect(po.number).toBe('PO-0001');
    const c = (await post(`/pre-documents/${po.id}/convert`, { issueDate: '2025-06-10' }).expect(201)).body;
    const doc = (await get(`/documents/${c.documentId}`)).body;
    expect(doc).toMatchObject({ docType: 'bill', supplierRef: 'PO-0001', total: 118000 });
  });
});

describe('emailing invoices and reminders', () => {
  let invoice: number;
  beforeAll(async () => {
    invoice = (await post('/documents', { docType: 'invoice', contactId: cust, issueDate: '2025-01-05', dueDate: '2025-01-20', lines: [line()] }).expect(201)).body.id;
  });
  it('queues the invoice PDF to the contact email, and needs an address when there is none', async () => {
    const r = (await post(`/documents/${invoice}/send`, { message: 'Thanks for your business' }).expect(201)).body;
    expect(r.queuedTo).toBe('cust@example.com');
    const noEmail = (await post('/documents', { docType: 'invoice', contactId: custNoEmail, issueDate: '2025-06-06', lines: [line()] })).body.id;
    await post(`/documents/${noEmail}/send`, {}).expect(400);
    await post(`/documents/${noEmail}/send`, { to: 'other@example.com' }).expect(201);
    await processOutbox();
    const m = (await getPool().query("SELECT attachment_name, length(attachment) AS len, status FROM email_outbox WHERE to_addr='cust@example.com' AND subject LIKE '%from%'")).rows[0];
    expect(m.status).toBe('sent');
    expect(m.attachment_name).toMatch(/^INV-.*\.pdf$/);
    expect(Number(m.len)).toBeGreaterThan(500);
    expect((await get(`/documents/${invoice}`)).body.id).toBe(invoice);
  });
  it('sends one reminder per overdue invoice with an email, then waits 7 days', async () => {
    const first = (await post('/documents/remind-overdue').expect(201)).body;
    expect(first.reminders).toBeGreaterThanOrEqual(1);
    expect((await post('/documents/remind-overdue').expect(201)).body.reminders).toBe(0);
    const r = (await getPool().query("SELECT count(*)::int AS n FROM email_outbox WHERE subject LIKE 'Reminder: invoice%'")).rows[0].n;
    expect(r).toBe(first.reminders);
  });
});

describe('repeating invoices', () => {
  it('creates a month-end invoice each month with the day kept (31 Jan, 28 Feb, 31 Mar) and stops at the end date', async () => {
    const id = (await post('/recurring', { contactId: cust, frequency: 'monthly', nextDate: '2024-01-31', endDate: '2024-03-31', dueDays: 10, lines: [line(100000, 1, 0)] }).expect(201)).body.id;
    const r1 = await runRecurring('2024-03-31');
    expect(r1.created).toBe(3);
    const docs = (await get(`/documents?type=invoice`)).body.filter((d: any) => d.issueDate >= '2024-01-01' && d.issueDate <= '2024-03-31');
    expect(docs.map((d: any) => d.issueDate).sort()).toEqual(['2024-01-31', '2024-02-29', '2024-03-31']);
    expect((await runRecurring('2024-12-31')).created).toBe(0);
    expect((await get('/recurring')).body.find((r: any) => r.id === id).active).toBe(false);
  });
  it('rejects a schedule with invalid lines up front', async () => {
    await post('/recurring', { contactId: cust, frequency: 'weekly', nextDate: '2025-01-01', lines: [line(100, 1, 1700)] }).expect(400);
  });
});

describe('bank rules', () => {
  let bankId: number;
  it('classifies imported lines by rule and posts them in one click', async () => {
    bankId = (await post('/bank-accounts', { name: 'SBI Current', accountId: acc('1010') }).expect(201)).body.id;
    await post('/bank-rules', { name: 'Bank charges', matchText: 'SBI CHARGES', direction: 'out', accountId: acc('5560') }).expect(201);
    await post('/bank-rules', { name: 'Bad', matchText: 'x', direction: 'any', accountId: acc('5560') }).expect(400); // too short to be safe
    await post(`/bank-accounts/${bankId}/import`, { csv: 'Date,Narration,Debit,Credit\n03/06/2025,sbi charges Q1,118,\n04/06/2025,Mystery deposit,,500\n05/06/2025,SBI CHARGES REFUND,,10' }).expect(201);
    const txns = (await get(`/bank-accounts/${bankId}/transactions`)).body;
    expect(txns.map((x: any) => x.ruleAccountId)).toEqual([acc('5560'), null, null]); // refund is money in, rule is for money out
    const r = (await post(`/bank-accounts/${bankId}/accept-rules`).expect(201)).body;
    expect(r.reconciled).toBe(1);
    const after = (await get(`/bank-accounts/${bankId}/transactions?status=unreconciled`)).body;
    expect(after).toHaveLength(2);
    expect((await get('/trial-balance')).body.balanced).toBe(true);
  });
  it('a rule added later also classifies lines already imported', async () => {
    await post('/bank-rules', { name: 'Deposits', matchText: 'mystery', direction: 'in', accountId: acc('4100') }).expect(201);
    const t = (await get(`/bank-accounts/${bankId}/transactions?status=unreconciled`)).body;
    expect(t.find((x: any) => x.description === 'Mystery deposit').ruleAccountId).toBe(acc('4100'));
  });
});

describe('fixed assets', () => {
  let asset: number;
  it('depreciates a Rs 12,000 asset at 20% straight line: Rs 200 a month, once per month', async () => {
    asset = (await post('/fixed-assets', { name: 'Laptop', purchaseDate: '2025-04-10', cost: 1200000, residual: 0, method: 'slm', rateBp: 2000 }).expect(201)).body.id;
    await post('/fixed-assets', { name: 'Bad', purchaseDate: '2025-04-10', cost: 100, residual: 100, method: 'slm', rateBp: 10 }).expect(400);
    const r = (await post('/fixed-assets/run-depreciation', { through: '2025-06-30' }).expect(201)).body;
    expect(r).toEqual({ entriesPosted: 3, totalDepreciation: 60000 });
    expect((await post('/fixed-assets/run-depreciation', { through: '2025-06-30' })).body.entriesPosted).toBe(0);
    const a = (await get('/fixed-assets')).body[0];
    expect(a).toMatchObject({ accumulated: 60000, bookValue: 1140000 });
    const tb = (await get('/trial-balance')).body;
    expect(tb.accounts.find((x: any) => x.code === '5580').debit).toBe(60000);
    expect(tb.accounts.find((x: any) => x.code === '1690').credit).toBe(60000);
    expect(tb.balanced).toBe(true);
  });
  it('stops depreciating once disposed', async () => {
    await post(`/fixed-assets/${asset}/dispose`, { date: '2025-07-15' }).expect(201);
    expect((await post('/fixed-assets/run-depreciation', { through: '2025-12-31' })).body.entriesPosted).toBe(0);
    await post(`/fixed-assets/${asset}/dispose`, { date: '2025-07-16' }).expect(404);
  });
});

describe('statements, dashboard and cash flow', () => {
  it('contact statement shows invoices, payments and credit notes with a running balance', async () => {
    const c2 = (await post('/contacts', { kind: 'customer', name: 'Statement Customer', stateCode: '27' })).body.id;
    const inv = (await post('/documents', { docType: 'invoice', contactId: c2, issueDate: '2025-02-01', lines: [line()] })).body.id;
    await post(`/documents/${inv}/payments`, { date: '2025-02-10', amount: 50000, accountId: acc('1010') }).expect(201);
    await post('/documents', { docType: 'credit_note', contactId: c2, originalDocId: inv, issueDate: '2025-02-15', lines: [{ ...line(10000, 1), accountId: acc('4010') }] }).expect(201);
    const s = (await get(`/contacts/${c2}/statement`).expect(200)).body;
    expect(s.lines.map((l: any) => [l.type, l.amount, l.balance])).toEqual([['invoice', 118000, 118000], ['payment', -50000, 68000], ['credit_note', -11800, 56200]]);
    expect(s.closingBalance).toBe(56200);
    const later = (await get(`/contacts/${c2}/statement?from=2025-02-12`)).body;
    expect(later.openingBalance).toBe(68000);
    expect(later.lines).toHaveLength(1);
  });
  it('dashboard summarises banks, receivables, six months of trend and year-to-date profit', async () => {
    await post('/documents', { docType: 'invoice', contactId: cust, issueDate: iso(-3), dueDate: iso(20), lines: [line(1000000, 1, 0)] }).expect(201);
    const d = (await get('/dashboard').expect(200)).body;
    expect(d.banks[0].name).toBe('SBI Current');
    expect(d.months).toHaveLength(6);
    expect(d.months[5].month).toBe(iso().slice(0, 7));
    expect(d.receivables.total).toBeGreaterThan(1000000);
    expect(d.receivables.top.length).toBeGreaterThan(0);
    expect(d.ytd.profit).toBe(d.ytd.income - d.ytd.expense);
    expect(d.tasks).toEqual({ open: 0, overdue: 0 });
  });
  it('cash flow report: opening + in - out = closing, by month', async () => {
    const cf = (await get('/reports/cash-flow?from=2025-01-01&to=2025-12-31').expect(200)).body;
    expect(cf.openingBalance + cf.totalIn - cf.totalOut).toBe(cf.closingBalance);
    expect(cf.months.length).toBeGreaterThan(0);
    for (const m of cf.months) expect(m.opening + m.net).toBe(m.closing);
    await get('/reports/cash-flow?from=bad').expect(400);
  });
});

describe('permissions', () => {
  it('clients can read items, statements and the dashboard but cannot create anything; other firms see nothing', async () => {
    const client = await ctx.register('xclient@x.com');
    await ctx.http().post('/api/members').set(auth(t)).send({ firmId, email: 'xclient@x.com', role: 'client', orgId: org }).expect(201);
    const c = (p: string) => ctx.http().get(`${base()}${p}`).set(auth(client.token));
    await c('/dashboard').expect(200);
    await c('/items').expect(200);
    await c('/pre-documents').expect(200);
    await ctx.http().post(`${base()}/items`).set(auth(client.token)).send({ code: 'Z', name: 'Z', kind: 'goods' }).expect(403);
    await ctx.http().post(`${base()}/pre-documents`).set(auth(client.token)).send({}).expect(403);
    await ctx.http().post(`${base()}/fixed-assets/run-depreciation`).set(auth(client.token)).send({ through: '2025-12-31' }).expect(403);
    await ctx.http().put(`${base()}/settings`).set(auth(client.token)).send({ name: 'Hacked' }).expect(403);
    const other = await ctx.register('xother@x.com');
    await ctx.http().get(`${base()}/dashboard`).set(auth(other.token)).expect(404);
    await ctx.http().get(`${base()}/fixed-assets`).set(auth(other.token)).expect(404);
  });
});
