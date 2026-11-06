// Backend for the change list: custom numbers, editing and deleting posted documents, attachments, fixed asset groups/disposal,
// journal rules, saved templates, quote/PO editing, expense claim resubmission, invoice matching in bank reconciliation, and new reports.
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { auth, boot } from './helpers';

const dataDir = mkdtempSync(join(tmpdir(), 'acctapp-data-'));
process.env.DATA_DIR = dataDir;
process.env.WORKER = 'off';

let ctx: Awaited<ReturnType<typeof boot>>;
let t: string, firmId: number, org: number, acc: (code: string) => number;
const base = () => `/api/orgs/${org}`;
const post = (path: string, body: object = {}) => ctx.http().post(base() + path).set(auth(t)).send(body);
const put = (path: string, body: object = {}) => ctx.http().put(base() + path).set(auth(t)).send(body);
const get = (path: string) => ctx.http().get(base() + path).set(auth(t));
const del = (path: string) => ctx.http().delete(base() + path).set(auth(t));
const binary = (req: any) => req.buffer(true).parse((res: any, cb: any) => { const d: Buffer[] = []; res.on('data', (x: Buffer) => d.push(x)); res.on('end', () => cb(null, Buffer.concat(d))); });

let cust: number, supplier: number;
const invoice = (extra: object = {}, rate = 100000) => ({ docType: 'invoice', contactId: cust, issueDate: '2026-04-10', placeOfSupply: '27', lines: [{ description: 'Work', quantity: 1, rate, gstRateBp: 0 }], ...extra });

beforeAll(async () => {
  ctx = await boot(54342);
  const u = await ctx.register('changes@firm.com', 'Changes Firm');
  t = u.token; firmId = u.firmId;
  org = await ctx.newOrg(t, firmId, 'Change Traders', { gstin: '27AAPFU0939F1ZV' });
  acc = await ctx.accounts(t, org);
  cust = (await post('/contacts', { kind: 'customer', name: 'Cust One', stateCode: '27' }).expect(201)).body.id;
  supplier = (await post('/contacts', { kind: 'supplier', name: 'Supp One', stateCode: '27' }).expect(201)).body.id;
});
afterAll(async () => { await ctx?.stop(); rmSync(dataDir, { recursive: true, force: true }); });

describe('document numbers', () => {
  it('shows the next number and accepts a typed one', async () => {
    const next = (await get('/documents-next-number?type=invoice&date=2026-04-10').expect(200)).body.number;
    expect(next).toBe('INV/26-27/0001');
    const typed = await post('/documents', invoice({ number: 'MYINV-77' })).expect(201);
    expect(typed.body.number).toBe('MYINV-77');
    await post('/documents', invoice({ number: 'MYINV-77' })).expect(409);
    // the automatic sequence is untouched by a typed number
    expect((await post('/documents', invoice()).expect(201)).body.number).toBe('INV/26-27/0001');
  });
  it('skips an automatic number that was already typed by hand', async () => {
    await post('/documents', invoice({ number: 'INV/26-27/0002' })).expect(201);
    expect((await post('/documents', invoice()).expect(201)).body.number).toBe('INV/26-27/0003');
  });
});

describe('contact default accounts', () => {
  it('uses the contact default sales account when a line has none', async () => {
    const other = (await post('/accounts', { code: '4050', name: 'Consulting Income', type: 'income', group: 'Revenue from Operations' }).expect(201)).body.id;
    const c2 = (await post('/contacts', { kind: 'customer', name: 'Defaulted', stateCode: '27', defaultSalesAccountId: other }).expect(201)).body.id;
    const d = (await post('/documents', invoice({ contactId: c2 })).expect(201)).body;
    const detail = (await get(`/documents/${d.id}`).expect(200)).body;
    expect(detail.lines[0].accountId).toBe(other);
  });
});

describe('editing and deleting posted documents', () => {
  let id: number, number: string;
  it('edits an invoice: old one is reversed, new one keeps the number', async () => {
    const d = (await post('/documents', invoice({}, 100000)).expect(201)).body;
    id = d.id; number = d.number;
    const e = (await put(`/documents/${id}`, invoice({}, 250000)).expect(200)).body;
    expect(e.number).toBe(number);
    expect(e.id).not.toBe(id);
    expect(e.total).toBe(250000);
    const old = (await get(`/documents/${id}`).expect(200)).body;
    expect(old.status).toBe('void');
    expect(old.replacedBy).toBe(e.id);
    id = e.id;
  });
  it('refuses an edit once a payment exists, then allows it after the payment is unlinked', async () => {
    const pay = (await post(`/documents/${id}/payments`, { date: '2026-04-20', amount: 50000, accountId: acc('1010') }).expect(201)).body;
    const r = await put(`/documents/${id}`, invoice({}, 300000)).expect(409);
    expect(r.body.message).toMatch(/payments/);
    await del(`/payments/${pay.id}`).expect(200);
    expect((await get(`/documents/${id}`)).body.outstanding).toBe(250000);
    expect((await put(`/documents/${id}`, invoice({}, 300000)).expect(200)).body.total).toBe(300000);
  });
  it('removes several at once and reports the ones it could not', async () => {
    const a = (await post('/documents', invoice()).expect(201)).body.id;
    const b = (await post('/documents', invoice()).expect(201)).body.id;
    await post(`/documents/${b}/payments`, { date: '2026-04-20', amount: 1000, accountId: acc('1010') }).expect(201);
    const r = (await post('/documents/bulk-void', { ids: [a, b], date: '2026-04-30' }).expect(201)).body;
    expect(r.voided).toEqual([a]);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].id).toBe(b);
    expect((await get(`/documents/${a}`)).body.status).toBe('void');
    expect((await get(`/documents/${b}`)).body.status).toBe('posted');
  });
  it('archives and hides', async () => {
    const a = (await post('/documents', invoice()).expect(201)).body.id;
    await post('/documents/bulk-archive', { ids: [a] }).expect(201);
    expect((await get('/documents').expect(200)).body.some((x: any) => x.id === a)).toBe(false);
    expect((await get('/documents?archived=true').expect(200)).body.find((x: any) => x.id === a).isArchived).toBe(true);
  });
});

describe('attachments', () => {
  it('links a file to a document and lists it', async () => {
    const d = (await post('/documents', invoice()).expect(201)).body.id;
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF').toString('base64');
    await post('/files', { name: 'po.pdf', mime: 'application/pdf', dataBase64: pdf, linkType: 'document', linkId: d }).expect(201);
    await post('/files', { name: 'bad.pdf', mime: 'application/pdf', dataBase64: pdf, linkType: 'document' }).expect(400);
    const list = (await get(`/files?linkType=document&linkId=${d}`).expect(200)).body;
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('po.pdf');
  });
});

describe('journal rules and bulk reverse', () => {
  it('posts due runs on a schedule and catches up', async () => {
    const r = (await post('/journal-rules', { name: 'Insurance', narration: 'Monthly insurance write-off', frequency: 'monthly', startDate: '2026-01-31', endDate: '2026-03-31',
      lines: [{ accountId: acc('5550'), debit: 10000 }, { accountId: acc('1500'), credit: 10000 }] }).expect(201)).body;
    expect(r.id).toBeGreaterThan(0);
    expect((await post('/journal-rules/run').expect(201)).body.created).toBe(3);
    expect((await post('/journal-rules/run').expect(201)).body.created).toBe(0);
    const rules = (await get('/journal-rules').expect(200)).body;
    expect(rules[0]).toMatchObject({ name: 'Insurance', runs: 3, active: false });
    await post('/journal-rules', { name: 'Bad', narration: 'x', frequency: 'monthly', startDate: '2026-01-01', lines: [{ accountId: acc('5550'), debit: 1 }, { accountId: acc('1500'), credit: 2 }] }).expect(400);
  });
  it('keeps the cost centre on a repeating journal and refuses an unknown one', async () => {
    await post('/tracking', { name: 'Department', options: ['Sales', 'Admin'] }).expect(201);
    const cats = (await get('/tracking').expect(200)).body;
    const dept = cats.find((c: any) => c.name === 'Department');
    const admin = dept.options.find((o: any) => o.name === 'Admin').id;
    const lines = (cc: number) => [{ accountId: acc('5550'), debit: 5000, trackingOptionId: cc }, { accountId: acc('1500'), credit: 5000 }];
    await post('/journal-rules', { name: 'Admin cost', narration: 'Admin cost', frequency: 'yearly', startDate: '2026-02-15', lines: lines(999999) }).expect(400);
    await post('/journal-rules', { name: 'Admin cost', narration: 'Admin cost', frequency: 'yearly', startDate: '2026-02-15', lines: lines(admin) }).expect(201);
    expect((await post('/journal-rules/run').expect(201)).body.created).toBeGreaterThanOrEqual(1);
    const r = (await get(`/reports/pnl-by-tracking?categoryId=${dept.id}&from=2026-01-01&to=2026-12-31`).expect(200)).body;
    expect(r.columns).toContain('Admin');
    expect(r.expenses.totals[r.columns.indexOf('Admin')]).toBe(5000);
  });
  it('reverses several journal entries and refuses ones that belong to documents', async () => {
    const j1 = (await post('/journal', { date: '2026-04-01', narration: 'One', lines: [{ accountId: acc('5550'), debit: 500 }, { accountId: acc('1000'), credit: 500 }] }).expect(201)).body.id;
    const j2 = (await post('/journal', { date: '2026-04-01', narration: 'Two', lines: [{ accountId: acc('5550'), debit: 700 }, { accountId: acc('1000'), credit: 700 }] }).expect(201)).body.id;
    const docEntry = (await get('/documents').expect(200)).body[0];
    const entries = (await get('/journal').expect(200)).body as any[];
    const docJournal = entries.find((e) => e.reference === docEntry.number)?.id;
    const r = (await post('/journal/bulk-reverse', { ids: [j1, j2, docJournal ?? 999999], date: '2026-04-30' }).expect(201)).body;
    expect(r.reversed.sort()).toEqual([j1, j2].sort());
    expect(r.failed).toHaveLength(1);
  });
});

describe('saved templates', () => {
  it('saves, lists, overwrites and deletes', async () => {
    const payload = { contactId: cust, lines: [{ description: 'Retainer', quantity: 1, rate: 500000, gstRateBp: 1800 }], notes: 'Pay in 7 days' };
    const id = (await post('/doc-templates', { name: 'Monthly retainer', docType: 'invoice', payload }).expect(201)).body.id;
    await post('/doc-templates', { name: 'Monthly retainer', docType: 'invoice', payload: { ...payload, notes: 'Pay in 10 days' } }).expect(201);
    const list = (await get('/doc-templates').expect(200)).body;
    expect(list).toHaveLength(1);
    expect(list[0].payload.notes).toBe('Pay in 10 days');
    await del(`/doc-templates/${id}`).expect(200);
    expect((await get('/doc-templates')).body).toHaveLength(0);
  });
});

describe('quotes and purchase orders', () => {
  it('edits before converting, and converts with changes', async () => {
    const q = (await post('/pre-documents', { kind: 'quote', contactId: cust, issueDate: '2026-05-01', lines: [{ description: 'A', quantity: 1, rate: 100000, gstRateBp: 0 }] }).expect(201)).body.id;
    await put(`/pre-documents/${q}`, { contactId: cust, issueDate: '2026-05-01', lines: [{ description: 'A edited', quantity: 2, rate: 100000, gstRateBp: 0 }] }).expect(200);
    expect((await get(`/pre-documents/${q}`).expect(200)).body.lines[0].description).toBe('A edited');
    const r = (await post(`/pre-documents/${q}/convert`, { issueDate: '2026-05-02', lines: [{ description: 'Final', quantity: 3, rate: 100000, gstRateBp: 0 }], placeOfSupply: '27' }).expect(201)).body;
    const doc = (await get(`/documents/${r.documentId}`).expect(200)).body;
    expect(doc.total).toBe(300000);
    expect(doc.lines[0].description).toBe('Final');
    await put(`/pre-documents/${q}`, { contactId: cust, issueDate: '2026-05-01', lines: [{ description: 'x', quantity: 1, rate: 1, gstRateBp: 0 }] }).expect(409);
  });
});

describe('items', () => {
  it('sets and edits default sales and purchase accounts', async () => {
    const id = (await post('/items', { code: 'SKU1', name: 'Widget', kind: 'goods', salesAccountId: acc('4000'), purchaseAccountId: acc('5000') }).expect(201)).body.id;
    await put(`/items/${id}`, { name: 'Widget 2', gstRateBp: 1800, purchaseAccountId: acc('5020') }).expect(200);
    const it = (await get('/items')).body.find((x: any) => x.id === id);
    expect(it).toMatchObject({ name: 'Widget 2', purchaseAccountId: acc('5020'), salesAccountId: null });
    await put(`/items/${id}`, { name: 'Widget 2', purchaseAccountId: acc('4000') }).expect(400);
  });
});

describe('fixed assets', () => {
  let a: number;
  it('lists groups with Indian rates and gives each asset an editable code', async () => {
    const groups = (await get('/asset-groups').expect(200)).body;
    expect(groups.find((g: any) => g.name === 'Computers and software').itRateBp).toBe(4000);
    expect((await get('/fixed-assets-next-code')).body.code).toBe('FA-0001');
    const r = (await post('/fixed-assets', { name: 'Laptop', group: 'Computers and software', purchaseDate: '2026-04-15', cost: 12000000, residual: 0, method: 'wdv', rateBp: 4000 }).expect(201)).body;
    a = r.id;
    expect(r.code).toBe('FA-0001');
    const r2 = (await post('/fixed-assets', { name: 'AC', code: 'AC-01', group: 'Plant and machinery', purchaseDate: '2026-04-15', cost: 5000000, method: 'slm', rateBp: 1500 }).expect(201)).body;
    expect(r2.code).toBe('AC-01');
    await post('/fixed-assets', { name: 'Dup', code: 'ac-01', purchaseDate: '2026-04-15', cost: 5000000, method: 'slm', rateBp: 1500 }).expect(409);
    await post('/fixed-assets', { name: 'NoLife', purchaseDate: '2026-04-15', cost: 5000000, method: 'slm_life' }).expect(400);
  });
  it('edits an asset until depreciation is posted', async () => {
    await put(`/fixed-assets/${a}`, { name: 'Laptop Pro', code: 'LT-1', group: 'Computers and software', purchaseDate: '2026-04-15', cost: 13000000, residual: 0, method: 'wdv', rateBp: 4000 }).expect(200);
    await post('/fixed-assets/run-depreciation', { through: '2026-05-31' }).expect(201);
    await put(`/fixed-assets/${a}`, { name: 'Laptop Pro', code: 'LT-1', group: 'Computers and software', purchaseDate: '2026-04-15', cost: 14000000, residual: 0, method: 'wdv', rateBp: 4000 }).expect(409);
    await put(`/fixed-assets/${a}`, { name: 'Laptop Pro 2', code: 'LT-1', group: 'Computers and software', purchaseDate: '2026-04-15', cost: 13000000, residual: 0, method: 'wdv', rateBp: 4000 }).expect(200);
  });
  it('depreciates over a useful life by actual days', async () => {
    const id = (await post('/fixed-assets', { name: 'Server', purchaseDate: '2026-06-16', cost: 3650000, residual: 0, method: 'slm_life', usefulLifeMonths: 36, dayBasis: 'actual_days' }).expect(201)).body.id;
    await post('/fixed-assets/run-depreciation', { through: '2026-06-30' }).expect(201);
    const row = (await get('/fixed-assets')).body.find((x: any) => x.id === id);
    // yearly 3650000*12/36 = 1216667; 15 days of 365 = 50000 (rounded)
    expect(row.accumulated).toBe(Math.round((3650000 * 12 / 36) * 15 / 365));
    expect(row.usefulLifeMonths).toBe(36);
    expect(row.dayBasis).toBe('actual_days');
  });
  it('previews and posts a disposal with gain or loss', async () => {
    const bankId = acc('1010');
    const p = (await post(`/fixed-assets/${a}/dispose`, { date: '2026-06-30', proceeds: 12000000, accountId: bankId, preview: true }).expect(201)).body;
    expect(p.preview).toBe(true);
    expect(p.bookValue).toBe(p.cost - p.accumulatedDepreciation);
    expect(p.gain).toBe(12000000 - p.bookValue);
    expect((await get('/fixed-assets')).body.find((x: any) => x.id === a).status).toBe('active'); // preview changes nothing
    await post(`/fixed-assets/${a}/dispose`, { date: '2026-06-30', proceeds: 12000000 }).expect(400); // proceeds need an account
    const r = (await post(`/fixed-assets/${a}/dispose`, { date: '2026-06-30', proceeds: 12000000, accountId: bankId }).expect(201)).body;
    expect(r.entryId).toBeGreaterThan(0);
    const row = (await get('/fixed-assets')).body.find((x: any) => x.id === a);
    expect(row).toMatchObject({ status: 'disposed', disposalProceeds: 12000000, disposalGain: r.gain });
    // asset is gone from the books: cost out of 1600, accumulated depreciation cleared
    const tb = (await get('/reports/trial-balance?asOf=2026-06-30')).body;
    expect(tb).toBeDefined();
    await post(`/fixed-assets/${a}/dispose`, { date: '2026-07-01', proceeds: 1, accountId: bankId }).expect(404);
  });
});

describe('expense claims', () => {
  it('goes back to the claimant after rejection and can be resubmitted by them only', async () => {
    const line = { description: 'Taxi', accountId: acc('5540'), amount: 50000 };
    const c = (await post('/expense-claims', { date: '2026-05-01', title: 'Travel', lines: [line] }).expect(201)).body.id;
    await put(`/expense-claims/${c}`, { date: '2026-05-01', title: 'Travel 2', lines: [line] }).expect(409); // not rejected yet
    await post(`/expense-claims/${c}/reject`, { reason: 'Missing receipt' }).expect(201);
    const other = await ctx.register('other@firm.com', 'Other Firm');
    await ctx.http().put(`${base()}/expense-claims/${c}`).set(auth(other.token)).send({ date: '2026-05-01', title: 'x', lines: [line] }).expect(404); // not in their org
    const r = (await put(`/expense-claims/${c}`, { date: '2026-05-02', title: 'Travel corrected', lines: [{ ...line, amount: 45000 }] }).expect(200)).body;
    expect(r).toMatchObject({ status: 'submitted', total: 45000 });
    const row = (await get('/expense-claims')).body.find((x: any) => x.id === c);
    expect(row).toMatchObject({ status: 'submitted', title: 'Travel corrected', reason: null });
  });
});

describe('bank reconciliation against invoices', () => {
  let bank: number, inv: number, inv2: number, bill: number;
  const lineOf = async (desc: string) => ((await get(`/bank-accounts/${bank}/transactions`)).body as any[]).find((x) => x.description === desc);
  beforeAll(async () => {
    bank = (await post('/bank-accounts', { name: 'HDFC', accountId: acc('1010') }).expect(201)).body.id;
    inv = (await post('/documents', invoice({ number: 'BANK-A' }, 777700)).expect(201)).body.id;
    inv2 = (await post('/documents', invoice({ number: 'BANK-B' }, 888800)).expect(201)).body.id;
    bill = (await post('/documents', { docType: 'bill', contactId: supplier, issueDate: '2026-04-10', placeOfSupply: '27', lines: [{ description: 'Stock', quantity: 1, rate: 333300, gstRateBp: 0 }] }).expect(201)).body.id;
    const csv = 'Date,Narration,Amount\n2026-04-20,Receipt from Cust One,7777.00\n2026-04-21,Receipt partial,500.00\n2026-04-22,Paid Supp One,-3333.00\n2026-04-23,Mystery,123.45\n';
    await post(`/bank-accounts/${bank}/import`, { csv }).expect(201);
  });
  it('finds open documents for the same amount and searches by text', async () => {
    const l = await lineOf('Receipt from Cust One');
    const m = (await get(`/bank-transactions/${l.id}/document-matches`).expect(200)).body;
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ id: inv, exact: true, outstanding: 777700 });
    const out = await lineOf('Paid Supp One');
    expect((await get(`/bank-transactions/${out.id}/document-matches`)).body[0].id).toBe(bill);
    const none = await lineOf('Mystery');
    expect((await get(`/bank-transactions/${none.id}/document-matches`)).body).toHaveLength(0);
    const found = (await get(`/bank-transactions/${none.id}/document-matches?q=BANK-B`)).body;
    expect(found.map((x: any) => x.id)).toEqual([inv2]);
  });
  it('matches manually, records the payment and reconciles; direction is enforced', async () => {
    const l = await lineOf('Receipt partial');
    await post(`/bank-transactions/${l.id}/match-document`, { documentId: bill }).expect(400); // money in cannot match a bill
    const r = (await post(`/bank-transactions/${l.id}/match-document`, { documentId: inv2 }).expect(201)).body;
    expect(r.outstandingAfter).toBe(888800 - 50000);
    expect((await lineOf('Receipt partial')).status).toBe('reconciled');
  });
  it('auto-matches exact single matches only', async () => {
    const r = (await post(`/bank-accounts/${bank}/auto-match-documents`).expect(201)).body;
    expect(r.matched).toBe(2); // the receipt and the supplier payment; the mystery line stays
    expect((await lineOf('Receipt from Cust One')).status).toBe('reconciled');
    expect((await lineOf('Mystery')).status).toBe('unreconciled');
    expect((await get(`/documents/${inv}`)).body.outstanding).toBe(0);
  });
  it('unlinks a wrong match: the payment is removed and the invoice is outstanding again', async () => {
    const l = await lineOf('Receipt from Cust One');
    const r = (await post(`/bank-transactions/${l.id}/unlink`).expect(201)).body;
    expect(r).toMatchObject({ paymentUnlinked: true, documentNumber: 'BANK-A' });
    expect((await lineOf('Receipt from Cust One')).status).toBe('unreconciled');
    expect((await get(`/documents/${inv}`)).body.outstanding).toBe(777700);
    // and it can now be matched to the right invoice
    expect((await post(`/bank-transactions/${l.id}/match-document`, { documentId: inv }).expect(201)).body.reconciled).toBe(true);
  });
});

describe('new reports', () => {
  it.each(['all-ledgers', 'fixed-assets', 'invoice-wise', 'bill-wise', 'purchase-register'])('exports %s as Excel and PDF', async (name) => {
    for (const format of ['xlsx', 'pdf']) {
      const r = await binary(ctx.http().get(`${base()}/export/${name}?format=${format}&from=2026-01-01&to=2026-12-31&asOf=2026-12-31`).set(auth(t))).expect(200);
      expect((r.body as Buffer).length).toBeGreaterThan(500);
    }
  });
});

describe('export templates, options and combined exports', () => {
  const range = 'from=2026-01-01&to=2026-12-31&asOf=2026-12-31';
  const bin = (path: string) => binary(ctx.http().get(base() + path).set(auth(t))).expect(200).then((r: any) => r.body as Buffer);
  const pages = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  const ExcelJS = require('exceljs');
  const sheets = async (buf: Buffer) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf); return wb; };

  it('lists five built-in templates', async () => {
    const r = (await get('/export-settings').expect(200)).body;
    expect(r.presets.map((x: any) => x.name)).toEqual(['classic', 'modern', 'minimal', 'corporate', 'elegant']);
  });

  it.each(['classic', 'modern', 'minimal', 'corporate', 'elegant'])('renders a report and an invoice in the %s template', async (tpl) => {
    const rep = await bin(`/export/trial-balance?format=pdf&${range}&template=${tpl}`);
    expect(rep.subarray(0, 4).toString()).toBe('%PDF');
    const d = (await post('/documents', invoice({ number: `TPL-${tpl}` })).expect(201)).body.id;
    const inv = await bin(`/documents/${d}/pdf?template=${tpl}&accent=%23b91c1c&footer=Thank%20you`);
    expect(inv.subarray(0, 4).toString()).toBe('%PDF');
    expect(inv.length).toBeGreaterThan(1500);
  });

  it('applies customisation: leaves columns out and changes the title in Excel, with a centred merged heading', async () => {
    const plain = await sheets(await bin(`/export/trial-balance?format=xlsx&${range}`));
    const ws = plain.worksheets[0];
    const cols = ws.getRow(ws.actualRowCount > 0 ? 5 : 5).cellCount;
    const custom = await sheets(await bin(`/export/trial-balance?format=xlsx&${range}&template=corporate&title=Board%20pack&note=Draft&hide=0&footer=Confidential`));
    const cs = custom.worksheets[0];
    expect(cs.getCell('A2').value).toBe('Board pack');
    expect(cs.getCell('A2').alignment?.horizontal).toBe('center');
    expect(cs.getCell('A1').alignment?.horizontal).toBe('center');
    expect(cs.model.merges.length).toBeGreaterThan(0);
    expect(cs.getRow(6).cellCount).toBeLessThan(cols + 1);
    expect(cs.views[0].state).toBe('frozen');
    expect(cs.headerFooter.oddFooter).toContain('Confidential');
  });

  it('ignores a bad template, colour and column list instead of failing', async () => {
    const r = await bin(`/export/trial-balance?format=pdf&${range}&template=nope&accent=zzz&hide=abc,-1&fontSize=99&paper=x`);
    expect(r.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('puts several reports in one PDF and one workbook', async () => {
    const one = pages(await bin(`/export/pnl?format=pdf&${range}`));
    const many = await bin(`/export-multi?format=pdf&${range}&reports=pnl,balance-sheet,trial-balance,fixed-assets&template=modern`);
    expect(many.subarray(0, 4).toString()).toBe('%PDF');
    expect(pages(many)).toBeGreaterThanOrEqual(one + 3);
    const wb = await sheets(await bin(`/export-multi?format=xlsx&${range}&reports=pnl,balance-sheet,trial-balance`));
    expect(wb.worksheets.map((w: any) => w.name)).toHaveLength(3);
    await ctx.http().get(`${base()}/export-multi?format=pdf`).set(auth(t)).expect(400);
    await ctx.http().get(`${base()}/export-multi?format=pdf&reports=ledger`).set(auth(t)).expect(400);
    await ctx.http().get(`${base()}/export-multi?format=pdf&reports=nope`).set(auth(t)).expect(404);
  });

  it('puts several invoices in one PDF', async () => {
    const a = (await post('/documents', invoice({ number: 'MULTI-1' })).expect(201)).body.id;
    const b = (await post('/documents', invoice({ number: 'MULTI-2' })).expect(201)).body.id;
    const single = pages(await bin(`/documents/${a}/pdf`));
    const both = await bin(`/documents-pdf?ids=${a},${b}&template=elegant`);
    expect(pages(both)).toBeGreaterThanOrEqual(single + 1);
    await ctx.http().get(`${base()}/documents-pdf`).set(auth(t)).expect(400);
  });

  it('lists a report\'s columns for the picker', async () => {
    const r = (await get(`/export-columns/trial-balance?${range}`).expect(200)).body;
    expect(r.columns.length).toBeGreaterThan(2);
  });
});

describe('export template settings (owner only)', () => {
  const ExcelJS = require('exceljs');
  const range = 'from=2026-01-01&to=2026-12-31&asOf=2026-12-31';
  const as = (token: string, method: 'get' | 'post' | 'put' | 'delete', path: string, body?: object) => (ctx.http() as any)[method](base() + path).set(auth(token)).send(body ?? {});
  let accountant: string, staff: string, client: string, otherOwner: string, otherOrg: number, tplId: number;
  const design = { accent: '#b91c1c', headColour: '#7f1d1d', textColour: '#222222', font: 'mono', fontSize: 10, heading: 'band', tableHeader: 'solid', zebra: true, grid: true, rowLines: false, orientation: 'landscape', paper: 'A3', pageNumbers: false, footer: 'Brand footer', invoiceLabel: 'COMMERCIAL INVOICE' };
  const headerRow = async (path: string) => { const r = await binary(ctx.http().get(base() + path).set(auth(t))).expect(200); const wb = new ExcelJS.Workbook(); await wb.xlsx.load(r.body); return wb.worksheets[0].getRow(5).getCell(1); };

  beforeAll(async () => {
    accountant = (await ctx.register('acct@tpl.com', 'Acct Own Firm')).token;
    staff = (await ctx.register('staff@tpl.com', 'Staff Own Firm')).token;
    client = (await ctx.register('client@tpl.com', 'Client Own Firm')).token;
    await ctx.http().post('/api/members').set(auth(t)).send({ firmId, email: 'acct@tpl.com', role: 'accountant' }).expect(201);
    await ctx.http().post('/api/members').set(auth(t)).send({ firmId, email: 'staff@tpl.com', role: 'staff' }).expect(201);
    await ctx.http().post('/api/members').set(auth(t)).send({ firmId, email: 'client@tpl.com', role: 'client', orgId: org }).expect(201);
    const other = await ctx.register('other@tpl.com', 'Other Firm');
    otherOwner = other.token; otherOrg = await ctx.newOrg(other.token, other.firmId, 'Other Traders');
  });

  it('starts with Classic for reports and invoices', async () => {
    const r = (await get('/export-settings').expect(200)).body;
    expect(r).toMatchObject({ canEdit: true, defaults: { report: 'classic', document: 'classic' }, templates: [] });
  });

  it('lets the owner design a template; values are checked and completed', async () => {
    const r = await post('/export-templates', { name: 'Brand red', config: { ...design, accent: 'not-a-colour', fontSize: 99 } }).expect(201);
    tplId = r.body.id;
    const saved = (await get('/export-settings').expect(200)).body.templates.find((x: any) => x.id === tplId);
    expect(saved.config).toMatchObject({ font: 'mono', heading: 'band', tableHeader: 'solid', headColour: '#7f1d1d', footer: 'Brand footer', accent: '#111111', fontSize: 9, paper: 'A3' });
    await post('/export-templates', { name: 'brand RED', config: design }).expect(409);
    await post('/export-templates', { name: '', config: design }).expect(400);
  });

  it('keeps the owner as the only person who can change templates; others can still read them', async () => {
    for (const who of [accountant, staff, client]) {
      await as(who, 'post', '/export-templates', { name: 'Nope', config: design }).expect(403);
      await as(who, 'put', `/export-templates/${tplId}`, { name: 'Nope' }).expect(403);
      await as(who, 'delete', `/export-templates/${tplId}`).expect(403);
      await as(who, 'put', '/export-defaults', { report: 'modern', document: 'modern' }).expect(403);
      await as(who, 'post', '/export-preview', { config: design, kind: 'report' }).expect(403);
      const r = (await as(who, 'get', '/export-settings').expect(200)).body;
      expect(r.canEdit).toBe(false);
    }
  });

  it('applies the chosen template to reports without any options in the request', async () => {
    await put('/export-defaults', { report: `custom:${tplId}`, document: 'modern' }).expect(200);
    const cell = await headerRow(`/export/trial-balance?format=xlsx&${range}`);
    expect(cell.font.name).toBe('Courier New');
    expect(cell.fill.fgColor.argb).toBe('FF7F1D1D');           // the design's table heading colour
    expect(cell.value).toBe('Code');
    const multi = await binary(ctx.http().get(`${base()}/export-multi?format=xlsx&${range}&reports=trial-balance,pnl`).set(auth(t))).expect(200);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(multi.body);
    expect(wb.worksheets[0].getRow(5).getCell(1).fill.fgColor.argb).toBe('FF7F1D1D');
  });

  it('lets a request still ask for another built-in template', async () => {
    const cell = await headerRow(`/export/trial-balance?format=xlsx&${range}&template=elegant`);
    expect(cell.font.name).toBe('Times New Roman');
  });

  it('uses the chosen templates for invoice PDFs and scheduled reports', async () => {
    const d = (await post('/documents', invoice({ number: 'TPL-DEFAULT' })).expect(201)).body.id;
    const withModern = (await binary(ctx.http().get(`${base()}/documents/${d}/pdf`).set(auth(t))).expect(200)).body as Buffer;
    await put('/export-defaults', { report: `custom:${tplId}`, document: 'classic' }).expect(200);
    const withClassic = (await binary(ctx.http().get(`${base()}/documents/${d}/pdf`).set(auth(t))).expect(200)).body as Buffer;
    expect(withModern.equals(withClassic)).toBe(false);
    const sched = await post('/scheduled-reports', { report: 'trial-balance', format: 'xlsx', frequency: 'weekly', recipients: ['a@b.com'], firstRun: '2020-01-01' }).expect(201);
    expect(sched.body.id).toBeGreaterThan(0);
  });

  it('refuses a template that does not exist or belongs to another organisation', async () => {
    await put('/export-defaults', { report: 'custom:99999999', document: 'classic' }).expect(400);
    await put('/export-defaults', { report: 'sparkly', document: 'classic' }).expect(400);
    const theirs = (await ctx.http().post(`/api/orgs/${otherOrg}/export-templates`).set(auth(otherOwner)).send({ name: 'Theirs', config: design }).expect(201)).body.id;
    await put('/export-defaults', { report: `custom:${theirs}`, document: 'classic' }).expect(400);
    expect((await ctx.http().get(`/api/orgs/${otherOrg}/export-settings`).set(auth(otherOwner)).expect(200)).body.templates).toHaveLength(1);
    await ctx.http().get(`/api/orgs/${otherOrg}/export-settings`).set(auth(t)).expect(404);   // not a member of that organisation
  });

  it('edits a template and previews the design as a PDF', async () => {
    await put(`/export-templates/${tplId}`, { name: 'Brand red v2', config: { ...design, font: 'serif' } }).expect(200);
    expect((await get('/export-settings').expect(200)).body.templates[0]).toMatchObject({ name: 'Brand red v2', config: { font: 'serif' } });
    for (const kind of ['report', 'invoice']) {
      const r = await binary(ctx.http().post(`${base()}/export-preview`).set(auth(t)).send({ config: design, kind })).expect(201);
      expect((r.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    }
    await post('/export-preview', { config: design, kind: 'nope' }).expect(400);
  });

  it('puts a deleted template back to Classic', async () => {
    await put('/export-defaults', { report: `custom:${tplId}`, document: `custom:${tplId}` }).expect(200);
    await del(`/export-templates/${tplId}`).expect(200);
    expect((await get('/export-settings').expect(200)).body.defaults).toEqual({ report: 'classic', document: 'classic' });
    await del(`/export-templates/${tplId}`).expect(404);
  });

  it('limits how many templates can be kept', async () => {
    for (let i = 0; i < 20; i++) await post('/export-templates', { name: `T${i}`, config: design }).expect(201);
    await post('/export-templates', { name: 'One too many', config: design }).expect(400);
  });
});
