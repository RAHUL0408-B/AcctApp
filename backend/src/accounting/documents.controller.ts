import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, ParseIntPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { PoolClient } from 'pg';
import { z } from 'zod';
import { getPool, withOrg } from '../db/db';
import { writeAudit } from '../audit/audit';
import { AuthGuard, Ip, UserId, parse } from '../common/guard';
import { requireOrg } from '../tenancy/acl';
import { financialYearOf, validateLines, reverseLines, Line } from '../ledger/ledger';
import { accountIdByCode, ensureAccount, insertEntry } from '../ledger/post';
import { computeGst, isValidGstin, stateOfGstin, supplyRules, SupplyType, TaxLine, toRupees, totals } from '../tax/gst';
import { issueCost, onHand, recordMove } from '../inventory/stock';
import { computeTds } from '../tax/tds';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const PREFIX = { invoice: 'INV', bill: 'BILL', credit_note: 'CN', debit_note: 'DN' } as const;
type DocType = keyof typeof PREFIX;
const SALES: DocType[] = ['invoice', 'credit_note'];

const contactSchema = z.object({
  kind: z.enum(['customer', 'supplier', 'both']), name: z.string().min(1).max(200),
  gstin: z.string().optional(), pan: z.string().regex(/^[A-Z]{5}\d{4}[A-Z]$/, 'Invalid PAN').optional(),
  stateCode: z.string().length(2).optional(), email: z.string().email().optional(), phone: z.string().max(20).optional(),
  isIndividual: z.boolean().default(false), country: z.string().regex(/^[A-Z]{2}$/, 'Use a 2-letter country code').default('IN'),
  bankAccountName: z.string().max(200).optional(), bankName: z.string().max(200).optional(), bankAccountNo: z.string().regex(/^\d{6,20}$/, 'Account number must be 6-20 digits').optional(),
  bankIfsc: z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Invalid IFSC code').optional(),
  defaultSalesAccountId: z.number().int().positive().nullable().optional(), defaultPurchaseAccountId: z.number().int().positive().nullable().optional(),
});
const CONTACT_COLS = `id,kind,name,gstin,pan,state_code AS "stateCode",email,phone,is_individual AS "isIndividual",country,
  bank_account_name AS "bankAccountName",bank_name AS "bankName",bank_account_no AS "bankAccountNo",bank_ifsc AS "bankIfsc",
  default_sales_account_id AS "defaultSalesAccountId",default_purchase_account_id AS "defaultPurchaseAccountId",is_archived AS "isArchived"`;
const shapeContact = (r: any) => ({ ...r, id: Number(r.id), defaultSalesAccountId: r.defaultSalesAccountId ? Number(r.defaultSalesAccountId) : null, defaultPurchaseAccountId: r.defaultPurchaseAccountId ? Number(r.defaultPurchaseAccountId) : null });
export const docSchema = z.object({
  docType: z.enum(['invoice', 'bill', 'credit_note', 'debit_note']), contactId: z.number().int().positive(),
  issueDate: date, dueDate: date.optional(), placeOfSupply: z.string().length(2).optional(), supplierRef: z.string().max(60).optional(),
  number: z.string().trim().min(1).max(40).optional(),
  originalDocId: z.number().int().positive().optional(), tdsSection: z.string().optional(), notes: z.string().max(500).optional(),
  supplyType: z.enum(['regular', 'export_lut', 'export_igst', 'sez_lut', 'sez_igst', 'reverse_charge']).default('regular'),
  currency: z.string().regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code').default('INR'),
  fxRate: z.number().positive().max(100000).optional(), // rupees per 1 unit of the currency
  lines: z.array(z.object({
    description: z.string().min(1).max(300), hsnSac: z.string().regex(/^\d{4,8}$/, 'HSN/SAC must be 4-8 digits').optional(),
    quantity: z.number().positive().max(1e9), rate: z.number().int().min(0), gstRateBp: z.number().int().min(0).max(5000).default(0),
    accountId: z.number().int().positive().optional(), itemId: z.number().int().positive().optional(), trackingOptionId: z.number().int().positive().optional(),
  })).min(1).max(200),
});

const OUTSTANDING_SQL = `
  SELECT d.*, c.name AS contact_name,
         d.net_payable - COALESCE(p.paid,0) - COALESCE(n.noted,0) AS outstanding, COALESCE(p.paid,0) AS paid
    FROM documents d JOIN contacts c ON c.id = d.contact_id
    LEFT JOIN (SELECT doc_id, SUM(amount) paid FROM payments GROUP BY doc_id) p ON p.doc_id = d.id
    LEFT JOIN (SELECT original_doc_id, SUM(total) noted FROM documents WHERE status='posted' AND original_doc_id IS NOT NULL GROUP BY original_doc_id) n ON n.original_doc_id = d.id`;

const shapeDoc = (r: any) => ({
  id: Number(r.id), docType: r.doc_type, number: r.number, contactId: Number(r.contact_id), contactName: r.contact_name,
  issueDate: r.issue_date, dueDate: r.due_date, placeOfSupply: r.place_of_supply, subtotal: Number(r.subtotal),
  cgst: Number(r.cgst), sgst: Number(r.sgst), igst: Number(r.igst), tdsSection: r.tds_section, tdsAmount: Number(r.tds_amount),
  total: Number(r.total), netPayable: Number(r.net_payable), status: r.status, supplierRef: r.supplier_ref,
  originalDocId: r.original_doc_id ? Number(r.original_doc_id) : null, supplyType: r.supply_type,
  notes: r.notes ?? null, replacedBy: r.replaced_by ? Number(r.replaced_by) : null,
  rcm: { cgst: Number(r.rcm_cgst ?? 0), sgst: Number(r.rcm_sgst ?? 0), igst: Number(r.rcm_igst ?? 0) },
  currency: r.currency ?? 'INR', fxRate: Number(r.fx_rate ?? 1), foreignTotal: r.foreign_total == null ? null : Number(r.foreign_total),
  isArchived: !!r.is_archived,
  paid: r.paid !== undefined ? Number(r.paid) : undefined, outstanding: r.outstanding !== undefined ? Number(r.outstanding) : undefined,
});

@Controller()
@UseGuards(AuthGuard)
export class DocumentsController {
  // ---- tax configuration (global tables) ----
  @Get('config/states') async states() { return (await getPool().query('SELECT code,name FROM gst_states ORDER BY code')).rows; }
  @Get('config/gst-rates') async gstRates() {
    return (await getPool().query('SELECT rate_bp AS "rateBp", label FROM gst_rates WHERE valid_to IS NULL OR valid_to >= CURRENT_DATE ORDER BY rate_bp')).rows;
  }
  @Get('config/tds-sections') async tdsSections() {
    return (await getPool().query(`SELECT code, description, rate_individual_bp AS "rateIndividualBp", rate_other_bp AS "rateOtherBp",
      single_threshold::bigint::float8 AS "singleThreshold", annual_threshold::bigint::float8 AS "annualThreshold" FROM tds_sections WHERE valid_to IS NULL ORDER BY code`)).rows;
  }

  // ---- contacts ----
  @Get('orgs/:orgId/contacts')
  async contacts(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Query('archived') archived?: string) {
    await requireOrg(uid, orgId, 'read');
    return withOrg(orgId, async (c) => (await c.query(`SELECT ${CONTACT_COLS} FROM contacts WHERE ($1::boolean OR NOT is_archived) ORDER BY name`, [archived === 'true'])).rows.map(shapeContact));
  }

  /** A default account must be an account of the right kind. */
  private async checkDefaults(c: PoolClient, b: z.infer<typeof contactSchema>) {
    if (b.defaultSalesAccountId && !(await c.query("SELECT 1 FROM accounts WHERE id=$1 AND type='income'", [b.defaultSalesAccountId])).rowCount) throw new BadRequestException('The default sales account must be an income account');
    if (b.defaultPurchaseAccountId && !(await c.query("SELECT 1 FROM accounts WHERE id=$1 AND type IN ('expense','asset')", [b.defaultPurchaseAccountId])).rowCount) throw new BadRequestException('The default purchase account must be an expense or asset account');
  }

  @Post('orgs/:orgId/contacts')
  async addContact(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'post');
    const b = parse(contactSchema, body);
    if (b.gstin && !isValidGstin(b.gstin)) throw new BadRequestException('Invalid GSTIN (format or check digit is wrong)');
    const state = b.stateCode ?? (b.gstin ? stateOfGstin(b.gstin) : null);
    return withOrg(orgId, async (c) => {
      if (state && !(await c.query('SELECT 1 FROM gst_states WHERE code=$1', [state])).rowCount) throw new BadRequestException('Unknown state code');
      await this.checkDefaults(c, b);
      const r = (await c.query(`INSERT INTO contacts(org_id,kind,name,gstin,pan,state_code,email,phone,is_individual,country,bank_account_name,bank_name,bank_account_no,bank_ifsc,default_sales_account_id,default_purchase_account_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
        [orgId, b.kind, b.name, b.gstin?.toUpperCase() ?? null, b.pan ?? null, state, b.email ?? null, b.phone ?? null, b.isIndividual, b.country,
          b.bankAccountName ?? null, b.bankName ?? null, b.bankAccountNo ?? null, b.bankIfsc ?? null, b.defaultSalesAccountId ?? null, b.defaultPurchaseAccountId ?? null])).rows[0];
      await writeAudit(c, { orgId, userId: uid, action: 'create', entity: 'contact', entityId: r.id, after: b, ip });
      return { id: Number(r.id) };
    });
  }

  /** Edit a contact. Send the whole form: fields left out are cleared. Documents already posted keep what they were issued with. */
  @Put('orgs/:orgId/contacts/:id')
  async editContact(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'post');
    const b = parse(contactSchema, body);
    if (b.gstin && !isValidGstin(b.gstin)) throw new BadRequestException('Invalid GSTIN (format or check digit is wrong)');
    const state = b.stateCode ?? (b.gstin ? stateOfGstin(b.gstin) : null);
    return withOrg(orgId, async (c) => {
      const before = (await c.query(`SELECT ${CONTACT_COLS} FROM contacts WHERE id=$1`, [id])).rows[0];
      if (!before) throw new NotFoundException('Contact not found');
      if (state && !(await c.query('SELECT 1 FROM gst_states WHERE code=$1', [state])).rowCount) throw new BadRequestException('Unknown state code');
      await this.checkDefaults(c, b);
      await c.query(`UPDATE contacts SET kind=$2,name=$3,gstin=$4,pan=$5,state_code=$6,email=$7,phone=$8,is_individual=$9,country=$10,
        bank_account_name=$11,bank_name=$12,bank_account_no=$13,bank_ifsc=$14,default_sales_account_id=$15,default_purchase_account_id=$16 WHERE id=$1`,
        [id, b.kind, b.name, b.gstin?.toUpperCase() ?? null, b.pan ?? null, state, b.email ?? null, b.phone ?? null, b.isIndividual, b.country,
          b.bankAccountName ?? null, b.bankName ?? null, b.bankAccountNo ?? null, b.bankIfsc ?? null, b.defaultSalesAccountId ?? null, b.defaultPurchaseAccountId ?? null]);
      await writeAudit(c, { orgId, userId: uid, action: 'update', entity: 'contact', entityId: id, before: shapeContact(before), after: b, ip });
      return { ok: true };
    });
  }

  @Post('orgs/:orgId/contacts/:id/archive')
  async archiveContact(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'post');
    const b = parse(z.object({ archived: z.boolean().default(true) }), body ?? {});
    return withOrg(orgId, async (c) => {
      if (!(await c.query('UPDATE contacts SET is_archived=$2 WHERE id=$1 RETURNING id', [id, b.archived])).rowCount) throw new NotFoundException('Contact not found');
      await writeAudit(c, { orgId, userId: uid, action: b.archived ? 'archive' : 'unarchive', entity: 'contact', entityId: id, ip });
      return { ok: true };
    });
  }

  /** Delete a contact that was never used. One with invoices, bills, quotes or projects must be archived instead. */
  @Delete('orgs/:orgId/contacts/:id')
  async deleteContact(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'manage');
    return withOrg(orgId, async (c) => {
      const before = (await c.query('SELECT name FROM contacts WHERE id=$1', [id])).rows[0];
      if (!before) throw new NotFoundException('Contact not found');
      await c.query('SAVEPOINT del');
      try { await c.query('DELETE FROM contacts WHERE id=$1', [id]); }
      catch (e: any) {
        if (e.code !== '23503') throw e;
        await c.query('ROLLBACK TO SAVEPOINT del');
        throw new ConflictException('This contact has invoices, bills or other records, so it cannot be deleted. Archive it instead.');
      }
      await writeAudit(c, { orgId, userId: uid, action: 'delete', entity: 'contact', entityId: id, before, ip });
      return { ok: true };
    });
  }

  // ---- documents ----
  @Get('orgs/:orgId/documents')
  async list(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Query('type') type?: string, @Query('contactId') contactId?: string, @Query('archived') archived?: string) {
    await requireOrg(uid, orgId, 'read');
    return withOrg(orgId, async (c) => {
      const rows = (await c.query(`${OUTSTANDING_SQL} WHERE ($1::text IS NULL OR d.doc_type=$1) AND ($2::bigint IS NULL OR d.contact_id=$2) AND ($3::boolean OR NOT d.is_archived) ORDER BY d.issue_date DESC, d.id DESC LIMIT 500`,
        [type ?? null, contactId ? Number(contactId) : null, archived === 'true'])).rows;
      return rows.map(shapeDoc);
    });
  }

  @Get('orgs/:orgId/documents/:id')
  async one(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number) {
    await requireOrg(uid, orgId, 'read');
    return withOrg(orgId, async (c) => {
      const d = (await c.query(`${OUTSTANDING_SQL} WHERE d.id=$1`, [id])).rows[0];
      if (!d) throw new NotFoundException('Document not found');
      const lines = (await c.query('SELECT description,hsn_sac AS "hsnSac",qty_milli,rate,taxable,gst_rate_bp AS "gstRateBp",cgst,sgst,igst,account_id,item_id,tracking_option_id FROM document_lines WHERE doc_id=$1 ORDER BY id', [id])).rows
        .map((l) => ({ ...l, qtyMilli: Number(l.qty_milli), rate: Number(l.rate), taxable: Number(l.taxable), cgst: Number(l.cgst), sgst: Number(l.sgst), igst: Number(l.igst), accountId: Number(l.account_id), itemId: l.item_id ? Number(l.item_id) : null, trackingOptionId: l.tracking_option_id ? Number(l.tracking_option_id) : null }));
      const payments = (await c.query('SELECT id,pay_date::text AS date,amount,reference FROM payments WHERE doc_id=$1 ORDER BY id', [id])).rows.map((p) => ({ ...p, id: Number(p.id), amount: Number(p.amount) }));
      return { ...shapeDoc(d), lines, payments };
    });
  }

  @Post('orgs/:orgId/documents')
  async create(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Body() body: unknown, @Ip() ip: string) {
    const role = await requireOrg(uid, orgId, 'post');
    const b = parse(docSchema, body);
    if (role === 'staff' && (await getPool().query('SELECT require_approval FROM organizations WHERE id=$1', [orgId])).rows[0]?.require_approval)
      throw new ForbiddenException('This organisation needs approval for new invoices and bills: submit it for approval instead');
    return withOrg(orgId, (c) => createDocument(c, orgId, uid, b, ip));
  }

  /** Cancel a document by posting a reversal of its journal entry. Not allowed once payments or notes exist. */
  @Post('orgs/:orgId/documents/:id/void')
  async voidDoc(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'post');
    const b = parse(z.object({ date, reason: z.string().min(1).max(300) }), body);
    return withOrg(orgId, (c) => voidDocument(c, orgId, uid, id, b.date, b.reason, ip));
  }

  /** "Delete" several invoices or bills at once. Posted entries are locked in the books, so each one is cancelled with a reversing entry. A failure on one does not stop the rest. */
  @Post('orgs/:orgId/documents/bulk-void')
  async bulkVoid(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'post');
    const b = parse(z.object({ ids: z.array(z.number().int().positive()).min(1).max(200), date, reason: z.string().min(1).max(300).default('Deleted from the app') }), body);
    return withOrg(orgId, async (c) => {
      const voided: number[] = [], failed: { id: number; number: string | null; reason: string }[] = [];
      for (const id of b.ids) {
        await c.query('SAVEPOINT one');
        try { await voidDocument(c, orgId, uid, id, b.date, b.reason, ip); await c.query('RELEASE SAVEPOINT one'); voided.push(id); }
        catch (e: any) {
          await c.query('ROLLBACK TO SAVEPOINT one');
          const n = (await c.query('SELECT number FROM documents WHERE id=$1', [id])).rows[0]?.number ?? null;
          failed.push({ id, number: n, reason: e?.message ?? 'Could not be removed' });
        }
      }
      return { voided, failed };
    });
  }

  /**
   * Edit a posted invoice or bill. The books keep a trail: the old version is cancelled by a reversing entry dated as the original,
   * and the corrected one is posted fresh under the same number. Not possible once payments or notes exist.
   */
  @Put('orgs/:orgId/documents/:id')
  async editDoc(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number, @Body() body: unknown, @Ip() ip: string) {
    const role = await requireOrg(uid, orgId, 'post');
    const b = parse(docSchema, body);
    if (role === 'staff' && (await getPool().query('SELECT require_approval FROM organizations WHERE id=$1', [orgId])).rows[0]?.require_approval)
      throw new ForbiddenException('This organisation needs approval for changes to invoices and bills');
    return withOrg(orgId, async (c) => {
      const old = (await c.query('SELECT number,doc_type,issue_date::text AS issue_date,status FROM documents WHERE id=$1', [id])).rows[0];
      if (!old) throw new NotFoundException('Document not found');
      if (old.status === 'void') throw new ConflictException('This document is already cancelled');
      if (old.doc_type !== b.docType) throw new BadRequestException('The type of a document cannot be changed');
      await voidDocument(c, orgId, uid, id, old.issue_date, 'Edited', ip);
      await c.query('UPDATE documents SET number = number || $2 WHERE id=$1', [id, `-v${id}`]); // free the number for the corrected version
      const fresh = await createDocument(c, orgId, uid, { ...b, number: b.number ?? old.number }, ip);
      await c.query('UPDATE documents SET replaced_by=$2 WHERE id=$1', [id, fresh.id]);
      await writeAudit(c, { orgId, userId: uid, action: 'edit', entity: 'document', entityId: fresh.id, before: { replacedId: id, number: old.number }, after: { total: fresh.total }, ip });
      return fresh;
    });
  }

  /** Next number the system would give, so the form can show it and let the user change it. */
  @Get('orgs/:orgId/documents-next-number')
  async nextNumber(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Query('type') type: string, @Query('date') on?: string) {
    await requireOrg(uid, orgId, 'read');
    if (!(type in PREFIX)) throw new BadRequestException('Unknown document type');
    const d = on && /^\d{4}-\d{2}-\d{2}$/.test(on) ? on : new Date().toISOString().slice(0, 10);
    return withOrg(orgId, async (c) => ({ number: await peekNumber(c, orgId, type as DocType, d) }));
  }

  /** Unlink a payment that was recorded against the wrong invoice or bill: its entry is reversed and the invoice becomes outstanding again. */
  @Delete('orgs/:orgId/payments/:paymentId')
  async unlinkPayment(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('paymentId', ParseIntPipe) paymentId: number, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'post');
    return withOrg(orgId, async (c) => {
      const p = (await c.query('SELECT p.*, d.number FROM payments p JOIN documents d ON d.id=p.doc_id WHERE p.id=$1 FOR UPDATE OF p', [paymentId])).rows[0];
      if (!p) throw new NotFoundException('Payment not found');
      const ls = (await c.query('SELECT account_id,debit,credit,tracking_option_id FROM journal_lines WHERE entry_id=$1', [p.journal_entry_id])).rows
        .map((r) => ({ accountId: Number(r.account_id), debit: Number(r.debit), credit: Number(r.credit), trackingOptionId: r.tracking_option_id ? Number(r.tracking_option_id) : null }));
      const on = new Date().toISOString().slice(0, 10);
      const vid = await insertEntry(c, orgId, uid, on, `Payment unlinked from ${p.number}`, p.number, Number(p.journal_entry_id), reverseLines(ls));
      await c.query("UPDATE bank_transactions SET status='unreconciled', matched_entry_id=NULL WHERE matched_entry_id=$1", [p.journal_entry_id]);
      await c.query('DELETE FROM payments WHERE id=$1', [paymentId]);
      await writeAudit(c, { orgId, userId: uid, action: 'unlink_payment', entity: 'document', entityId: Number(p.doc_id), before: { paymentId, amount: Number(p.amount) }, ip });
      return { unlinked: true, reversalEntryId: vid };
    });
  }

  @Post('orgs/:orgId/documents/:id/payments')
  async pay(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'post');
    // amount = rupees actually received or paid. For a foreign-currency document also give foreignAmount (in its currency's cents).
    const b = parse(z.object({ date, amount: z.number().int().positive(), accountId: z.number().int().positive(), reference: z.string().max(100).optional(),
      foreignAmount: z.number().int().positive().optional() }), body);
    return withOrg(orgId, (c) => recordPayment(c, orgId, uid, id, b, ip));
  }
}

export interface PaymentInput { date: string; amount: number; accountId: number; reference?: string; foreignAmount?: number }
/** Record a payment received on an invoice or made on a bill, and post its journal entry. Call inside withOrg(). */
export async function recordPayment(c: PoolClient, orgId: number, uid: number, id: number, b: PaymentInput, ip?: string) {
  const d = (await c.query(`${OUTSTANDING_SQL} WHERE d.id=$1 FOR UPDATE OF d`, [id])).rows[0];
  if (!d) throw new NotFoundException('Document not found');
  if (d.status !== 'posted') throw new ConflictException('Document is void');
  if (d.doc_type !== 'invoice' && d.doc_type !== 'bill') throw new BadRequestException('Only invoices and bills can be paid');
  const outstanding = Number(d.outstanding);
  let settled = b.amount, fxGain = 0;
  if (d.currency !== 'INR') {
    if (!b.foreignAmount) throw new BadRequestException(`Give the amount in ${d.currency} (foreignAmount) as well as the rupees`);
    const fo = Number((await c.query(`SELECT d.foreign_total - COALESCE((SELECT SUM(foreign_amount) FROM payments WHERE doc_id=d.id),0)
        - COALESCE((SELECT SUM(foreign_total) FROM documents n WHERE n.original_doc_id=d.id AND n.status='posted'),0) AS fo FROM documents d WHERE d.id=$1`, [id])).rows[0].fo);
    if (b.foreignAmount > fo) throw new BadRequestException(`Payment exceeds the amount still owed (${fo} ${d.currency} cents)`);
    // Settle at the rate the document was booked at; the difference from the rupees actually moved is an exchange gain or loss.
    settled = b.foreignAmount === fo ? outstanding : Math.min(outstanding, toRupees(b.foreignAmount, Number(d.fx_rate)));
    fxGain = d.doc_type === 'invoice' ? b.amount - settled : settled - b.amount;
  } else if (b.amount > outstanding) throw new BadRequestException(`Payment exceeds the outstanding amount (${outstanding} paise)`);
  const bank = (await c.query('SELECT type FROM accounts WHERE id=$1 AND is_active', [b.accountId])).rows[0];
  if (!bank || bank.type !== 'asset') throw new BadRequestException('Pay from/into a cash or bank (asset) account');
  const control = await accountIdByCode(c, d.doc_type === 'invoice' ? '1100' : '2000');
  const lines: Line[] = d.doc_type === 'invoice'
    ? [{ accountId: b.accountId, debit: b.amount, credit: 0 }, { accountId: control, debit: 0, credit: settled }]
    : [{ accountId: control, debit: settled, credit: 0 }, { accountId: b.accountId, debit: 0, credit: b.amount }];
  if (fxGain) {
    const fx = await ensureAccount(c, orgId, '4300');
    lines.push(fxGain > 0 ? { accountId: fx, debit: 0, credit: fxGain } : { accountId: fx, debit: -fxGain, credit: 0 });
  }
  const eid = await insertEntry(c, orgId, uid, b.date, `Payment ${d.doc_type === 'invoice' ? 'received for' : 'made for'} ${d.number}`, d.number, null, lines);
  const p = (await c.query('INSERT INTO payments(org_id,doc_id,pay_date,amount,account_id,journal_entry_id,reference,created_by,foreign_amount,bank_amount,fx_gain) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id',
    [orgId, id, b.date, settled, b.accountId, eid, b.reference ?? null, uid, b.foreignAmount ?? null, b.amount, fxGain])).rows[0];
  await writeAudit(c, { orgId, userId: uid, action: 'payment', entity: 'document', entityId: id, after: b, ip });
  return { id: Number(p.id), journalEntryId: eid, settled, fxGain, outstandingAfter: outstanding - settled };
}

export type DocLineInput = { description: string; hsnSac?: string; quantity: number; rate: number; gstRateBp: number; accountId?: number; itemId?: number; trackingOptionId?: number };

/**
 * Validate lines and work out GST for a sales or purchase document. Shared by invoices/bills, quotes and purchase orders
 * so they always agree on tax. Amounts are in the document's own currency (paise for rupees).
 */
export async function priceLines(c: PoolClient, orgId: number, isSales: boolean, contactId: number, issueDate: string, lines: DocLineInput[], placeOfSupply?: string, supplyType: SupplyType = 'regular') {
  const org = (await c.query('SELECT gstin,state_code,gst_scheme,lut_number FROM organizations WHERE id=$1', [orgId])).rows[0];
  const contact = (await c.query('SELECT * FROM contacts WHERE id=$1', [contactId])).rows[0];
  if (!contact) throw new BadRequestException('Contact not found');
  if (contact.kind !== 'both' && contact.kind !== (isSales ? 'customer' : 'supplier')) throw new BadRequestException(`This contact is a ${contact.kind}; ${isSales ? 'sales' : 'purchase'} documents need a ${isSales ? 'customer' : 'supplier'}`);
  let rules: ReturnType<typeof supplyRules>;
  try { rules = supplyRules(supplyType, isSales, org.gst_scheme === 'composition'); } catch (e) { throw new BadRequestException((e as Error).message); }
  if (rules.needsLut && !org.lut_number) throw new BadRequestException('Add your Letter of Undertaking (LUT) number in organisation settings before making zero-rated supplies');
  const isExport = supplyType.startsWith('export');
  if (isExport && contact.country === 'IN') throw new BadRequestException('Exports need a customer outside India: set the country on the contact');

  // Who supplies, and where is the supply made? (drives CGST+SGST vs IGST)
  const supplierState: string | null = isSales ? org.state_code : contact.state_code;
  const pos: string | null = placeOfSupply ?? (isExport ? '96' : isSales ? contact.state_code ?? org.state_code : org.state_code);
  if (pos && !(await c.query('SELECT 1 FROM gst_states WHERE code=$1', [pos])).rowCount) throw new BadRequestException('Unknown place of supply');
  const registered = rules.chargeTax && (isSales ? !!org.gstin : !!contact.gstin);

  // Validate GST slabs against the config table.
  const slabs = new Set((await c.query('SELECT rate_bp FROM gst_rates WHERE valid_from <= $1 AND (valid_to IS NULL OR valid_to >= $1)', [issueDate])).rows.map((r) => r.rate_bp));
  const contactDefault = isSales ? contact.default_sales_account_id : contact.default_purchase_account_id;
  const defaultAcc = contactDefault ? Number(contactDefault) : await accountIdByCode(c, isSales ? '4000' : '5000').catch(() => null);

  // Stock-tracked goods on a purchase go to the Inventory account instead of an expense.
  const itemIds = [...new Set(lines.map((l) => l.itemId).filter((x): x is number => !!x))];
  const items = itemIds.length ? (await c.query('SELECT id,name,track_stock FROM items WHERE id = ANY($1) AND active', [itemIds])).rows : [];
  const inventory = !isSales && items.some((i) => i.track_stock) ? await ensureAccount(c, orgId, '1200') : null;
  const optIds = [...new Set(lines.map((l) => l.trackingOptionId).filter((x): x is number => !!x))];
  if (optIds.length && (await c.query('SELECT id FROM tracking_options WHERE id = ANY($1) AND active', [optIds])).rowCount !== optIds.length) throw new BadRequestException('Unknown or archived tracking option');

  const resolved = lines.map((l, i) => {
    if (!l.itemId) return { ...l, accountId: l.accountId ?? defaultAcc };
    const it = items.find((x) => Number(x.id) === l.itemId);
    if (!it) throw new BadRequestException(`Line ${i + 1}: unknown or archived item`);
    return { ...l, accountId: it.track_stock && !isSales ? inventory : l.accountId ?? defaultAcc };
  });
  const wanted = isSales ? ['income'] : ['expense', 'asset'];
  const accIds = [...new Set(resolved.map((l) => l.accountId).filter((x): x is number => !!x))];
  const accRows = (await c.query('SELECT id,type FROM accounts WHERE id = ANY($1) AND is_active', [accIds])).rows;
  resolved.forEach((l, i) => {
    if (!slabs.has(l.gstRateBp)) throw new BadRequestException(`Line ${i + 1}: ${l.gstRateBp / 100}% is not a configured GST rate`);
    const row = accRows.find((r) => Number(r.id) === l.accountId);
    if (!l.accountId || !row) throw new BadRequestException(`Line ${i + 1}: choose a valid account`);
    if (!wanted.includes(row.type)) throw new BadRequestException(`Line ${i + 1}: account must be ${wanted.join(' or ')} type`);
  });

  const input = resolved.map((l) => ({
    description: l.description, hsnSac: l.hsnSac, qtyMilli: Math.round(l.quantity * 1000), rate: l.rate, gstRateBp: l.gstRateBp, accountId: l.accountId!,
    itemId: l.itemId ?? null, trackingOptionId: l.trackingOptionId ?? null,
  }));
  const taxLines = computeGst(input, supplierState, pos, registered, rules.forceIgst);
  // Reverse charge: the GST the buyer must pay itself, worked out as if the supplier had charged it (buyer's state is the place of supply).
  const rcmLines = rules.reverseCharge ? computeGst(input, contact.state_code ?? org.state_code, org.state_code, !!org.gstin) : null;
  const t = totals(taxLines);
  if (t.subtotal <= 0) throw new BadRequestException('Document total must be more than zero');
  return { org, contact, pos, taxLines, t, rules, rcmLines };
}

/** Cancel a posted document with a reversing entry (and put any stock back). */
export async function voidDocument(c: PoolClient, orgId: number, uid: number, id: number, on: string, reason: string, ip?: string) {
  const d = (await c.query('SELECT * FROM documents WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!d) throw new NotFoundException('Document not found');
  if (d.status === 'void') throw new ConflictException('Already void');
  if ((await c.query('SELECT 1 FROM payments WHERE doc_id=$1', [id])).rowCount) throw new ConflictException('This document has payments. Unlink them first');
  if ((await c.query("SELECT 1 FROM documents WHERE original_doc_id=$1 AND status='posted'", [id])).rowCount) throw new ConflictException('This document has credit/debit notes against it');
  const ls = (await c.query('SELECT account_id,debit,credit,tracking_option_id FROM journal_lines WHERE entry_id=$1', [d.journal_entry_id])).rows
    .map((r) => ({ accountId: Number(r.account_id), debit: Number(r.debit), credit: Number(r.credit), trackingOptionId: r.tracking_option_id ? Number(r.tracking_option_id) : null }));
  const moves = (await c.query('SELECT item_id, MIN(id) AS first_id, SUM(qty_milli) AS q, SUM(value) AS v FROM stock_moves WHERE doc_id=$1 GROUP BY item_id', [id])).rows;
  for (const m of moves) {
    await c.query('SELECT id FROM items WHERE id=$1 FOR UPDATE', [m.item_id]);
    if (Number(m.q) > 0 && (await c.query("SELECT 1 FROM stock_moves WHERE item_id=$1 AND id > $2 AND kind='sale'", [m.item_id, m.first_id])).rowCount)
      throw new ConflictException('Goods on this bill have been sold since it was posted: record a debit note or a stock adjustment instead');
  }
  const vid = await insertEntry(c, orgId, uid, on, `Void ${d.number}: ${reason}`, d.number, Number(d.journal_entry_id), reverseLines(ls));
  for (const m of moves) await recordMove(c, orgId, { itemId: Number(m.item_id), date: on, kind: 'void', qtyMilli: -Number(m.q), value: -Number(m.v), docId: id, entryId: vid, note: `Void ${d.number}` });
  await c.query("UPDATE documents SET status='void', void_entry_id=$2 WHERE id=$1", [id, vid]);
  // Project time and costs billed on a voided invoice can be invoiced again.
  await c.query('UPDATE project_time SET invoiced_doc_id=NULL WHERE invoiced_doc_id=$1', [id]);
  await c.query('UPDATE project_costs SET invoiced_doc_id=NULL WHERE invoiced_doc_id=$1', [id]);
  await writeAudit(c, { orgId, userId: uid, action: 'void', entity: 'document', entityId: id, after: { date: on, reason }, ip });
  return { voided: true, reversalEntryId: vid };
}

const numberFor = (type: DocType, fyLabel: string, n: number) => `${PREFIX[type]}/${fyLabel.replace('FY ', '').slice(2)}/${String(n).padStart(4, '0')}`;
/** The next automatic number for a type and date, skipping any that were typed in by hand. Does not use it up. */
async function peekNumber(c: PoolClient, orgId: number, type: DocType, on: string) {
  const fy = financialYearOf(on);
  let n = Number((await c.query('SELECT next_no FROM doc_sequences WHERE org_id=$1 AND doc_type=$2 AND fy_label=$3', [orgId, type, fy.label])).rows[0]?.next_no ?? 1);
  while ((await c.query('SELECT 1 FROM documents WHERE doc_type=$1 AND number=$2', [type, numberFor(type, fy.label, n)])).rowCount) n++;
  return numberFor(type, fy.label, n);
}

/** Build, validate and post a sales/purchase document with its GST, TDS, stock and journal entry. */
export async function createDocument(c: PoolClient, orgId: number, uid: number, b: z.infer<typeof docSchema>, ip?: string, extra: { recurringId?: number } = {}) {
  const type = b.docType as DocType, isSales = SALES.includes(type);
  const supplyType = (b.supplyType ?? 'regular') as SupplyType, currency = b.currency ?? 'INR', foreign = currency !== 'INR';
  if (b.dueDate && b.dueDate < b.issueDate) throw new BadRequestException('Due date is before issue date');

  // Original document checks for credit/debit notes. A note uses its original's currency and exchange rate.
  let original: any = null, fxRate = 1;
  if (b.originalDocId) {
    if (type !== 'credit_note' && type !== 'debit_note') throw new BadRequestException('Only credit/debit notes can refer to an original document');
    original = (await c.query(`${OUTSTANDING_SQL} WHERE d.id=$1`, [b.originalDocId])).rows[0];
    const expect = type === 'credit_note' ? 'invoice' : 'bill';
    if (!original || original.doc_type !== expect || original.status !== 'posted' || Number(original.contact_id) !== b.contactId) throw new BadRequestException(`Original must be a posted ${expect} for the same contact`);
    if (original.currency !== currency) throw new BadRequestException(`A note must be in the same currency as its original (${original.currency})`);
    fxRate = Number(original.fx_rate);
  } else if (foreign) {
    if (!b.fxRate) throw new BadRequestException(`Give the exchange rate: rupees per 1 ${currency}`);
    fxRate = b.fxRate;
  }
  if (foreign && b.tdsSection) throw new BadRequestException('TDS on foreign-currency bills is not supported: record the bill in rupees');

  const priced = await priceLines(c, orgId, isSales, b.contactId, b.issueDate, b.lines, b.placeOfSupply, supplyType);
  const { contact, pos, rules } = priced;
  const conv = (l: TaxLine): TaxLine => (foreign
    ? { ...l, rate: toRupees(l.rate, fxRate), taxable: toRupees(l.taxable, fxRate), cgst: toRupees(l.cgst, fxRate), sgst: toRupees(l.sgst, fxRate), igst: toRupees(l.igst, fxRate) }
    : l);
  const taxLines = priced.taxLines.map(conv), t = totals(taxLines);
  const rcm = priced.rcmLines ? totals(priced.rcmLines.map(conv)) : { cgst: 0, sgst: 0, igst: 0, total: 0, subtotal: 0 };
  const foreignTotal = foreign ? priced.t.total : null;
  if (original && t.total > Number(original.outstanding)) throw new BadRequestException('Note is larger than the amount still outstanding on the original');

  // TDS on bills only.
  let tdsSection: string | null = null, tdsAmount = 0;
  if (b.tdsSection) {
    if (type !== 'bill') throw new BadRequestException('TDS can only be deducted on purchase bills');
    const sec = (await c.query('SELECT * FROM tds_sections WHERE code=$1 AND valid_from <= $2 AND (valid_to IS NULL OR valid_to >= $2)', [b.tdsSection, b.issueDate])).rows[0];
    if (!sec) throw new BadRequestException(`Unknown TDS section ${b.tdsSection}`);
    const fy = financialYearOf(b.issueDate);
    const prior = (await c.query(
      `SELECT COALESCE(SUM(subtotal),0) AS total, COALESCE(SUM(subtotal) FILTER (WHERE tds_amount > 0),0) AS deducted
         FROM documents WHERE contact_id=$1 AND doc_type='bill' AND status='posted' AND tds_section=$2 AND issue_date BETWEEN $3 AND $4`,
      [b.contactId, b.tdsSection, fy.start, fy.end])).rows[0];
    const r = computeTds({
      section: { code: sec.code, rateIndividualBp: sec.rate_individual_bp, rateOtherBp: sec.rate_other_bp, singleThreshold: Number(sec.single_threshold), annualThreshold: Number(sec.annual_threshold) },
      deducteeIsIndividual: contact.is_individual, hasPan: !!contact.pan || !!contact.gstin,
      amount: t.subtotal, priorTotal: Number(prior.total), priorDeductedBase: Number(prior.deducted),
    });
    tdsSection = sec.code; tdsAmount = Math.min(r.tds, t.total);
  }
  const netPayable = t.total - tdsAmount;

  // Stock: purchases add quantity at cost; sales take it out at weighted average cost. Notes do not move stock.
  const moves: { itemId: number; qtyMilli: number; value: number }[] = [];
  let costOfSales = 0;
  const lineItemIds = [...new Set(taxLines.map((l) => l.itemId).filter((x): x is number => !!x))];
  if ((type === 'invoice' || type === 'bill') && lineItemIds.length) {
    const tracked = new Set((await c.query('SELECT id FROM items WHERE id = ANY($1) AND track_stock ORDER BY id FOR UPDATE', [lineItemIds])).rows.map((r) => Number(r.id)));
    const state = new Map<number, { qtyMilli: number; value: number }>();
    for (const l of taxLines) {
      if (!l.itemId || !tracked.has(l.itemId)) continue;
      if (type === 'bill') { moves.push({ itemId: l.itemId, qtyMilli: l.qtyMilli, value: l.taxable + (rules.claimInputCredit ? 0 : l.cgst + l.sgst + l.igst) }); continue; }
      const s = state.get(l.itemId) ?? await onHand(c, l.itemId);
      if (l.qtyMilli > s.qtyMilli) throw new BadRequestException(`Not enough stock for "${l.description}": ${s.qtyMilli / 1000} on hand`);
      const cost = issueCost(s, l.qtyMilli);
      state.set(l.itemId, { qtyMilli: s.qtyMilli - l.qtyMilli, value: s.value - cost });
      moves.push({ itemId: l.itemId, qtyMilli: -l.qtyMilli, value: -cost });
      costOfSales += cost;
    }
  }

  // Number: PREFIX/FY/0001, one running sequence per type per financial year. A number typed by the user is used as it is, if it is free.
  const fy = financialYearOf(b.issueDate);
  let number: string;
  if (b.number) {
    number = b.number.trim();
    if ((await c.query('SELECT 1 FROM documents WHERE doc_type=$1 AND number=$2', [type, number])).rowCount) throw new ConflictException(`The number ${number} is already used by another ${type.replace('_', ' ')}`);
  } else {
    do {
      const seq = (await c.query(`INSERT INTO doc_sequences(org_id,doc_type,fy_label,next_no) VALUES ($1,$2,$3,2)
        ON CONFLICT (org_id,doc_type,fy_label) DO UPDATE SET next_no = doc_sequences.next_no + 1 RETURNING next_no - 1 AS n`, [orgId, type, fy.label])).rows[0];
      number = numberFor(type, fy.label, Number(seq.n));
    } while ((await c.query('SELECT 1 FROM documents WHERE doc_type=$1 AND number=$2', [type, number])).rowCount);
  }

  // Journal. Sales: Dr Debtors / Cr revenue + output GST. Purchases: Dr expense + input GST / Cr Creditors + TDS payable. Notes reverse.
  // Lines are grouped by account and tracking option so reports by tracking category still work.
  const sums = new Map<string, { accountId: number; trackingOptionId: number | null; amount: number }>();
  for (const l of taxLines) {
    const key = `${l.accountId}:${l.trackingOptionId ?? ''}`;
    const tax = !isSales && !rules.claimInputCredit ? l.cgst + l.sgst + l.igst : 0; // composition dealers: GST paid is part of the cost
    const cur = sums.get(key) ?? { accountId: l.accountId, trackingOptionId: l.trackingOptionId ?? null, amount: 0 };
    cur.amount += l.taxable + tax; sums.set(key, cur);
  }
  const gstIds: number[] = [];
  for (const code of isSales ? ['2100', '2110', '2120'] : ['1300', '1310', '1320']) gstIds.push(await accountIdByCode(c, code)); // sequential: one client runs one query at a time
  const taxAmts = [t.cgst, t.sgst, t.igst];
  const primary: Line[] = []; // the "normal" direction for an invoice (sales) or bill (purchase)
  if (isSales) {
    primary.push({ accountId: await accountIdByCode(c, '1100'), debit: t.total, credit: 0 });
    for (const v of sums.values()) primary.push({ accountId: v.accountId, debit: 0, credit: v.amount, trackingOptionId: v.trackingOptionId });
    taxAmts.forEach((v, i) => v && primary.push({ accountId: gstIds[i], debit: 0, credit: v }));
    if (costOfSales) {
      primary.push({ accountId: await ensureAccount(c, orgId, '5050'), debit: costOfSales, credit: 0 });
      primary.push({ accountId: await ensureAccount(c, orgId, '1200'), debit: 0, credit: costOfSales });
    }
  } else {
    for (const v of sums.values()) primary.push({ accountId: v.accountId, debit: v.amount, credit: 0, trackingOptionId: v.trackingOptionId });
    if (rules.claimInputCredit) taxAmts.forEach((v, i) => v && primary.push({ accountId: gstIds[i], debit: v, credit: 0 }));
    primary.push({ accountId: await accountIdByCode(c, '2000'), debit: 0, credit: netPayable });
    if (tdsAmount) primary.push({ accountId: await accountIdByCode(c, '2200'), debit: 0, credit: tdsAmount });
    // Reverse charge: Dr input GST (or the cost, for composition dealers) / Cr RCM GST payable.
    const rcmAmts = [rcm.cgst, rcm.sgst, rcm.igst];
    if (rcm.cgst + rcm.sgst + rcm.igst > 0) {
      const payIds = [await ensureAccount(c, orgId, '2130'), await ensureAccount(c, orgId, '2140'), await ensureAccount(c, orgId, '2150')];
      const costAcc = [...sums.values()][0].accountId;
      rcmAmts.forEach((v, i) => {
        if (!v) return;
        primary.push({ accountId: rules.claimInputCredit ? gstIds[i] : costAcc, debit: v, credit: 0 });
        primary.push({ accountId: payIds[i], debit: 0, credit: v });
      });
    }
  }
  const isNote = type === 'credit_note' || type === 'debit_note';
  const journal = validateLines(isNote ? reverseLines(primary) : primary);
  const eid = await insertEntry(c, orgId, uid, b.issueDate, `${type.replace('_', ' ')} ${number} - ${contact.name}`, number, null, journal);

  // Sales and purchase settings: default payment terms, and the terms printed on invoices.
  const defaults = (await c.query('SELECT invoice_due_days, bill_due_days, invoice_terms FROM organizations WHERE id = current_org()')).rows[0];
  const dueDays = type === 'invoice' ? defaults.invoice_due_days : type === 'bill' ? defaults.bill_due_days : null;
  const dueDate = b.dueDate ?? (dueDays == null ? null : new Date(Date.parse(b.issueDate) + dueDays * 86400000).toISOString().slice(0, 10));
  const notes = b.notes ?? (type === 'invoice' ? defaults.invoice_terms : null) ?? null;

  const doc = (await c.query(
    `INSERT INTO documents(org_id,doc_type,number,contact_id,issue_date,due_date,place_of_supply,supplier_ref,original_doc_id,subtotal,cgst,sgst,igst,
       tds_section,tds_amount,total,net_payable,journal_entry_id,notes,created_by,recurring_id,supply_type,rcm_cgst,rcm_sgst,rcm_igst,currency,fx_rate,foreign_total)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28) RETURNING id`,
    [orgId, type, number, b.contactId, b.issueDate, dueDate, pos, b.supplierRef ?? null, b.originalDocId ?? null, t.subtotal, t.cgst, t.sgst, t.igst,
     tdsSection, tdsAmount, t.total, netPayable, eid, notes, uid, extra.recurringId ?? null, supplyType, rcm.cgst, rcm.sgst, rcm.igst, currency, fxRate, foreignTotal])).rows[0];
  for (const l of taxLines) {
    await c.query('INSERT INTO document_lines(doc_id,org_id,description,hsn_sac,qty_milli,rate,taxable,gst_rate_bp,cgst,sgst,igst,account_id,item_id,tracking_option_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
      [doc.id, orgId, l.description, l.hsnSac ?? null, l.qtyMilli, l.rate, l.taxable, l.gstRateBp, l.cgst, l.sgst, l.igst, l.accountId, l.itemId ?? null, l.trackingOptionId ?? null]);
  }
  for (const m of moves) await recordMove(c, orgId, { ...m, date: b.issueDate, kind: type === 'bill' ? 'purchase' : 'sale', docId: Number(doc.id), entryId: eid, note: number });
  await writeAudit(c, { orgId, userId: uid, action: 'create', entity: 'document', entityId: doc.id, after: { number, total: t.total, tdsAmount, supplyType, currency }, ip });
  return { id: Number(doc.id), number, dueDate, ...t, tdsSection, tdsAmount, netPayable, journalEntryId: eid, supplyType, rcm: { cgst: rcm.cgst, sgst: rcm.sgst, igst: rcm.igst }, currency, foreignTotal, costOfSales };
}
