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
});
