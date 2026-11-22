// Changes asked for in the CA's review (Points Noted 2): contacts (address, constitution, unregistered dealers, default
// TDS, lower-deduction certificates, India SEZ), the contact import error list, invoice details (unit, number check,
// TDS preview, reminders for chosen invoices, LUT validity, Rule 46 particulars) and exports of any table.
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { inflateSync } from 'zlib';
import { auth, boot, mkGstin, pw } from './helpers';
import { runRecurringFor } from '../src/extras/extras.controller';
import { fillNarration } from '../src/extras/narration';
import { nextCode } from '../src/coa/structure';
import { getPool } from '../src/db/db';

const dataDir = mkdtempSync(join(tmpdir(), 'acctapp-data-'));
process.env.DATA_DIR = dataDir;
process.env.WORKER = 'off';

/** Text drawn in a PDF made by pdfkit (its content streams are deflated). Good enough to look for words. */
function pdfText(buf: Buffer) {
  const s = buf.toString('latin1');
  let out = '';
  for (const m of s.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    try { out += inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); } catch { /* images and fonts */ }
  }
  // pdfkit writes text as hex glyph strings <...> or (...) inside TJ arrays.
  return [...out.matchAll(/\[(.*?)\]\s*TJ/g)].map((m) => m[1].replace(/<([0-9a-fA-F]+)>/g, (_, h) => Buffer.from(h, 'hex').toString('latin1')).replace(/\(([^)]*)\)/g, '$1').replace(/-?\d+(\.\d+)?/g, '').replace(/\s+/g, ''))
    .join(' ');
}

describe('CA review: contacts, invoices and exports', () => {
  let ctx: Awaited<ReturnType<typeof boot>>, t: string, firmId: number, org: number;
  const base = () => `/api/orgs/${org}`;
  const post = (p: string, b: object = {}, tok = t) => ctx.http().post(base() + p).set(auth(tok)).send(b);
  const put = (p: string, b: object, tok = t) => ctx.http().put(base() + p).set(auth(tok)).send(b);
  const get = (p: string, tok = t) => ctx.http().get(base() + p).set(auth(tok));
  const today = new Date().toISOString().slice(0, 10);
  const line = (rate: number, extra: object = {}) => ({ description: 'Work', quantity: 1, rate, gstRateBp: 1800, ...extra });

  beforeAll(async () => {
    ctx = await boot(54382);
    const u = await ctx.register('owner@review.com', 'Review & Co');
    t = u.token; firmId = u.firmId;
    org = await ctx.newOrg(t, firmId, 'Pune Works', { gstin: '27AAPFU0939F1ZV' });
  });
  afterAll(async () => { await ctx?.stop(); rmSync(dataDir, { recursive: true, force: true }); });

  it('contacts keep address, delivery address, constitution, SEZ, default TDS section, certificate rate and reverse charge', async () => {
    const id = (await post('/contacts', {
      kind: 'supplier', name: 'Shah Contractors', pan: 'AAAPS1234C', stateCode: '27', constitution: 'huf',
      addressLine1: '12 FC Road', city: 'Pune', pincode: '411004', shipLine1: 'Plot 4, MIDC', shipCity: 'Chakan', shipStateCode: '27', shipPincode: '410501',
      defaultTdsSection: '194C', lowerTdsRateBp: 50, lowerTdsCert: 'LDC-2026-77', rcmDefault: true,
    }).expect(201)).body.id;
    const c = (await get('/contacts').expect(200)).body.find((x: any) => x.id === id);
    expect(c).toMatchObject({ constitution: 'huf', isIndividual: true, addressLine1: '12 FC Road', city: 'Pune', pincode: '411004', shipLine1: 'Plot 4, MIDC', shipStateCode: '27',
      defaultTdsSection: '194C', lowerTdsRateBp: 50, lowerTdsCert: 'LDC-2026-77', rcmDefault: true, isSez: false });
    await post('/contacts', { kind: 'supplier', name: 'Bad TDS', stateCode: '27', defaultTdsSection: '999Z' }).expect(400);
    await post('/contacts', { kind: 'supplier', name: 'Bad kind', constitution: 'pirate' }).expect(400);
    const sez = (await post('/contacts', { kind: 'customer', name: 'SEZ Unit', gstin: mkGstin('27AAACS5555S1Z'), isSez: true }).expect(201)).body.id;
    expect((await get('/contacts').expect(200)).body.find((x: any) => x.id === sez).isSez).toBe(true);
    // A company: the "other" TDS rate; an edit that changes the constitution changes it.
    await put(`/contacts/${id}`, { kind: 'supplier', name: 'Shah Contractors', pan: 'AAAPS1234C', stateCode: '27', constitution: 'private_company', defaultTdsSection: '194C' }).expect(200);
    const after = (await get('/contacts').expect(200)).body.find((x: any) => x.id === id);
    expect(after).toMatchObject({ constitution: 'private_company', isIndividual: false, addressLine1: null, lowerTdsRateBp: null, rcmDefault: false });
  });

  it('TDS follows the constitution and a section 197 certificate; the preview equals what is posted', async () => {
    const huf = (await post('/contacts', { kind: 'supplier', name: 'Mehta HUF', pan: 'AAAHM1234M', stateCode: '27', constitution: 'huf', defaultTdsSection: '194C' }).expect(201)).body.id;
    const co = (await post('/contacts', { kind: 'supplier', name: 'Mehta Pvt Ltd', pan: 'AAACM1234M', stateCode: '27', constitution: 'private_company', defaultTdsSection: '194C' }).expect(201)).body.id;
    const cert = (await post('/contacts', { kind: 'supplier', name: 'Low Rate LLP', pan: 'AAAFL1234L', stateCode: '27', constitution: 'llp', defaultTdsSection: '194C', lowerTdsRateBp: 50 }).expect(201)).body.id;
    // Rs 40,000 contract: above the Rs 30,000 single-bill limit.
    for (const [cid, want] of [[huf, 40000], [co, 80000], [cert, 20000]] as const) {
      const p = (await get(`/tds-preview?section=194C&contactId=${cid}&amount=4000000&date=${today}`).expect(200)).body;
      expect(p.tds).toBe(want);                                  // 1% individual / HUF, 2% company, 0.5% certificate
      const d = (await post('/documents', { docType: 'bill', contactId: cid, issueDate: today, tdsSection: '194C', lines: [line(4000000)] }).expect(201)).body;
      expect(d.tdsAmount).toBe(want);
    }
    await get(`/tds-preview?section=194C&contactId=${huf}&amount=-1&date=${today}`).expect(400);
  });

  it('a bill from an unregistered dealer carries no GST and claims none', async () => {
    const urd = (await post('/contacts', { kind: 'supplier', name: 'Local Carpenter', stateCode: '27' }).expect(201)).body.id;
    const d = (await post('/documents', { docType: 'bill', contactId: urd, issueDate: today, supplyType: 'unregistered', lines: [line(1000000)] }).expect(201)).body;
    expect(d).toMatchObject({ subtotal: 1000000, cgst: 0, sgst: 0, igst: 0, total: 1000000, supplyType: 'unregistered' });
    const cust = (await post('/contacts', { kind: 'customer', name: 'Walk-in', stateCode: '27' }).expect(201)).body.id;
    await post('/documents', { docType: 'invoice', contactId: cust, issueDate: today, supplyType: 'unregistered', lines: [line(1000)] }).expect(400);
  });

  it('lines carry a GST unit; the number check finds a clash before saving; reminders go to chosen invoices', async () => {
    const cust = (await post('/contacts', { kind: 'customer', name: 'Gujarat Buyer', stateCode: '24', email: 'buyer@example.com', addressLine1: '7 CG Road', city: 'Ahmedabad', pincode: '380009' }).expect(201)).body.id;
    await post('/documents', { docType: 'invoice', contactId: cust, issueDate: today, lines: [line(100000, { unit: 'kilo' })] }).expect(400);
    const inv = (await post('/documents', { docType: 'invoice', contactId: cust, issueDate: today, number: 'GJ/001', dueDate: today, lines: [line(100000, { unit: 'kgs', quantity: 2.5 })] }).expect(201)).body;
    expect((await get(`/documents/${inv.id}`).expect(200)).body.lines[0].unit).toBe('KGS');
    expect((await get('/documents-number-check?type=invoice&number=gj/001').expect(200)).body).toMatchObject({ free: false, message: expect.stringMatching(/GJ\/001 is already used \(Gujarat Buyer/) });
    expect((await get('/documents-number-check?type=invoice&number=GJ/002').expect(200)).body).toEqual({ free: true });
    expect((await get(`/documents-number-check?type=invoice&number=GJ/001&except=${inv.id}`).expect(200)).body).toEqual({ free: true });
    expect((await get('/documents-number-check?type=bill&number=GJ/001').expect(200)).body).toEqual({ free: true }); // another series
    // Not overdue yet, but asked for by hand: sent anyway.
    expect((await post('/documents/remind-overdue', { ids: [inv.id] }).expect(201)).body.reminders).toBe(1);
    expect((await post('/documents/remind-overdue', {}).expect(201)).body.reminders).toBe(0);  // the all-overdue run skips it (not due yet)
    const mail = (await getPool().query("SELECT subject FROM email_outbox WHERE to_addr='buyer@example.com' ORDER BY id DESC LIMIT 1")).rows[0];
    expect(mail.subject).toMatch(/GJ\/001/);

    // Rule 46: the PDF names the place of supply, says whether reverse charge applies, prints the unit, the address and a signature.
    const pdf = await get(`/documents/${inv.id}/pdf`).buffer(true).parse((res, cb) => { const ch: Buffer[] = []; res.on('data', (d: Buffer) => ch.push(d)); res.on('end', () => cb(null, Buffer.concat(ch))); }).expect(200);
    const text = pdfText(pdf.body as Buffer);
    for (const w of ['Placeofsupply Gujarat', 'Reversecharge No', 'KGS', 'CGRoad', 'Ahmedabad', 'AuthorisedSignatory', 'ForPuneWorks']) expect(text).toContain(w); // (the helper drops digits)
  });

  it('zero-rated supplies need an LUT that has not ended', async () => {
    const usa = (await post('/contacts', { kind: 'customer', name: 'Acme Inc', country: 'US' }).expect(201)).body.id;
    await put('/settings', { lutNumber: 'AD270326001234X', lutFrom: '2025-04-01', lutTo: '2025-03-31' }).expect(400);  // ends before it starts
    await put('/settings', { lutNumber: 'AD270326001234X', lutFrom: '2024-04-01', lutTo: '2025-03-31', tan: 'pnea12345b' }).expect(200);
    expect((await get('/settings').expect(200)).body).toMatchObject({ lutNumber: 'AD270326001234X', lutTo: '2025-03-31', tan: 'PNEA12345B' });
    const r = await post('/documents', { docType: 'invoice', contactId: usa, issueDate: today, supplyType: 'export_lut', lines: [line(100000)] }).expect(400);
    expect(r.body.message).toMatch(/LUT AD270326001234X ended on 2025-03-31/);
    await put('/settings', { lutTo: null }).expect(200);
    await post('/documents', { docType: 'invoice', contactId: usa, issueDate: today, supplyType: 'export_lut', lines: [line(100000)] }).expect(201);
  });

  it('the contact import lists each wrong cell with what to change, and imports addresses and constitution', async () => {
    const bad = (await post('/import/contacts', { csv: 'Name,GSTIN,Email,Constitution\nA One,27AAPFU0939F1ZX,a@b.in,LLP\nB Two,,not-mail,Spaceship\n', dryRun: true }).expect(201)).body;
    expect(bad.ok).toBe(false);
    expect(bad.problems.map((p: any) => [p.row, p.column])).toEqual([[2, 'GSTIN'], [3, 'Email'], [3, 'Constitution']]);
    expect(bad.problems.every((p: any) => p.fix.length > 10)).toBe(true);
    const good = (await post('/import/contacts', { csv: 'Name,Type,State Code,Constitution,Address,City,PIN Code,TDS Section\nRoad Movers,Supplier,27,Partnership,5 Station Rd,Nashik,422001,194C\n' }).expect(201)).body;
    expect(good).toMatchObject({ ok: true, imported: 1 });
    expect((await get('/contacts').expect(200)).body.find((x: any) => x.name === 'Road Movers')).toMatchObject({ constitution: 'partnership', addressLine1: '5 Station Rd', city: 'Nashik', pincode: '422001', defaultTdsSection: '194C' });
  });

  it('any table exports as Excel, PDF, CSV or XML', async () => {
    const table = { title: 'Invoices', subtitle: 'Search: "Gujarat"', columns: [{ header: 'Number' }, { header: 'Due date' }, { header: 'Total', type: 'money' }],
      rows: [['GJ/001', '2026-11-21', 295000], ['A & B <x>', null, -150]], boldRows: [1] };
    const bin = (res: any, cb: any) => { const ch: Buffer[] = []; res.on('data', (d: Buffer) => ch.push(d)); res.on('end', () => cb(null, Buffer.concat(ch))); };
    const csv = await post('/export-table', { ...table, format: 'csv' }).buffer(true).parse(bin).expect(201);
    expect(csv.headers['content-disposition']).toMatch(/Invoices\.csv/);
    expect((csv.body as Buffer).toString('utf8')).toBe('﻿Number,Due date,Total\r\nGJ/001,2026-11-21,2950.00\r\nA & B <x>,,-1.50\r\n');
    const xml = (await post('/export-table', { ...table, format: 'xml' }).buffer(true).parse(bin).expect(201)).body.toString('utf8');
    expect(xml).toContain('<Due_date>2026-11-21</Due_date>');
    expect(xml).toContain('<Number>A &amp; B &lt;x&gt;</Number>');
    expect(xml).toContain('<Row total="true">');
    expect(xml).toContain('<Total currency="INR">2950.00</Total>');
    const xlsx = (await post('/export-table', { ...table, format: 'xlsx' }).buffer(true).parse(bin).expect(201)).body as Buffer;
    expect(xlsx.subarray(0, 2).toString()).toBe('PK');
    const pdf = (await post('/export-table', { ...table, format: 'pdf' }).buffer(true).parse(bin).expect(201)).body as Buffer;
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    await post('/export-table', { ...table, format: 'docx' }).expect(400);
    await post('/export-table', { ...table, columns: [], format: 'csv' }).expect(400);
  });
  it('chart of accounts: statement line, group and sub-group, the next number suggested, archive and delete', async () => {
    expect(nextCode(['5300', '5350'], 5000, 6000)).toBe('5360');
    expect(nextCode([], 5800, 5899)).toBe('5800');
    expect(nextCode(['5890', '5899'], 5800, 5899)).toBe('5800');
    const tree = (await get('/account-structure').expect(200)).body;
    const cl = tree.find((f: any) => f.key === 'cl');
    expect(cl.name).toBe('Current Liabilities');
    expect(cl.groups.find((g: any) => g.name === 'Duties & Taxes').sub.map((x: any) => x.name)).toEqual(expect.arrayContaining(['Output Tax Liability', 'TDS Payable']));
    const out = (await get('/accounts').expect(200)).body.find((a: any) => a.code === '2100');
    expect(out).toMatchObject({ fsli: 'cl', subGroup: 'Output Tax Liability', system: true });
    // Next number in Indirect Expenses > Administrative and Other Expenses follows the last one used there.
    const next = (await get('/accounts-next-code?fsli=ie&group=Administrative%20and%20Other%20Expenses').expect(200)).body;
    expect(Number(next.code)).toBeGreaterThanOrEqual(5500);
    const made = (await post('/accounts', { fsli: 'ie', group: 'Administrative and Other Expenses', name: 'Staff Welfare' }).expect(201)).body;
    expect(made.code).toBe(next.code);
    await post('/accounts', { fsli: 'ie', group: 'Administrative and Other Expenses', name: 'Dup', code: made.code }).expect(400);
    // A new group with its own number range, and a sub-group in it.
    await post('/account-groups', { fsli: 'ie', name: 'Vehicle Running', codeFrom: 5900, codeTo: 5949 }).expect(201);
    await post('/account-groups', { fsli: 'ie', name: 'Vehicle Running' }).expect(409);
    await post('/account-groups', { fsli: 'ie', name: 'Fuel', parent: 'Vehicle Running', codeFrom: 5900, codeTo: 5909 }).expect(201);
    expect((await get('/accounts-next-code?fsli=ie&group=Vehicle%20Running&subGroup=Fuel').expect(200)).body.code).toBe('5900');
    const fuel = (await post('/accounts', { fsli: 'ie', group: 'Vehicle Running', subGroup: 'Fuel', name: 'Diesel', itcBlocked: true }).expect(201)).body;
    expect(fuel.code).toBe('5900');
    expect((await get('/accounts').expect(200)).body.find((a: any) => a.id === fuel.id)).toMatchObject({ itcBlocked: true, group: 'Vehicle Running', subGroup: 'Fuel', type: 'expense' });
    // Edit, archive, delete.
    await put(`/accounts/${fuel.id}`, { name: 'Diesel and Petrol', fsli: 'ca', group: 'Inventories' }).expect(200);    // no entries yet: it may change type
    await put(`/accounts/${fuel.id}`, { name: 'Diesel and Petrol', fsli: 'ie', group: 'Vehicle Running', subGroup: 'Fuel' }).expect(200);
    await post(`/accounts/${out.id}/archive`, { archived: true }).expect(400);                                        // used by the software
    await ctx.http().delete(`${base()}/accounts/${out.id}`).set(auth(t)).expect(400);
    await post(`/accounts/${fuel.id}/archive`, { archived: true }).expect(201);
    expect((await get('/accounts').expect(200)).body.find((a: any) => a.id === fuel.id).isActive).toBe(false);
    await post(`/accounts/${fuel.id}/archive`, { archived: false }).expect(201);
    await ctx.http().delete(`${base()}/accounts/${fuel.id}`).set(auth(t)).expect(200);
    const cash = (await get('/accounts').expect(200)).body.find((a: any) => a.code === '1000').id, welfare = made.id;
    await post('/journal', { date: today, narration: 'Tea', lines: [{ accountId: welfare, debit: 5000 }, { accountId: cash, credit: 5000 }] }).expect(201);
    expect((await ctx.http().delete(`${base()}/accounts/${welfare}`).set(auth(t)).expect(409)).body.message).toMatch(/Archive it instead/);
  });

  it('journals get a voucher number with its own prefix; staff send them for review when approval is on', async () => {
    const acc = await ctx.accounts(t, org);
    const lines = [{ accountId: acc('5550'), debit: 10000 }, { accountId: acc('1000'), credit: 10000 }];
    const next = (await get(`/journal-next-number?date=${today}`).expect(200)).body.number;
    expect(next).toMatch(/^JV\/\d\d-\d\d\/\d{4}$/);
    const a = (await post('/journal', { date: today, narration: 'Office tea', reference: 'BILL-77', lines }).expect(201)).body;
    expect(a.voucherNo).toBe(next);
    await post('/journal', { date: today, narration: 'Clash', voucherNo: next.toLowerCase(), lines }).expect(409);
    const own = (await post('/journal', { date: today, narration: 'Own number', voucherNo: 'ADJ/1', lines }).expect(201)).body;
    expect(own.voucherNo).toBe('ADJ/1');
    const listed = (await get('/journal').expect(200)).body.find((e: any) => e.id === a.id);
    expect(listed).toMatchObject({ voucherNo: next, reference: 'BILL-77' });
    await ctx.http().put(`${base()}/org-settings`).set(auth(t)).send({ prefixes: { journal: 'jnl' } }).expect(200);
    expect((await get(`/journal-next-number?date=${today}`).expect(200)).body.number).toMatch(/^JNL\//);
    // A staff member, with approval required: review first.
    await ctx.register('staff@review.com');
    await ctx.http().post('/api/members').set(auth(t)).send({ firmId, email: 'staff@review.com', role: 'staff' }).expect(201);
    const staffT = (await ctx.http().post('/api/auth/login').send({ email: 'staff@review.com', password: pw }).expect(200)).body.token;
    await put('/settings', { requireApproval: true }).expect(200);
    expect((await post('/journal', { date: today, narration: 'Staff', lines }, staffT)).status).toBe(403);
    const d = (await post('/journal-drafts', { date: today, narration: 'Staff accrual', lines }, staffT).expect(201)).body;
    await post(`/journal-drafts/${d.id}/approve`, {}, staffT).expect(403);                       // staff cannot approve
    const ap = (await post(`/journal-drafts/${d.id}/approve`).expect(201)).body;
    expect(ap.voucherNo).toMatch(/^JNL\//);
    await post(`/journal-drafts/${d.id}/approve`).expect(409);
    await put('/settings', { requireApproval: false }).expect(200);
  });

  it('lock dates: your password to lock, and only the owner unlocks', async () => {
    await ctx.register('acct@review.com');
    await ctx.http().post('/api/members').set(auth(t)).send({ firmId, email: 'acct@review.com', role: 'accountant' }).expect(201);
    const acT = (await ctx.http().post('/api/auth/login').send({ email: 'acct@review.com', password: pw }).expect(200)).body.token;
    await put('/lock-dates', { lockThrough: '2025-03-31' }, acT).expect(400);
    await put('/lock-dates', { lockThrough: '2025-03-31', password: 'nope' }, acT).expect(401);
    await put('/lock-dates', { lockThrough: '2025-03-31', password: pw }, acT).expect(200);       // an accountant may lock
    await put('/lock-dates', { lockThrough: '2025-06-30', password: pw }, acT).expect(200);       // and lock further
    expect((await put('/lock-dates', { lockThrough: '2025-01-31', password: pw }, acT).expect(403)).body.message).toMatch(/Only the owner/);
    await put('/lock-dates', { lockThrough: null, password: pw }, acT).expect(403);
    await put('/lock-dates', { lockThrough: null, password: pw }).expect(200);                     // the owner unlocks
  });

  it('repeating bills wait for review, with the month in the narration; a schedule can be edited, archived and deleted', async () => {
    expect(fillNarration('Being milk supply bill posted for {month}', '2026-11-05')).toBe('Being milk supply bill posted for Nov-26');
    expect(fillNarration('{period} / {fy} / {quarter} / {date} / {unknown}', '2026-11-05')).toBe('01-11-2026 to 30-11-2026 / 2026-27 / Q3 2026-27 / 05-11-2026 / {unknown}');
    expect(fillNarration('Rent {period}', '2027-02-01', 'quarterly')).toBe('Rent 01-01-2027 to 31-03-2027');
    const sup = (await post('/contacts', { kind: 'supplier', name: 'Dairy Co', stateCode: '27' }).expect(201)).body.id;
    const start = new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10);
    const id = (await post('/recurring', { docType: 'bill', contactId: sup, frequency: 'monthly', nextDate: start, supplyType: 'unregistered', notes: 'Being milk supply bill posted for {month}', lines: [line(300000, { gstRateBp: 0 })] }).expect(201)).body.id;
    const listed = (await get('/recurring?type=bill').expect(200)).body.find((r: any) => r.id === id);
    expect(listed).toMatchObject({ postMode: 'review', supplyType: 'unregistered' });
    expect(await runRecurringFor(org)).toBe(0);                                                   // nothing posted by itself
    const due = (await get('/recurring-due').expect(200)).body.filter((d: any) => d.recurringId === id);
    expect(due.length).toBe(2);                                                                    // 40 days ago and 10 days ago
    expect(due[0].notes).toMatch(/^Being milk supply bill posted for [A-Z][a-z]{2}-\d\d$/);
    // The person opens one, adds the supplier's bill number and posts it.
    const doc = (await post('/documents', { docType: 'bill', contactId: sup, issueDate: due[0].dueDate, supplierRef: 'MILK-1', supplyType: 'unregistered', notes: due[0].notes, lines: due[0].lines }).expect(201)).body;
    await post(`/recurring-due/${due[0].id}`, { status: 'posted', documentId: doc.id }).expect(201);
    await post(`/recurring-due/${due[0].id}`, { status: 'posted', documentId: doc.id }).expect(409);
    await post(`/recurring-due/${due[1].id}`, { status: 'skipped' }).expect(201);
    expect((await get('/recurring-due').expect(200)).body.filter((d: any) => d.recurringId === id)).toEqual([]);
    // Edit, archive, delete.
    await put(`/recurring/${id}`, { docType: 'bill', contactId: sup, frequency: 'quarterly', nextDate: listed.nextDate, supplyType: 'unregistered', postMode: 'auto', notes: 'Milk {period}', lines: [line(350000, { gstRateBp: 0 })] }).expect(200);
    expect((await get('/recurring?type=bill').expect(200)).body.find((r: any) => r.id === id)).toMatchObject({ frequency: 'quarterly', postMode: 'auto', notes: 'Milk {period}' });
    await put(`/recurring/${id}`, { docType: 'invoice', contactId: sup, frequency: 'monthly', nextDate: listed.nextDate, lines: [line(1000)] }).expect(400);
    await post(`/recurring/${id}/archive`, { archived: true }).expect(201);
    expect((await get('/recurring?type=bill').expect(200)).body.find((r: any) => r.id === id)).toMatchObject({ isArchived: true, active: false });
    await ctx.http().delete(`${base()}/recurring/${id}`).set(auth(t)).expect(200);
    expect((await get('/recurring?type=bill').expect(200)).body.find((r: any) => r.id === id)).toBeUndefined();
    expect((await get(`/documents/${doc.id}`).expect(200)).body.status).toBe('posted');            // what was posted stays
  });

  it('a ledger for a range of accounts, with the source of each line; reports export as CSV and XML', async () => {
    const all = (await get('/report-table/all-ledgers?from=2020-01-01&fromCode=1000&toCode=1000').expect(200)).body;
    expect(all.title).toMatch(/^Ledger: 1000 /);
    const kinds = new Set(all.links.filter(Boolean).map((l: any) => l.kind));
    expect(kinds.has('account')).toBe(true);
    expect(kinds.has('journal')).toBe(true);
    const range = (await get('/report-table/all-ledgers?from=2020-01-01&fromCode=1000&toCode=1999').expect(200)).body;
    expect(range.rows.filter((_: any, i: number) => range.links[i]?.kind === 'account').every((r: any) => /^1\d{3} /.test(r[1]))).toBe(true);
    const bin = (res: any, cb: any) => { const ch: Buffer[] = []; res.on('data', (d: Buffer) => ch.push(d)); res.on('end', () => cb(null, Buffer.concat(ch))); };
    const csv = (await get('/export/trial-balance?format=csv').buffer(true).parse(bin).expect(200)).body.toString('utf8');
    expect(csv).toMatch(/^﻿Code,Account,Debit,Credit\r\n/);
    const xml = (await get('/export/all-ledgers?format=xml&fromCode=1000&toCode=1000').buffer(true).parse(bin).expect(200)).body.toString('utf8');
    expect(xml).toContain('<Report organisation="Pune Works"');
    const pnl = (await get('/reports/pnl?from=2020-01-01').expect(200)).body;
    expect(pnl.expenses.items[0]).toEqual(expect.objectContaining({ fsli: expect.any(String), group: expect.any(String) }));
  });
  it('Rule 46: missing particulars are listed, and strict mode stops the invoice until they are added', async () => {
    const buyer = (await post('/contacts', { kind: 'customer', name: 'Registered Buyer', gstin: mkGstin('27AAACB7777B1Z'), stateCode: '27' }).expect(201)).body.id;
    const body = { docType: 'invoice', contactId: buyer, issueDate: today, supplyType: 'regular', total: 118000, lines: [{ description: 'Goods', unit: 'NOS' }] };
    const warn = (await post('/documents-check', body).expect(201)).body;
    expect(warn.strict).toBe(false);
    expect(warn.issues.map((x: any) => x.text).join(' ')).toMatch(/business address is missing/);
    expect(warn.issues.map((x: any) => x.text).join(' ')).toMatch(/Registered Buyer has a GSTIN but no address/);
    expect(warn.issues.map((x: any) => x.text).join(' ')).toMatch(/no HSN\/SAC code/);
    // Off by default: the invoice is issued with a warning only.
    const line = { description: 'Goods', quantity: 1, rate: 100000, gstRateBp: 1800 };
    await post('/documents', { docType: 'invoice', contactId: buyer, issueDate: today, lines: [line] }).expect(201);
    await put('/settings', { strictInvoiceChecks: true }).expect(200);
    const blocked = await post('/documents', { docType: 'invoice', contactId: buyer, issueDate: today, lines: [line] }).expect(400);
    expect(blocked.body.message).toMatch(/not issued.*business address is missing.*no address/s);
    // Credit and debit notes against bills are not checked; fix each problem and the invoice goes through.
    await ctx.http().put(`${base()}/org-settings`).set(auth(t)).send({ addressLine1: '1 FC Road', city: 'Pune', pincode: '411004' }).expect(200);
    await put(`/contacts/${buyer}`, { kind: 'customer', name: 'Registered Buyer', gstin: mkGstin('27AAACB7777B1Z'), stateCode: '27', addressLine1: '9 MG Road', city: 'Pune', pincode: '411001' }).expect(200);
    const missingHsn = await post('/documents', { docType: 'invoice', contactId: buyer, issueDate: today, lines: [line] }).expect(400);
    expect(missingHsn.body.message).toMatch(/no HSN\/SAC code/);
    await post('/documents', { docType: 'invoice', contactId: buyer, issueDate: today, lines: [{ ...line, hsnSac: '8708' }] }).expect(201);
    await put('/settings', { strictInvoiceChecks: false }).expect(200);
  });

  it('customs duty: a duty ledger line on an export invoice, only when the organisation says duty applies', async () => {
    const duty = (await post('/accounts', { fsli: 'cl', group: 'Duties & Taxes', subGroup: 'Other Statutory Dues', name: 'Customs Duty Payable' }).expect(201)).body;
    const buyer = (await post('/contacts', { kind: 'customer', name: 'Dubai Trading LLC', country: 'AE' }).expect(201)).body.id;
    const goods = { description: 'Spares', quantity: 1, rate: 1000000, gstRateBp: 1800, hsnSac: '8708' };
    const dutyLine = { description: 'Customs duty', quantity: 1, rate: 50000, gstRateBp: 0, accountId: duty.id };
    const make = (extra: object = {}) => post('/documents', { docType: 'invoice', contactId: buyer, issueDate: today, supplyType: 'export_igst', lines: [goods, dutyLine], ...extra });
    expect((await make().expect(400)).body.message).toMatch(/duty ledger can only be used.*turned on/);        // not turned on
    await put('/settings', { customsDuty: true }).expect(200);
    expect((await get('/settings').expect(200)).body.customsDuty).toBe(true);
    expect((await make({ lines: [goods, { ...dutyLine, gstRateBp: 1800 }] }).expect(400)).body.message).toMatch(/carries no GST/);
    expect((await make({ supplyType: 'regular' }).expect(400)).body.message).toMatch(/duty ledger can only be used/);   // not an export
    const inv = (await make().expect(201)).body;
    expect(inv.total).toBe(1000000 + 180000 + 50000);                                                            // goods + IGST + duty
    const tb = (await get('/trial-balance').expect(200)).body.accounts.find((a: any) => a.code === duty.code);
    expect(tb.credit - tb.debit).toBe(50000);                                                                    // duty is a liability, not income
    const listed = (await get('/documents').expect(200)).body.find((d: any) => d.id === inv.id);
    expect(listed.bookedCode).toMatch(/^\d{4}$/);
    await put('/settings', { customsDuty: false }).expect(200);
  });
});
