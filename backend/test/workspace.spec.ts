// Phase 7 end-to-end: spend / receive / transfer money, sales and purchase defaults, overviews, search, notifications,
// the setup guide, short-term cash flow, business snapshot, TDS report, projects and "last login". Numbers worked by hand.
import { auth, boot, pw } from './helpers';
import { cashWeeks, depositBy, fyQuarter, grade, timeValue } from '../src/insights/calc';

process.env.WORKER = 'off';
process.env.LOG_REQUESTS = 'off';

let ctx: Awaited<ReturnType<typeof boot>>;
let t: string, firmId: number;
const today = new Date().toISOString().slice(0, 10);
const plus = (n: number) => new Date(Date.parse(today) + n * 86400000).toISOString().slice(0, 10);

const post = (org: number, p: string, b: object = {}) => ctx.http().post(`/api/orgs/${org}${p}`).set(auth(t)).send(b);
const get = (org: number, p: string) => ctx.http().get(`/api/orgs/${org}${p}`).set(auth(t));
const accId = async (org: number, code: string) => (await get(org, '/accounts').expect(200)).body.find((a: any) => a.code === code)?.id as number;
const balance = async (org: number, code: string) => (await get(org, `/reports/ledger/${await accId(org, code)}`).expect(200)).body.closingBalance as number;
const line = (rate: number, extra: object = {}) => ({ description: 'Line', quantity: 1, rate, gstRateBp: 1800, ...extra });

beforeAll(async () => {
  ctx = await boot(54341);
  const u = await ctx.register('owner@workspace.com', 'Workspace CA');
  t = u.token; firmId = u.firmId;
});
afterAll(async () => { await ctx?.stop(); });

describe('calculations', () => {
  it('TDS is deposited by the 7th of the next month, March by 30 April', () => {
    expect(depositBy('2025-06')).toBe('2025-07-07');
    expect(depositBy('2025-12')).toBe('2026-01-07');
    expect(depositBy('2026-03')).toBe('2026-04-30');
  });
  it('financial-year quarters run April-June, July-September, October-December, January-March', () => {
    expect(['2025-04-01', '2025-09-30', '2025-12-31', '2026-03-31'].map(fyQuarter)).toEqual(['Q1', 'Q2', 'Q3', 'Q4']);
  });
  it('20 minutes at Rs 1,000 an hour = Rs 333.33', () => expect(timeValue(20, 100000)).toBe(33333));
  it('grades a ratio against two thresholds, either direction', () => {
    expect([grade(2, 1.5, 1), grade(1.2, 1.5, 1), grade(0.5, 1.5, 1), grade(null, 1, 0)]).toEqual(['good', 'watch', 'concern', 'n/a']);
    expect([grade(25, 30, 60, true), grade(45, 30, 60, true), grade(90, 30, 60, true)]).toEqual(['good', 'watch', 'concern']);
  });
  it('cash weeks: Rs 100 now, Rs 50 in on day 9, Rs 30 out on day 2, Rs 20 overdue in', () => {
    const r = cashWeeks(10000, '2025-04-01', 14, [
      { date: '2025-04-10', direction: 'in', amount: 5000, overdue: false },
      { date: '2025-04-03', direction: 'out', amount: 3000, overdue: false },
      { date: '2025-03-20', direction: 'in', amount: 2000, overdue: true },
      { date: '2025-05-30', direction: 'in', amount: 999, overdue: false }, // outside the window
    ]);
    expect(r.weeks.map((w) => [w.start, w.end, w.closing])).toEqual([['2025-04-01', '2025-04-07', 7000], ['2025-04-08', '2025-04-14', 12000]]);
    expect(r).toMatchObject({ projected: 12000, projectedIncludingOverdue: 14000, overdue: { cashIn: 2000, cashOut: 0 } });
  });
});

describe('spend, receive and transfer money', () => {
  let org: number, hdfc: number, icici: number;
  beforeAll(async () => {
    org = await ctx.newOrg(t, firmId, 'Money Co', { gstin: '27AAPFU0939F1ZV' });
    hdfc = (await post(org, '/bank-accounts', { name: 'HDFC', accountId: await accId(org, '1010') }).expect(201)).body.id;
    const icAcc = (await post(org, '/accounts', { code: '1020', name: 'ICICI Bank', type: 'asset', group: 'Cash and Bank' }).expect(201)).body.id;
    icici = (await post(org, '/bank-accounts', { name: 'ICICI', accountId: icAcc }).expect(201)).body.id;
  });

  it('spend Rs 1,180 on rent: Dr Rent / Cr HDFC', async () => {
    const r = (await post(org, `/bank-accounts/${hdfc}/spend`, { date: today, payee: 'Landlord', lines: [{ accountId: await accId(org, '5500'), amount: 118000, description: 'April rent' }] }).expect(201)).body;
    expect(r.total).toBe(118000);
    expect(await balance(org, '5500')).toBe(118000);
    expect(await balance(org, '1010')).toBe(-118000);
  });

  it('receive Rs 5,000 of other income into HDFC, then move Rs 2,000 to ICICI: HDFC Rs 1,820, ICICI Rs 2,000', async () => {
    await post(org, `/bank-accounts/${hdfc}/receive`, { date: today, payee: 'Interest', lines: [{ accountId: await accId(org, '4100'), amount: 500000 }] }).expect(201);
    await post(org, '/bank-transfers', { date: today, fromBankAccountId: hdfc, toBankAccountId: icici, amount: 200000 }).expect(201);
    expect(await balance(org, '1010')).toBe(182000);
    expect(await balance(org, '1020')).toBe(200000);
    expect(await balance(org, '4100')).toBe(500000);
  });

  it('rejects posting to the bank itself, a transfer to the same bank, and unknown banks', async () => {
    await post(org, `/bank-accounts/${hdfc}/spend`, { date: today, payee: 'X', lines: [{ accountId: await accId(org, '1010'), amount: 100 }] }).expect(400);
    await post(org, '/bank-transfers', { date: today, fromBankAccountId: hdfc, toBankAccountId: hdfc, amount: 100 }).expect(400);
    await post(org, '/bank-accounts/999999/spend', { date: today, payee: 'X', lines: [{ accountId: await accId(org, '5500'), amount: 100 }] }).expect(404);
  });

  it('a spend shows up as a match when the bank statement line is imported', async () => {
    const d = today.split('-').reverse().join('/');
    await post(org, `/bank-accounts/${hdfc}/import`, { csv: `Date,Narration,Debit,Credit\n${d},RENT LANDLORD,1180,\n` }).expect(201);
    const txn = (await get(org, `/bank-accounts/${hdfc}/transactions`).expect(200)).body[0];
    const s = (await get(org, `/bank-transactions/${txn.id}/suggestions`).expect(200)).body;
    expect(s[0].narration).toBe('Spent: Landlord - April rent');
  });
});

describe('sales and purchase settings, overviews, cash flow, notifications, search, setup guide', () => {
  let org: number, acme: number, supplier: number;
  beforeAll(async () => {
    org = await ctx.newOrg(t, firmId, 'Overview Traders', { gstin: '27AAPFU0939F1ZV' });
    acme = (await post(org, '/contacts', { kind: 'customer', name: 'Acme Retail', stateCode: '27' }).expect(201)).body.id;
    supplier = (await post(org, '/contacts', { kind: 'supplier', name: 'Paper Mills', stateCode: '27' }).expect(201)).body.id;
  });

  it('setup guide starts at 2 of 6 (business details and contacts are in)', async () => {
    expect((await get(org, '/setup-guide').expect(200)).body).toMatchObject({ completed: 2, total: 6 }); // details + contacts
  });

  it('default payment terms: invoices due in 10 days with terms printed; bills due in 3 days', async () => {
    await ctx.http().put(`/api/orgs/${org}/settings`).set(auth(t)).send({ invoiceDueDays: 10, billDueDays: 3, invoiceTerms: 'Pay by NEFT to HDFC 0001' }).expect(200);
    expect((await get(org, '/settings').expect(200)).body).toMatchObject({ invoiceDueDays: 10, billDueDays: 3, invoiceTerms: 'Pay by NEFT to HDFC 0001' });
    const inv = (await post(org, '/documents', { docType: 'invoice', contactId: acme, issueDate: today, lines: [line(1000000)] }).expect(201)).body;
    expect(inv).toMatchObject({ dueDate: plus(10), total: 1180000 });
    expect((await get(org, `/documents/${inv.id}`).expect(200)).body.dueDate).toBe(plus(10));
    const bill = (await post(org, '/documents', { docType: 'bill', contactId: supplier, issueDate: today, lines: [line(500000)] }).expect(201)).body;
    expect(bill).toMatchObject({ dueDate: plus(3), total: 500000 }); // unregistered supplier: no GST
    // An explicit due date still wins.
    const old = (await post(org, '/documents', { docType: 'invoice', contactId: acme, issueDate: plus(-20), dueDate: plus(-5), lines: [line(100000)] }).expect(201)).body;
    expect(old.dueDate).toBe(plus(-5));
  });

  it('sales overview: 2 awaiting payment (Rs 12,980), 1 overdue (Rs 1,180)', async () => {
    const o = (await get(org, '/overview/sales').expect(200)).body;
    expect(o.awaitingPayment).toEqual({ count: 2, total: 1298000 });
    expect(o.overdue).toEqual({ count: 1, total: 118000 });
    expect(o.top[0]).toEqual({ contact: 'Acme Retail', total: 1298000 });
    const p = (await get(org, '/overview/purchases').expect(200)).body;
    expect(p.dueThisWeek).toEqual({ count: 1, total: 500000 });
    await get(org, '/overview/other').expect(400);
  });

  it('short-term cash flow: no cash yet, Rs 11,800 in and Rs 5,000 out within 30 days = Rs 6,800; Rs 7,980 if the overdue Rs 1,180 is also paid', async () => {
    const r = (await get(org, '/reports/short-term-cash-flow?days=30').expect(200)).body;
    expect(r).toMatchObject({ opening: 0, projected: 680000, projectedIncludingOverdue: 798000, overdue: { cashIn: 118000, cashOut: 0 } });
    expect(r.weeks).toHaveLength(5);
    expect(r.weeks[0]).toMatchObject({ cashOut: 500000, cashIn: 0 });
    expect(r.weeks[1]).toMatchObject({ cashIn: 1180000 });
  });

  it('notifications list the overdue invoice and the bill due this week', async () => {
    const n = (await get(org, '/notifications').expect(200)).body;
    expect(n.items.map((i: any) => i.key)).toEqual(expect.arrayContaining(['overdue-invoices', 'bills-due']));
    expect(n.items.find((i: any) => i.key === 'overdue-invoices').text).toBe('1 overdue invoice(s), ₹1,180.00 to collect');
  });

  it('search finds the customer and their invoices; short queries return nothing', async () => {
    const r = (await get(org, '/search?q=acme').expect(200)).body.results;
    expect(r.filter((x: any) => x.type === 'Contact')).toHaveLength(1);
    expect(r.filter((x: any) => x.type === 'invoice')).toHaveLength(2);
    expect((await get(org, '/search?q=a').expect(200)).body.results).toEqual([]);
    expect((await get(org, '/search?q=%25').expect(200)).body.results).toEqual([]); // % is matched literally, not as a wildcard
  });

  it('setup guide moves to 4 of 6 once an invoice and a bill exist', async () => {
    expect((await get(org, '/setup-guide').expect(200)).body.completed).toBe(4);
  });
});

describe('business snapshot and TDS report', () => {
  let org: number;
  beforeAll(async () => { org = await ctx.newOrg(t, firmId, 'Snapshot Traders', { gstin: '27AAPFU0939F1ZV' }); });

  it('sales Rs 1,00,000, purchases Rs 40,000, rent Rs 20,000: gross margin 60%, net margin 40%, cash Rs 40,000', async () => {
    const j = async (dr: string, cr: string, amt: number) => post(org, '/journal', { date: today, narration: 'x', lines: [{ accountId: await accId(org, dr), debit: amt }, { accountId: await accId(org, cr), credit: amt }] }).expect(201);
    await j('1010', '4000', 10000000); await j('5000', '1010', 4000000); await j('5500', '1010', 2000000);
    await post(org, '/bank-accounts', { name: 'HDFC', accountId: await accId(org, '1010') }).expect(201);
    const s = (await get(org, `/reports/business-snapshot?from=${today}&to=${today}`).expect(200)).body;
    expect(s).toMatchObject({ income: 10000000, costOfSales: 4000000, grossProfit: 6000000, expenses: 6000000, profit: 4000000, cash: 4000000, grossMarginPct: 60, netMarginPct: 40, currentRatio: null });
    expect(s.scorecard.find((x: any) => x.metric === 'Net profit margin').status).toBe('good');
    expect(s.scorecard.find((x: any) => x.metric === 'Current ratio').status).toBe('n/a');
  });

  it('194J on Rs 60,000 to a supplier with a PAN = Rs 6,000 TDS, deposit by the 7th of next month', async () => {
    const sup = (await post(org, '/contacts', { kind: 'supplier', name: 'CA Sharma', pan: 'ABCPS1234K', stateCode: '27', isIndividual: true }).expect(201)).body.id;
    await post(org, '/documents', { docType: 'bill', contactId: sup, issueDate: today, tdsSection: '194J', lines: [line(6000000, { gstRateBp: 0 })] }).expect(201);
    const r = (await get(org, `/reports/tds?from=${today}&to=${today}`).expect(200)).body;
    expect(r.rows).toEqual([expect.objectContaining({ party: 'CA Sharma', pan: 'ABCPS1234K', section: '194J', amount: 6000000, tds: 600000, quarter: fyQuarter(today) })]);
    expect(r.bySection).toEqual([{ section: '194J', count: 1, amount: 6000000, tds: 600000 }]);
    expect(r.byMonth).toEqual([{ month: today.slice(0, 7), tds: 600000, depositBy: depositBy(today.slice(0, 7)) }]);
  });
});

describe('projects', () => {
  let org: number, pid: number, invoiceId: number;
  beforeAll(async () => {
    org = await ctx.newOrg(t, firmId, 'Project Studio', { gstin: '27AAPFU0939F1ZV' });
    const cust = (await post(org, '/contacts', { kind: 'customer', name: 'Bright Homes', stateCode: '27' }).expect(201)).body.id;
    const sup = (await post(org, '/contacts', { kind: 'supplier', name: 'Some Supplier' }).expect(201)).body.id;
    await post(org, '/projects', { name: 'Website', contactId: sup }).expect(400); // must be a customer
    pid = (await post(org, '/projects', { name: 'Website', contactId: cust, estimate: 1000000 }).expect(201)).body.id;
    await post(org, '/projects', { name: 'Website', contactId: cust }).expect(409);
  });

  it('90 min + 20 min at Rs 1,000/h = Rs 1,833.33 of time; Rs 500 chargeable + Rs 200 own cost', async () => {
    expect((await post(org, `/projects/${pid}/time`, { date: today, description: 'Design', minutes: 90, rate: 100000 }).expect(201)).body.value).toBe(150000);
    await post(org, `/projects/${pid}/time`, { date: today, description: 'Call', minutes: 20, rate: 100000 }).expect(201);
    await post(org, `/projects/${pid}/costs`, { date: today, description: 'Stock photos', amount: 50000 }).expect(201);
    await post(org, `/projects/${pid}/costs`, { date: today, description: 'Software', amount: 20000, chargeable: false }).expect(201);
    const p = (await get(org, `/projects/${pid}`).expect(200)).body;
    expect(p).toMatchObject({ minutes: 110, timeValue: 183333, costs: 70000, toInvoice: 233333, invoiced: 0, estimateUsedPct: 25 });
    expect(p.timeEntries).toHaveLength(2);
  });

  it('invoicing bills Rs 2,333.33 before GST once; profit = Rs 2,333.33 - Rs 700 = Rs 1,633.33', async () => {
    const r = (await post(org, `/projects/${pid}/invoice`, { issueDate: today, gstRateBp: 1800 }).expect(201)).body;
    expect(r.subtotal).toBe(233333);
    invoiceId = r.documentId;
    await post(org, `/projects/${pid}/invoice`, { issueDate: today }).expect(400);
    expect((await get(org, `/projects/${pid}`).expect(200)).body).toMatchObject({ invoiced: 233333, toInvoice: 0, profit: 163333 });
  });

  it('voiding the invoice makes the time and costs billable again; a closed project takes no more time', async () => {
    await post(org, `/documents/${invoiceId}/void`, { date: today, reason: 'Wrong rate' }).expect(201);
    expect((await get(org, `/projects/${pid}`).expect(200)).body).toMatchObject({ invoiced: 0, toInvoice: 233333 });
    await post(org, `/projects/${pid}/status`, { status: 'closed' }).expect(201);
    await post(org, `/projects/${pid}/time`, { date: today, description: 'More', minutes: 10, rate: 0 }).expect(409);
    expect((await get(org, '/projects').expect(200)).body[0]).toMatchObject({ name: 'Website', status: 'closed' });
  });
});

describe('last login', () => {
  it('is empty on the first login and shows the previous one after that', async () => {
    await ctx.register('login@workspace.com', 'Login Firm');
    const login = async () => (await ctx.http().post('/api/auth/login').send({ email: 'login@workspace.com', password: pw }).expect(200)).body.token as string;
    const first = await login();
    expect((await ctx.http().get('/api/auth/me').set(auth(first)).expect(200)).body.lastLogin).toBeNull();
    const second = await login();
    const me = (await ctx.http().get('/api/auth/me').set(auth(second)).expect(200)).body;
    expect(me.lastLogin.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
