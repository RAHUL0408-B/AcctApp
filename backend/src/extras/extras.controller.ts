// Features that round out the product: settings, items, quotes and POs, repeating invoices, bank rules, fixed assets, dashboard.
import { BadRequestException, Body, ConflictException, Controller, Get, NotFoundException, Param, ParseIntPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { getPool, withOrg } from '../db/db';
import { writeAudit } from '../audit/audit';
import { AuthGuard, Ip, UserId, parse } from '../common/guard';
import { requireOrg } from '../tenancy/acl';
import { financialYearOf } from '../ledger/ledger';
import { accountIdByCode, insertEntry } from '../ledger/post';
import { aged } from '../accounting/reports';
import { createDocument, DocLineInput, priceLines } from '../accounting/documents.controller';
import { isValidGstin } from '../tax/gst';
import { queueMail } from '../firm/mailer';
import { formatPaise } from '../money';
import { buildInvoicePdf } from './invoicepdf';
import { matchRule, monthEnds, monthlyDepreciation, nextDate } from './calc';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const today = () => new Date().toISOString().slice(0, 10);
const num = (r: any, ...ks: string[]) => { for (const k of ks) if (r[k] != null) r[k] = Number(r[k]); return r; };
const lineSchema = z.object({
  description: z.string().min(1).max(300), hsnSac: z.string().regex(/^\d{4,8}$/, 'HSN/SAC must be 4-8 digits').optional(),
  quantity: z.number().positive().max(1e9), rate: z.number().int().min(0), gstRateBp: z.number().int().min(0).max(5000).default(0), accountId: z.number().int().positive().optional(),
});
const PRE = { quote: { prefix: 'QU', docType: 'invoice', contactKinds: 'customer' }, purchase_order: { prefix: 'PO', docType: 'bill', contactKinds: 'supplier' } } as const;

@Controller('orgs/:orgId')
@UseGuards(AuthGuard)
export class ExtrasController {
  // ---------- organisation settings ----------
  @Get('settings')
  async settings(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number) {
    await requireOrg(uid, orgId, 'read');
    const o = (await getPool().query(`SELECT id,name,gstin,pan,state_code AS "stateCode",fy_start_month AS "fyStartMonth",gst_scheme AS "gstScheme",
      lut_number AS "lutNumber",require_approval AS "requireApproval" FROM organizations WHERE id=$1`, [orgId])).rows[0];
    return num(o, 'id');
  }

  @Put('settings')
  async updateSettings(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'manage');
    const b = parse(z.object({
      name: z.string().min(1).max(200).optional(),
      gstin: z.string().refine(isValidGstin, 'Invalid GSTIN (format or check digit is wrong)').nullable().optional(),
      pan: z.string().regex(/^[A-Z]{5}\d{4}[A-Z]$/, 'Invalid PAN').nullable().optional(),
      gstScheme: z.enum(['regular', 'composition']).optional(),
      lutNumber: z.string().min(5).max(40).nullable().optional(),
      requireApproval: z.boolean().optional(),
    }), body);
    const before = (await getPool().query('SELECT name,gstin,pan,state_code,gst_scheme,lut_number,require_approval FROM organizations WHERE id=$1', [orgId])).rows[0];
    const next = { name: b.name ?? before.name, gstin: b.gstin === undefined ? before.gstin : b.gstin, pan: b.pan === undefined ? before.pan : b.pan,
      gstScheme: b.gstScheme ?? before.gst_scheme, lutNumber: b.lutNumber === undefined ? before.lut_number : b.lutNumber, requireApproval: b.requireApproval ?? before.require_approval };
    const state = next.gstin ? next.gstin.slice(0, 2) : before.state_code;
    return withOrg(orgId, async (c) => {
      await c.query('UPDATE organizations SET name=$2, gstin=$3, pan=$4, state_code=$5, gst_scheme=$6, lut_number=$7, require_approval=$8 WHERE id=$1',
        [orgId, next.name, next.gstin, next.pan, state, next.gstScheme, next.lutNumber, next.requireApproval]);
      await writeAudit(c, { orgId, userId: uid, action: 'update', entity: 'organization', entityId: orgId, before, after: next, ip });
      return { ok: true, stateCode: state };
    });
  }

  // ---------- products and services ----------
  @Get('items')
  async items(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number) {
    await requireOrg(uid, orgId, 'read');
    return withOrg(orgId, async (c) => (await c.query(
      `SELECT id,code,name,kind,hsn_sac AS "hsnSac",sale_rate AS "saleRate",purchase_rate AS "purchaseRate",gst_rate_bp AS "gstRateBp",
              sales_account_id AS "salesAccountId",purchase_account_id AS "purchaseAccountId",track_stock AS "trackStock" FROM items WHERE active ORDER BY name`)).rows
      .map((r) => num(r, 'id', 'saleRate', 'purchaseRate', 'salesAccountId', 'purchaseAccountId')));
  }

  @Post('items')
  async addItem(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'post');
    const b = parse(z.object({
      code: z.string().min(1).max(40), name: z.string().min(1).max(200), kind: z.enum(['goods', 'service']),
      hsnSac: z.string().regex(/^\d{4,8}$/, 'HSN/SAC must be 4-8 digits').optional(), saleRate: z.number().int().min(0).default(0), purchaseRate: z.number().int().min(0).default(0),
      gstRateBp: z.number().int().min(0).max(5000).default(1800), salesAccountId: z.number().int().positive().optional(), purchaseAccountId: z.number().int().positive().optional(),
      trackStock: z.boolean().default(false),
    }), body);
    if (b.trackStock && b.kind !== 'goods') throw new BadRequestException('Only goods can have stock tracked');
    return withOrg(orgId, async (c) => {
      if ((await c.query('SELECT 1 FROM items WHERE code=$1', [b.code])).rowCount) throw new ConflictException(`Item code ${b.code} already exists`);
      if (!(await c.query('SELECT 1 FROM gst_rates WHERE rate_bp=$1 AND valid_to IS NULL', [b.gstRateBp])).rowCount) throw new BadRequestException('Not a configured GST rate');
      const r = (await c.query('INSERT INTO items(org_id,code,name,kind,hsn_sac,sale_rate,purchase_rate,gst_rate_bp,sales_account_id,purchase_account_id,track_stock) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id',
        [orgId, b.code, b.name, b.kind, b.hsnSac ?? null, b.saleRate, b.purchaseRate, b.gstRateBp, b.salesAccountId ?? null, b.purchaseAccountId ?? null, b.trackStock])).rows[0];
      await writeAudit(c, { orgId, userId: uid, action: 'create', entity: 'item', entityId: r.id, after: b, ip });
      return { id: Number(r.id) };
    });
  }

  @Post('items/:id/archive')
  async archiveItem(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number) {
    await requireOrg(uid, orgId, 'post');
    return withOrg(orgId, async (c) => { await c.query('UPDATE items SET active=false WHERE id=$1', [id]); return { ok: true }; });
  }

  // ---------- quotes and purchase orders ----------
  @Get('pre-documents')
  async preDocs(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Query('kind') kind?: string) {
    await requireOrg(uid, orgId, 'read');
    return withOrg(orgId, async (c) => (await c.query(
      `SELECT p.id,p.kind,p.number,p.contact_id AS "contactId",ct.name AS "contactName",p.issue_date AS "issueDate",p.expiry_date AS "expiryDate",p.status,p.subtotal,p.tax,p.total,p.converted_doc_id AS "convertedDocId"
         FROM pre_documents p JOIN contacts ct ON ct.id=p.contact_id WHERE ($1::text IS NULL OR p.kind=$1) ORDER BY p.id DESC`, [kind ?? null])).rows
      .map((r) => num(r, 'id', 'contactId', 'subtotal', 'tax', 'total', 'convertedDocId')));
  }

  @Post('pre-documents')
  async addPreDoc(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'post');
    const b = parse(z.object({ kind: z.enum(['quote', 'purchase_order']), contactId: z.number().int().positive(), issueDate: date, expiryDate: date.optional(), notes: z.string().max(500).optional(), lines: z.array(lineSchema).min(1).max(200) }), body);
    return withOrg(orgId, async (c) => {
      const { t } = await priceLines(c, orgId, b.kind === 'quote', b.contactId, b.issueDate, b.lines);
      const seq = (await c.query(`INSERT INTO doc_sequences(org_id,doc_type,fy_label,next_no) VALUES ($1,$2,'-',2)
        ON CONFLICT (org_id,doc_type,fy_label) DO UPDATE SET next_no = doc_sequences.next_no + 1 RETURNING next_no - 1 AS n`, [orgId, b.kind])).rows[0];
      const number = `${PRE[b.kind].prefix}-${String(seq.n).padStart(4, '0')}`;
      const r = (await c.query('INSERT INTO pre_documents(org_id,kind,number,contact_id,issue_date,expiry_date,lines,subtotal,tax,total,notes,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id',
        [orgId, b.kind, number, b.contactId, b.issueDate, b.expiryDate ?? null, JSON.stringify(b.lines), t.subtotal, t.total - t.subtotal, t.total, b.notes ?? null, uid])).rows[0];
      await writeAudit(c, { orgId, userId: uid, action: 'create', entity: b.kind, entityId: r.id, after: { number, total: t.total }, ip });
      return { id: Number(r.id), number, total: t.total };
    });
  }

  @Post('pre-documents/:id/status')
  async preStatus(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number, @Body() body: unknown) {
    await requireOrg(uid, orgId, 'post');
    const b = parse(z.object({ status: z.enum(['sent', 'accepted', 'declined']) }), body);
    return withOrg(orgId, async (c) => {
      const r = await c.query("UPDATE pre_documents SET status=$2 WHERE id=$1 AND status NOT IN ('converted') RETURNING id", [id, b.status]);
      if (!r.rowCount) throw new ConflictException('Not found, or already converted');
      return { ok: true };
    });
  }

  /** Turn an accepted quote into an invoice, or a purchase order into a bill. This is where the ledger is touched. */
  @Post('pre-documents/:id/convert')
  async convert(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'post');
    const b = parse(z.object({ issueDate: date.default(today()), dueDate: date.optional() }), body ?? {});
    return withOrg(orgId, async (c) => {
      const p = (await c.query('SELECT * FROM pre_documents WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!p) throw new NotFoundException('Not found');
      if (p.status === 'converted') throw new ConflictException('Already converted');
      if (p.status === 'declined') throw new ConflictException('A declined document cannot be converted');
      const spec = PRE[p.kind as keyof typeof PRE];
      const doc = await createDocument(c, orgId, uid, { docType: spec.docType, contactId: Number(p.contact_id), issueDate: b.issueDate, dueDate: b.dueDate, lines: p.lines, supplierRef: p.kind === 'purchase_order' ? p.number : undefined, notes: p.notes ?? undefined } as any, ip);
      await c.query("UPDATE pre_documents SET status='converted', converted_doc_id=$2 WHERE id=$1", [id, doc.id]);
      await writeAudit(c, { orgId, userId: uid, action: 'convert', entity: p.kind, entityId: id, after: { documentId: doc.id, number: doc.number }, ip });
      return { documentId: doc.id, number: doc.number };
    });
  }

  // ---------- repeating invoices ----------
  @Get('recurring')
  async recurring(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number) {
    await requireOrg(uid, orgId, 'read');
    return withOrg(orgId, async (c) => (await c.query(
      `SELECT r.id,ct.name AS "contactName",r.frequency,r.next_date AS "nextDate",r.end_date AS "endDate",r.auto_email AS "autoEmail",r.active
         FROM recurring_invoices r JOIN contacts ct ON ct.id=r.contact_id ORDER BY r.id DESC`)).rows.map((r) => num(r, 'id')));
  }

  @Post('recurring')
  async addRecurring(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'post');
    const b = parse(z.object({ contactId: z.number().int().positive(), frequency: z.enum(['weekly', 'monthly', 'quarterly', 'yearly']), nextDate: date, endDate: date.optional(),
      dueDays: z.number().int().min(0).max(120).default(15), autoEmail: z.boolean().default(false), lines: z.array(lineSchema).min(1).max(50) }), body);
    return withOrg(orgId, async (c) => {
      await priceLines(c, orgId, true, b.contactId, b.nextDate, b.lines); // validate now so the schedule cannot fail later for bad data
      const r = (await c.query('INSERT INTO recurring_invoices(org_id,contact_id,lines,frequency,next_date,end_date,due_days,auto_email,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
        [orgId, b.contactId, JSON.stringify(b.lines), b.frequency, b.nextDate, b.endDate ?? null, b.dueDays, b.autoEmail, uid])).rows[0];
      await writeAudit(c, { orgId, userId: uid, action: 'create', entity: 'recurring_invoice', entityId: r.id, after: { ...b, lines: b.lines.length }, ip });
      return { id: Number(r.id) };
    });
  }

  @Post('recurring/:id/stop')
  async stopRecurring(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number) {
    await requireOrg(uid, orgId, 'post');
    return withOrg(orgId, async (c) => { await c.query('UPDATE recurring_invoices SET active=false WHERE id=$1', [id]); return { ok: true }; });
  }

  // ---------- email an invoice, payment reminders ----------
  @Post('documents/:id/send')
  async send(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'post');
    const b = parse(z.object({ to: z.string().email().optional(), message: z.string().max(1000).optional() }), body ?? {});
    const r = await withOrg(orgId, async (c) => {
      const x = await buildInvoicePdf(c, orgId, id);
      if (!x) throw new NotFoundException('Document not found');
      const to = b.to ?? x.contactEmail;
      if (!to) throw new BadRequestException('This contact has no email address. Enter one to send to.');
      await c.query('UPDATE documents SET sent_at=now() WHERE id=$1', [id]);
      await writeAudit(c, { orgId, userId: uid, action: 'email', entity: 'document', entityId: id, after: { to }, ip });
      return { x, to };
    });
    const org = (await getPool().query('SELECT name FROM organizations WHERE id=$1', [orgId])).rows[0];
    await queueMail({ orgId, to: r.to, subject: `${r.x.docType.replace('_', ' ')} ${r.x.number} from ${org.name}`, body: `${b.message ?? `Dear ${r.x.contactName},\n\nPlease find ${r.x.number} attached.`}\n\nRegards,\n${org.name}`,
      attachment: { name: `${r.x.number.replace(/\//g, '-')}.pdf`, mime: 'application/pdf', data: r.x.pdf } });
    return { queuedTo: r.to };
  }

  /** Email a polite reminder for every overdue sales invoice that has a contact email and was not reminded in the last 7 days. */
  @Post('documents/remind-overdue')
  async remindOverdue(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'post');
    const org = (await getPool().query('SELECT name FROM organizations WHERE id=$1', [orgId])).rows[0];
    const mails = await withOrg(orgId, async (c) => {
      const rows = (await c.query(
        `SELECT d.id, d.number, d.due_date, ct.name, ct.email,
                d.net_payable - COALESCE((SELECT SUM(amount) FROM payments p WHERE p.doc_id=d.id),0)
                              - COALESCE((SELECT SUM(total) FROM documents x WHERE x.original_doc_id=d.id AND x.status='posted'),0) AS outstanding
           FROM documents d JOIN contacts ct ON ct.id=d.contact_id
          WHERE d.doc_type='invoice' AND d.status='posted' AND d.due_date < CURRENT_DATE AND ct.email IS NOT NULL
            AND (d.reminder_sent_at IS NULL OR d.reminder_sent_at < now() - interval '7 days')`)).rows.filter((r) => Number(r.outstanding) > 0);
      if (rows.length) await c.query('UPDATE documents SET reminder_sent_at=now() WHERE id = ANY($1)', [rows.map((r) => r.id)]);
      await writeAudit(c, { orgId, userId: uid, action: 'remind_overdue', entity: 'document', after: { count: rows.length }, ip });
      return rows;
    });
    for (const m of mails) {
      await queueMail({ orgId, to: m.email, subject: `Reminder: invoice ${m.number} is overdue`, body: `Dear ${m.name},\n\nInvoice ${m.number} (due ${m.due_date}) has Rs ${formatPaise(Number(m.outstanding))} outstanding. Please arrange payment.\n\nRegards,\n${org.name}` });
    }
    return { reminders: mails.length };
  }

  // ---------- bank rules ----------
  @Get('bank-rules')
  async rules(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number) {
    await requireOrg(uid, orgId, 'read');
    return withOrg(orgId, async (c) => (await c.query(
      'SELECT r.id,r.name,r.match_text AS "matchText",r.direction,r.account_id AS "accountId",a.name AS "accountName" FROM bank_rules r JOIN accounts a ON a.id=r.account_id WHERE r.active ORDER BY r.id')).rows.map((r) => num(r, 'id', 'accountId')));
  }

  @Post('bank-rules')
  async addRule(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'manage');
    const b = parse(z.object({ name: z.string().min(1).max(100), matchText: z.string().min(2).max(100), direction: z.enum(['in', 'out', 'any']).default('any'), accountId: z.number().int().positive() }), body);
    return withOrg(orgId, async (c) => {
      if (!(await c.query('SELECT 1 FROM accounts WHERE id=$1 AND is_active', [b.accountId])).rowCount) throw new BadRequestException('Account not found');
      const r = (await c.query('INSERT INTO bank_rules(org_id,name,match_text,direction,account_id) VALUES ($1,$2,$3,$4,$5) RETURNING id', [orgId, b.name, b.matchText, b.direction, b.accountId])).rows[0];
      // Apply to lines already waiting for reconciliation.
      const open = (await c.query("SELECT id,description,amount FROM bank_transactions WHERE status='unreconciled' AND rule_account_id IS NULL")).rows;
      for (const t of open) if (matchRule([{ matchText: b.matchText, direction: b.direction, accountId: b.accountId }], t.description, Number(t.amount))) await c.query('UPDATE bank_transactions SET rule_account_id=$2 WHERE id=$1', [t.id, b.accountId]);
      await writeAudit(c, { orgId, userId: uid, action: 'create', entity: 'bank_rule', entityId: r.id, after: b, ip });
      return { id: Number(r.id) };
    });
  }

  @Post('bank-rules/:id/delete')
  async deleteRule(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number) {
    await requireOrg(uid, orgId, 'manage');
    return withOrg(orgId, async (c) => { await c.query('UPDATE bank_rules SET active=false WHERE id=$1', [id]); return { ok: true }; });
  }

  /** Post and reconcile every unreconciled bank line that a rule has already classified. */
  @Post('bank-accounts/:id/accept-rules')
  async acceptRules(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'post');
    return withOrg(orgId, async (c) => {
      const ba = (await c.query('SELECT account_id FROM bank_accounts WHERE id=$1', [id])).rows[0];
      if (!ba) throw new NotFoundException('Bank account not found');
      const txns = (await c.query("SELECT id,txn_date::text AS d,description,amount,reference,rule_account_id FROM bank_transactions WHERE bank_account_id=$1 AND status='unreconciled' AND rule_account_id IS NOT NULL ORDER BY txn_date,id FOR UPDATE", [id])).rows;
      for (const t of txns) {
        const amt = Number(t.amount), abs = Math.abs(amt), bank = Number(ba.account_id), other = Number(t.rule_account_id);
        const lines = amt > 0 ? [{ accountId: bank, debit: abs, credit: 0 }, { accountId: other, debit: 0, credit: abs }] : [{ accountId: other, debit: abs, credit: 0 }, { accountId: bank, debit: 0, credit: abs }];
        const eid = await insertEntry(c, orgId, uid, t.d, t.description, t.reference, null, lines);
        await c.query("UPDATE bank_transactions SET status='reconciled', matched_entry_id=$2 WHERE id=$1", [t.id, eid]);
      }
      await writeAudit(c, { orgId, userId: uid, action: 'accept_rules', entity: 'bank_account', entityId: id, after: { count: txns.length }, ip });
      return { reconciled: txns.length };
    });
  }

  // ---------- fixed assets ----------
  @Get('fixed-assets')
  async assets(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number) {
    await requireOrg(uid, orgId, 'read');
    return withOrg(orgId, async (c) => (await c.query(
      `SELECT a.id,a.name,a.purchase_date AS "purchaseDate",a.cost,a.residual,a.method,a.rate_bp AS "rateBp",a.status,
              COALESCE((SELECT SUM(amount) FROM asset_depreciation d WHERE d.asset_id=a.id),0) AS accumulated
         FROM fixed_assets a ORDER BY a.purchase_date, a.id`)).rows.map((r) => { num(r, 'id', 'cost', 'residual', 'rateBp', 'accumulated'); return { ...r, bookValue: r.cost - r.accumulated }; }));
  }

  @Post('fixed-assets')
  async addAsset(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'manage');
    const b = parse(z.object({ name: z.string().min(1).max(200), purchaseDate: date, cost: z.number().int().positive(), residual: z.number().int().min(0).default(0),
      method: z.enum(['slm', 'wdv']), rateBp: z.number().int().min(1).max(10000) }), body);
    if (b.residual >= b.cost) throw new BadRequestException('Residual value must be less than cost');
    return withOrg(orgId, async (c) => {
      const r = (await c.query('INSERT INTO fixed_assets(org_id,name,purchase_date,cost,residual,method,rate_bp,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
        [orgId, b.name, b.purchaseDate, b.cost, b.residual, b.method, b.rateBp, uid])).rows[0];
      await writeAudit(c, { orgId, userId: uid, action: 'create', entity: 'fixed_asset', entityId: r.id, after: b, ip });
      return { id: Number(r.id) };
    });
  }

  /** Post monthly depreciation (Dr Depreciation, Cr Accumulated Depreciation) for every month end up to `through`. Safe to repeat. */
  @Post('fixed-assets/run-depreciation')
  async runDepreciation(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'manage');
    const b = parse(z.object({ through: date }), body);
    return withOrg(orgId, async (c) => {
      const expense = await accountIdByCode(c, '5580'), accum = await accountIdByCode(c, '1690');
      const assets = (await c.query("SELECT * FROM fixed_assets WHERE status='active' ORDER BY id")).rows;
      let posted = 0, total = 0;
      for (const a of assets) {
        let acc = Number((await c.query('SELECT COALESCE(SUM(amount),0) AS s FROM asset_depreciation WHERE asset_id=$1', [a.id])).rows[0].s);
        const done = new Set((await c.query('SELECT period_end::text AS p FROM asset_depreciation WHERE asset_id=$1', [a.id])).rows.map((r) => r.p));
        for (const end of monthEnds(a.purchase_date, b.through)) {
          if (done.has(end)) continue;
          const amount = monthlyDepreciation({ cost: Number(a.cost), residual: Number(a.residual), method: a.method, rateBp: a.rate_bp, purchaseDate: a.purchase_date, accumulated: acc });
          if (amount <= 0) break;
          const eid = await insertEntry(c, orgId, uid, end, `Depreciation ${a.name} to ${end}`, `DEP-${a.id}`, null,
            [{ accountId: expense, debit: amount, credit: 0 }, { accountId: accum, debit: 0, credit: amount }]);
          await c.query('INSERT INTO asset_depreciation(org_id,asset_id,period_end,amount,entry_id) VALUES ($1,$2,$3,$4,$5)', [orgId, a.id, end, amount, eid]);
          acc += amount; posted++; total += amount;
        }
      }
      await writeAudit(c, { orgId, userId: uid, action: 'run_depreciation', entity: 'fixed_asset', after: { through: b.through, posted, total }, ip });
      return { entriesPosted: posted, totalDepreciation: total };
    });
  }

  @Post('fixed-assets/:id/dispose')
  async dispose(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'manage');
    const b = parse(z.object({ date }), body);
    return withOrg(orgId, async (c) => {
      const r = await c.query("UPDATE fixed_assets SET status='disposed', disposed_on=$2 WHERE id=$1 AND status='active' RETURNING id", [id, b.date]);
      if (!r.rowCount) throw new NotFoundException('Active asset not found');
      await writeAudit(c, { orgId, userId: uid, action: 'dispose', entity: 'fixed_asset', entityId: id, after: b, ip });
      return { ok: true, note: 'Depreciation stops. Post the sale proceeds and any gain or loss with a journal entry.' };
    });
  }

  // ---------- contact statement ----------
  @Get('contacts/:id/statement')
  async statement(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number, @Query('from') from?: string, @Query('to') to?: string) {
    await requireOrg(uid, orgId, 'read');
    for (const v of [from, to]) if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new BadRequestException('Dates must be YYYY-MM-DD');
    return withOrg(orgId, async (c) => {
      const ct = (await c.query('SELECT id,name,kind,gstin FROM contacts WHERE id=$1', [id])).rows[0];
      if (!ct) throw new NotFoundException('Contact not found');
      // Positive = they owe us (customer) / we owe them (supplier). Payments and credit/debit notes reduce it.
      const rows = (await c.query(
        `SELECT * FROM (
           SELECT d.issue_date AS date, d.number AS ref, d.doc_type AS type,
                  CASE d.doc_type WHEN 'invoice' THEN d.total WHEN 'bill' THEN d.net_payable ELSE -d.total END AS amount, d.id AS sort_id
             FROM documents d WHERE d.contact_id=$1 AND d.status='posted'
           UNION ALL
           SELECT p.pay_date, 'Payment ' || d.number, 'payment', -p.amount, p.id + 1000000000
             FROM payments p JOIN documents d ON d.id=p.doc_id WHERE d.contact_id=$1 AND d.status='posted') x
         ORDER BY date, sort_id`, [id])).rows;
      let running = 0, opening = 0;
      const lines: { date: string; ref: string; type: string; amount: number; balance: number }[] = [];
      for (const r of rows) {
        const amt = Number(r.amount);
        if (from && r.date < from) { opening += amt; running += amt; continue; }
        if (to && r.date > to) continue;
        running += amt;
        lines.push({ date: r.date, ref: r.ref, type: r.type, amount: amt, balance: running });
      }
      return { contact: num(ct, 'id'), openingBalance: opening, lines, closingBalance: running };
    });
  }

  // ---------- dashboard and cash flow ----------
  @Get('dashboard')
  async dashboard(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number) {
    await requireOrg(uid, orgId, 'read');
    return withOrg(orgId, async (c) => {
      const t = today(), fy = financialYearOf(t);
      const banks = (await c.query(
        `SELECT b.id,b.name,COALESCE((SELECT SUM(debit-credit) FROM journal_lines WHERE account_id=b.account_id),0) AS balance,
                (SELECT COUNT(*) FROM bank_transactions x WHERE x.bank_account_id=b.id AND x.status='unreconciled') AS unreconciled FROM bank_accounts b ORDER BY b.name`)).rows.map((r) => num(r, 'id', 'balance', 'unreconciled'));
      const cash = Number((await c.query("SELECT COALESCE(SUM(l.debit-l.credit),0) AS s FROM journal_lines l JOIN accounts a ON a.id=l.account_id WHERE a.code='1000'")).rows[0].s);
      const ar = await aged(c, 'receivables', t), ap = await aged(c, 'payables', t);
      const months = (await c.query(
        `WITH m AS (SELECT to_char(date_trunc('month', CURRENT_DATE) - (n || ' month')::interval, 'YYYY-MM') AS ym FROM generate_series(0,5) n)
         SELECT m.ym,
                COALESCE(SUM(CASE WHEN a.type='income' THEN l.credit-l.debit END),0) AS income,
                COALESCE(SUM(CASE WHEN a.type='expense' THEN l.debit-l.credit END),0) AS expense,
                COALESCE(SUM(CASE WHEN a.id IN (SELECT account_id FROM bank_accounts) OR a.code='1000' THEN l.debit END),0) AS cash_in,
                COALESCE(SUM(CASE WHEN a.id IN (SELECT account_id FROM bank_accounts) OR a.code='1000' THEN l.credit END),0) AS cash_out
           FROM m LEFT JOIN journal_entries e ON to_char(e.entry_date,'YYYY-MM') = m.ym AND e.kind = 'normal'
                  LEFT JOIN journal_lines l ON l.entry_id=e.id LEFT JOIN accounts a ON a.id=l.account_id
          GROUP BY m.ym ORDER BY m.ym`)).rows.map((r) => ({ month: r.ym, income: Number(r.income), expense: Number(r.expense), cashIn: Number(r.cash_in), cashOut: Number(r.cash_out) }));
      const ytd = (await c.query(
        `SELECT COALESCE(SUM(CASE WHEN a.type='income' THEN l.credit-l.debit END),0) AS inc, COALESCE(SUM(CASE WHEN a.type='expense' THEN l.debit-l.credit END),0) AS exp
           FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id JOIN accounts a ON a.id=l.account_id WHERE e.entry_date BETWEEN $1 AND $2 AND e.kind = 'normal'`, [fy.start, fy.end])).rows[0];
      const tasks = (await c.query("SELECT count(*) FILTER (WHERE status='open')::int AS open, count(*) FILTER (WHERE status='open' AND due_date < CURRENT_DATE)::int AS overdue FROM tasks")).rows[0];
      return {
        banks, cashInHand: cash, totalCash: banks.reduce((s, b) => s + b.balance, 0) + cash,
        receivables: { total: ar.totals.total, overdue: ar.totals.total - ar.totals.notDue, top: ar.contacts.sort((a: any, b: any) => b.total - a.total).slice(0, 5).map((x: any) => ({ contact: x.contact, total: x.total })) },
        payables: { total: ap.totals.total, overdue: ap.totals.total - ap.totals.notDue },
        months, ytd: { label: fy.label, income: Number(ytd.inc), expense: Number(ytd.exp), profit: Number(ytd.inc) - Number(ytd.exp) }, tasks,
      };
    });
  }

  /** Cash movement through bank and cash accounts by month, with opening and closing balances. */
  @Get('reports/cash-flow')
  async cashFlow(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Query('from') from?: string, @Query('to') to?: string) {
    await requireOrg(uid, orgId, 'read');
    const fy = financialYearOf(today());
    const f = from ?? fy.start, e = to ?? today();
    for (const v of [f, e]) if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new BadRequestException('Dates must be YYYY-MM-DD');
    return withOrg(orgId, async (c) => {
      const isCash = "(a.id IN (SELECT account_id FROM bank_accounts) OR a.code='1000')";
      const opening = Number((await c.query(`SELECT COALESCE(SUM(l.debit-l.credit),0) AS s FROM journal_lines l JOIN journal_entries en ON en.id=l.entry_id JOIN accounts a ON a.id=l.account_id WHERE ${isCash} AND en.entry_date < $1`, [f])).rows[0].s);
      const rows = (await c.query(
        `SELECT to_char(en.entry_date,'YYYY-MM') AS month, SUM(l.debit) AS cash_in, SUM(l.credit) AS cash_out
           FROM journal_lines l JOIN journal_entries en ON en.id=l.entry_id JOIN accounts a ON a.id=l.account_id
          WHERE ${isCash} AND en.entry_date BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 1`, [f, e])).rows;
      let bal = opening;
      const months = rows.map((r) => { const i = Number(r.cash_in), o = Number(r.cash_out); const open = bal; bal += i - o; return { month: r.month, opening: open, cashIn: i, cashOut: o, net: i - o, closing: bal }; });
      return { from: f, to: e, openingBalance: opening, months, closingBalance: bal, totalIn: months.reduce((s, m) => s + m.cashIn, 0), totalOut: months.reduce((s, m) => s + m.cashOut, 0) };
    });
  }
}

/** Worker job: create invoices for every repeating schedule that is due. Catches up at most 12 missed runs per schedule. */
export async function runRecurring(today = new Date().toISOString().slice(0, 10)) {
  const orgs = (await getPool().query('SELECT id FROM organizations')).rows;
  let created = 0;
  for (const o of orgs) {
    const orgId = Number(o.id);
    const due = await withOrg(orgId, async (c) => (await c.query('SELECT * FROM recurring_invoices WHERE active AND next_date <= $1::date ORDER BY id', [today])).rows);
    for (const r of due) {
      let next: string = r.next_date;
      const anchor = Number(String(r.next_date).slice(8, 10));
      for (let i = 0; i < 12 && next <= today && (!r.end_date || next <= r.end_date); i++) {
        const issue = next;
        const due_date = new Date(Date.parse(issue) + r.due_days * 86400000).toISOString().slice(0, 10);
        const made = await withOrg(orgId, async (c) => {
          const doc = await createDocument(c, orgId, Number(r.created_by), { docType: 'invoice', contactId: Number(r.contact_id), issueDate: issue, dueDate: due_date, lines: r.lines } as any, undefined, { recurringId: Number(r.id) });
          await c.query('UPDATE recurring_invoices SET last_doc_id=$2 WHERE id=$1', [r.id, doc.id]);
          return doc;
        }).catch(async (e) => {
          await withOrg(orgId, (c) => c.query('UPDATE recurring_invoices SET active=false WHERE id=$1', [r.id]));
          console.error(JSON.stringify({ level: 'error', msg: 'recurring invoice failed and was paused', id: r.id, error: (e as Error).message }));
          return null;
        });
        if (!made) break;
        created++;
        if (r.auto_email) {
          const sent = await withOrg(orgId, async (c) => buildInvoicePdf(c, orgId, made.id));
          if (sent?.contactEmail) {
            const org = (await getPool().query('SELECT name FROM organizations WHERE id=$1', [orgId])).rows[0];
            await queueMail({ orgId, to: sent.contactEmail, subject: `Invoice ${sent.number} from ${org.name}`, body: `Dear ${sent.contactName},\n\nPlease find invoice ${sent.number} attached.\n\nRegards,\n${org.name}`,
              attachment: { name: `${sent.number.replace(/\//g, '-')}.pdf`, mime: 'application/pdf', data: sent.pdf } });
            await withOrg(orgId, (c) => c.query('UPDATE documents SET sent_at=now() WHERE id=$1', [made.id]));
          }
        }
        next = nextDate(next, r.frequency, anchor);
        await withOrg(orgId, (c) => c.query('UPDATE recurring_invoices SET next_date=$2, active = ($3::date IS NULL OR $2::date <= $3::date) WHERE id=$1', [r.id, next, r.end_date]));
      }
    }
  }
  return { created };
}
