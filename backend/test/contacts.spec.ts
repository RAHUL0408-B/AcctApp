// Contacts: bank details, default accounts, edit, archive, delete, and CSV import with bank columns.
import { auth, boot } from './helpers';

let ctx: Awaited<ReturnType<typeof boot>>;
let t: string, org: number, acc: (code: string) => number;
const base = () => `/api/orgs/${org}`;

beforeAll(async () => {
  ctx = await boot(54341);
  const u = await ctx.register('contacts@firm.com', 'Contacts Firm');
  t = u.token;
  org = await ctx.newOrg(t, u.firmId, 'Contact Traders');
  acc = await ctx.accounts(t, org);
});
afterAll(async () => { await ctx?.stop(); });

describe('contact details', () => {
  let id: number;
  it('saves bank details and default accounts', async () => {
    const r = await ctx.http().post(`${base()}/contacts`).set(auth(t)).send({
      kind: 'supplier', name: 'Bharat Steel', bankAccountName: 'Bharat Steel', bankName: 'HDFC Bank', bankAccountNo: '12345678901', bankIfsc: 'HDFC0000001',
      defaultSalesAccountId: acc('4000'), defaultPurchaseAccountId: acc('5000'),
    }).expect(201);
    id = r.body.id;
    const list = (await ctx.http().get(`${base()}/contacts`).set(auth(t)).expect(200)).body;
    const c = list.find((x: any) => x.id === id);
    expect(c).toMatchObject({ bankName: 'HDFC Bank', bankAccountNo: '12345678901', bankIfsc: 'HDFC0000001', defaultSalesAccountId: acc('4000'), defaultPurchaseAccountId: acc('5000'), isArchived: false });
  });
  it('rejects a bad IFSC and a default account of the wrong kind', async () => {
    await ctx.http().post(`${base()}/contacts`).set(auth(t)).send({ kind: 'customer', name: 'Bad Bank', bankIfsc: 'nope' }).expect(400);
    await ctx.http().post(`${base()}/contacts`).set(auth(t)).send({ kind: 'customer', name: 'Wrong Acct', defaultSalesAccountId: acc('2000') }).expect(400);
  });
  it('edits a contact', async () => {
    await ctx.http().put(`${base()}/contacts/${id}`).set(auth(t)).send({ kind: 'both', name: 'Bharat Steel Ltd', bankName: 'ICICI Bank' }).expect(200);
    const c = (await ctx.http().get(`${base()}/contacts`).set(auth(t))).body.find((x: any) => x.id === id);
    expect(c).toMatchObject({ name: 'Bharat Steel Ltd', kind: 'both', bankName: 'ICICI Bank', bankAccountNo: null });
    await ctx.http().put(`${base()}/contacts/999999`).set(auth(t)).send({ kind: 'both', name: 'Nobody' }).expect(404);
  });
  it('archives and restores, hiding archived contacts by default', async () => {
    await ctx.http().post(`${base()}/contacts/${id}/archive`).set(auth(t)).send({}).expect(201);
    expect((await ctx.http().get(`${base()}/contacts`).set(auth(t))).body.some((x: any) => x.id === id)).toBe(false);
    expect((await ctx.http().get(`${base()}/contacts?archived=true`).set(auth(t))).body.some((x: any) => x.id === id)).toBe(true);
    await ctx.http().post(`${base()}/contacts/${id}/archive`).set(auth(t)).send({ archived: false }).expect(201);
    expect((await ctx.http().get(`${base()}/contacts`).set(auth(t))).body.some((x: any) => x.id === id)).toBe(true);
  });
  it('deletes an unused contact but refuses one with an invoice', async () => {
    await ctx.http().delete(`${base()}/contacts/${id}`).set(auth(t)).expect(200);
    expect((await ctx.http().get(`${base()}/contacts?archived=true`).set(auth(t))).body.some((x: any) => x.id === id)).toBe(false);

    const used = (await ctx.http().post(`${base()}/contacts`).set(auth(t)).send({ kind: 'customer', name: 'Used Customer', stateCode: '27' }).expect(201)).body.id;
    await ctx.http().post(`${base()}/documents`).set(auth(t)).send({
      docType: 'invoice', contactId: used, issueDate: '2026-04-10', placeOfSupply: '27', lines: [{ description: 'Work', quantity: 1, rate: 100000, gstRateBp: 0 }],
    }).expect(201);
    const r = await ctx.http().delete(`${base()}/contacts/${used}`).set(auth(t)).expect(409);
    expect(r.body.message).toMatch(/Archive it instead/);
    // the failed delete must not have broken the connection or removed the contact
    expect((await ctx.http().get(`${base()}/contacts`).set(auth(t))).body.some((x: any) => x.id === used)).toBe(true);
  });
  it('imports contacts with bank columns', async () => {
    const csv = 'Name,Type,Bank Name,Bank Account Number,IFSC\nImported Co,Supplier,SBI,987654321012,SBIN0000123\n';
    const r = await ctx.http().post(`${base()}/import/contacts`).set(auth(t)).send({ csv }).expect(201);
    expect(r.body.imported).toBe(1);
    const c = (await ctx.http().get(`${base()}/contacts`).set(auth(t))).body.find((x: any) => x.name === 'Imported Co');
    expect(c).toMatchObject({ bankName: 'SBI', bankAccountNo: '987654321012', bankIfsc: 'SBIN0000123' });
    const bad = await ctx.http().post(`${base()}/import/contacts`).set(auth(t)).send({ csv: 'Name,IFSC\nX,bad\n' }).expect(201);
    expect(bad.body.ok).toBe(false);
  });
});
