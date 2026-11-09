// Compliance checks: MSME payments (43B(h)), the 180-day input tax credit rule, and GSTR-2B matching.
import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { withOrg } from '../db/db';
import { writeAudit } from '../audit/audit';
import { AuthGuard, Ip, UserId, parse } from '../common/guard';
import { requireOrg } from '../tenancy/acl';
import { fyOfDate, invoiceKey, itc180Report, msmeReport, parseGstr2b, reconcile2b } from './checks';

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const today = () => new Date().toISOString().slice(0, 10);
const asOfParam = (v?: string) => { if (v && !ISO.test(v)) throw new BadRequestException('asOf must be YYYY-MM-DD'); return v ?? today(); };

@Controller('orgs/:orgId/compliance')
@UseGuards(AuthGuard)
export class ComplianceController {
  /** Bills from micro and small suppliers in a financial year, with what is paid on time and what is not allowed. ?fy=2026 */
  @Get('msme')
  async msme(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Query('fy') fy?: string, @Query('asOf') asOf?: string) {
    await requireOrg(uid, orgId, 'read');
    const on = asOfParam(asOf);
    if (fy && !/^\d{4}$/.test(fy)) throw new BadRequestException('fy must be the starting year, e.g. 2026');
    return withOrg(orgId, (c) => msmeReport(c, fy ? `${fy}-04-01` : fyOfDate(on).start, on));
  }

  /** Unpaid bills older than 180 days (credit to reverse) and those reaching 180 days within 30 days. */
  @Get('itc-180')
  async itc180(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Query('asOf') asOf?: string) {
    await requireOrg(uid, orgId, 'read');
    return withOrg(orgId, (c) => itc180Report(c, asOfParam(asOf)));
  }

  @Get('gstr2b')
  async imports(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number) {
    await requireOrg(uid, orgId, 'read');
    return withOrg(orgId, async (c) => (await c.query(
      `SELECT i.id, i.period, i.file_name AS "fileName", i.line_count AS "lines", i.created_at AS "uploadedAt", u.full_name AS "uploadedBy"
         FROM gstr2b_imports i JOIN users u ON u.id = i.uploaded_by ORDER BY i.period DESC, i.id DESC`)).rows.map((r) => ({ ...r, id: Number(r.id) })));
  }

  /** Upload GSTR-2B (the portal's JSON, or a CSV). An upload for a month replaces the previous one for that month. */
  @Post('gstr2b')
  async upload(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'post');
    const b = parse(z.object({ fileName: z.string().trim().min(1).max(200), content: z.string().min(10).max(12_000_000), period: z.string().regex(/^\d{4}-\d{2}$/, 'period must be YYYY-MM').optional() }), body);
    let parsed;
    try { parsed = parseGstr2b(b.content); } catch (e) { throw new BadRequestException(`This file could not be read as GSTR-2B: ${(e as Error).message}`); }
    const period = parsed.period ?? b.period;
    if (!period) throw new BadRequestException('Choose which month this GSTR-2B is for');
    if (!parsed.lines.length) throw new BadRequestException('No invoices were found in this file');
    return withOrg(orgId, async (c) => {
      await c.query('DELETE FROM gstr2b_imports WHERE period=$1', [period]);
      const imp = (await c.query('INSERT INTO gstr2b_imports(org_id,period,file_name,line_count,uploaded_by) VALUES ($1,$2,$3,$4,$5) RETURNING id', [orgId, period, b.fileName, parsed.lines.length, uid])).rows[0];
      for (const l of parsed.lines) {
        await c.query(`INSERT INTO gstr2b_lines(org_id,import_id,gstin,supplier_name,invoice_no,invoice_key,invoice_date,taxable,igst,cgst,sgst,cess,itc_available,reverse_charge)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [orgId, imp.id, l.gstin, l.supplierName, l.invoiceNo, invoiceKey(l.invoiceNo), l.date, l.taxable, l.igst, l.cgst, l.sgst, l.cess, l.itcAvailable, l.reverseCharge]);
      }
      await writeAudit(c, { orgId, userId: uid, action: 'upload', entity: 'gstr2b', entityId: imp.id, after: { period, fileName: b.fileName, lines: parsed.lines.length }, ip });
      return { id: Number(imp.id), period, lines: parsed.lines.length, skipped: parsed.skipped };
    });
  }

  @Get('gstr2b/:id')
  async match(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number) {
    await requireOrg(uid, orgId, 'read');
    const r = await withOrg(orgId, (c) => reconcile2b(c, id));
    if (!r) throw new NotFoundException('Upload not found');
    return r;
  }

  @Delete('gstr2b/:id')
  async remove(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'post');
    return withOrg(orgId, async (c) => {
      if (!(await c.query('DELETE FROM gstr2b_imports WHERE id=$1', [id])).rowCount) throw new NotFoundException('Upload not found');
      await writeAudit(c, { orgId, userId: uid, action: 'delete', entity: 'gstr2b', entityId: id, ip });
      return { ok: true };
    });
  }
}
