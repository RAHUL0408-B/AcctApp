// Changes asked for in the CA's review (Points Noted 2): contacts (address, constitution, unregistered dealers, default
// TDS, lower-deduction certificates, India SEZ), the contact import error list, invoice details (unit, number check,
// TDS preview, reminders for chosen invoices, LUT validity, Rule 46 particulars) and exports of any table.
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { inflateSync } from 'zlib';
import { auth, boot, mkGstin } from './helpers';
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
});
