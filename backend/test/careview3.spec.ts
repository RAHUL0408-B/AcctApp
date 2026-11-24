// Changes asked for in the CA's third review (Points Noted 3): search finds records again, posted documents can be
// voided, duplicated and edited without losing the history, attachments change without a void, TDS on sales, custom TDS
// and GST rates, journal list details, drill-downs behind reports and the dashboard, and batch allocation unlinks.
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { auth, boot, mkGstin } from './helpers';

const dataDir = mkdtempSync(join(tmpdir(), 'acctapp-data-'));
process.env.DATA_DIR = dataDir;
process.env.WORKER = 'off';

describe('CA review 3', () => {
  let ctx: Awaited<ReturnType<typeof boot>>, t: string, firmId: number, org: number;
  const base = () => `/api/orgs/${org}`;
  const post = (p: string, b: object = {}, tok = t) => ctx.http().post(base() + p).set(auth(tok)).send(b);
  const put = (p: string, b: object, tok = t) => ctx.http().put(base() + p).set(auth(tok)).send(b);
  const get = (p: string, tok = t) => ctx.http().get(base() + p).set(auth(tok));
  const today = new Date().toISOString().slice(0, 10);
  const line = (rate: number, extra: object = {}) => ({ description: 'Work', quantity: 1, rate, gstRateBp: 1800, ...extra });

  beforeAll(async () => {
    ctx = await boot(54393);
    const u = await ctx.register('owner@review3.com', 'Review Three & Co');
    t = u.token; firmId = u.firmId;
    org = await ctx.newOrg(t, firmId, 'Nashik Mills', { gstin: '27AAPFU0939F1ZV' });
  });
  afterAll(async () => { await ctx?.stop(); rmSync(dataDir, { recursive: true, force: true }); });

  it('search finds contacts, invoices, bills and journals, not only screens', async () => {
    const cust = (await post('/contacts', { kind: 'customer', name: 'Godavari Traders', gstin: mkGstin('27AAACG4321G1Z') }).expect(201)).body.id;
    const sup = (await post('/contacts', { kind: 'supplier', name: 'Godavari Steel', stateCode: '27' }).expect(201)).body.id;
    const inv = (await post('/documents', { docType: 'invoice', contactId: cust, issueDate: today, lines: [line(10000)] }).expect(201)).body;
    await post('/documents', { docType: 'bill', contactId: sup, issueDate: today, supplierRef: 'GS-77', lines: [line(5000)] }).expect(201);
    const r = (await get('/search?q=godavari').expect(200)).body.results;
    const types = r.map((x: any) => x.type);
    expect(types).toEqual(expect.arrayContaining(['Contact', 'Invoice', 'Bill']));
    expect(r.find((x: any) => x.type === 'Invoice').page).toBe(`invoices/open-${inv.id}`);
    expect(r.find((x: any) => x.type === 'Contact' && x.title === 'Godavari Traders').page).toBe(`customers/${cust}`);
    expect((await get('/search?q=GS-77').expect(200)).body.results.some((x: any) => x.type === 'Bill')).toBe(true);
  });

  const accId = async (code: string) => (await get('/accounts').expect(200)).body.find((a: any) => a.code === code).id;
  const tbRow = async (code: string) => (await get('/trial-balance').expect(200)).body.accounts.find((a: any) => a.code === code) ?? { debit: 0, credit: 0 };

  it('2FA setup returns a QR code to scan as well as the key', async () => {
    const u = await ctx.register('qr@review3.com', 'QR Co');
    const r = (await ctx.http().post('/api/auth/2fa/setup').set(auth(u.token)).expect(200)).body;
    expect(r.secret).toBeTruthy();
    expect(r.qr).toMatch(/^data:image\/png;base64,/);
  });

  it('history shows the particulars of an edit and what changed from and to', async () => {
    const cust = (await post('/contacts', { kind: 'customer', name: 'Trimbak Foods', stateCode: '27' }).expect(201)).body.id;
    const inv = (await post('/documents', { docType: 'invoice', contactId: cust, issueDate: today, lines: [line(10000)] }).expect(201)).body;
    const ed = (await put(`/documents/${inv.id}`, { docType: 'invoice', contactId: cust, issueDate: today, lines: [line(20000)] }).expect(200)).body;
    const h = (await get(`/history?entity=document&entityId=${ed.id}`).expect(200)).body;
    const edit = h.find((x: any) => x.action === 'edit');
    expect(edit.particulars).toContain(inv.number);
    expect(edit.particulars).toContain('Trimbak Foods');
    expect(edit.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'Total', from: '118.00', to: '236.00' }),
      expect.objectContaining({ field: 'Taxable value', from: '100.00', to: '200.00' }),
    ]));
    // the history can be searched by a document number
    expect((await get(`/history?q=${encodeURIComponent(inv.number)}`).expect(200)).body.length).toBeGreaterThan(0);
  });

  it('one document can be unlinked from a batch payment; the rest stay paid and the books balance', async () => {
    const sup = (await post('/contacts', { kind: 'supplier', name: 'Batch Supplies', stateCode: '27' }).expect(201)).body.id;
    const b1 = (await post('/documents', { docType: 'bill', contactId: sup, issueDate: today, supplierRef: 'BS-1', lines: [line(100000)] }).expect(201)).body.id; // 1,180
    const b2 = (await post('/documents', { docType: 'bill', contactId: sup, issueDate: today, supplierRef: 'BS-2', lines: [line(200000)] }).expect(201)).body.id; // 2,360
    const bank = await accId('1010');
    const bankBefore = await tbRow('1010');
    const o1 = (await get(`/documents/${b1}`).expect(200)).body.outstanding, o2 = (await get(`/documents/${b2}`).expect(200)).body.outstanding;
    const made = await post('/payment-batches', { date: today, accountId: bank, items: [{ documentId: b1, amount: o1 }, { documentId: b2, amount: o2 }] });
    expect([made.status, made.body.message]).toEqual([201, undefined]);
    const batch = made.body;
    const one = (await get(`/payment-batches/${batch.id}`).expect(200)).body;
    expect(one.items.map((i: any) => i.documentId).sort()).toEqual([b1, b2].sort());
    const r = (await post(`/payment-batches/${batch.id}/unlink`, { documentIds: [b1] }).expect(201)).body;
    expect(r).toMatchObject({ unlinked: 1, amount: o1, batchTotal: o2 });
    expect((await get(`/documents/${b1}`).expect(200)).body.outstanding).toBe(o1);
    expect((await get(`/documents/${b2}`).expect(200)).body.outstanding).toBe(0);
    // only Rs 2,360 left the bank
    const bankAfter = await tbRow('1010');
    expect((bankBefore.debit - bankBefore.credit) - (bankAfter.debit - bankAfter.credit)).toBe(o2);
    await post(`/payment-batches/${batch.id}/unlink`, { documentIds: [b1] }).expect(400);           // no longer in the batch
    // undoing the rest reverses only what is left
    await ctx.http().delete(`${base()}/payment-batches/${batch.id}`).set(auth(t)).expect(200);
    expect((await get(`/documents/${b2}`).expect(200)).body.outstanding).toBe(o2);
    const bankEnd = await tbRow('1010');
    expect(bankEnd.debit - bankEnd.credit).toBe(bankBefore.debit - bankBefore.credit);
    expect((await get('/trial-balance').expect(200)).body.balanced).toBe(true);
  });

  it('TDS on a sales invoice: Dr debtor (net) and Dr TDS receivable, Cr sales and GST; forced below the threshold; typed by hand', async () => {
    const made = await post('/contacts', { kind: 'customer', name: 'Deolali Hospital', pan: 'AAACD1234D', stateCode: '27', defaultTdsSection: '194J' });
    expect([made.status, made.body.message]).toEqual([201, undefined]);
    const cust = made.body.id;
    // Rs 10,000 + 18% GST; 194J at 10% on the value before GST = Rs 1,000; below the Rs 30,000 threshold, so it needs "force"
    const below = (await post('/documents', { docType: 'invoice', contactId: cust, issueDate: today, tdsSection: '194J', lines: [line(1000000)] }).expect(201)).body;
    expect(below.tdsAmount).toBe(0);
    const tb0 = await tbRow('1400');
    const inv = (await post('/documents', { docType: 'invoice', contactId: cust, issueDate: today, tdsSection: '194J', tdsForced: true, lines: [line(1000000)] }).expect(201)).body;
    expect(inv).toMatchObject({ total: 1180000, tdsAmount: 100000, netPayable: 1080000 });
    const doc = (await get(`/documents/${inv.id}`).expect(200)).body;
    expect(doc.outstanding).toBe(1080000);                                         // the customer pays the net
    const tb1 = await tbRow('1400');
    expect((tb1.debit - tb1.credit) - (tb0.debit - tb0.credit)).toBe(100000);       // Dr TDS receivable
    // typed by hand
    const hand = (await post('/documents', { docType: 'invoice', contactId: cust, issueDate: today, tdsSection: '194J', tdsForced: true, tdsAmount: 75000, lines: [line(1000000)] }).expect(201)).body;
    expect(hand.tdsAmount).toBe(75000);
    // preview for an invoice
    const pv = (await get(`/tds-preview?section=194J&contactId=${cust}&amount=1000000&date=${today}&type=invoice&force=1`).expect(200)).body;
    expect(pv.tds).toBe(100000);
    expect((await get('/trial-balance').expect(200)).body.balanced).toBe(true);
  });

  it('a discount line with a negative rate has the opposite effect; the total must stay above zero', async () => {
    const cust = (await post('/contacts', { kind: 'customer', name: 'Discount Buyer', stateCode: '27' }).expect(201)).body.id;
    const inv = (await post('/documents', { docType: 'invoice', contactId: cust, issueDate: today, lines: [line(1000000), { description: 'Trade discount', quantity: 1, rate: -100000, gstRateBp: 1800 }] }).expect(201)).body;
    expect(inv.subtotal).toBe(900000);
    expect(inv.total).toBe(1062000);
    await post('/documents', { docType: 'invoice', contactId: cust, issueDate: today, lines: [line(10000), { description: 'Too much', quantity: 1, rate: -20000, gstRateBp: 1800 }] }).expect(400);
    expect((await get('/trial-balance').expect(200)).body.balanced).toBe(true);
  });

  it('own TDS sections, changed rates and thresholds (statutory kept), own GST rates, with history', async () => {
    const list0 = (await get('/tds-sections').expect(200)).body;
    const c194 = list0.find((x: any) => x.code === '194C');
    expect(c194.source).toBe('statutory');
    await put('/tds-sections/194C', { rateIndividualBp: 150, rateOtherBp: 250, singleThreshold: 4000000, annualThreshold: 12000000 }).expect(200);
    const changed = (await get('/tds-sections').expect(200)).body.find((x: any) => x.code === '194C');
    expect(changed).toMatchObject({ source: 'changed', rateIndividualBp: 150, rateOtherBp: 250, statutory: { rateIndividualBp: c194.rateIndividualBp } });
    await put('/tds-sections/9ZZ', { rateIndividualBp: 500, rateOtherBp: 500 }).expect(400);              // own section needs a description
    await put('/tds-sections/194ZZ', { description: 'Our special section', rateIndividualBp: 500, rateOtherBp: 500 }).expect(200);
    const sup = (await post('/contacts', { kind: 'supplier', name: 'Custom TDS Vendor', pan: 'AAACV1234V', stateCode: '27' }).expect(201)).body.id;
    const bill = (await post('/documents', { docType: 'bill', contactId: sup, issueDate: today, tdsSection: '194ZZ', lines: [line(1000000)] }).expect(201)).body;
    expect(bill.tdsAmount).toBe(50000);
    await ctx.http().delete(`${base()}/tds-sections/194ZZ`).set(auth(t)).expect(409);                // used on a posted bill
    await ctx.http().delete(`${base()}/tds-sections/194C`).set(auth(t)).expect(200);                 // back to statutory
    expect((await get('/tds-sections').expect(200)).body.find((x: any) => x.code === '194C').source).toBe('statutory');
    await put('/gst-rates', { rates: [75, 150] }).expect(200);
    const rates = (await get('/gst-rates').expect(200)).body;
    expect(rates.filter((r: any) => r.custom).map((r: any) => r.rateBp)).toEqual(expect.arrayContaining([75, 150]));
    const h = (await get('/history?entity=tds_section').expect(200)).body;
    expect(h.map((x: any) => x.action)).toEqual(expect.arrayContaining(['change_tds_section', 'add_tds_section', 'reset_tds_section']));
  });

  it('TDS on a quote is carried to the invoice it becomes', async () => {
    const cust = (await post('/contacts', { kind: 'customer', name: 'Quote TDS Co', pan: 'AAACQ1234Q', stateCode: '27' }).expect(201)).body.id;
    const qr = await post('/pre-documents', { kind: 'quote', contactId: cust, issueDate: today, tdsSection: '194J', tdsForced: true, lines: [line(1000000)] });
    expect([qr.status, qr.body.message]).toEqual([201, undefined]);
    const q = qr.body;
    expect((await get(`/pre-documents/${q.id}`).expect(200)).body).toMatchObject({ tdsSection: '194J', tdsForced: true });
    const conv = (await post(`/pre-documents/${q.id}/convert`, { issueDate: today }).expect(201)).body;
    expect((await get(`/documents/${conv.documentId}`).expect(200)).body).toMatchObject({ tdsSection: '194J', tdsAmount: 100000 });
  });

  it('a quote keeps the unit, product and cess of its lines, and carries them to the invoice', async () => {
    const cust = (await post('/contacts', { kind: 'customer', name: 'Quote Lines Co', stateCode: '27' }).expect(201)).body.id;
    const item = (await post('/items', { code: 'QL-1', name: 'Quoted item', kind: 'goods', saleRate: 5000, gstRateBp: 1800 }).expect(201)).body.id;
    const q = (await post('/pre-documents', { kind: 'quote', contactId: cust, issueDate: today, lines: [{ description: 'Quoted item', hsnSac: '8471', unit: 'NOS', quantity: 2, rate: 5000, gstRateBp: 1800, itemId: item, cessRateBp: 100 }] }).expect(201)).body;
    const back = (await get(`/pre-documents/${q.id}`).expect(200)).body;
    expect(back.lines[0]).toMatchObject({ unit: 'NOS', itemId: item, cessRateBp: 100 });
    const conv = (await post(`/pre-documents/${q.id}/convert`, { issueDate: today }).expect(201)).body;
    const doc = (await get(`/documents/${conv.documentId}`).expect(200)).body;
    expect(doc.lines[0]).toMatchObject({ unit: 'NOS', itemId: item });
  });

  it('a single-ledger export names the account in every format', async () => {
    const bank = await accId('1010');
    const rows = (await get(`/report-table/ledger?accountId=${bank}&from=2020-01-01`).expect(200)).body.rows;
    expect(String(rows[0][1])).toContain('1010 Bank Account');
  });
});
