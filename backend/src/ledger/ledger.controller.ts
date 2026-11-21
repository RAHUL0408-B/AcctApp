import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, NotFoundException, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { PoolClient } from 'pg';
import { z } from 'zod';
import { getPool, withOrg } from '../db/db';
import { prefixFor } from '../settings/settings';
import { financialYearOf } from './ledger';
import { writeAudit } from '../audit/audit';
import { AuthGuard, Ip, UserId, parse } from '../common/guard';
import { requireAnyOrg, requireOrg } from '../tenancy/acl';
import { insertEntry } from './post';
import { naturalBalance, reverseLines, validateLines } from './ledger';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const postSchema = z.object({
  date, narration: z.string().min(1).max(500), reference: z.string().trim().max(100).optional(), voucherNo: z.string().trim().min(1).max(40).optional(),
  lines: z.array(z.object({
    accountId: z.number().int().positive(), debit: z.number().int().optional(),
    credit: z.number().int().optional(), memo: z.string().max(300).optional(), trackingOptionId: z.number().int().positive().optional(),
  })).min(2),
});

const jvNumber = (prefix: string, fyLabel: string, n: number) => `${prefix}/${fyLabel.replace('FY ', '').slice(2)}/${String(n).padStart(4, '0')}`;
/** The next journal voucher number (JV/26-27/0001) for a date, skipping numbers typed by hand. Does not use it up. */
export async function peekJournalNumber(c: PoolClient, orgId: number, on: string) {
  const fy = financialYearOf(on), prefix = await prefixFor(c, 'journal');
  let n = Number((await c.query("SELECT next_no FROM doc_sequences WHERE org_id=$1 AND doc_type='journal' AND fy_label=$2", [orgId, fy.label])).rows[0]?.next_no ?? 1);
  while ((await c.query('SELECT 1 FROM journal_entries WHERE lower(voucher_no)=lower($1)', [jvNumber(prefix, fy.label, n)])).rowCount) n++;
  return jvNumber(prefix, fy.label, n);
}
/** Take the next voucher number, or check a typed one is free. */
export async function voucherFor(c: PoolClient, orgId: number, on: string, typed?: string) {
  if (typed) {
    if ((await c.query('SELECT 1 FROM journal_entries WHERE lower(voucher_no)=lower($1)', [typed])).rowCount) throw new ConflictException(`Voucher ${typed} is already used. Choose another number.`);
    return typed;
  }
  const fy = financialYearOf(on), prefix = await prefixFor(c, 'journal');
  for (;;) {
    const n = Number((await c.query(`INSERT INTO doc_sequences(org_id,doc_type,fy_label,next_no) VALUES ($1,'journal',$2,2)
      ON CONFLICT (org_id,doc_type,fy_label) DO UPDATE SET next_no = doc_sequences.next_no + 1 RETURNING next_no - 1 AS n`, [orgId, fy.label])).rows[0].n);
    const v = jvNumber(prefix, fy.label, n);
    if (!(await c.query('SELECT 1 FROM journal_entries WHERE lower(voucher_no)=lower($1)', [v])).rowCount) return v;
  }
}
type PostBody = z.infer<typeof postSchema>;
/** Validate and post a manual journal with its voucher number. */
async function postJournal(c: PoolClient, orgId: number, uid: number, b: PostBody, ip?: string) {
  const lines = validateLines(b.lines);
  const ids = [...new Set(lines.map((l) => l.accountId))];
  const found = await c.query('SELECT id FROM accounts WHERE id = ANY($1) AND is_active', [ids]);
  if (found.rowCount !== ids.length) throw new BadRequestException('One or more accounts do not exist or are archived');
  const opts = [...new Set(lines.map((l) => l.trackingOptionId).filter((x): x is number => !!x))];
  if (opts.length && (await c.query('SELECT id FROM tracking_options WHERE id = ANY($1) AND active', [opts])).rowCount !== opts.length) throw new BadRequestException('Unknown or archived tracking option');
  const voucher = await voucherFor(c, orgId, b.date, b.voucherNo);
  const id = await insertEntry(c, orgId, uid, b.date, b.narration, b.reference || null, null, lines, 'normal', voucher);
  await writeAudit(c, { orgId, userId: uid, action: 'post', entity: 'journal_entry', entityId: id, after: { ...b, voucherNo: voucher }, ip });
  return { id, voucherNo: voucher };
}
const approvalNeeded = async (orgId: number) => !!(await getPool().query('SELECT require_approval FROM organizations WHERE id=$1', [orgId])).rows[0]?.require_approval;

@Controller('orgs/:orgId')
@UseGuards(AuthGuard)
export class LedgerController {
  /** The voucher number the next journal will get. */
  @Get('journal-next-number')
  async nextJv(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Query('date') on?: string) {
    await requireOrg(uid, orgId, 'read');
    const d = on && /^\d{4}-\d{2}-\d{2}$/.test(on) ? on : new Date().toISOString().slice(0, 10);
    return withOrg(orgId, async (c) => ({ number: await peekJournalNumber(c, orgId, d) }));
  }

  // ---------- journals sent for an accountant's review ----------
  /** Staff send a journal for review; nothing reaches the books until an owner or accountant approves it. */
  @Post('journal-drafts')
  async submitJournal(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'post');
    const b = parse(postSchema, body);
    const lines = validateLines(b.lines);
    const total = lines.reduce((s, l) => s + l.debit, 0);
    return withOrg(orgId, async (c) => {
      if (b.voucherNo && (await c.query('SELECT 1 FROM journal_entries WHERE lower(voucher_no)=lower($1)', [b.voucherNo])).rowCount) throw new ConflictException(`Voucher ${b.voucherNo} is already used`);
      const r = (await c.query('INSERT INTO journal_drafts(org_id,entry_date,narration,reference,voucher_no,lines,total,submitted_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
        [orgId, b.date, b.narration, b.reference || null, b.voucherNo ?? null, JSON.stringify(b.lines), total, uid])).rows[0];
      await writeAudit(c, { orgId, userId: uid, action: 'submit', entity: 'journal_draft', entityId: r.id, after: { total }, ip });
      return { id: Number(r.id), total, status: 'submitted' };
    });
  }

  @Get('journal-drafts')
  async journalDrafts(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Query('status') status?: string) {
    await requireOrg(uid, orgId, 'read');
    return withOrg(orgId, async (c) => (await c.query(
      `SELECT d.id, d.entry_date::text AS date, d.narration, d.reference, d.voucher_no AS "voucherNo", d.lines, d.total, d.status, d.reason,
              u.full_name AS "submittedBy", d.created_at AS "submittedAt", e.voucher_no AS "postedVoucher"
         FROM journal_drafts d JOIN users u ON u.id=d.submitted_by LEFT JOIN journal_entries e ON e.id=d.posted_entry_id
        WHERE ($1::text IS NULL OR d.status=$1) ORDER BY d.id DESC`, [status ?? null])).rows.map((r) => ({ ...r, id: Number(r.id), total: Number(r.total) })));
  }

  @Post('journal-drafts/:id/approve')
  async approveJournal(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'manage');
    return withOrg(orgId, async (c) => {
      const d = (await c.query('SELECT * FROM journal_drafts WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!d) throw new NotFoundException('Not found');
      if (d.status !== 'submitted') throw new ConflictException(`Already ${d.status}`);
      const r = await postJournal(c, orgId, uid, { date: d.entry_date instanceof Date ? new Date(d.entry_date.getTime() - d.entry_date.getTimezoneOffset() * 60000).toISOString().slice(0, 10) : String(d.entry_date).slice(0, 10),
        narration: d.narration, reference: d.reference ?? undefined, voucherNo: d.voucher_no ?? undefined, lines: d.lines }, ip);
      await c.query("UPDATE journal_drafts SET status='approved', decided_by=$2, decided_at=now(), posted_entry_id=$3 WHERE id=$1", [id, uid, r.id]);
      await writeAudit(c, { orgId, userId: uid, action: 'approve', entity: 'journal_draft', entityId: id, after: r, ip });
      return { status: 'approved', ...r };
    });
  }

  @Post('journal-drafts/:id/reject')
  async rejectJournal(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'manage');
    const b = parse(z.object({ reason: z.string().trim().min(1).max(300) }), body);
    return withOrg(orgId, async (c) => {
      const r = await c.query("UPDATE journal_drafts SET status='rejected', reason=$2, decided_by=$3, decided_at=now() WHERE id=$1 AND status='submitted' RETURNING id", [id, b.reason, uid]);
      if (!r.rowCount) throw new ConflictException('Not waiting for review');
      await writeAudit(c, { orgId, userId: uid, action: 'reject', entity: 'journal_draft', entityId: id, after: b, ip });
      return { status: 'rejected' };
    });
  }

  @Post('journal')
  async post(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Body() body: unknown, @Ip() ip: string) {
    const role = await requireAnyOrg(uid, orgId, ['post']);
    const b = parse(postSchema, body);
    validateLines(b.lines);
    if (role === 'staff' && (await approvalNeeded(orgId))) throw new ForbiddenException('This organisation needs an accountant to review journals: send it for review instead');
    return withOrg(orgId, (c) => postJournal(c, orgId, uid, b, ip));
  }

  /** Reverse a posted entry by posting a mirror entry. The original is never touched. */
  @Post('journal/:id/reverse')
  async reverse(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'post');
    const b = parse(z.object({ date, reason: z.string().min(1).max(300) }), body);
    return withOrg(orgId, async (c) => {
      const orig = (await c.query('SELECT * FROM journal_entries WHERE id=$1', [id])).rows[0];
      if (!orig) throw new NotFoundException('Entry not found');
      if (orig.reverses_id) throw new BadRequestException('A reversal entry cannot itself be reversed; post a new entry instead');
      if ((await c.query('SELECT 1 FROM journal_entries WHERE reverses_id=$1', [id])).rowCount) throw new ConflictException('Entry is already reversed');
      const ls = (await c.query('SELECT account_id,debit,credit,memo,tracking_option_id FROM journal_lines WHERE entry_id=$1', [id])).rows
        .map((r) => ({ accountId: Number(r.account_id), debit: Number(r.debit), credit: Number(r.credit), memo: r.memo ?? undefined, trackingOptionId: r.tracking_option_id ? Number(r.tracking_option_id) : null }));
      const rid = await insertEntry(c, orgId, uid, b.date, `Reversal of #${id}: ${b.reason}`, orig.reference, id, reverseLines(ls), orig.kind);
      await writeAudit(c, { orgId, userId: uid, action: 'reverse', entity: 'journal_entry', entityId: id, after: { reversalId: rid, ...b }, ip });
      return { id: rid };
    });
  }

  @Get('journal')
  async list(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Query('limit') limit = '50', @Query('offset') offset = '0') {
    await requireOrg(uid, orgId, 'read');
    const lim = Math.min(Math.max(parseInt(limit) || 50, 1), 200), off = Math.max(parseInt(offset) || 0, 0);
    return withOrg(orgId, async (c) => {
      const entries = (await c.query(`SELECT e.id,e.entry_date::text AS date,e.narration,e.reference,e.reverses_id,e.voucher_no,u.full_name AS created_by,
          EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_id=e.id) AS reversed
        FROM journal_entries e LEFT JOIN users u ON u.id=e.created_by ORDER BY e.entry_date DESC, e.id DESC LIMIT $1 OFFSET $2`, [lim, off])).rows;
      const lines = entries.length
        ? (await c.query('SELECT entry_id,account_id,debit,credit,memo FROM journal_lines WHERE entry_id = ANY($1) ORDER BY id', [entries.map((e) => e.id)])).rows
        : [];
      return entries.map((e) => ({
        id: Number(e.id), date: e.date, narration: e.narration, reference: e.reference, reversesId: e.reverses_id ? Number(e.reverses_id) : null,
        voucherNo: e.voucher_no, createdBy: e.created_by, reversed: !!e.reversed,
        lines: lines.filter((l) => l.entry_id === e.id).map((l) => ({ accountId: Number(l.account_id), debit: Number(l.debit), credit: Number(l.credit), memo: l.memo })),
      }));
    });
  }

  @Get('trial-balance')
  async trialBalance(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Query('asOf') asOf?: string) {
    await requireOrg(uid, orgId, 'read');
    if (asOf && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new BadRequestException('asOf must be YYYY-MM-DD');
    return withOrg(orgId, async (c) => {
      const rows = (await c.query(
        `SELECT a.id,a.code,a.name,a.type,COALESCE(SUM(l.debit),0) AS debit,COALESCE(SUM(l.credit),0) AS credit
           FROM accounts a LEFT JOIN (SELECT jl.* FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
                                      WHERE $1::date IS NULL OR je.entry_date <= $1::date) l ON l.account_id=a.id
          GROUP BY a.id ORDER BY a.code`, [asOf ?? null])).rows;
      const accounts = rows.filter((r) => Number(r.debit) || Number(r.credit)).map((r) => {
        const d = Number(r.debit), cr = Number(r.credit), net = d - cr;
        return { id: Number(r.id), code: r.code, name: r.name, type: r.type,
          balance: naturalBalance(r.type, d, cr), debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 };
      });
      const totalDebit = accounts.reduce((s, a) => s + a.debit, 0), totalCredit = accounts.reduce((s, a) => s + a.credit, 0);
      return { accounts, totalDebit, totalCredit, balanced: totalDebit === totalCredit };
    });
  }

  @Get('audit')
  async audit(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Query('limit') limit = '100') {
    await requireOrg(uid, orgId, 'manage');
    const lim = Math.min(Math.max(parseInt(limit) || 100, 1), 500);
    return withOrg(orgId, async (c) =>
      (await c.query('SELECT id,user_id,action,entity,entity_id,before_data,after_data,ip,created_at FROM audit_log ORDER BY id DESC LIMIT $1', [lim])).rows);
  }
}
