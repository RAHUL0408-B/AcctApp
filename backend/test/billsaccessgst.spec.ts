// Repeating bills, batch payments, access per person, and GST details (cess, blocked credits, Rule 37 reversals,
// GSTR-2B amendments and credit notes, GSTR-1 JSON), with worked examples.
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { auth, boot, mkGstin } from './helpers';
import { getPool } from '../src/db/db';
import { runRecurring } from '../src/extras/extras.controller';
import { addDays } from '../src/compliance/checks';

const dataDir = mkdtempSync(join(tmpdir(), 'acctapp-data-'));
process.env.DATA_DIR = dataDir;
process.env.WORKER = 'off';

describe('repeating bills, batch payments, access and GST details', () => {
  let ctx: Awaited<ReturnType<typeof boot>>, t: string, firmId: number, org: number, acc: (code: string) => number, staffT: string, staffMember: number;
  let supplier: number, supplier2: number, customer: number;
  const base = () => `/api/orgs/${org}`;
  const post = (p: string, b: object = {}, tok = t) => ctx.http().post(base() + p).set(auth(tok)).send(b);
  const put = (p: string, b: object, tok = t) => ctx.http().put(base() + p).set(auth(tok)).send(b);
  const get = (p: string, tok = t) => ctx.http().get(base() + p).set(auth(tok));
  const del = (p: string, tok = t) => ctx.http().delete(base() + p).set(auth(tok));
  const today = new Date().toISOString().slice(0, 10);
  const line = (rate: number, extra: object = {}) => ({ description: 'Goods', quantity: 1, rate, gstRateBp: 1800, ...extra });
  const outstanding = async (id: number) => (await get(`/documents/${id}`).expect(200)).body.outstanding as number;
  /** Balance of an account in the trial balance (debit positive). */
  const balance = async (code: string) => {
    const a = (await get('/trial-balance').expect(200)).body.accounts.find((x: any) => x.code === code);
    return a ? a.debit - a.credit : 0;
  };

  beforeAll(async () => {
    ctx = await boot(54372);
    const u = await ctx.register('owner@bag.com', 'BAG Associates');
    t = u.token; firmId = u.firmId;
    org = await ctx.newOrg(t, firmId, 'Mumbai Motors', { gstin: '27AAPFU0939F1ZV' });
    acc = await ctx.accounts(t, org);
    supplier = (await post('/contacts', { kind: 'supplier', name: 'Landlord LLP', gstin: mkGstin('27AAACL1234L1Z'), pan: 'AAACL1234L' }).expect(201)).body.id;
    supplier2 = (await post('/contacts', { kind: 'supplier', name: 'Parts Co', gstin: mkGstin('29AAACP1234P1Z') }).expect(201)).body.id;
    customer = (await post('/contacts', { kind: 'customer', name: 'Rao Traders', gstin: mkGstin('27AAACR1234R1Z') }).expect(201)).body.id;
    const staff = await ctx.register('staff@bag.com');
    staffT = staff.token;
    await ctx.http().post('/api/members').set(auth(t)).send({ firmId, email: 'staff@bag.com', role: 'staff' }).expect(201);
    staffMember = (await ctx.http().get(`/api/firms/${firmId}/team`).set(auth(t)).expect(200)).body.members.find((m: any) => m.email === 'staff@bag.com').id;
  });
  afterAll(async () => { await ctx?.stop(); rmSync(dataDir, { recursive: true, force: true }); });

  // ------------------------------------------------------------ 1. repeating bills
  it('repeating bill: a Rs 50,000 monthly maintenance contract with TDS under 194C is posted on schedule', async () => {
    const tds = (await ctx.http().get('/api/config/tds-sections').set(auth(t)).expect(200)).body.map((x: any) => x.code);
    const sec = tds.includes('194C') ? '194C' : tds[0];
    const first = addDays(today, -40);
    await post('/recurring', { docType: 'bill', contactId: supplier, frequency: 'monthly', nextDate: first, dueDays: 10, autoEmail: true, lines: [line(5000000, { gstRateBp: 1800 })] }).expect(400); // bills are not emailed
    await post('/recurring', { docType: 'invoice', contactId: customer, frequency: 'monthly', nextDate: first, tdsSection: '999Z', lines: [line(100000)] }).expect(400);
    await post('/recurring', { docType: 'bill', contactId: customer, frequency: 'monthly', nextDate: first, lines: [line(100000)] }).expect(400);         // a customer, not a supplier
    const id = (await post('/recurring', { docType: 'bill', contactId: supplier, frequency: 'monthly', nextDate: first, dueDays: 10, tdsSection: sec, notes: 'Maintenance contract', postMode: 'auto', lines: [line(5000000)] }).expect(201)).body.id;
    expect((await get('/recurring?type=bill').expect(200)).body.map((r: any) => r.id)).toEqual([id]);
    expect((await get('/recurring').expect(200)).body).toEqual([]);                  // the invoice list does not show bills
    const r = await runRecurring(today);
    expect(r.created).toBe(2);                                                       // 40 days ago and 10 days ago
    const bills = (await get(`/documents?type=bill`).expect(200)).body.filter((d: any) => d.contactName === 'Landlord LLP');
    expect(bills).toHaveLength(2);
    const one = (await get(`/documents/${bills[0].id}`).expect(200)).body;
    expect(one).toMatchObject({ subtotal: 5000000, total: 5900000, tdsSection: sec, notes: 'Maintenance contract' });
    expect(one.tdsAmount).toBeGreaterThan(0);
    const sched = (await get('/recurring?type=bill')).body[0];
    expect(sched).toMatchObject({ docType: 'bill', made: 2 });
  });

  // ------------------------------------------------------------ 1. batch payments
  it('batch payment: two bills paid with one bank payment of Rs 3,540 posted as one entry', async () => {
    const b1 = (await post('/documents', { docType: 'bill', contactId: supplier2, issueDate: today, supplierRef: 'P-1', lines: [line(100000)] }).expect(201)).body.id; // Rs 1,180
    const b2 = (await post('/documents', { docType: 'bill', contactId: supplier2, issueDate: today, supplierRef: 'P-2', lines: [line(200000)] }).expect(201)).body.id; // Rs 2,360
    const inv = (await post('/documents', { docType: 'invoice', contactId: customer, issueDate: today, lines: [line(100000)] }).expect(201)).body.id;
    const bank = acc('1010'), bankBefore = await balance('1010'), creditorsBefore = await balance('2000');
    await post('/payment-batches', { date: today, accountId: bank, items: [{ documentId: b1, amount: 118000 }, { documentId: inv, amount: 118000 }] }).expect(400);   // bills and invoices do not mix
    await post('/payment-batches', { date: today, accountId: bank, items: [{ documentId: b1, amount: 118001 }] }).expect(400);                                       // more than due
    await post('/payment-batches', { date: today, accountId: bank, items: [{ documentId: b1, amount: 1000 }, { documentId: b1, amount: 1000 }] }).expect(400);         // twice
    const r = (await post('/payment-batches', { date: today, accountId: bank, reference: 'NEFT-778', items: [{ documentId: b1, amount: 118000 }, { documentId: b2, amount: 236000 }] }).expect(201)).body;
    expect(r).toMatchObject({ side: 'pay', total: 354000, count: 2 });
    expect([await outstanding(b1), await outstanding(b2)]).toEqual([0, 0]);
    expect(await balance('1010')).toBe(bankBefore - 354000);
    expect(await balance('2000')).toBe(creditorsBefore + 354000);
    const lines = (await getPool().query('SELECT count(*)::int AS n FROM journal_lines WHERE entry_id=$1', [r.journalEntryId])).rows[0].n;
    expect(lines).toBe(2);                                                           // one bank line, as on the statement
    const list = (await get('/payment-batches?side=pay').expect(200)).body;
    expect(list[0]).toMatchObject({ id: r.id, total: 354000, reference: 'NEFT-778', status: 'posted' });
    expect(list[0].items.map((i: any) => i.number)).toHaveLength(2);
    const payId = (await get(`/documents/${b1}`)).body.payments[0].id;
    await del(`/payments/${payId}`).expect(409);                                     // undo the whole batch instead
    await del(`/payment-batches/${r.id}`).expect(200);
    await del(`/payment-batches/${r.id}`).expect(409);
    expect([await outstanding(b1), await outstanding(b2)]).toEqual([118000, 236000]);
    expect(await balance('1010')).toBe(bankBefore);
    // Customer receipts work the same way.
    const rc = (await post('/payment-batches', { date: today, accountId: bank, items: [{ documentId: inv, amount: 50000 }] }).expect(201)).body;
    expect(rc.side).toBe('receive');
    expect(await outstanding(inv)).toBe(68000);
    expect((await get('/trial-balance')).body.balanced).toBe(true);
  });

  // ------------------------------------------------------------ 4. cess
  it('cess: a car sold at Rs 10,00,000 with 28% GST and 22% cess; cess goes to its own accounts and the returns', async () => {
    const inv = (await post('/documents', { docType: 'invoice', contactId: customer, issueDate: today, lines: [{ description: 'Car', quantity: 1, rate: 100000000, gstRateBp: 2800, cessRateBp: 2200 }] }).expect(201)).body;
    expect(inv).toMatchObject({ subtotal: 100000000, cgst: 14000000, sgst: 14000000, cess: 22000000, total: 150000000 });
    expect(await balance('2160')).toBe(-22000000);                                   // output cess (a credit)
    const bill = (await post('/documents', { docType: 'bill', contactId: supplier, issueDate: today, supplierRef: 'CAR-1', lines: [{ description: 'Car for resale', quantity: 1, rate: 80000000, gstRateBp: 2800, cessRateBp: 2200 }] }).expect(201)).body;
    expect(bill.cess).toBe(17600000);
    expect(await balance('1330')).toBe(17600000);                                    // input cess
    const g3 = (await ctx.http().get(`${base()}/reports/gstr3b?from=${today}&to=${today}`).set(auth(t)).expect(200)).body;
    expect(g3.section4_itcAvailable.cess).toBe(17600000);
    expect(g3.netTaxPayable.cess).toBe(22000000 - 17600000);
    const g1 = (await ctx.http().get(`${base()}/reports/gstr1?from=${today}&to=${today}`).set(auth(t)).expect(200)).body;
    expect(g1.b2b.find((x: any) => x.number === inv.number).cess).toBe(22000000);
    expect((await get(`/documents/${inv.id}`)).body.lines[0]).toMatchObject({ cessRateBp: 2200, cess: 22000000 });
    expect((await get('/trial-balance')).body.balanced).toBe(true);
  });

  // ------------------------------------------------------------ 4. blocked credits (17(5))
  it('blocked credit: GST on a staff lunch (Rs 1,000 + Rs 50) is part of the cost, not input credit', async () => {
    const food = (await post('/accounts', { code: '5990', name: 'Staff Welfare - Food', type: 'expense', group: 'Operating Expenses' }).expect(201)).body.id;
    const inputBefore = await balance('1300') + await balance('1310') + await balance('1320');
    const lunch = (await post('/documents', { docType: 'bill', contactId: supplier, issueDate: today, supplierRef: 'FOOD-1', lines: [{ description: 'Lunch', quantity: 1, rate: 100000, gstRateBp: 500, accountId: food, itcBlocked: true }] }).expect(201)).body;
    expect(lunch.total).toBe(105000);
    expect(await balance('5990')).toBe(105000);                                      // the whole Rs 1,050 is the expense
    expect(await balance('1300') + await balance('1310') + await balance('1320')).toBe(inputBefore);
    // Marking the account blocked makes every later bill on it blocked without ticking the line.
    await put(`/accounts/${food}/itc-blocked`, { blocked: true }).expect(200);
    await put(`/accounts/${acc('1010')}/itc-blocked`, { blocked: true }).expect(200); // bank is an asset: allowed but harmless
    await put(`/accounts/${acc('4000')}/itc-blocked`, { blocked: true }).expect(400); // income account
    await post('/documents', { docType: 'bill', contactId: supplier, issueDate: today, supplierRef: 'FOOD-2', lines: [{ description: 'Dinner', quantity: 1, rate: 200000, gstRateBp: 500, accountId: food }] }).expect(201);
    expect(await balance('5990')).toBe(105000 + 210000);
    expect((await get('/accounts')).body.find((a: any) => a.id === food).itcBlocked).toBe(true);
    const g3 = (await ctx.http().get(`${base()}/reports/gstr3b?from=${today}&to=${today}`).set(auth(t)).expect(200)).body;
    expect(g3.section4d_ineligibleItc.cgst + g3.section4d_ineligibleItc.sgst).toBe(5000 + 10000);
    expect((await get('/trial-balance')).body.balanced).toBe(true);
  });

  // ------------------------------------------------------------ 4. Rule 37
  it('Rule 37: credit on a bill unpaid for 200 days is reversed, then reclaimed once paid', async () => {
    const old = (await post('/documents', { docType: 'bill', contactId: supplier2, issueDate: addDays(today, -200), supplierRef: 'OLD-9', lines: [line(100000)] }).expect(201)).body.id; // IGST Rs 180
    const young = (await post('/documents', { docType: 'bill', contactId: supplier2, issueDate: addDays(today, -20), supplierRef: 'NEW-9', lines: [line(100000)] }).expect(201)).body.id;
    await post(`/compliance/itc-180/${young}/reverse`).expect(400);                  // not 180 days yet
    const r = (await post(`/compliance/itc-180/${old}/reverse`).expect(201)).body;
    expect(r).toMatchObject({ amount: 18000, igst: 18000, cgst: 0, sgst: 0 });
    expect(await balance('1340')).toBe(18000);
    await post(`/compliance/itc-180/${old}/reverse`).expect(409);
    const report = (await get('/compliance/itc-180').expect(200)).body;
    expect(report.rows.find((x: any) => x.id === old)).toMatchObject({ status: 'reversed' });
    const g3 = (await ctx.http().get(`${base()}/reports/gstr3b?from=${today}&to=${today}`).set(auth(t)).expect(200)).body;
    expect(g3.section4b2_itcReversed.igst).toBe(18000);
    await post(`/compliance/itc-180/${old}/reclaim`).expect(400);                     // still unpaid
    await post(`/documents/${old}/payments`, { date: today, amount: 118000, accountId: acc('1010') }).expect(201);
    const back = (await post(`/compliance/itc-180/${old}/reclaim`).expect(201)).body;
    expect(back.amount).toBe(18000);
    expect(await balance('1340')).toBe(0);
    const list = (await get('/compliance/itc-reversals').expect(200)).body;
    expect(list[0]).toMatchObject({ number: expect.any(String), amount: 18000, reclaimedOn: today, canReclaim: false });
    const g3b = (await ctx.http().get(`${base()}/reports/gstr3b?from=${today}&to=${today}`).set(auth(t)).expect(200)).body;
    expect(g3b.section4a5_itcReclaimed.igst).toBe(18000);
  });

  // ------------------------------------------------------------ 4. GSTR-2B amendments and credit notes
  it('GSTR-2B: an amended invoice matches on its old number, and a supplier credit note matches our debit note', async () => {
    const s = (await post('/contacts', { kind: 'supplier', name: 'Amend Ltd', gstin: mkGstin('24AAACA1234A1Z') }).expect(201)).body.id;
    const month = today.slice(0, 7), d = `${today.slice(8, 10)}-${month.slice(5)}-${month.slice(0, 4)}`;
    const bill = (await post('/documents', { docType: 'bill', contactId: s, issueDate: today, supplierRef: 'AM/0007', lines: [line(100000)] }).expect(201)).body.id;
    await post('/documents', { docType: 'debit_note', contactId: s, issueDate: today, supplierRef: 'CN-3', originalDocId: bill, lines: [line(10000)] }).expect(201);
    const twoB = { data: { rtnprd: `${month.slice(5)}${month.slice(0, 4)}`, docdata: {
      b2ba: [{ ctin: mkGstin('24AAACA1234A1Z'), trdnm: 'Amend Ltd', inv: [{ oinum: 'AM-7', inum: 'AM-7A', dt: d, items: [{ txval: 1000, igst: 180 }] }] }],
      cdnr: [{ ctin: mkGstin('24AAACA1234A1Z'), trdnm: 'Amend Ltd', nt: [{ ntnum: 'CN-3', typ: 'C', dt: d, items: [{ txval: 100, igst: 18 }] }, { ntnum: 'CN-4', typ: 'C', dt: d, items: [{ txval: 50, igst: 9 }] }] }] } } };
    const up = (await post('/compliance/gstr2b', { fileName: '2b.json', content: JSON.stringify(twoB) }).expect(201)).body;
    expect(up.lines).toBe(3);
    const m = (await get(`/compliance/gstr2b/${up.id}`).expect(200)).body;
    const amended = m.rows.find((r: any) => r.invoiceNo === 'AM-7A');
    expect(amended).toMatchObject({ status: 'matched', kind: 'invoice', amended: true, originalNo: 'AM-7' });
    expect(amended.note).toMatch(/Amended by the supplier \(was AM-7\)/);
    expect(m.rows.find((r: any) => r.invoiceNo === 'CN-3')).toMatchObject({ status: 'matched', kind: 'credit_note' });
    const missing = m.rows.find((r: any) => r.invoiceNo === 'CN-4');
    expect(missing).toMatchObject({ status: 'only_2b', kind: 'credit_note', difference: -900 });
    expect(missing.note).toMatch(/Enter it as a debit note/);
  });

  // ------------------------------------------------------------ 4. GSTR-1 JSON
  it('GSTR-1 JSON: B2B with cess, B2CS, credit notes and HSN in the offline tool layout', async () => {
    const month = today.slice(0, 7);
    const unreg = (await post('/contacts', { kind: 'customer', name: 'Walk-in', stateCode: '27' }).expect(201)).body.id;
    const sale = (await post('/documents', { docType: 'invoice', contactId: unreg, issueDate: today, lines: [{ description: 'Oil', hsnSac: '2710', quantity: 2, rate: 50000, gstRateBp: 1800 }] }).expect(201)).body;
    const regInv = (await post('/documents', { docType: 'invoice', contactId: customer, issueDate: today, lines: [{ description: 'Tyres', hsnSac: '4011', quantity: 4, rate: 500000, gstRateBp: 2800 }] }).expect(201)).body;
    await post('/documents', { docType: 'credit_note', contactId: customer, issueDate: today, originalDocId: regInv.id, lines: [{ description: 'Return', hsnSac: '4011', quantity: 1, rate: 500000, gstRateBp: 2800 }] }).expect(201);
    await get('/reports/gstr1-json?month=2026-13').expect(400);
    const j = (await get(`/reports/gstr1-json?month=${month}`).expect(200)).body;
    expect(j).toMatchObject({ gstin: '27AAPFU0939F1ZV', fp: `${month.slice(5)}${month.slice(0, 4)}` });
    const rao = j.b2b.find((x: any) => x.ctin === mkGstin('27AAACR1234R1Z'));
    const tyres = rao.inv.find((i: any) => i.inum === regInv.number);
    expect(tyres).toMatchObject({ idt: `${today.slice(8, 10)}-${month.slice(5)}-${month.slice(0, 4)}`, val: 25600, pos: '27', rchrg: 'N', inv_typ: 'R' });
    expect(tyres.itms[0]).toEqual({ num: 1, itm_det: { rt: 28, txval: 20000, iamt: 0, camt: 2800, samt: 2800, csamt: 0 } });
    const car = rao.inv.find((i: any) => i.itms[0].itm_det.csamt > 0);
    expect(car.itms[0].itm_det).toMatchObject({ rt: 28, csamt: 220000 });           // the car sold with 22% cess
    expect(j.b2cs).toContainEqual({ sply_ty: 'INTRA', pos: '27', typ: 'OE', rt: 18, txval: 1000, iamt: 0, camt: 90, samt: 90, csamt: 0 });
    expect(j.cdnr[0].nt[0]).toMatchObject({ ntty: 'C', val: 6400, itms: [{ num: 1, itm_det: { rt: 28, txval: 5000, camt: 700, samt: 700 } }] });
    expect(j.hsn.data.find((h: any) => h.hsn_sc === '4011')).toMatchObject({ qty: 3, txval: 15000, camt: 2100, samt: 2100 });
    expect(sale.total).toBe(118000);
  });

  // ------------------------------------------------------------ 2. access per person
  it('access per person: a bank-only staff member can reconcile but not see sales, bills or reports', async () => {
    const team = () => ctx.http().put(`/api/firms/${firmId}/members/${staffMember}/access`).set(auth(t));
    await team().send({ access: { bank: 'edit', contacts: 'view', sales: 'none', purchases: 'none', accounting: 'none', reports: 'none', tax: 'none', projects: 'none', settings: 'none' } }).expect(200);
    await team().send({ access: { bank: 'all' } }).expect(400);
    await ctx.http().put(`/api/firms/${firmId}/members/${staffMember}/access`).set(auth(staffT)).send({ access: null }).expect(403); // only the owner
    const me = (await ctx.http().get('/api/auth/me').set(auth(staffT)).expect(200)).body;
    expect(me.memberships.find((x: any) => x.firmId === firmId).access).toMatchObject({ bank: 'edit', sales: 'none' });
    // bank: yes
    await get('/bank-accounts', staffT).expect(200);
    const hdfc = (await post('/bank-accounts', { name: 'HDFC', accountId: acc('1010') }).expect(201)).body.id;
    const cash = (await post('/bank-accounts', { name: 'Cash', accountId: acc('1000') }).expect(201)).body.id;
    await post('/bank-transfers', { date: today, fromBankAccountId: hdfc, toBankAccountId: cash, amount: 1000 }, staffT).expect(201);
    // the rest: no
    expect((await get('/documents?type=invoice', staffT)).status).toBe(403);
    expect((await get('/documents', staffT).expect(200)).body).toEqual([]);           // a mixed list shows nothing they may not see
    const anInvoice = (await get('/documents?type=invoice')).body[0].id;
    expect((await get(`/documents/${anInvoice}`, staffT)).status).toBe(403);
    expect((await get('/reports/pnl', staffT)).status).toBe(403);
    expect((await get('/compliance/itc-180', staffT)).status).toBe(403);
    expect((await post('/journal', { date: today, narration: 'x', lines: [{ accountId: acc('1000'), debit: 1 }, { accountId: acc('4000'), credit: 1 }] }, staffT)).status).toBe(403);
    expect((await post('/contacts', { kind: 'customer', name: 'Not allowed' }, staffT)).status).toBe(403); // contacts: view only
    await get('/contacts', staffT).expect(200);                                       // lists the forms need still load
    await get('/accounts', staffT).expect(200);
    // "view" lets them look but not change.
    await team().send({ access: { purchases: 'view', sales: 'none' } }).expect(200);
    const bills = (await get('/documents', staffT).expect(200)).body;
    expect(bills.length).toBeGreaterThan(0);
    expect(bills.every((d: any) => d.docType === 'bill' || d.docType === 'debit_note')).toBe(true);
    expect((await post('/documents', { docType: 'bill', contactId: supplier2, issueDate: today, lines: [line(1000)] }, staffT)).status).toBe(403);
    await get('/reports/pnl', staffT).expect(200);                                    // not limited any more
    // Giving everything back clears the limits; owners cannot be limited.
    const back = (await team().send({ access: { sales: 'edit', purchases: 'edit' } }).expect(200)).body;
    expect(back.access).toBeNull();
    await post('/documents', { docType: 'bill', contactId: supplier2, issueDate: today, lines: [line(1000)] }, staffT).expect(201);
    const ownerMember = (await ctx.http().get(`/api/firms/${firmId}/team`).set(auth(t))).body.members.find((m: any) => m.role === 'owner').id;
    await ctx.http().put(`/api/firms/${firmId}/members/${ownerMember}/access`).set(auth(t)).send({ access: { bank: 'none' } }).expect(400);
    const team2 = (await ctx.http().get(`/api/firms/${firmId}/team`).set(auth(t))).body;
    expect(team2.areas.map((a: any) => a.key)).toEqual(['sales', 'purchases', 'bank', 'accounting', 'reports', 'tax', 'contacts', 'projects', 'settings']);
  });
});
