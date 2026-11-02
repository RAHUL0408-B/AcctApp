// Phase 6 end-to-end: exports, SEZ, reverse charge, composition, foreign currency, inventory, tracking, budgets,
// year-end close, approvals, expense claims and the practice overview. Every number below is worked out by hand.
import { auth, boot, mkGstin } from './helpers';
import { financialYearOf } from '../src/ledger/ledger';

process.env.WORKER = 'off';
process.env.LOG_REQUESTS = 'off';

let ctx: Awaited<ReturnType<typeof boot>>;
let t: string, firmId: number, staff: string;
const today = new Date().toISOString().slice(0, 10);
const fy = financialYearOf(today);
const prevFy = financialYearOf(new Date(Date.parse(fy.start) - 86400000).toISOString().slice(0, 10));
const thisMonth = today.slice(0, 7);

const post = (org: number, p: string, b: object = {}, tok = t) => ctx.http().post(`/api/orgs/${org}${p}`).set(auth(tok)).send(b);
const put = (org: number, p: string, b: object) => ctx.http().put(`/api/orgs/${org}${p}`).set(auth(t)).send(b);
const get = (org: number, p: string, tok = t) => ctx.http().get(`/api/orgs/${org}${p}`).set(auth(tok));
const accId = async (org: number, code: string) => (await get(org, '/accounts').expect(200)).body.find((a: any) => a.code === code)?.id as number;
/** Balance of an account in its natural direction (credit-positive for income, liabilities and equity). */
const balance = async (org: number, code: string) => {
  const id = await accId(org, code);
  return id ? (await get(org, `/reports/ledger/${id}`).expect(200)).body.closingBalance as number : 0;
};
const line = (rate: number, extra: object = {}) => ({ description: 'Line', quantity: 1, rate, gstRateBp: 1800, ...extra });

beforeAll(async () => {
  ctx = await boot(54339);
  const u = await ctx.register('owner@more.com', 'More Features CA');
  t = u.token; firmId = u.firmId;
  staff = (await ctx.register('staff@more.com', 'Staff Own Firm')).token;
  await ctx.http().post('/api/members').set(auth(t)).send({ firmId, email: 'staff@more.com', role: 'staff' }).expect(201);
});
afterAll(async () => { await ctx?.stop(); });

describe('exports, SEZ and reverse charge (Maharashtra exporter)', () => {
  let org: number, usCustomer: number, sezUnit: number, advocate: number, usVendor: number, invoiceId: number;
  beforeAll(async () => {
    org = await ctx.newOrg(t, firmId, 'Export House', { gstin: '27AAPFU0939F1ZV' });
    usCustomer = (await post(org, '/contacts', { kind: 'customer', name: 'Acme Inc', country: 'US' }).expect(201)).body.id;
    sezUnit = (await post(org, '/contacts', { kind: 'customer', name: 'SEZ Unit Pune', gstin: mkGstin('27AABCS1234K1Z') }).expect(201)).body.id;
    advocate = (await post(org, '/contacts', { kind: 'supplier', name: 'Advocate Rao', stateCode: '27' }).expect(201)).body.id;
    usVendor = (await post(org, '/contacts', { kind: 'supplier', name: 'US Vendor', country: 'US' }).expect(201)).body.id;
  });

  it('a zero-rated export needs a Letter of Undertaking and a customer outside India', async () => {
    const doc = { docType: 'invoice', contactId: usCustomer, issueDate: today, supplyType: 'export_lut', currency: 'USD', fxRate: 83.25, lines: [line(100000, { hsnSac: '998314' })] };
    expect((await post(org, '/documents', doc).expect(400)).body.message).toMatch(/Letter of Undertaking/);
    await put(org, '/settings', { lutNumber: 'AD2704260012345' }).expect(200);
    await post(org, '/documents', { ...doc, contactId: sezUnit }).expect(400); // an Indian customer cannot receive an export
    await post(org, '/documents', { ...doc, fxRate: undefined }).expect(400); // foreign currency needs a rate
  });

  it('USD 1,000 export under LUT at Rs 83.25 = Rs 83,250 with no GST, place of supply 96', async () => {
    const r = (await post(org, '/documents', { docType: 'invoice', contactId: usCustomer, issueDate: today, supplyType: 'export_lut', currency: 'USD', fxRate: 83.25,
      lines: [line(100000, { hsnSac: '998314', description: 'Software services' })] }).expect(201)).body;
    expect(r).toMatchObject({ subtotal: 8325000, cgst: 0, sgst: 0, igst: 0, total: 8325000, currency: 'USD', foreignTotal: 100000 });
    invoiceId = r.id;
    expect((await get(org, `/documents/${r.id}`).expect(200)).body).toMatchObject({ placeOfSupply: '96', supplyType: 'export_lut', fxRate: 83.25 });
  });

  it('receiving USD 1,000 as Rs 84,000 clears the invoice and books a Rs 750 exchange gain', async () => {
    await post(org, `/documents/${invoiceId}/payments`, { date: today, amount: 8400000, accountId: await accId(org, '1010') }).expect(400); // needs the USD amount too
    await post(org, `/documents/${invoiceId}/payments`, { date: today, amount: 8400000, foreignAmount: 100001, accountId: await accId(org, '1010') }).expect(400);
    const p = (await post(org, `/documents/${invoiceId}/payments`, { date: today, amount: 8400000, foreignAmount: 100000, accountId: await accId(org, '1010') }).expect(201)).body;
    expect(p).toMatchObject({ settled: 8325000, fxGain: 75000, outstandingAfter: 0 });
    expect(await balance(org, '4300')).toBe(75000);
  });

  it('SEZ supply with payment of tax is IGST even inside Maharashtra: Rs 100 @18% = IGST 18', async () => {
    const r = (await post(org, '/documents', { docType: 'invoice', contactId: sezUnit, issueDate: today, supplyType: 'sez_igst', lines: [line(10000)] }).expect(201)).body;
    expect(r).toMatchObject({ subtotal: 10000, cgst: 0, sgst: 0, igst: 1800, total: 11800 });
  });

  it('reverse charge: Rs 10,000 legal fees from an unregistered advocate -> pay Rs 10,000, self-assess CGST 900 + SGST 900', async () => {
    await post(org, '/documents', { docType: 'invoice', contactId: sezUnit, issueDate: today, supplyType: 'reverse_charge', lines: [line(10000)] }).expect(400);
    const r = (await post(org, '/documents', { docType: 'bill', contactId: advocate, issueDate: today, supplyType: 'reverse_charge',
      lines: [line(1000000, { description: 'Legal fees', hsnSac: '998212', accountId: await accId(org, '5530') })] }).expect(201)).body;
    expect(r).toMatchObject({ subtotal: 1000000, cgst: 0, sgst: 0, total: 1000000, netPayable: 1000000, rcm: { cgst: 90000, sgst: 90000, igst: 0 } });
    expect(await balance(org, '2130')).toBe(90000);
    expect(await balance(org, '2140')).toBe(90000);
    expect(await balance(org, '1300')).toBe(90000);
    expect(await balance(org, '2000')).toBe(1000000);
    expect((await get(org, '/trial-balance').expect(200)).body.balanced).toBe(true);
  });

  it('USD 500 bill at Rs 83, paid USD 200 at Rs 82.50 (gain Rs 100) then USD 300 at Rs 84 (loss Rs 300)', async () => {
    const bill = (await post(org, '/documents', { docType: 'bill', contactId: usVendor, issueDate: today, currency: 'USD', fxRate: 83,
      lines: [{ description: 'Cloud hosting', quantity: 1, rate: 50000, gstRateBp: 0 }] }).expect(201)).body;
    expect(bill).toMatchObject({ total: 4150000, foreignTotal: 50000 });
    await post(org, '/documents', { docType: 'bill', contactId: usVendor, issueDate: today, currency: 'USD', fxRate: 83, tdsSection: '194J', lines: [line(50000)] }).expect(400);
    const bank = await accId(org, '1010');
    const p1 = (await post(org, `/documents/${bill.id}/payments`, { date: today, amount: 1650000, foreignAmount: 20000, accountId: bank }).expect(201)).body;
    expect(p1).toMatchObject({ settled: 1660000, fxGain: 10000, outstandingAfter: 2490000 });
    const p2 = (await post(org, `/documents/${bill.id}/payments`, { date: today, amount: 2520000, foreignAmount: 30000, accountId: bank }).expect(201)).body;
    expect(p2).toMatchObject({ settled: 2490000, fxGain: -30000, outstandingAfter: 0 });
    expect(await balance(org, '4300')).toBe(75000 + 10000 - 30000);
  });

  it('GSTR-3B shows the export and SEZ supply as zero-rated (3.1b) and the reverse-charge tax in 3.1(d) and ITC', async () => {
    const g = (await get(org, `/reports/gstr3b?from=${fy.start}&to=${today}`).expect(200)).body;
    expect(g.section31b_zeroRated).toMatchObject({ taxable: 8335000, igst: 1800 });
    expect(g.section31d_inwardReverseCharge).toMatchObject({ taxable: 1000000, cgst: 90000, sgst: 90000 });
    expect(g.section4_itcAvailable).toMatchObject({ cgst: 90000, sgst: 90000 });
    const g1 = (await get(org, `/reports/gstr1?from=${fy.start}&to=${today}`).expect(200)).body;
    expect(g1.exp).toHaveLength(1);
    expect(g1.exp[0]).toMatchObject({ taxable: 8325000, withPayment: false, currency: 'USD', foreignTotal: 100000 });
    expect(g1.b2b.find((d: any) => d.sez)).toMatchObject({ sez: 'SEZWP', igst: 1800 });
  });
});

describe('composition scheme', () => {
  it('charges no GST on sales and adds GST paid on purchases to the cost (no input credit)', async () => {
    const org = await ctx.newOrg(t, firmId, 'Corner Shop', { gstin: mkGstin('27AAACS1234A1Z') });
    await put(org, '/settings', { gstScheme: 'composition' }).expect(200);
    const cust = (await post(org, '/contacts', { kind: 'customer', name: 'Walk-in', stateCode: '27' }).expect(201)).body.id;
    const sup = (await post(org, '/contacts', { kind: 'supplier', name: 'Wholesaler', gstin: mkGstin('27AAAFW1234Q1Z') }).expect(201)).body.id;
    expect((await post(org, '/documents', { docType: 'invoice', contactId: cust, issueDate: today, lines: [line(10000)] }).expect(201)).body)
      .toMatchObject({ subtotal: 10000, cgst: 0, sgst: 0, total: 10000 });
    const bill = (await post(org, '/documents', { docType: 'bill', contactId: sup, issueDate: today, lines: [line(10000)] }).expect(201)).body;
    expect(bill).toMatchObject({ cgst: 900, sgst: 900, total: 11800 });
    expect(await balance(org, '5000')).toBe(11800);
    expect(await balance(org, '1300')).toBe(0);
    const us = (await post(org, '/contacts', { kind: 'customer', name: 'Abroad', country: 'GB' }).expect(201)).body.id;
    await put(org, '/settings', { lutNumber: 'AD2704260099999' }).expect(200);
    await post(org, '/documents', { docType: 'invoice', contactId: us, issueDate: today, supplyType: 'export_lut', lines: [line(10000)] }).expect(400);
    const g = (await get(org, `/reports/gstr3b?from=${fy.start}&to=${today}`).expect(200)).body;
    expect(g.section4_itcAvailable).toEqual({ igst: 0, cgst: 0, sgst: 0 });
  });
});

describe('inventory at weighted average cost', () => {
  let org: number, item: number, sup: number, cust: number, sale: number, bill1: number;
  beforeAll(async () => {
    org = await ctx.newOrg(t, firmId, 'Widget Traders', { gstin: mkGstin('27AAACW1234B1Z') });
    sup = (await post(org, '/contacts', { kind: 'supplier', name: 'Widget Maker', gstin: mkGstin('27AAAFM1234Q1Z') }).expect(201)).body.id;
    cust = (await post(org, '/contacts', { kind: 'customer', name: 'Retailer', stateCode: '27' }).expect(201)).body.id;
  });

  it('only goods can be stock-tracked', async () => {
    await post(org, '/items', { code: 'SVC', name: 'Fitting', kind: 'service', trackStock: true }).expect(400);
    item = (await post(org, '/items', { code: 'WIDGET', name: 'Widget', kind: 'goods', trackStock: true, saleRate: 20000, gstRateBp: 1800 }).expect(201)).body.id;
    expect((await get(org, '/items').expect(200)).body[0]).toMatchObject({ code: 'WIDGET', trackStock: true });
  });

  it('buys 10 @ Rs 100 and 10 @ Rs 130 -> 20 on hand worth Rs 2,300 (average Rs 115), in the Inventory account', async () => {
    bill1 = (await post(org, '/documents', { docType: 'bill', contactId: sup, issueDate: today, lines: [{ description: 'Widgets', quantity: 10, rate: 10000, gstRateBp: 1800, itemId: item }] }).expect(201)).body.id;
    await post(org, '/documents', { docType: 'bill', contactId: sup, issueDate: today, lines: [{ description: 'Widgets', quantity: 10, rate: 13000, gstRateBp: 1800, itemId: item }] }).expect(201);
    const s = (await get(org, '/stock').expect(200)).body;
    expect(s.items[0]).toMatchObject({ quantity: 20, value: 230000, averageCost: 11500 });
    expect(s).toMatchObject({ totalValue: 230000, inventoryAccountBalance: 230000, agrees: true });
    expect(await balance(org, '5000')).toBe(0); // stock is an asset, not an expense, until sold
  });

  it('sells 5 -> cost of goods sold Rs 575; cannot sell 16 of the 15 left', async () => {
    const r = (await post(org, '/documents', { docType: 'invoice', contactId: cust, issueDate: today, lines: [{ description: 'Widgets', quantity: 5, rate: 20000, gstRateBp: 1800, itemId: item }] }).expect(201)).body;
    expect(r).toMatchObject({ subtotal: 100000, costOfSales: 57500 });
    sale = r.id;
    expect(await balance(org, '5050')).toBe(57500);
    expect((await post(org, '/documents', { docType: 'invoice', contactId: cust, issueDate: today, lines: [{ description: 'Widgets', quantity: 16, rate: 20000, gstRateBp: 1800, itemId: item }] }).expect(400)).body.message).toMatch(/Not enough stock.*15 on hand/);
    expect((await get(org, '/stock').expect(200)).body).toMatchObject({ totalValue: 172500, agrees: true });
  });

  it('voiding the sale puts the stock back; a bill whose goods were sold since cannot be voided', async () => {
    await post(org, `/documents/${sale}/void`, { date: today, reason: 'Order cancelled' }).expect(201);
    expect((await get(org, '/stock').expect(200)).body).toMatchObject({ totalValue: 230000, agrees: true });
    expect(await balance(org, '5050')).toBe(0);
    await post(org, `/documents/${bill1}/void`, { date: today, reason: 'Wrong bill' }).expect(409);
  });

  it('adjustments: writing off all 20 removes exactly Rs 2,300; adding 4 @ Rs 120 values them at Rs 480', async () => {
    await post(org, '/stock/adjust', { itemId: item, date: today, quantity: 4, reason: 'Found' }).expect(400); // adding needs a unit cost
    expect((await post(org, '/stock/adjust', { itemId: item, date: today, quantity: -20, reason: 'Flood damage' }).expect(201)).body).toMatchObject({ value: -230000, onHand: { qtyMilli: 0, value: 0 } });
    expect((await post(org, '/stock/adjust', { itemId: item, date: today, quantity: 4, unitCost: 12000, reason: 'Opening stock' }).expect(201)).body.value).toBe(48000);
    expect((await get(org, '/stock').expect(200)).body).toMatchObject({ totalValue: 48000, inventoryAccountBalance: 48000, agrees: true });
    const moves = (await get(org, `/stock/${item}/moves`).expect(200)).body;
    expect(moves.map((m: any) => m.kind)).toEqual(['purchase', 'purchase', 'sale', 'void', 'adjustment', 'adjustment']);
    expect(moves.at(-1)).toMatchObject({ balanceQuantity: 4, balanceValue: 48000 });
    await post(org, '/stock/adjust', { itemId: item, date: today, quantity: 1, unitCost: 1, reason: 'x' }, staff).expect(403); // adjustments need manage rights
  });
});

describe('tracking categories, monthly P&L and budgets', () => {
  let org: number, mumbai: number, pune: number, cust: number, budgetId: number;
  beforeAll(async () => {
    org = await ctx.newOrg(t, firmId, 'Branch Services', { template: 'services' });
    cust = (await post(org, '/contacts', { kind: 'customer', name: 'Client A', stateCode: '27' }).expect(201)).body.id;
  });

  it('creates a "Branch" category with Mumbai and Pune', async () => {
    await post(org, '/tracking', { name: 'Branch', options: ['Mumbai', 'Pune'] }).expect(201);
    await post(org, '/tracking', { name: 'Branch' }).expect(409);
    await post(org, '/tracking', { name: 'Region' }, staff).expect(403);
    const cats = (await get(org, '/tracking').expect(200)).body;
    mumbai = cats[0].options.find((o: any) => o.name === 'Mumbai').id;
    pune = cats[0].options.find((o: any) => o.name === 'Pune').id;
  });

  it('P&L by branch: Mumbai 500 income, Pune 300 income less 200 rent, 100 unassigned', async () => {
    const inv = (rate: number, opt?: number) => post(org, '/documents', { docType: 'invoice', contactId: cust, issueDate: today, lines: [{ description: 'Fees', quantity: 1, rate, gstRateBp: 0, trackingOptionId: opt }] }).expect(201);
    await inv(50000, mumbai); await inv(30000, pune); await inv(10000);
    await post(org, '/documents', { docType: 'invoice', contactId: cust, issueDate: today, lines: [{ description: 'x', quantity: 1, rate: 1, gstRateBp: 0, trackingOptionId: 999999 }] }).expect(400);
    await post(org, '/journal', { date: today, narration: 'Pune rent', lines: [
      { accountId: await accId(org, '5500'), debit: 20000, trackingOptionId: pune }, { accountId: await accId(org, '1000'), credit: 20000 }] }).expect(201);
    const cats = (await get(org, '/tracking').expect(200)).body;
    const r = (await get(org, `/reports/pnl-by-tracking?categoryId=${cats[0].id}&from=${fy.start}&to=${today}`).expect(200)).body;
    expect(r.columns).toEqual(['Mumbai', 'Pune', 'Unassigned']);
    expect(r.income.totals).toEqual([50000, 30000, 10000]);
    expect(r.expenses.totals).toEqual([0, 20000, 0]);
    expect(r.netProfit).toEqual([50000, 10000, 10000]);
  });

  it('P&L by month puts this month\'s 900 income and 200 expense in its own column', async () => {
    const r = (await get(org, `/reports/pnl-by-month?from=${fy.start}&to=${today}`).expect(200)).body;
    expect(r.columns[0]).toBe(fy.start.slice(0, 7));
    const i = r.columns.indexOf(thisMonth);
    expect(r.income.totals[i]).toBe(90000);
    expect(r.netProfit[i]).toBe(70000);
    expect(r.netProfitTotal).toBe(70000);
  });

  it('budget vs actual: sales 1,000 budgeted vs 900 actual; rent 150 budgeted vs 200 actual', async () => {
    await post(org, '/budgets', { name: 'Plan', fyStart: '2026-05-01' }).expect(400);
    budgetId = (await post(org, '/budgets', { name: 'Plan', fyStart: fy.start }).expect(201)).body.id;
    await put(org, `/budgets/${budgetId}/lines`, { lines: [{ accountId: await accId(org, '1000'), month: thisMonth, amount: 1 }] }).expect(400);
    await put(org, `/budgets/${budgetId}/lines`, { lines: [{ accountId: await accId(org, '4000'), month: `${Number(fy.start.slice(0, 4)) + 2}-01`, amount: 1 }] }).expect(400);
    await put(org, `/budgets/${budgetId}/lines`, { lines: [{ accountId: await accId(org, '4000'), month: thisMonth, amount: 100000 }, { accountId: await accId(org, '5500'), month: thisMonth, amount: 15000 }] }).expect(200);
    const r = (await get(org, `/reports/budget-vs-actual?budgetId=${budgetId}&from=${fy.start}&to=${today}`).expect(200)).body;
    expect(r.lines.find((l: any) => l.code === '4000')).toMatchObject({ budget: 100000, actual: 90000, variance: -10000, favourable: false });
    expect(r.lines.find((l: any) => l.code === '5500')).toMatchObject({ budget: 15000, actual: 20000, variance: 5000, favourable: false });
    expect(r.totals).toMatchObject({ profitBudget: 85000, profitActual: 70000 });
    expect((await get(org, '/budgets').expect(200)).body[0]).toMatchObject({ name: 'Plan', total: 115000 });
  });
});

describe('year-end close', () => {
  let org: number;
  it('moves last year\'s Rs 700 profit to reserves, keeps the P&L intact and locks the year', async () => {
    org = await ctx.newOrg(t, firmId, 'Closing Co', { template: 'services' });
    const cust = (await post(org, '/contacts', { kind: 'customer', name: 'Client', stateCode: '27' }).expect(201)).body.id;
    await post(org, '/documents', { docType: 'invoice', contactId: cust, issueDate: prevFy.end, lines: [{ description: 'Fees', quantity: 1, rate: 100000, gstRateBp: 0 }] }).expect(201);
    await post(org, '/journal', { date: prevFy.end, narration: 'Rent', lines: [{ accountId: await accId(org, '5500'), debit: 30000 }, { accountId: await accId(org, '1000'), credit: 30000 }] }).expect(201);

    await get(org, `/year-end?fyEnd=${prevFy.start}`).expect(400); // not a year end
    expect((await get(org, `/year-end?fyEnd=${prevFy.end}`).expect(200)).body).toMatchObject({ income: 100000, expense: 30000, netProfit: 70000, closed: false });
    await post(org, '/year-end/close', { fyEnd: prevFy.end }, staff).expect(403);
    const r = (await post(org, '/year-end/close', { fyEnd: prevFy.end }).expect(201)).body;
    expect(r).toMatchObject({ netProfit: 70000, lockedThrough: prevFy.end });
    await post(org, '/year-end/close', { fyEnd: prevFy.end }).expect(409);

    expect((await get(org, `/reports/pnl?from=${prevFy.start}&to=${prevFy.end}`).expect(200)).body.netProfit).toBe(70000);
    const bs = (await get(org, `/reports/balance-sheet?asOf=${prevFy.end}`).expect(200)).body;
    expect(bs.equity.items.find((i: any) => i.code === '3100').amount).toBe(70000);
    expect(bs.equity.profitToDate).toBe(0);
    expect(bs.balanced).toBe(true);
    expect(await balance(org, '4000')).toBe(0);
    await post(org, '/journal', { date: prevFy.end, narration: 'Late', lines: [{ accountId: await accId(org, '5500'), debit: 1 }, { accountId: await accId(org, '1000'), credit: 1 }] }).expect(400);
  });
});

describe('approvals and expense claims', () => {
  let org: number, cust: number, draft: number, claim: number;
  beforeAll(async () => {
    org = await ctx.newOrg(t, firmId, 'Approval Ltd', { template: 'services' });
    cust = (await post(org, '/contacts', { kind: 'customer', name: 'Client', stateCode: '27' }).expect(201)).body.id;
    await put(org, '/settings', { requireApproval: true }).expect(200);
  });
  const invoice = () => ({ docType: 'invoice', contactId: cust, issueDate: today, lines: [{ description: 'Fees', quantity: 2, rate: 25000, gstRateBp: 0 }] });

  it('staff cannot post an invoice directly once approval is required; they submit it instead', async () => {
    expect((await post(org, '/documents', invoice(), staff).expect(403)).body.message).toMatch(/approval/);
    const r = (await post(org, '/drafts', invoice(), staff).expect(201)).body;
    expect(r).toMatchObject({ total: 50000, status: 'submitted' });
    draft = r.id;
    await post(org, '/drafts', { ...invoice(), docType: 'credit_note' }, staff).expect(400);
    expect((await get(org, '/documents?type=invoice').expect(200)).body).toHaveLength(0); // nothing in the books yet
  });

  it('only an owner or accountant approves; approval posts the invoice; a second decision is refused', async () => {
    await post(org, `/drafts/${draft}/approve`, {}, staff).expect(403);
    const r = (await post(org, `/drafts/${draft}/approve`).expect(201)).body;
    expect(r.number).toMatch(/^INV\//);
    await post(org, `/drafts/${draft}/approve`).expect(409);
    expect(await balance(org, '4000')).toBe(50000);
    const second = (await post(org, '/drafts', invoice(), staff).expect(201)).body.id;
    await post(org, `/drafts/${second}/reject`, { reason: 'Duplicate' }).expect(201);
    const list = (await get(org, '/drafts').expect(200)).body;
    expect(list.map((d: any) => d.status)).toEqual(['rejected', 'approved']);
    expect(list[0]).toMatchObject({ reason: 'Duplicate', submittedBy: 'T staff@more.com' });
  });

  it('expense claim: taxi 450 + lunch 120 approved (owed to the employee), then repaid from the bank', async () => {
    await post(org, '/expense-claims', { date: today, title: 'Bad', lines: [{ description: 'x', accountId: await accId(org, '1000'), amount: 100 }] }, staff).expect(400);
    claim = (await post(org, '/expense-claims', { date: today, title: 'Client visit', lines: [
      { description: 'Taxi', accountId: await accId(org, '5540'), amount: 45000 }, { description: 'Lunch', accountId: await accId(org, '5550'), amount: 12000 }] }, staff).expect(201)).body.id;
    await post(org, `/expense-claims/${claim}/pay`, { date: today, accountId: await accId(org, '1010') }, staff).expect(409); // not approved yet
    await post(org, `/expense-claims/${claim}/approve`, {}, staff).expect(403);
    await post(org, `/expense-claims/${claim}/approve`).expect(201);
    expect(await balance(org, '2310')).toBe(57000);
    expect(await balance(org, '5540')).toBe(45000);
    await post(org, `/expense-claims/${claim}/pay`, { date: today, accountId: await accId(org, '1010') }, staff).expect(201);
    expect(await balance(org, '2310')).toBe(0);
    expect(await balance(org, '1010')).toBe(-57000);
    expect((await get(org, '/expense-claims').expect(200)).body[0]).toMatchObject({ status: 'paid', total: 57000, claimant: 'T staff@more.com' });
  });
});

describe('practice overview', () => {
  it('lists every client with receivables, cash and work waiting, plus firm totals', async () => {
    const r = (await ctx.http().get('/api/practice/overview').set(auth(t)).expect(200)).body;
    expect(r.totals.clients).toBe(6);
    const exp = r.clients.find((c: any) => c.name === 'Export House');
    expect(exp).toMatchObject({ receivable: 11800, payable: 1000000 });
    expect(r.clients.find((c: any) => c.name === 'Approval Ltd')).toMatchObject({ receivable: 50000, awaitingApproval: 0 });
    const staffView = (await ctx.http().get('/api/practice/overview').set(auth(staff)).expect(200)).body;
    expect(staffView.totals.clients).toBe(6); // staff see every client of the firm they work for
  });
});
