import { BadRequestException, Body, ConflictException, Controller, Get, NotFoundException, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { PoolClient } from 'pg';
import { z } from 'zod';
import { getPool, withOrg } from '../db/db';
import { writeAudit } from '../audit/audit';
import { AuthGuard, Ip, UserId, parse } from '../common/guard';
import { requireOrg } from '../tenancy/acl';
import { financialYearOf, validateLines, reverseLines, Line } from '../ledger/ledger';
import { accountIdByCode, insertEntry } from '../ledger/post';
import { computeGst, isValidGstin, stateOfGstin, totals } from '../tax/gst';
import { computeTds } from '../tax/tds';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const PREFIX = { invoice: 'INV', bill: 'BILL', credit_note: 'CN', debit_note: 'DN' } as const;
type DocType = keyof typeof PREFIX;
const SALES: DocType[] = ['invoice', 'credit_note'];

const contactSchema = z.object({
  kind: z.enum(['customer', 'supplier', 'both']), name: z.string().min(1).max(200),
  gstin: z.string().optional(), pan: z.string().regex(/^[A-Z]{5}\d{4}[A-Z]$/, 'Invalid PAN').optional(),
  stateCode: z.string().length(2).optional(), email: z.string().email().optional(), phone: z.string().max(20).optional(),
  isIndividual: z.boolean().default(false),
});
export const docSchema = z.object({
  docType: z.enum(['invoice', 'bill', 'credit_note', 'debit_note']), contactId: z.number().int().positive(),
  issueDate: date, dueDate: date.optional(), placeOfSupply: z.string().length(2).optional(), supplierRef: z.string().max(60).optional(),
  originalDocId: z.number().int().positive().optional(), tdsSection: z.string().optional(), notes: z.string().max(500).optional(),
  lines: z.array(z.object({
    description: z.string().min(1).max(300), hsnSac: z.string().regex(/^\d{4,8}$/, 'HSN/SAC must be 4-8 digits').optional(),
    quantity: z.number().positive().max(1e9), rate: z.number().int().min(0), gstRateBp: z.number().int().min(0).max(5000).default(0),
    accountId: z.number().int().positive().optional(),
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
  originalDocId: r.original_doc_id ? Number(r.original_doc_id) : null,
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
  async contacts(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number) {
    await requireOrg(uid, orgId, 'read');
    return withOrg(orgId, async (c) => (await c.query('SELECT id,kind,name,gstin,pan,state_code AS "stateCode",email,phone,is_individual AS "isIndividual" FROM contacts ORDER BY name')).rows
      .map((r) => ({ ...r, id: Number(r.id) })));
  }

  @Post('orgs/:orgId/contacts')
  async addContact(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'post');
    const b = parse(contactSchema, body);
    if (b.gstin && !isValidGstin(b.gstin)) throw new BadRequestException('Invalid GSTIN (format or check digit is wrong)');
    const state = b.stateCode ?? (b.gstin ? stateOfGstin(b.gstin) : null);
    return withOrg(orgId, async (c) => {
      if (state && !(await c.query('SELECT 1 FROM gst_states WHERE code=$1', [state])).rowCount) throw new BadRequestException('Unknown state code');
      const r = (await c.query('INSERT INTO contacts(org_id,kind,name,gstin,pan,state_code,email,phone,is_individual) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
        [orgId, b.kind, b.name, b.gstin?.toUpperCase() ?? null, b.pan ?? null, state, b.email ?? null, b.phone ?? null, b.isIndividual])).rows[0];
      await writeAudit(c, { orgId, userId: uid, action: 'create', entity: 'contact', entityId: r.id, after: b, ip });
      return { id: Number(r.id) };
    });
  }

  // ---- documents ----
  @Get('orgs/:orgId/documents')
  async list(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Query('type') type?: string, @Query('contactId') contactId?: string) {
    await requireOrg(uid, orgId, 'read');
    return withOrg(orgId, async (c) => {
      const rows = (await c.query(`${OUTSTANDING_SQL} WHERE ($1::text IS NULL OR d.doc_type=$1) AND ($2::bigint IS NULL OR d.contact_id=$2) ORDER BY d.issue_date DESC, d.id DESC LIMIT 500`,
        [type ?? null, contactId ? Number(contactId) : null])).rows;
      return rows.map(shapeDoc);
    });
  }

  @Get('orgs/:orgId/documents/:id')
  async one(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number) {
    await requireOrg(uid, orgId, 'read');
    return withOrg(orgId, async (c) => {
      const d = (await c.query(`${OUTSTANDING_SQL} WHERE d.id=$1`, [id])).rows[0];
      if (!d) throw new NotFoundException('Document not found');
      const lines = (await c.query('SELECT description,hsn_sac AS "hsnSac",qty_milli,rate,taxable,gst_rate_bp AS "gstRateBp",cgst,sgst,igst,account_id FROM document_lines WHERE doc_id=$1 ORDER BY id', [id])).rows
        .map((l) => ({ ...l, qtyMilli: Number(l.qty_milli), rate: Number(l.rate), taxable: Number(l.taxable), cgst: Number(l.cgst), sgst: Number(l.sgst), igst: Number(l.igst), accountId: Number(l.account_id) }));
      const payments = (await c.query('SELECT id,pay_date::text AS date,amount,reference FROM payments WHERE doc_id=$1 ORDER BY id', [id])).rows.map((p) => ({ ...p, id: Number(p.id), amount: Number(p.amount) }));
      return { ...shapeDoc(d), lines, payments };
    });
  }

  @Post('orgs/:orgId/documents')
  async create(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'post');
    const b = parse(docSchema, body);
    return withOrg(orgId, (c) => createDocument(c, orgId, uid, b, ip));
  }

  /** Cancel a document by posting a reversal of its journal entry. Not allowed once payments or notes exist. */
  @Post('orgs/:orgId/documents/:id/void')
  async voidDoc(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'post');
    const b = parse(z.object({ date, reason: z.string().min(1).max(300) }), body);
    return withOrg(orgId, async (c) => {
      const d = (await c.query('SELECT * FROM documents WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!d) throw new NotFoundException('Document not found');
      if (d.status === 'void') throw new ConflictException('Already void');
      if ((await c.query('SELECT 1 FROM payments WHERE doc_id=$1', [id])).rowCount) throw new ConflictException('Remove payments first: this document has payments');
      if ((await c.query("SELECT 1 FROM documents WHERE original_doc_id=$1 AND status='posted'", [id])).rowCount) throw new ConflictException('This document has credit/debit notes against it');
      const ls = (await c.query('SELECT account_id,debit,credit FROM journal_lines WHERE entry_id=$1', [d.journal_entry_id])).rows
        .map((r) => ({ accountId: Number(r.account_id), debit: Number(r.debit), credit: Number(r.credit) }));
      const vid = await insertEntry(c, orgId, uid, b.date, `Void ${d.number}: ${b.reason}`, d.number, Number(d.journal_entry_id), reverseLines(ls));
      await c.query("UPDATE documents SET status='void', void_entry_id=$2 WHERE id=$1", [id, vid]);
      await writeAudit(c, { orgId, userId: uid, action: 'void', entity: 'document', entityId: id, after: b, ip });
      return { voided: true, reversalEntryId: vid };
    });
  }

  @Post('orgs/:orgId/documents/:id/payments')
  async pay(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'post');
    const b = parse(z.object({ date, amount: z.number().int().positive(), accountId: z.number().int().positive(), reference: z.string().max(100).optional() }), body);
    return withOrg(orgId, async (c) => {
      const d = (await c.query(`${OUTSTANDING_SQL} WHERE d.id=$1 FOR UPDATE OF d`, [id])).rows[0];
      if (!d) throw new NotFoundException('Document not found');
      if (d.status !== 'posted') throw new ConflictException('Document is void');
      if (d.doc_type !== 'invoice' && d.doc_type !== 'bill') throw new BadRequestException('Only invoices and bills can be paid');
      if (b.amount > Number(d.outstanding)) throw new BadRequestException(`Payment exceeds the outstanding amount (${d.outstanding} paise)`);
      const bank = (await c.query('SELECT type FROM accounts WHERE id=$1 AND is_active', [b.accountId])).rows[0];
      if (!bank || bank.type !== 'asset') throw new BadRequestException('Pay from/into a cash or bank (asset) account');
      const control = await accountIdByCode(c, d.doc_type === 'invoice' ? '1100' : '2000');
      const lines: Line[] = d.doc_type === 'invoice'
        ? [{ accountId: b.accountId, debit: b.amount, credit: 0 }, { accountId: control, debit: 0, credit: b.amount }]
        : [{ accountId: control, debit: b.amount, credit: 0 }, { accountId: b.accountId, debit: 0, credit: b.amount }];
      const eid = await insertEntry(c, orgId, uid, b.date, `Payment ${d.doc_type === 'invoice' ? 'received for' : 'made for'} ${d.number}`, d.number, null, lines);
      const p = (await c.query('INSERT INTO payments(org_id,doc_id,pay_date,amount,account_id,journal_entry_id,reference,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
        [orgId, id, b.date, b.amount, b.accountId, eid, b.reference ?? null, uid])).rows[0];
      await writeAudit(c, { orgId, userId: uid, action: 'payment', entity: 'document', entityId: id, after: b, ip });
      return { id: Number(p.id), journalEntryId: eid, outstandingAfter: Number(d.outstanding) - b.amount };
    });
  }
}

export type DocLineInput = { description: string; hsnSac?: string; quantity: number; rate: number; gstRateBp: number; accountId?: number };

/**
 * Validate lines and work out GST for a sales or purchase document. Shared by invoices/bills, quotes and purchase orders
 * so they always agree on tax.
 */
export async function priceLines(c: PoolClient, orgId: number, isSales: boolean, contactId: number, issueDate: string, lines: DocLineInput[], placeOfSupply?: string) {
  const org = (await c.query('SELECT gstin,state_code FROM organizations WHERE id=$1', [orgId])).rows[0];
  const contact = (await c.query('SELECT * FROM contacts WHERE id=$1', [contactId])).rows[0];
  if (!contact) throw new BadRequestException('Contact not found');
  if (contact.kind !== 'both' && contact.kind !== (isSales ? 'customer' : 'supplier')) throw new BadRequestException(`This contact is a ${contact.kind}; ${isSales ? 'sales' : 'purchase'} documents need a ${isSales ? 'customer' : 'supplier'}`);

  // Who supplies, and where is the supply made? (drives CGST+SGST vs IGST)
  const supplierState: string | null = isSales ? org.state_code : contact.state_code;
  const pos: string | null = placeOfSupply ?? (isSales ? contact.state_code ?? org.state_code : org.state_code);
  if (pos && !(await c.query('SELECT 1 FROM gst_states WHERE code=$1', [pos])).rowCount) throw new BadRequestException('Unknown place of supply');
  const registered = isSales ? !!org.gstin : !!contact.gstin;

  // Validate GST slabs against the config table.
  const slabs = new Set((await c.query('SELECT rate_bp FROM gst_rates WHERE valid_from <= $1 AND (valid_to IS NULL OR valid_to >= $1)', [issueDate])).rows.map((r) => r.rate_bp));
  const defaultAcc = await accountIdByCode(c, isSales ? '4000' : '5000').catch(() => null);
  const wanted = isSales ? ['income'] : ['expense', 'asset'];
  const accIds = [...new Set(lines.map((l) => l.accountId ?? defaultAcc).filter((x): x is number => !!x))];
  const accRows = (await c.query('SELECT id,type FROM accounts WHERE id = ANY($1) AND is_active', [accIds])).rows;
  lines.forEach((l, i) => {
    if (!slabs.has(l.gstRateBp)) throw new BadRequestException(`Line ${i + 1}: ${l.gstRateBp / 100}% is not a configured GST rate`);
    const acc = l.accountId ?? defaultAcc;
    const row = accRows.find((r) => Number(r.id) === acc);
    if (!acc || !row) throw new BadRequestException(`Line ${i + 1}: choose a valid account`);
    if (!wanted.includes(row.type)) throw new BadRequestException(`Line ${i + 1}: account must be ${wanted.join(' or ')} type`);
  });

  const taxLines = computeGst(lines.map((l) => ({
    description: l.description, hsnSac: l.hsnSac, qtyMilli: Math.round(l.quantity * 1000), rate: l.rate, gstRateBp: l.gstRateBp, accountId: (l.accountId ?? defaultAcc)!,
  })), supplierState, pos, registered);
  const t = totals(taxLines);
  if (t.subtotal <= 0) throw new BadRequestException('Document total must be more than zero');
  return { org, contact, pos, taxLines, t };
}

/** Build, validate and post a sales/purchase document with its GST, TDS and journal entry. */
export async function createDocument(c: PoolClient, orgId: number, uid: number, b: z.infer<typeof docSchema>, ip?: string, extra: { recurringId?: number } = {}) {
  const type = b.docType as DocType, isSales = SALES.includes(type);
  if (b.dueDate && b.dueDate < b.issueDate) throw new BadRequestException('Due date is before issue date');
  const { contact, pos, taxLines, t } = await priceLines(c, orgId, isSales, b.contactId, b.issueDate, b.lines, b.placeOfSupply);

  // Original document checks for credit/debit notes.
  if (b.originalDocId) {
    if (type !== 'credit_note' && type !== 'debit_note') throw new BadRequestException('Only credit/debit notes can refer to an original document');
    const o = (await c.query(`${OUTSTANDING_SQL} WHERE d.id=$1`, [b.originalDocId])).rows[0];
    const expect = type === 'credit_note' ? 'invoice' : 'bill';
    if (!o || o.doc_type !== expect || o.status !== 'posted' || Number(o.contact_id) !== b.contactId) throw new BadRequestException(`Original must be a posted ${expect} for the same contact`);
    if (t.total > Number(o.outstanding)) throw new BadRequestException('Note is larger than the amount still outstanding on the original');
  }

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

  // Number: PREFIX/FY/0001, one running sequence per type per financial year.
  const fy = financialYearOf(b.issueDate);
  const seq = (await c.query(`INSERT INTO doc_sequences(org_id,doc_type,fy_label,next_no) VALUES ($1,$2,$3,2)
    ON CONFLICT (org_id,doc_type,fy_label) DO UPDATE SET next_no = doc_sequences.next_no + 1 RETURNING next_no - 1 AS n`, [orgId, type, fy.label])).rows[0];
  const number = `${PREFIX[type]}/${fy.label.replace('FY ', '').slice(2)}/${String(seq.n).padStart(4, '0')}`;

  // Journal. Sales: Dr Debtors / Cr revenue + output GST. Purchases: Dr expense + input GST / Cr Creditors + TDS payable. Notes reverse.
  const sums = new Map<number, number>();
  for (const l of taxLines) sums.set(l.accountId, (sums.get(l.accountId) ?? 0) + l.taxable);
  const gstAcc = isSales ? ['2100', '2110', '2120'] : ['1300', '1310', '1320'];
  const gstIds: number[] = [];
  for (const code of gstAcc) gstIds.push(await accountIdByCode(c, code)); // sequential: one client runs one query at a time
  const taxAmts = [t.cgst, t.sgst, t.igst];
  const primary: Line[] = []; // the "normal" direction for an invoice (sales) or bill (purchase)
  if (isSales) {
    primary.push({ accountId: await accountIdByCode(c, '1100'), debit: t.total, credit: 0 });
    for (const [a, v] of sums) primary.push({ accountId: a, debit: 0, credit: v });
    taxAmts.forEach((v, i) => v && primary.push({ accountId: gstIds[i], debit: 0, credit: v }));
  } else {
    for (const [a, v] of sums) primary.push({ accountId: a, debit: v, credit: 0 });
    taxAmts.forEach((v, i) => v && primary.push({ accountId: gstIds[i], debit: v, credit: 0 }));
    primary.push({ accountId: await accountIdByCode(c, '2000'), debit: 0, credit: netPayable });
    if (tdsAmount) primary.push({ accountId: await accountIdByCode(c, '2200'), debit: 0, credit: tdsAmount });
  }
  const isNote = type === 'credit_note' || type === 'debit_note';
  const journal = validateLines(isNote ? reverseLines(primary) : primary);
  const eid = await insertEntry(c, orgId, uid, b.issueDate, `${type.replace('_', ' ')} ${number} - ${contact.name}`, number, null, journal);

  const doc = (await c.query(
    `INSERT INTO documents(org_id,doc_type,number,contact_id,issue_date,due_date,place_of_supply,supplier_ref,original_doc_id,subtotal,cgst,sgst,igst,
       tds_section,tds_amount,total,net_payable,journal_entry_id,notes,created_by,recurring_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING id`,
    [orgId, type, number, b.contactId, b.issueDate, b.dueDate ?? null, pos, b.supplierRef ?? null, b.originalDocId ?? null, t.subtotal, t.cgst, t.sgst, t.igst,
     tdsSection, tdsAmount, t.total, netPayable, eid, b.notes ?? null, uid, extra.recurringId ?? null])).rows[0];
  for (const l of taxLines) {
    await c.query('INSERT INTO document_lines(doc_id,org_id,description,hsn_sac,qty_milli,rate,taxable,gst_rate_bp,cgst,sgst,igst,account_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
      [doc.id, orgId, l.description, l.hsnSac ?? null, l.qtyMilli, l.rate, l.taxable, l.gstRateBp, l.cgst, l.sgst, l.igst, l.accountId]);
  }
  await writeAudit(c, { orgId, userId: uid, action: 'create', entity: 'document', entityId: doc.id, after: { number, total: t.total, tdsAmount }, ip });
  return { id: Number(doc.id), number, ...t, tdsSection, tdsAmount, netPayable, journalEntryId: eid };
}
