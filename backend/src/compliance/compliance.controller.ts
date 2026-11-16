// Compliance checks: MSME payments (43B(h)), the 180-day input tax credit rule, and GSTR-2B matching.
import { BadRequestException, Body, ConflictException, Controller, Delete, Get, NotFoundException, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { withOrg } from '../db/db';
import { writeAudit } from '../audit/audit';
import { AuthGuard, Ip, UserId, parse } from '../common/guard';
import { requireOrg } from '../tenancy/acl';
import { fyOfDate, invoiceKey, itc180Report, itcSplit, msmeReport, parseGstr2b, reconcile2b } from './checks';
import { accountIdByCode, ensureAccount, insertEntry } from '../ledger/post';
import { Line } from '../ledger/ledger';

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

  /** Rule 37: reverse the credit on a bill unpaid for 180 days. Dr Input credit reversed (reclaimable) / Cr Input CGST, SGST, IGST. */
  @Post('itc-180/:docId/reverse')
  async reverse(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('docId', ParseIntPipe) docId: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'post');
    const b = parse(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }), body ?? {});
    const on = b.date ?? new Date().toISOString().slice(0, 10);
    return withOrg(orgId, async (c) => {
      const x = await itcSplit(c, docId, on);
      if (!x) throw new NotFoundException('Bill not found');
      if ((await c.query('SELECT 1 FROM itc_reversals WHERE doc_id=$1 AND reclaimed_on IS NULL', [docId])).rowCount) throw new ConflictException(`The credit on ${x.bill.number} is already reversed`);
      if (x.unpaid <= 0) throw new BadRequestException(`${x.bill.number} is paid: there is nothing to reverse`);
      if (x.daysPast < 0) throw new BadRequestException(`${x.bill.number} reaches 180 days in ${-x.daysPast} day(s); reverse it after that`);
      const amt = x.cgst + x.sgst + x.igst;
      if (amt <= 0) throw new BadRequestException(`${x.bill.number} has no input credit to reverse`);
      const lines: Line[] = [{ accountId: await ensureAccount(c, orgId, '1340'), debit: amt, credit: 0 }];
      const heads: [number, string][] = [[x.cgst, '1300'], [x.sgst, '1310'], [x.igst, '1320']];
      for (const [v, code] of heads) if (v) lines.push({ accountId: await accountIdByCode(c, code), debit: 0, credit: v });
      const eid = await insertEntry(c, orgId, uid, on, `Input credit reversed under Rule 37: ${x.bill.number} unpaid for over 180 days`, x.bill.number, null, lines);
      const r = (await c.query('INSERT INTO itc_reversals(org_id,doc_id,reversed_on,cgst,sgst,igst,entry_id,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
        [orgId, docId, on, x.cgst, x.sgst, x.igst, eid, uid])).rows[0];
      await writeAudit(c, { orgId, userId: uid, action: 'itc_reverse', entity: 'document', entityId: docId, after: { cgst: x.cgst, sgst: x.sgst, igst: x.igst, on }, ip });
      return { id: Number(r.id), amount: amt, cgst: x.cgst, sgst: x.sgst, igst: x.igst, journalEntryId: eid };
    });
  }

  /** Once the supplier is paid, the reversed credit can be claimed again. */
  @Post('itc-180/:docId/reclaim')
  async reclaim(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('docId', ParseIntPipe) docId: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'post');
    const b = parse(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }), body ?? {});
    const on = b.date ?? new Date().toISOString().slice(0, 10);
    return withOrg(orgId, async (c) => {
      const r = (await c.query('SELECT * FROM itc_reversals WHERE doc_id=$1 AND reclaimed_on IS NULL FOR UPDATE', [docId])).rows[0];
      if (!r) throw new NotFoundException('No reversed credit on this bill');
      const x = await itcSplit(c, docId, on);
      if (x && x.unpaid > 0) throw new BadRequestException(`${x.bill.number} still has Rs ${(x.unpaid / 100).toFixed(2)} unpaid: pay the supplier first`);
      const amt = Number(r.cgst) + Number(r.sgst) + Number(r.igst);
      const lines: Line[] = [];
      const heads: [number, string][] = [[Number(r.cgst), '1300'], [Number(r.sgst), '1310'], [Number(r.igst), '1320']];
      for (const [v, code] of heads) if (v) lines.push({ accountId: await accountIdByCode(c, code), debit: v, credit: 0 });
      lines.push({ accountId: await ensureAccount(c, orgId, '1340'), debit: 0, credit: amt });
      const eid = await insertEntry(c, orgId, uid, on, `Input credit reclaimed after payment: ${x?.bill.number ?? docId}`, x?.bill.number ?? null, Number(r.entry_id), lines);
      await c.query('UPDATE itc_reversals SET reclaimed_on=$2, reclaim_entry_id=$3 WHERE id=$1', [r.id, on, eid]);
      await writeAudit(c, { orgId, userId: uid, action: 'itc_reclaim', entity: 'document', entityId: docId, after: { amount: amt, on }, ip });
      return { amount: amt, journalEntryId: eid };
    });
  }

  /** Every Rule 37 reversal, with whether it can be reclaimed now (the bill is paid). */
  @Get('itc-reversals')
  async reversals(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number) {
    await requireOrg(uid, orgId, 'read');
    const on = new Date().toISOString().slice(0, 10);
    return withOrg(orgId, async (c) => {
      const rows = (await c.query(`SELECT r.*, r.reversed_on::text AS rev, r.reclaimed_on::text AS rec, d.number, ct.name AS supplier FROM itc_reversals r JOIN documents d ON d.id=r.doc_id JOIN contacts ct ON ct.id=d.contact_id ORDER BY r.id DESC`)).rows;
      const out = [];
      for (const r of rows) {
        const x = r.rec ? null : await itcSplit(c, Number(r.doc_id), on);
        out.push({ id: Number(r.id), documentId: Number(r.doc_id), number: r.number, supplier: r.supplier, reversedOn: r.rev, reclaimedOn: r.rec,
          amount: Number(r.cgst) + Number(r.sgst) + Number(r.igst), unpaid: x ? x.unpaid : 0, canReclaim: !r.rec && !!x && x.unpaid <= 0 });
      }
      return out;
    });
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
        await c.query(`INSERT INTO gstr2b_lines(org_id,import_id,gstin,supplier_name,invoice_no,invoice_key,invoice_date,taxable,igst,cgst,sgst,cess,itc_available,reverse_charge,doc_kind,amended,original_no,original_key)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`, [orgId, imp.id, l.gstin, l.supplierName, l.invoiceNo, invoiceKey(l.invoiceNo), l.date, l.taxable, l.igst, l.cgst, l.sgst, l.cess, l.itcAvailable, l.reverseCharge,
          l.docKind ?? 'invoice', !!l.amended, l.originalNo ?? null, l.originalNo ? invoiceKey(l.originalNo) : null]);
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
