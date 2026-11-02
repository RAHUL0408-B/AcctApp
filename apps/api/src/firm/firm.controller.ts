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
import { requireOrg } from '../tenancy/acl';
import { aged } from '../accounting/reports';
import { deadlinesBetween, Rule } from './deadlines';
import { buildTable, renderInvoicePdf, renderPdf, renderXlsx, REPORTS, ReportName } from './exporter';
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
    const b = parse(z.object({ name: z.string().min(1).max(200), mime: z.string(), dataBase64: z.string().min(1), category: z.string().max(40).default('general') }), body);
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
      const r = (await c.query('INSERT INTO files(org_id,name,mime,size,sha256,storage_key,category,uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
        [orgId, name, b.mime, data.length, createHash('sha256').update(data).digest('hex'), key, b.category, uid])).rows[0];
      await writeAudit(c, { orgId, userId: uid, action: 'upload', entity: 'file', entityId: r.id, after: { name, size: data.length }, ip });
      return { id: Number(r.id) };
    });
  }

  @Get('files')
  async files(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number) {
    await requireOrg(uid, orgId, 'read');
    return withOrg(orgId, async (c) => (await c.query('SELECT id,name,mime,size,category,created_at AS "createdAt" FROM files ORDER BY id DESC')).rows.map((r) => num(r, 'id', 'size')));
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
          await c.query('INSERT INTO contacts(org_id,kind,name,gstin,pan,state_code,email,phone) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [orgId, r.kind, r.name, r.gstin ?? null, r.pan ?? null, okState ? state : null, r.email ?? null, r.phone ?? null]);
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
  @Get('export/:report')
  async exportReport(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('report') report: string, @Query() q: Record<string, string>, @Res() res: Response) {
    await requireOrg(uid, orgId, 'read');
    if (!(REPORTS as readonly string[]).includes(report)) throw new NotFoundException(`Unknown report. Available: ${REPORTS.join(', ')}`);
    const fmt = q.format === 'xlsx' ? 'xlsx' : 'pdf';
    for (const k of ['from', 'to', 'asOf']) if (q[k] && !/^\d{4}-\d{2}-\d{2}$/.test(q[k])) throw new BadRequestException(`${k} must be YYYY-MM-DD`);
    const fy = financialYearOf(today());
    const org = (await getPool().query('SELECT name FROM organizations WHERE id=$1', [orgId])).rows[0];
    const table = await withOrg(orgId, (c) => buildTable(c, report as ReportName, { from: q.from ?? fy.start, to: q.to ?? today(), asOf: q.asOf ?? today(), accountId: q.accountId ? Number(q.accountId) : undefined }))
      .catch((e) => { throw new BadRequestException(e.message); });
    const data = fmt === 'pdf' ? await renderPdf(table, org.name) : await renderXlsx(table, org.name);
    res.setHeader('Content-Type', fmt === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${report}.${fmt}"`);
    res.send(data);
  }

  @Get('documents/:id/pdf')
  async invoicePdf(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    await requireOrg(uid, orgId, 'read');
    const org = (await getPool().query('SELECT name,gstin FROM organizations WHERE id=$1', [orgId])).rows[0];
    const v = await withOrg(orgId, async (c) => {
      const d = (await c.query('SELECT d.*, ct.name AS cname, ct.gstin AS cgstin FROM documents d JOIN contacts ct ON ct.id=d.contact_id WHERE d.id=$1', [id])).rows[0];
      if (!d) return null;
      const lines = (await c.query('SELECT description,hsn_sac,qty_milli,rate,taxable,gst_rate_bp FROM document_lines WHERE doc_id=$1 ORDER BY id', [id])).rows;
      return { d, lines };
    });
    if (!v) throw new NotFoundException('Document not found');
    const d = v.d;
    const pdf = await renderInvoicePdf({
      orgName: org.name, orgGstin: org.gstin, type: d.doc_type, number: d.number, issueDate: new Date(d.issue_date).toISOString().slice(0, 10),
      dueDate: d.due_date ? new Date(d.due_date).toISOString().slice(0, 10) : null, contact: d.cname, contactGstin: d.cgstin, placeOfSupply: d.place_of_supply,
      lines: v.lines.map((l) => ({ description: l.description, hsnSac: l.hsn_sac, qtyMilli: Number(l.qty_milli), rate: Number(l.rate), taxable: Number(l.taxable), gstRateBp: l.gst_rate_bp })),
      subtotal: Number(d.subtotal), cgst: Number(d.cgst), sgst: Number(d.sgst), igst: Number(d.igst), total: Number(d.total), tdsAmount: Number(d.tds_amount), notes: d.notes,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${String(d.number).replace(/\//g, '-')}.pdf"`);
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
