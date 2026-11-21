// Organisation settings like Xero's: details, branding and payment details on invoices, numbering, email templates,
// reminders, lock dates, currencies and history.
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { auth, boot, pw } from './helpers';
import { getPool } from '../src/db/db';
import { fillTemplate, upiLink } from '../src/settings/settings';
import { fromHeader } from '../src/firm/mailer';

const dataDir = mkdtempSync(join(tmpdir(), 'acctapp-data-'));
process.env.DATA_DIR = dataDir;
process.env.WORKER = 'off';

// A 1x1 PNG.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

describe('settings helpers', () => {
  it('fills placeholders and leaves unknown ones', () => {
    expect(fillTemplate('Dear {contact}, {number} for Rs {amount} {x}', { contact: 'Kapoor', number: 'INV/1', amount: '100.00' })).toBe('Dear Kapoor, INV/1 for Rs 100.00 {x}');
  });
  it('builds a UPI link with the amount in rupees', () => {
    const l = upiLink('shop@okhdfcbank', 'Shree Traders', 118000, 'INV/26-27/0001');
    expect(l).toMatch(/^upi:\/\/pay\?/);
    const q = new URLSearchParams(l.split('?')[1]);
    expect(Object.fromEntries(q)).toMatchObject({ pa: 'shop@okhdfcbank', pn: 'Shree Traders', am: '1180.00', cu: 'INR', tn: 'INV/26-27/0001' });
  });
  it('puts the sender name in front of the MAIL_FROM address', () => {
    expect(fromHeader('AcctApp <no-reply@acct.app>', 'Shree "Traders"')).toBe('"Shree Traders" <no-reply@acct.app>');
    expect(fromHeader('no-reply@acct.app', null)).toBe('no-reply@acct.app');
  });
});

describe('organisation settings through the API', () => {
  let ctx: Awaited<ReturnType<typeof boot>>, t: string, firmId: number, org: number, staffT: string, cust: number, sales: number, cash: number;
  const base = () => `/api/orgs/${org}`;
  const post = (p: string, b: object = {}, tok = t) => ctx.http().post(base() + p).set(auth(tok)).send(b);
  const put = (p: string, b: object, tok = t) => ctx.http().put(base() + p).set(auth(tok)).send(b);
  const get = (p: string, tok = t) => ctx.http().get(base() + p).set(auth(tok));
  const today = new Date().toISOString().slice(0, 10);
  const line = { description: 'Service', quantity: 1, rate: 100000, gstRateBp: 1800 };

  beforeAll(async () => {
    ctx = await boot(54362);
    const u = await ctx.register('owner@settings.com', 'Settings CA');
    t = u.token; firmId = u.firmId;
    org = await ctx.newOrg(t, firmId, 'Shree Traders', { gstin: '27AAPFU0939F1ZV' });
    const staff = await ctx.register('staff@settings.com');
    staffT = staff.token;
    await ctx.http().post('/api/members').set(auth(t)).send({ firmId, email: 'staff@settings.com', role: 'staff' }).expect(201);
    cust = (await post('/contacts', { kind: 'customer', name: 'Kapoor Stores', stateCode: '27', email: 'kapoor@example.com' }).expect(201)).body.id;
    const acc = await ctx.accounts(t, org);
    sales = acc('4000'); cash = acc('1000');
  });
  afterAll(async () => { await ctx?.stop(); rmSync(dataDir, { recursive: true, force: true }); });

  it('saves organisation details and checks each field', async () => {
    await put('/org-settings', { legalName: 'Shree Traders Private Limited', businessType: 'private_limited', industry: 'Wholesale', cin: 'U51909MH2020PTC123456',
      tan: 'MUMS12345B', addressLine1: '12 MG Road', city: 'Pune', pincode: '411001', phone: '+91 20 1234 5678', email: 'accounts@shree.in', website: 'shree.in', timezone: 'Asia/Kolkata' }).expect(200);
    const s = (await get('/org-settings').expect(200)).body;
    expect(s).toMatchObject({ legalName: 'Shree Traders Private Limited', businessType: 'private_limited', city: 'Pune', pincode: '411001', tan: 'MUMS12345B', fyStartMonth: 4 });
    for (const bad of [{ pincode: '01100' }, { tan: 'ABC' }, { email: 'nope' }, { timezone: 'Mars/Base' }, { businessType: 'company' }, { logo: 'data:text/html;base64,AAAA' }])
      await put('/org-settings', bad).expect(400);
    await put('/org-settings', { city: '' }).expect(200);
    expect((await get('/org-settings')).body.city).toBeNull();               // an empty field clears it
  });

  it('only owners and accountants can change settings', async () => {
    await put('/org-settings', { industry: 'x' }, staffT).expect(403);
    await get('/org-settings', staffT).expect(200);
    await ctx.http().put(`/api/orgs/${org}/lock-dates`).set(auth(staffT)).send({ staffLockThrough: today, password: pw }).expect(403);
  });

  it('prints the logo, address and payment details with a UPI QR on sales invoices', async () => {
    const plain = (await post('/documents', { docType: 'invoice', contactId: cust, issueDate: today, lines: [line] }).expect(201)).body.id;
    const before = (await get(`/documents/${plain}/pdf`).buffer(true).parse((res, cb) => { const d: Buffer[] = []; res.on('data', (x: Buffer) => d.push(x)); res.on('end', () => cb(null, Buffer.concat(d))); }).expect(200)).body as Buffer;
    await put('/org-settings', { logo: PNG, city: 'Pune', bankName: 'HDFC Bank', bankAccountName: 'Shree Traders', bankAccountNo: '50100012345678', bankIfsc: 'HDFC0001234',
      upiId: 'shree@okhdfcbank', showPaymentOnInvoice: true, showUpiQr: true }).expect(200);
    await put('/org-settings', { bankIfsc: 'HDFC1234' }).expect(400);
    await put('/org-settings', { upiId: 'not a upi' }).expect(400);
    const pdf = (await get(`/documents/${plain}/pdf`).buffer(true).parse((res, cb) => { const d: Buffer[] = []; res.on('data', (x: Buffer) => d.push(x)); res.on('end', () => cb(null, Buffer.concat(d))); }).expect(200)).body as Buffer;
    const images = (b: Buffer) => (b.toString('latin1').match(/\/Subtype\s*\/Image/g) ?? []).length;
    expect(images(before)).toBe(0);
    expect(images(pdf)).toBeGreaterThanOrEqual(2);                             // the logo and the QR code (PNG transparency adds a mask image)
    expect(pdf.length).toBeGreaterThan(before.length);
    expect((await get('/upi-sample').expect(200)).body.link).toMatch(/^upi:\/\/pay\?pa=shree%40okhdfcbank/);
    // Bills never carry payment details (only the logo).
    const sup = (await post('/contacts', { kind: 'supplier', name: 'Paper Co', stateCode: '27' }).expect(201)).body.id;
    const bill = (await post('/documents', { docType: 'bill', contactId: sup, issueDate: today, lines: [line] }).expect(201)).body.id;
    const billPdf = (await get(`/documents/${bill}/pdf`).buffer(true).parse((res, cb) => { const d: Buffer[] = []; res.on('data', (x: Buffer) => d.push(x)); res.on('end', () => cb(null, Buffer.concat(d))); }).expect(200)).body as Buffer;
    expect(images(billPdf)).toBeGreaterThanOrEqual(1);
    expect(images(billPdf)).toBeLessThan(images(pdf));
  });

  it('uses the chosen number prefixes and starting numbers', async () => {
    await put('/org-settings', { prefixes: { invoice: 'si', quote: 'EST' } }).expect(200);
    await put('/org-settings', { prefixes: { invoice: 'S/I' } }).expect(400);
    const n = (await get('/numbering').expect(200)).body;
    expect(n.next.invoice).toMatch(/^SI\/\d\d-\d\d\/\d{4}$/);
    expect(n.next.quote).toMatch(/^EST-\d{4}$/);
    expect(n.next.bill).toMatch(/^BILL\//);
    await put('/numbering/next', { type: 'invoice', next: 500 }).expect(200);
    await put('/numbering/next', { type: 'invoice', next: 500 }, staffT).expect(403);
    const doc = (await post('/documents', { docType: 'invoice', contactId: cust, issueDate: today, lines: [line] }).expect(201)).body;
    expect(doc.number).toMatch(/^SI\/\d\d-\d\d\/0500$/);
    const q = (await post('/pre-documents', { kind: 'quote', contactId: cust, issueDate: today, lines: [line] }).expect(201)).body;
    expect(q.number).toMatch(/^EST-\d{4}$/);
    await put('/org-settings', { prefixes: { invoice: '' } }).expect(200);           // back to the built-in prefix
    expect((await get('/numbering')).body.next.invoice).toMatch(/^INV\//);
    expect((await get('/org-settings')).body.prefixes).toMatchObject({ invoice: 'INV', quote: 'EST', credit_note: 'CN' });
  });

  it('sends invoices and reminders with the email templates, reply-to and sender name', async () => {
    await put('/org-settings', { emailReplyTo: 'accounts@shree.in', emailSenderName: 'Shree Accounts', emailInvoiceSubject: 'Your bill {number} – {org}',
      emailInvoiceBody: 'Hello {contact}, amount Rs {amount}.', emailReminderSubject: 'Gentle nudge: {number}', emailReminderBody: 'Hi {contact}, Rs {amount} was due on {due}.', remindEveryDays: 3 }).expect(200);
    const inv = (await post('/documents', { docType: 'invoice', contactId: cust, issueDate: '2026-01-05', dueDate: '2026-01-20', lines: [line] }).expect(201)).body;
    await post(`/documents/${inv.id}/send`, {}).expect(201);
    const m = (await getPool().query('SELECT subject, body, reply_to, from_name FROM email_outbox WHERE subject LIKE $1', [`Your bill ${inv.number}%`])).rows[0];
    expect(m).toMatchObject({ subject: `Your bill ${inv.number} – Shree Traders`, reply_to: 'accounts@shree.in', from_name: 'Shree Accounts' });
    expect(m.body).toContain('Hello Kapoor Stores, amount Rs 1,180.00.');
    const r = (await post('/reminders/run').expect(201)).body;
    expect(r.reminders).toBeGreaterThanOrEqual(1);
    const rem = (await getPool().query('SELECT body FROM email_outbox WHERE subject=$1', [`Gentle nudge: ${inv.number}`])).rows[0];
    expect(rem.body).toContain('was due on 2026-01-20');
    expect((await post('/reminders/run').expect(201)).body.reminders).toBe(0);  // not again within 3 days
    const pv = (await post('/email-preview', { subject: 'Re {number}', body: 'Dear {contact}' }).expect(201)).body;
    expect(pv).toMatchObject({ subject: 'Re INV/26-27/0014' });
    expect(pv.body).toContain('Dear Kapoor Stores');
  });

  it('sends reminders automatically when turned on', async () => {
    const { runAutoReminders } = await import('../src/extras/extras.controller');
    await getPool().query('UPDATE documents SET reminder_sent_at = NULL');
    expect((await runAutoReminders()).sent).toBe(0);                              // off by default
    await put('/org-settings', { autoRemind: true }).expect(200);
    expect((await runAutoReminders()).sent).toBeGreaterThanOrEqual(1);
    expect((await runAutoReminders()).sent).toBe(0);
  });

  it('lock dates: staff stop at the staff lock date, everyone stops at the hard lock', async () => {
    const entry = (date: string) => ({ date, narration: 'lock test', lines: [{ accountId: cash, debit: 100 }, { accountId: sales, credit: 100 }] });
    await put('/lock-dates', { staffLockThrough: '2026-03-31' }).expect(400);                 // the password is asked for
    await put('/lock-dates', { staffLockThrough: '2026-03-31', password: 'wrong-one' }).expect(401);
    await put('/lock-dates', { staffLockThrough: '2026-03-31', password: pw }).expect(200);
    const blocked = await post('/journal', entry('2026-03-15'), staffT);
    expect(blocked.status).toBe(403);
    expect(blocked.body.message).toMatch(/locked for staff up to 2026-03-31/);
    await post('/journal', entry('2026-04-02'), staffT).expect(201);
    await post('/journal', entry('2026-03-15')).expect(201);                     // the owner may still post
    await put('/lock-dates', { lockThrough: '2026-02-28', password: pw }).expect(200);
    expect((await post('/journal', entry('2026-02-10'))).status).toBe(400);      // nobody posts into the hard-locked period
    const s = (await get('/org-settings')).body;
    expect(s).toMatchObject({ staffLockThrough: '2026-03-31', lockThrough: '2026-02-28' });
    await put('/lock-dates', { staffLockThrough: null, lockThrough: null, password: pw }).expect(200);
    await post('/journal', entry('2026-02-10'), staffT).expect(201);
  });

  it('keeps currencies with their default exchange rates', async () => {
    await post('/currencies', { code: 'usd', rate: 83.25 }).expect(201);
    await post('/currencies', { code: 'EUR', rate: 90.1 }).expect(201);
    await post('/currencies', { code: 'USD', rate: 84 }).expect(201);              // updates the rate
    await post('/currencies', { code: 'INR', rate: 1 }).expect(400);
    await post('/currencies', { code: 'US', rate: 1 }).expect(400);
    await post('/currencies', { code: 'GBP', rate: 100 }, staffT).expect(403);
    expect((await get('/currencies').expect(200)).body.map((c: any) => [c.code, c.rate])).toEqual([['EUR', 90.1], ['USD', 84]]);
    await ctx.http().delete(`${base()}/currencies/EUR`).set(auth(t)).expect(200);
    await ctx.http().delete(`${base()}/currencies/EUR`).set(auth(t)).expect(404);
  });

  it('shows the history of changes with who made them', async () => {
    const h = (await get('/history?limit=200').expect(200)).body;
    expect(h.length).toBeGreaterThan(5);
    expect(h.find((x: any) => x.action === 'update_settings')).toMatchObject({ user: 'T owner@settings.com', entity: 'organization' });
    expect(h.some((x: any) => x.action === 'auto_remind_overdue' && x.user === 'System')).toBe(true);
    const only = (await get('/history?entity=currency').expect(200)).body;
    expect(only.length).toBe(4);
    expect(only.every((x: any) => x.entity === 'currency')).toBe(true);
    await get('/history', staffT).expect(403);
  });
});
