import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, ParseIntPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { Response } from 'express';
import { z } from 'zod';
import { getPool, withOrg } from '../db/db';
import { writeAudit } from '../audit/audit';
import { AuthGuard, Ip, UserId, parse } from '../common/guard';
import { financialYearOf, validateLines } from '../ledger/ledger';
import { insertEntry } from '../ledger/post';
import { requireOrg, requireAnyOrg } from '../tenancy/acl';
import { aged } from '../accounting/reports';
import { deadlinesBetween, Rule } from './deadlines';
import { buildTable, InvoiceView, renderInvoicesPdf, renderPdfMulti, renderXlsxMulti, REPORTS, ReportName } from './exporter';
import { optionsFor } from './styles';
import { templateConfigFor } from './templates';
import { parseAccounts, parseContacts, parseVouchers } from './importer';

const DATA_DIR = () => process.env.DATA_DIR ?? join(process.cwd(), 'data');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const today = () => new Date().toISOString().slice(0, 10);
const MAX_FILE = 10 * 1024 * 1024;
const MIME: Record<string, (b: Buffer) => boolean> = {
  'application/pdf': (b) => b.subarray(0, 4).toString() === '%PDF',
  'image/png': (b) => b[0] === 0x89 && b.subarray(1, 4).toString() === 'PNG',
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8,
  'text/csv': () => true, 'text/plain': () => true,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': (b) => b.subarray(0, 2).toString() === 'PK',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': (b) => b.subarray(0, 2).toString() === 'PK',
};
const num = (r: any, ...ks: string[]) => { for (const k of ks) if (r[k] != null) r[k] = Number(r[k]); return r; };

@Controller('orgs/:orgId')
@UseGuards(AuthGuard)
export class FirmController {
  // ---------- tasks and deadlines ----------
  @Get('tasks')
  async tasks(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number) {
    await requireOrg(uid, orgId, 'read');
    return withOrg(orgId, async (c) => (await c.query(
      "SELECT id,title,description,due_date::text AS \"dueDate\",status,rule_code AS \"ruleCode\",period FROM tasks ORDER BY status DESC, due_date")).rows.map((r) => num(r, 'id')));
  }

  @Post('tasks')
  async addTask(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'post');
    const b = parse(z.object({ title: z.string().min(1).max(200), description: z.string().max(1000).optional(), dueDate: date }), body);
    return withOrg(orgId, async (c) => {
      const r = (await c.query('INSERT INTO tasks(org_id,title,description,due_date,created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id', [orgId, b.title, b.description ?? null, b.dueDate, uid])).rows[0];
      await writeAudit(c, { orgId, userId: uid, action: 'create', entity: 'task', entityId: r.id, after: b, ip });
      return { id: Number(r.id) };
    });
  }

  @Post('tasks/:id/complete')
  async complete(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'post');
    return withOrg(orgId, async (c) => {
      const r = await c.query("UPDATE tasks SET status='done', completed_at=now() WHERE id=$1 AND status='open'", [id]);
      if (!r.rowCount) throw new NotFoundException('Open task not found');
      await writeAudit(c, { orgId, userId: uid, action: 'complete', entity: 'task', entityId: id, ip });
      return { ok: true };
    });
  }

  /** Create GST/TDS due-date tasks for the next N months from the compliance_rules table. Safe to call repeatedly. */
  @Post('deadlines/generate')
  async generate(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Body() body: unknown) {
    await requireOrg(uid, orgId, 'post');
    const b = parse(z.object({ months: z.number().int().min(1).max(12).default(3) }), body ?? {});
    const org = (await getPool().query('SELECT gstin FROM organizations WHERE id=$1', [orgId])).rows[0];
    const rules: Rule[] = (await getPool().query('SELECT code,title,frequency,due_day,due_month_offset,applies_when FROM compliance_rules')).rows
      .map((r) => ({ code: r.code, title: r.title, frequency: r.frequency, dueDay: r.due_day, dueMonthOffset: r.due_month_offset, appliesWhen: r.applies_when }));
    const from = today(), to = new Date(Date.parse(from) + b.months * 31 * 86400000).toISOString().slice(0, 10);
    const list = deadlinesBetween(rules, from, to, !!org.gstin);
    return withOrg(orgId, async (c) => {
      let created = 0;
      for (const d of list) {
        const r = await c.query('INSERT INTO tasks(org_id,title,due_date,rule_code,period,created_by) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (org_id,rule_code,period) DO NOTHING', [orgId, d.title, d.dueDate, d.ruleCode, d.period, uid]);
        created += r.rowCount ?? 0;
      }
      return { created, upcoming: list.length };
    });
  }

  // ---------- documents (client file uploads) ----------
  @Post('files')
  async upload(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'read'); // clients may upload paperwork for their accountant
    const b = parse(z.object({ name: z.string().min(1).max(200), mime: z.string(), dataBase64: z.string().min(1), category: z.string().max(40).default('general'),
      linkType: z.enum(['document', 'journal', 'asset']).optional(), linkId: z.number().int().positive().optional() }).refine((x) => (x.linkType == null) === (x.linkId == null), 'Give both linkType and linkId'), body);
    if (!MIME[b.mime]) throw new BadRequestException(`File type not allowed. Allowed: ${Object.keys(MIME).join(', ')}`);
    const data = Buffer.from(b.dataBase64, 'base64');
    if (data.length === 0 || data.length > MAX_FILE) throw new BadRequestException('File must be between 1 byte and 10 MB');
    if (!MIME[b.mime](data)) throw new BadRequestException('File content does not match its type');
    const name = b.name.replace(/[^\w.\- ()]/g, '_');
    const key = `${orgId}/${randomUUID()}`;
    const path = join(DATA_DIR(), 'files', key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
    return withOrg(orgId, async (c) => {
      const r = (await c.query('INSERT INTO files(org_id,name,mime,size,sha256,storage_key,category,uploaded_by,link_type,link_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',
        [orgId, name, b.mime, data.length, createHash('sha256').update(data).digest('hex'), key, b.category, uid, b.linkType ?? null, b.linkId ?? null])).rows[0];
      await writeAudit(c, { orgId, userId: uid, action: 'upload', entity: 'file', entityId: r.id, after: { name, size: data.length }, ip });
      return { id: Number(r.id) };
    });
  }

  @Get('files')
  async files(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Query('linkType') linkType?: string, @Query('linkId') linkId?: string) {
    await requireOrg(uid, orgId, 'read');
    return withOrg(orgId, async (c) => (await c.query('SELECT id,name,mime,size,category,link_type AS "linkType",link_id AS "linkId",created_at AS "createdAt" FROM files WHERE ($1::text IS NULL OR (link_type=$1 AND link_id=$2::bigint)) ORDER BY id DESC', [linkType ?? null, linkId ? Number(linkId) : null])).rows.map((r) => num(r, 'id', 'size', 'linkId')));
  }

  @Get('files/:id/download')
  async download(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    await requireOrg(uid, orgId, 'read');
    const f = await withOrg(orgId, async (c) => (await c.query('SELECT name,mime,storage_key,sha256 FROM files WHERE id=$1', [id])).rows[0]);
    if (!f) throw new NotFoundException('File not found');
    const data = readFileSync(join(DATA_DIR(), 'files', f.storage_key));
    if (createHash('sha256').update(data).digest('hex') !== f.sha256) throw new Error('Stored file failed its integrity check');
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(f.name)}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(data);
  }

  @Delete('files/:id')
  async removeFile(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'manage');
    return withOrg(orgId, async (c) => {
      const f = (await c.query('DELETE FROM files WHERE id=$1 RETURNING storage_key,name', [id])).rows[0];
      if (!f) throw new NotFoundException('File not found');
      rmSync(join(DATA_DIR(), 'files', f.storage_key), { force: true });
      await writeAudit(c, { orgId, userId: uid, action: 'delete', entity: 'file', entityId: id, before: { name: f.name }, ip });
      return { ok: true };
    });
  }

  // ---------- import from other software ----------
  @Post('import/:kind')
  async importData(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('kind') kind: string, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'manage');
    const b = parse(z.object({ csv: z.string().min(1).max(5_000_000), dryRun: z.boolean().default(false) }), body);
    if (!['contacts', 'accounts', 'vouchers'].includes(kind)) throw new NotFoundException('Import kind must be contacts, accounts or vouchers');
    let parsed;
    try { parsed = kind === 'contacts' ? parseContacts(b.csv) : kind === 'accounts' ? parseAccounts(b.csv) : parseVouchers(b.csv); }
    catch (e) { throw new BadRequestException((e as Error).message); }
    if (parsed.errors.length) return { imported: 0, errors: parsed.errors.slice(0, 50), dryRun: b.dryRun, ok: false };
    if (b.dryRun) return { imported: 0, wouldImport: parsed.rows.length, errors: [], dryRun: true, ok: true };

    return withOrg(orgId, async (c) => {
      let imported = 0;
      const errors: string[] = [];
      if (kind === 'contacts') {
        for (const r of parsed.rows as ReturnType<typeof parseContacts>['rows']) {
          const dup = await c.query('SELECT 1 FROM contacts WHERE lower(name)=lower($1) AND COALESCE(gstin,\'\')=COALESCE($2,\'\')', [r.name, r.gstin ?? null]);
          if (dup.rowCount) { errors.push(`Skipped existing contact ${r.name}`); continue; }
          const state = r.stateCode ?? (r.gstin ? r.gstin.slice(0, 2) : null);
          const okState = state ? (await c.query('SELECT 1 FROM gst_states WHERE code=$1', [state])).rowCount : 1;
          await c.query('INSERT INTO contacts(org_id,kind,name,gstin,pan,state_code,email,phone,bank_account_name,bank_name,bank_account_no,bank_ifsc) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
            [orgId, r.kind, r.name, r.gstin ?? null, r.pan ?? null, okState ? state : null, r.email ?? null, r.phone ?? null, r.bankAccountName ?? null, r.bankName ?? null, r.bankAccountNo ?? null, r.bankIfsc ?? null]);
          imported++;
        }
      } else if (kind === 'accounts') {
        for (const r of parsed.rows as ReturnType<typeof parseAccounts>['rows']) {
          const res = await c.query('INSERT INTO accounts(org_id,code,name,type,group_name) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (org_id,code) DO NOTHING', [orgId, r.code, r.name, r.type, r.group]);
          if (res.rowCount) imported++; else errors.push(`Skipped existing account code ${r.code}`);
        }
      } else {
        const accs = (await c.query('SELECT id,code,name FROM accounts WHERE is_active')).rows;
        const find = (s: string) => accs.find((a) => a.code === s) ?? accs.find((a) => a.name.toLowerCase() === s.toLowerCase());
        const vouchers = parsed.rows as ReturnType<typeof parseVouchers>['rows'];
        for (const v of vouchers) {
          const lines = v.lines.map((l) => { const a = find(l.account); if (!a) throw new BadRequestException(`Voucher ${v.key}: account "${l.account}" not found`); return { accountId: Number(a.id), debit: l.debit, credit: l.credit }; });
          await insertEntry(c, orgId, uid, v.date, v.narration, v.key, null, validateLines(lines));
          imported++;
        }
      }
      await writeAudit(c, { orgId, userId: uid, action: 'import', entity: kind, after: { imported }, ip });
      return { imported, errors, dryRun: false, ok: true };
    });
  }

  // ---------- exports ----------
  private async tablesFor(orgId: number, reports: string[], q: Record<string, string>) {
    for (const r of reports) if (!(REPORTS as readonly string[]).includes(r)) throw new NotFoundException(`Unknown report "${r}". Available: ${REPORTS.join(', ')}`);
    for (const k of ['from', 'to', 'asOf']) if (q[k] && !/^\d{4}-\d{2}-\d{2}$/.test(q[k])) throw new BadRequestException(`${k} must be YYYY-MM-DD`);
    const fy = financialYearOf(today());
    const params = { from: q.from ?? fy.start, to: q.to ?? today(), asOf: q.asOf ?? today(), accountId: q.accountId ? Number(q.accountId) : undefined };
    return withOrg(orgId, async (c) => { const out = []; for (const r of reports) out.push(await buildTable(c, r as ReportName, params)); return out; })
      .catch((e) => { throw new BadRequestException(e.message); });
  }

  private sendFile(res: Response, fmt: string, name: string, data: Buffer) {
    res.setHeader('Content-Type', fmt === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.${fmt}"`);
    res.send(data);
  }

  /** Column headings of a report, so the export panel can offer to leave some out. */
  @Get('export-columns/:report')
  async exportColumns(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('report') report: string, @Query() q: Record<string, string>) {
    await requireOrg(uid, orgId, 'read');
    const [t] = await this.tablesFor(orgId, [report], q);
    return { columns: t.columns.map((c) => c.header) };
  }

  @Get('export/:report')
  async exportReport(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('report') report: string, @Query() q: Record<string, string>, @Res() res: Response) {
    await requireOrg(uid, orgId, 'read');
    const fmt = q.format === 'xlsx' ? 'xlsx' : 'pdf';
    const org = (await getPool().query('SELECT name FROM organizations WHERE id=$1', [orgId])).rows[0];
    const tables = await this.tablesFor(orgId, [report], q);
    const o = optionsFor(await withOrg(orgId, (c) => templateConfigFor(c, 'report')), q);
    this.sendFile(res, fmt, report, fmt === 'pdf' ? await renderPdfMulti(tables, org.name, o) : await renderXlsxMulti(tables, org.name, o));
  }

  /** Several reports in one PDF (each on its own pages) or one Excel workbook (one sheet each): ?reports=pnl,balance-sheet,trial-balance */
  @Get('export-multi')
  async exportMulti(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Query() q: Record<string, string>, @Res() res: Response) {
    await requireOrg(uid, orgId, 'read');
    const reports = [...new Set((q.reports ?? '').split(',').map((x) => x.trim()).filter(Boolean))];
    if (!reports.length) throw new BadRequestException('Choose at least one report');
    if (reports.length > 15) throw new BadRequestException('Choose at most 15 reports at a time');
    if (reports.includes('ledger') && !q.accountId) throw new BadRequestException('The Ledger report needs an account. Choose one, or use "All ledgers" instead.');
    const fmt = q.format === 'xlsx' ? 'xlsx' : 'pdf';
    const org = (await getPool().query('SELECT name FROM organizations WHERE id=$1', [orgId])).rows[0];
    const tables = await this.tablesFor(orgId, reports, q);
    const o = optionsFor(await withOrg(orgId, (c) => templateConfigFor(c, 'report')), q);
    this.sendFile(res, fmt, 'reports', fmt === 'pdf' ? await renderPdfMulti(tables, org.name, o) : await renderXlsxMulti(tables, org.name, o));
  }

  /** The same figures as an export, as JSON, for showing on screen. */
  @Get('report-table/:report')
  async reportTable(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('report') report: string, @Query() q: Record<string, string>) {
    await requireOrg(uid, orgId, 'read');
    if (!(REPORTS as readonly string[]).includes(report)) throw new NotFoundException(`Unknown report. Available: ${REPORTS.join(', ')}`);
    for (const k of ['from', 'to', 'asOf']) if (q[k] && !/^\d{4}-\d{2}-\d{2}$/.test(q[k])) throw new BadRequestException(`${k} must be YYYY-MM-DD`);
    const fy = financialYearOf(today());
    return withOrg(orgId, (c) => buildTable(c, report as ReportName, { from: q.from ?? fy.start, to: q.to ?? today(), asOf: q.asOf ?? today(), accountId: q.accountId ? Number(q.accountId) : undefined }))
      .catch((e) => { throw new BadRequestException(e.message); });
  }

  private async invoiceViews(orgId: number, ids: number[]): Promise<InvoiceView[]> {
    const org = (await getPool().query('SELECT name,gstin FROM organizations WHERE id=$1', [orgId])).rows[0];
    const iso = (x: unknown) => (x ? new Date(x as string).toISOString().slice(0, 10) : null);
    return withOrg(orgId, async (c) => {
      const out: InvoiceView[] = [];
      for (const id of ids) {
        const d = (await c.query('SELECT d.*, ct.name AS cname, ct.gstin AS cgstin FROM documents d JOIN contacts ct ON ct.id=d.contact_id WHERE d.id=$1', [id])).rows[0];
        if (!d) throw new NotFoundException(`Document ${id} not found`);
        const lines = (await c.query('SELECT description,hsn_sac,qty_milli,rate,taxable,gst_rate_bp FROM document_lines WHERE doc_id=$1 ORDER BY id', [id])).rows;
        out.push({
          orgName: org.name, orgGstin: org.gstin, type: d.doc_type, number: d.number, issueDate: iso(d.issue_date)!, dueDate: iso(d.due_date), contact: d.cname, contactGstin: d.cgstin, placeOfSupply: d.place_of_supply,
          lines: lines.map((l) => ({ description: l.description, hsnSac: l.hsn_sac, qtyMilli: Number(l.qty_milli), rate: Number(l.rate), taxable: Number(l.taxable), gstRateBp: l.gst_rate_bp })),
          subtotal: Number(d.subtotal), cgst: Number(d.cgst), sgst: Number(d.sgst), igst: Number(d.igst), total: Number(d.total), tdsAmount: Number(d.tds_amount), notes: d.notes,
        });
      }
      return out;
    });
  }

  @Get('documents/:id/pdf')
  async invoicePdf(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number, @Query() q: Record<string, string>, @Res() res: Response) {
    const role = await requireAnyOrg(uid, orgId, ['read', 'sales']);
    const [v] = await this.invoiceViews(orgId, [id]);
    if (role === 'sales' && v.type !== 'invoice') throw new NotFoundException('Document not found');
    const pdf = await renderInvoicesPdf([v], optionsFor(await withOrg(orgId, (c) => templateConfigFor(c, 'document')), q));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${v.number.replace(/\//g, '-')}.pdf"`);
    res.send(pdf);
  }

  /** Several invoices or bills in one PDF: ?ids=1,2,3 */
  @Get('documents-pdf')
  async invoicesPdf(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Query() q: Record<string, string>, @Res() res: Response) {
    const role = await requireAnyOrg(uid, orgId, ['read', 'sales']);
    const ids = [...new Set((q.ids ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!ids.length) throw new BadRequestException('Choose at least one document');
    if (ids.length > 100) throw new BadRequestException('Choose at most 100 documents at a time');
    const views = await this.invoiceViews(orgId, ids);
    if (role === 'sales' && views.some((v) => v.type !== 'invoice')) throw new NotFoundException('Document not found');
    const pdf = await renderInvoicesPdf(views, optionsFor(await withOrg(orgId, (c) => templateConfigFor(c, 'document')), q));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="documents.pdf"');
    res.send(pdf);
  }

  // ---------- scheduled email reports ----------
  @Get('scheduled-reports')
  async schedules(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number) {
    await requireOrg(uid, orgId, 'manage');
    return withOrg(orgId, async (c) => (await c.query('SELECT id,report,format,frequency,recipients,next_run::text AS "nextRun",active FROM scheduled_reports WHERE active ORDER BY id')).rows.map((r) => num(r, 'id')));
  }

  @Post('scheduled-reports')
  async schedule(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'manage');
    const b = parse(z.object({ report: z.enum(REPORTS), format: z.enum(['pdf', 'xlsx']), frequency: z.enum(['weekly', 'monthly']), recipients: z.array(z.string().email()).min(1).max(10), firstRun: date.optional() }), body);
    return withOrg(orgId, async (c) => {
      const r = (await c.query('INSERT INTO scheduled_reports(org_id,report,format,frequency,recipients,next_run,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [orgId, b.report, b.format, b.frequency, b.recipients, b.firstRun ?? today(), uid])).rows[0];
      await writeAudit(c, { orgId, userId: uid, action: 'create', entity: 'scheduled_report', entityId: r.id, after: b, ip });
      return { id: Number(r.id) };
    });
  }

  @Delete('scheduled-reports/:id')
  async unschedule(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number) {
    await requireOrg(uid, orgId, 'manage');
    return withOrg(orgId, async (c) => { await c.query('UPDATE scheduled_reports SET active=false WHERE id=$1', [id]); return { ok: true }; });
  }

  // ---------- client portal summary ----------
  @Get('portal')
  async portal(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number) {
    await requireOrg(uid, orgId, 'read');
    return withOrg(orgId, async (c) => {
      const ar = await aged(c, 'receivables', today());
      const invoices = (await c.query("SELECT d.id,d.number,d.issue_date::text AS date,d.total,d.status FROM documents d WHERE doc_type='invoice' ORDER BY d.issue_date DESC, d.id DESC LIMIT 5")).rows.map((r) => num(r, 'id', 'total'));
      const open = (await c.query("SELECT count(*)::int AS n FROM tasks WHERE status='open'")).rows[0].n;
      return { receivablesOutstanding: ar.totals.total, overdue: ar.totals.total - ar.totals.notDue, recentInvoices: invoices, openTasks: open };
    });
  }
}
