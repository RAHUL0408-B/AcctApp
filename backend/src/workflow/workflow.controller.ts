// Approval workflows: invoices and bills submitted for approval, and employee expense claims.
import { BadRequestException, Body, ConflictException, Controller, Get, NotFoundException, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { withOrg } from '../db/db';
import { writeAudit } from '../audit/audit';
import { AuthGuard, Ip, UserId, parse } from '../common/guard';
import { requireOrg } from '../tenancy/acl';
import { ensureAccount, insertEntry } from '../ledger/post';
import { validateLines } from '../ledger/ledger';
import { createDocument, docSchema, priceLines } from '../accounting/documents.controller';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const reasonSchema = z.object({ reason: z.string().min(1).max(300) });

@Controller('orgs/:orgId')
@UseGuards(AuthGuard)
export class WorkflowController {
  // ---------- invoices and bills awaiting approval ----------
  /** Anyone who can post may submit; nothing reaches the ledger until an owner or accountant approves it. */
  @Post('drafts')
  async submit(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'post');
    const b = parse(docSchema, body);
    if (b.docType !== 'invoice' && b.docType !== 'bill') throw new BadRequestException('Only invoices and bills go through approval');
    return withOrg(orgId, async (c) => {
      const { t } = await priceLines(c, orgId, b.docType === 'invoice', b.contactId, b.issueDate, b.lines, b.placeOfSupply, b.supplyType); // validates now, not at approval
      const r = (await c.query('INSERT INTO document_drafts(org_id,doc_type,contact_id,payload,total,submitted_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [orgId, b.docType, b.contactId, JSON.stringify(b), t.total, uid])).rows[0];
      await writeAudit(c, { orgId, userId: uid, action: 'submit', entity: 'document_draft', entityId: r.id, after: { docType: b.docType, total: t.total }, ip });
      return { id: Number(r.id), total: t.total, status: 'submitted' };
    });
  }

  @Get('drafts')
  async drafts(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Query('status') status?: string) {
    await requireOrg(uid, orgId, 'read');
    return withOrg(orgId, async (c) => (await c.query(
      `SELECT d.id, d.doc_type AS "docType", d.total, d.status, d.reason, d.created_at AS "submittedAt", ct.name AS "contactName",
              u.full_name AS "submittedBy", doc.number AS "postedNumber", d.payload->>'issueDate' AS "issueDate"
         FROM document_drafts d JOIN contacts ct ON ct.id=d.contact_id JOIN users u ON u.id=d.submitted_by LEFT JOIN documents doc ON doc.id=d.posted_doc_id
        WHERE ($1::text IS NULL OR d.status=$1) ORDER BY d.id DESC`, [status ?? null])).rows.map((r) => ({ ...r, id: Number(r.id), total: Number(r.total) })));
  }

  @Post('drafts/:id/approve')
  async approve(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'manage');
    return withOrg(orgId, async (c) => {
      const d = (await c.query('SELECT * FROM document_drafts WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!d) throw new NotFoundException('Not found');
      if (d.status !== 'submitted') throw new ConflictException(`Already ${d.status}`);
      const doc = await createDocument(c, orgId, uid, parse(docSchema, d.payload), ip);
      await c.query("UPDATE document_drafts SET status='approved', decided_by=$2, decided_at=now(), posted_doc_id=$3 WHERE id=$1", [id, uid, doc.id]);
      await writeAudit(c, { orgId, userId: uid, action: 'approve', entity: 'document_draft', entityId: id, after: { number: doc.number }, ip });
      return { status: 'approved', documentId: doc.id, number: doc.number };
    });
  }

  @Post('drafts/:id/reject')
  async reject(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'manage');
    const b = parse(reasonSchema, body);
    return withOrg(orgId, async (c) => {
      const r = await c.query("UPDATE document_drafts SET status='rejected', decided_by=$2, decided_at=now(), reason=$3 WHERE id=$1 AND status='submitted'", [id, uid, b.reason]);
      if (!r.rowCount) throw new ConflictException('Only submitted items can be rejected');
      await writeAudit(c, { orgId, userId: uid, action: 'reject', entity: 'document_draft', entityId: id, after: b, ip });
      return { status: 'rejected' };
    });
  }

  // ---------- expense claims ----------
  /** An employee claims back money they spent. Each line goes to an expense account. */
  @Post('expense-claims')
  async claim(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'post');
    const b = parse(z.object({
      date, title: z.string().min(1).max(200),
      lines: z.array(z.object({ description: z.string().min(1).max(300), accountId: z.number().int().positive(), amount: z.number().int().positive() })).min(1).max(100),
    }), body);
    return withOrg(orgId, async (c) => {
      const ids = [...new Set(b.lines.map((l) => l.accountId))];
      const ok = (await c.query("SELECT id FROM accounts WHERE id = ANY($1) AND type='expense' AND is_active", [ids])).rowCount;
      if (ok !== ids.length) throw new BadRequestException('Every line needs an active expense account');
      const total = b.lines.reduce((s, l) => s + l.amount, 0);
      const r = (await c.query('INSERT INTO expense_claims(org_id,claimant_id,claim_date,title,lines,total) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [orgId, uid, b.date, b.title, JSON.stringify(b.lines), total])).rows[0];
      await writeAudit(c, { orgId, userId: uid, action: 'submit', entity: 'expense_claim', entityId: r.id, after: { title: b.title, total }, ip });
      return { id: Number(r.id), total, status: 'submitted' };
    });
  }

  @Get('expense-claims')
  async claims(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number) {
    await requireOrg(uid, orgId, 'read');
    return withOrg(orgId, async (c) => (await c.query(
      `SELECT e.id, e.claim_date::text AS date, e.title, e.lines, e.total, e.status, e.reason, u.full_name AS claimant
         FROM expense_claims e JOIN users u ON u.id=e.claimant_id ORDER BY e.id DESC`)).rows.map((r) => ({ ...r, id: Number(r.id), total: Number(r.total) })));
  }

  /** Approving books the expenses: Dr each expense / Cr Employee Reimbursements Payable. */
  @Post('expense-claims/:id/approve')
  async approveClaim(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'manage');
    return withOrg(orgId, async (c) => {
      const e = (await c.query('SELECT * FROM expense_claims WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!e) throw new NotFoundException('Not found');
      if (e.status !== 'submitted') throw new ConflictException(`Already ${e.status}`);
      const payable = await ensureAccount(c, orgId, '2310');
      const lines = validateLines([
        ...(e.lines as { description: string; accountId: number; amount: number }[]).map((l) => ({ accountId: l.accountId, debit: l.amount, memo: l.description })),
        { accountId: payable, credit: Number(e.total) },
      ]);
      const eid = await insertEntry(c, orgId, uid, e.claim_date, `Expense claim #${id}: ${e.title}`, `EC-${id}`, null, lines);
      await c.query("UPDATE expense_claims SET status='approved', decided_by=$2, approved_entry_id=$3 WHERE id=$1", [id, uid, eid]);
      await writeAudit(c, { orgId, userId: uid, action: 'approve', entity: 'expense_claim', entityId: id, ip });
      return { status: 'approved', journalEntryId: eid };
    });
  }

  @Post('expense-claims/:id/reject')
  async rejectClaim(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'manage');
    const b = parse(reasonSchema, body);
    return withOrg(orgId, async (c) => {
      const r = await c.query("UPDATE expense_claims SET status='rejected', decided_by=$2, reason=$3 WHERE id=$1 AND status='submitted'", [id, uid, b.reason]);
      if (!r.rowCount) throw new ConflictException('Only submitted claims can be rejected');
      await writeAudit(c, { orgId, userId: uid, action: 'reject', entity: 'expense_claim', entityId: id, after: b, ip });
      return { status: 'rejected' };
    });
  }

  /** Repay the employee: Dr Employee Reimbursements Payable / Cr bank. */
  @Post('expense-claims/:id/pay')
  async payClaim(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'post');
    const b = parse(z.object({ date, accountId: z.number().int().positive() }), body);
    return withOrg(orgId, async (c) => {
      const e = (await c.query('SELECT * FROM expense_claims WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!e) throw new NotFoundException('Not found');
      if (e.status !== 'approved') throw new ConflictException('Only approved claims can be paid');
      const bank = (await c.query('SELECT type FROM accounts WHERE id=$1 AND is_active', [b.accountId])).rows[0];
      if (!bank || bank.type !== 'asset') throw new BadRequestException('Pay from a cash or bank (asset) account');
      const payable = await ensureAccount(c, orgId, '2310');
      const eid = await insertEntry(c, orgId, uid, b.date, `Repaid expense claim #${id}: ${e.title}`, `EC-${id}`, null,
        validateLines([{ accountId: payable, debit: Number(e.total) }, { accountId: b.accountId, credit: Number(e.total) }]));
      await c.query("UPDATE expense_claims SET status='paid', paid_entry_id=$2 WHERE id=$1", [id, eid]);
      await writeAudit(c, { orgId, userId: uid, action: 'pay', entity: 'expense_claim', entityId: id, after: b, ip });
      return { status: 'paid', journalEntryId: eid };
    });
  }
}
