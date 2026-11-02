// Phase 3 end-to-end: tasks/deadlines, file uploads, CSV import, PDF/Excel export, reminders and scheduled reports.
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { auth, boot, mkGstin } from './helpers';
import { getPool } from '../src/db/db';
import { processOutbox } from '../src/firm/mailer';
import { runReminders, runScheduledReports } from '../src/firm/scheduler';

process.env.WORKER = 'off';
const dataDir = mkdtempSync(join(tmpdir(), 'acctapp-data-'));
process.env.DATA_DIR = dataDir;

let ctx: Awaited<ReturnType<typeof boot>>;
let t: string, firmId: number, org: number, acc: (code: string) => number;
const base = () => `/api/orgs/${org}`;
const iso = (offsetDays = 0) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
const bin = (res: any) => res.body as Buffer;
const binary = (req: any) => req.buffer(true).parse((res: any, cb: any) => { const d: Buffer[] = []; res.on('data', (x: Buffer) => d.push(x)); res.on('end', () => cb(null, Buffer.concat(d))); });

beforeAll(async () => {
  ctx = await boot(54331);
  const u = await ctx.register('ca2@firm.com', 'CA Firm Two');
  t = u.token; firmId = u.firmId;
  org = await ctx.newOrg(t, firmId, 'Verma Exports', { gstin: '27AAPFU0939F1ZV' });
  acc = await ctx.accounts(t, org);
});
afterAll(async () => { await ctx?.stop(); rmSync(dataDir, { recursive: true, force: true }); });

describe('tasks and deadlines', () => {
  it('creates and completes a manual task', async () => {
    const id = (await ctx.http().post(`${base()}/tasks`).set(auth(t)).send({ title: 'Collect bank statements', dueDate: iso(10) }).expect(201)).body.id;
    await ctx.http().post(`${base()}/tasks/${id}/complete`).set(auth(t)).expect(201);
    await ctx.http().post(`${base()}/tasks/${id}/complete`).set(auth(t)).expect(404);
  });
  it('generates GST and TDS due dates from the rules table, once only', async () => {
    const a = (await ctx.http().post(`${base()}/deadlines/generate`).set(auth(t)).send({ months: 3 }).expect(201)).body;
    expect(a.created).toBeGreaterThan(5);
    const b = (await ctx.http().post(`${base()}/deadlines/generate`).set(auth(t)).send({ months: 3 }).expect(201)).body;
    expect(b.created).toBe(0);
    const tasks = (await ctx.http().get(`${base()}/tasks`).set(auth(t)).expect(200)).body;
    expect(tasks.some((x: any) => x.ruleCode === 'GSTR3B')).toBe(true);
  });
});

describe('document upload', () => {
  const pdf = Buffer.from('%PDF-1.4\n% test file\n');
  let fileId: number;
  it('stores a PDF and returns identical bytes on download', async () => {
    fileId = (await ctx.http().post(`${base()}/files`).set(auth(t)).send({ name: 'Form 16.pdf', mime: 'application/pdf', dataBase64: pdf.toString('base64') }).expect(201)).body.id;
    const res = await binary(ctx.http().get(`${base()}/files/${fileId}/download`).set(auth(t))).expect(200);
    expect(bin(res).equals(pdf)).toBe(true);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
  it('rejects disallowed types, mismatched content and oversize files', async () => {
    const send = (b: object) => ctx.http().post(`${base()}/files`).set(auth(t)).send(b);
    await send({ name: 'x.exe', mime: 'application/x-msdownload', dataBase64: 'AAAA' }).expect(400);
    await send({ name: 'fake.pdf', mime: 'application/pdf', dataBase64: Buffer.from('not a pdf').toString('base64') }).expect(400);
    await send({ name: 'big.txt', mime: 'text/plain', dataBase64: Buffer.alloc(10 * 1024 * 1024 + 1, 97).toString('base64') }).expect(400);
  });
  it('clients can upload and see files but only managers can delete; other firms see nothing', async () => {
    const client = await ctx.register('portal@verma.com');
    await ctx.http().post('/api/members').set(auth(t)).send({ firmId, email: 'portal@verma.com', role: 'client', orgId: org }).expect(201);
    await ctx.http().post(`${base()}/files`).set(auth(client.token)).send({ name: 'inv.txt', mime: 'text/plain', dataBase64: Buffer.from('hello').toString('base64') }).expect(201);
    expect((await ctx.http().get(`${base()}/files`).set(auth(client.token)).expect(200)).body.length).toBe(2);
    await ctx.http().delete(`${base()}/files/${fileId}`).set(auth(client.token)).expect(403);
    const other = await ctx.register('other2@firm.com');
    await ctx.http().get(`${base()}/files/${fileId}/download`).set(auth(other.token)).expect(404);
    await ctx.http().delete(`${base()}/files/${fileId}`).set(auth(t)).expect(200);
    await ctx.http().get(`${base()}/files/${fileId}/download`).set(auth(t)).expect(404);
  });
  it('portal summary works for client users', async () => {
    const c2 = await ctx.http().post('/api/auth/login').send({ email: 'portal@verma.com', password: 'S3cure-passphrase!' }).expect(200);
    const p = (await ctx.http().get(`${base()}/portal`).set(auth(c2.body.token)).expect(200)).body;
    expect(p).toMatchObject({ receivablesOutstanding: 0, recentInvoices: [] });
    expect(p.openTasks).toBeGreaterThan(0);
  });
});

describe('import from other software', () => {
  it('dry run validates without writing; bad rows are reported with row numbers', async () => {
    const csv = 'Voucher No,Date,Ledger,Debit,Credit,Narration\nOPEN1,01/04/2025,1010,"5,00,000.00",,Opening\nOPEN1,01/04/2025,3000,,500000,Opening';
    const r = (await ctx.http().post(`${base()}/import/vouchers`).set(auth(t)).send({ csv, dryRun: true }).expect(201)).body;
    expect(r).toMatchObject({ ok: true, wouldImport: 1 });
    expect((await ctx.http().get(`${base()}/trial-balance`).set(auth(t))).body.accounts).toHaveLength(0);
    const bad = (await ctx.http().post(`${base()}/import/vouchers`).set(auth(t)).send({ csv: csv.replace('500000,Opening', '400000,Opening') }).expect(201)).body;
    expect(bad.ok).toBe(false);
    expect(bad.errors[0]).toMatch(/Voucher OPEN1/);
  });
  it('imports opening balances (Indian-grouped amounts) that appear in the trial balance', async () => {
    const csv = 'Voucher No,Date,Ledger,Debit,Credit,Narration\nOPEN1,01/04/2025,1010,"5,00,000.00",,Opening\nOPEN1,01/04/2025,Owner\'s Capital,,500000,Opening';
    const r = (await ctx.http().post(`${base()}/import/vouchers`).set(auth(t)).send({ csv }).expect(201)).body;
    expect(r).toMatchObject({ ok: true, imported: 1 });
    const tb = (await ctx.http().get(`${base()}/trial-balance`).set(auth(t))).body;
    expect(tb.totalDebit).toBe(50000000);
    expect(tb.balanced).toBe(true);
  });
  it('imports contacts (skipping duplicates) and rejects an unknown account in a voucher', async () => {
    const csv = `Party Name,Type,GSTIN\nZeta Corp,Customer,${mkGstin('29ABCDE1234F1Z')}\nZeta Corp,Customer,${mkGstin('29ABCDE1234F1Z')}`;
    const r = (await ctx.http().post(`${base()}/import/contacts`).set(auth(t)).send({ csv }).expect(201)).body;
    expect(r.imported).toBe(1);
    expect(r.errors[0]).toMatch(/Skipped existing/);
    await ctx.http().post(`${base()}/import/vouchers`).set(auth(t)).send({ csv: 'Voucher No,Date,Ledger,Debit,Credit\nV9,01/04/2025,Nope,1,\nV9,01/04/2025,1010,,1' }).expect(400);
    await ctx.http().post(`${base()}/import/payroll`).set(auth(t)).send({ csv: 'a\nb' }).expect(404);
  });
});

describe('exports', () => {
  beforeAll(async () => {
    const cust = (await ctx.http().post(`${base()}/contacts`).set(auth(t)).send({ kind: 'customer', name: 'Pdf Customer', stateCode: '27' })).body.id;
    await ctx.http().post(`${base()}/documents`).set(auth(t)).send({ docType: 'invoice', contactId: cust, issueDate: iso(-5), dueDate: iso(25), lines: [{ description: 'Consulting', hsnSac: '9983', quantity: 1, rate: 1000000, gstRateBp: 1800 }] }).expect(201);
  });
  it.each([['trial-balance', 'pdf', '%PDF'], ['trial-balance', 'xlsx', 'PK'], ['pnl', 'pdf', '%PDF'], ['balance-sheet', 'xlsx', 'PK'], ['aged-receivables', 'pdf', '%PDF'], ['gstr3b', 'xlsx', 'PK'], ['gstr1-b2b', 'pdf', '%PDF']])('%s as %s', async (report, format, magic) => {
    const res = await binary(ctx.http().get(`${base()}/export/${report}?format=${format}`).set(auth(t))).expect(200);
    expect(bin(res).subarray(0, magic.length).toString()).toBe(magic);
  });
  it('xlsx stores rupees as numbers: trial balance debit 5,00,000 + invoice receivable', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const res = await binary(ctx.http().get(`${base()}/export/trial-balance?format=xlsx`).set(auth(t))).expect(200);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(bin(res) as any);
    const rows: any[][] = []; wb.worksheets[0].eachRow((r) => rows.push(r.values as any[]));
    const total = rows.find((r) => r[2] === 'Total')!;
    expect(total[3]).toBe(500000 + 11800); // debit total in rupees
    expect(total[3]).toBe(total[4]);
  });
  it('ledger export needs accountId; invoice PDF downloads; unknown report is 404', async () => {
    await ctx.http().get(`${base()}/export/ledger`).set(auth(t)).expect(400);
    const res = await binary(ctx.http().get(`${base()}/export/ledger?accountId=${acc('1010')}&format=pdf`).set(auth(t))).expect(200);
    expect(bin(res).subarray(0, 4).toString()).toBe('%PDF');
    const docs = (await ctx.http().get(`${base()}/documents?type=invoice`).set(auth(t))).body;
    const pdf = await binary(ctx.http().get(`${base()}/documents/${docs[0].id}/pdf`).set(auth(t))).expect(200);
    expect(bin(pdf).subarray(0, 4).toString()).toBe('%PDF');
    await ctx.http().get(`${base()}/export/secrets`).set(auth(t)).expect(404);
  });
});

describe('reminders and scheduled reports (worker jobs)', () => {
  it('queues reminder mail once for a task due tomorrow and sends it via the outbox', async () => {
    await ctx.http().post(`${base()}/tasks`).set(auth(t)).send({ title: 'File GSTR-1 for client', dueDate: iso(1) }).expect(201);
    const first = await runReminders(iso(0), 3);
    expect(first.queued).toBeGreaterThanOrEqual(1);
    expect((await runReminders(iso(0), 3)).queued).toBe(0);
    const r = await processOutbox();
    expect(r.sent).toBeGreaterThanOrEqual(1);
    const row = (await getPool().query("SELECT subject, status FROM email_outbox WHERE subject LIKE 'Reminder:%' LIMIT 1")).rows[0];
    expect(row).toMatchObject({ status: 'sent' });
  });
  it('emails a scheduled report as an attachment and moves the next run forward', async () => {
    await ctx.http().post(`${base()}/scheduled-reports`).set(auth(t)).send({ report: 'pnl', format: 'pdf', frequency: 'weekly', recipients: ['owner@verma.com'], firstRun: iso(0) }).expect(201);
    await ctx.http().post(`${base()}/scheduled-reports`).set(auth(t)).send({ report: 'pnl', format: 'pdf', frequency: 'weekly', recipients: ['not-an-email'] }).expect(400);
    expect((await runScheduledReports(iso(0))).sent).toBe(1);
    expect((await runScheduledReports(iso(0))).sent).toBe(0); // not due again today
    const m = (await getPool().query("SELECT attachment_name, length(attachment) AS len FROM email_outbox WHERE to_addr='owner@verma.com'")).rows[0];
    expect(m.attachment_name).toMatch(/^pnl-.*\.pdf$/);
    expect(Number(m.len)).toBeGreaterThan(500);
    const s = (await ctx.http().get(`${base()}/scheduled-reports`).set(auth(t)).expect(200)).body[0];
    expect(s.nextRun).toBe(iso(7));
  });
});
