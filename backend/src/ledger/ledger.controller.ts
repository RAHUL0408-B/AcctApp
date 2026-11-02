import { BadRequestException, Body, ConflictException, Controller, Get, NotFoundException, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { withOrg } from '../db/db';
import { writeAudit } from '../audit/audit';
import { AuthGuard, Ip, UserId, parse } from '../common/guard';
import { requireOrg } from '../tenancy/acl';
import { insertEntry } from './post';
import { naturalBalance, reverseLines, validateLines } from './ledger';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const postSchema = z.object({
  date, narration: z.string().min(1).max(500), reference: z.string().max(100).optional(),
  lines: z.array(z.object({
    accountId: z.number().int().positive(), debit: z.number().int().optional(),
    credit: z.number().int().optional(), memo: z.string().max(300).optional(), trackingOptionId: z.number().int().positive().optional(),
  })).min(2),
});

@Controller('orgs/:orgId')
@UseGuards(AuthGuard)
export class LedgerController {
  @Post('journal')
  async post(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'post');
    const b = parse(postSchema, body);
    const lines = validateLines(b.lines);
    return withOrg(orgId, async (c) => {
      const ids = [...new Set(lines.map((l) => l.accountId))];
      const found = await c.query('SELECT id FROM accounts WHERE id = ANY($1) AND is_active', [ids]);
      if (found.rowCount !== ids.length) throw new BadRequestException('One or more accounts do not exist or are inactive');
      const opts = [...new Set(lines.map((l) => l.trackingOptionId).filter((x): x is number => !!x))];
      if (opts.length && (await c.query('SELECT id FROM tracking_options WHERE id = ANY($1) AND active', [opts])).rowCount !== opts.length) throw new BadRequestException('Unknown or archived tracking option');
      const id = await insertEntry(c, orgId, uid, b.date, b.narration, b.reference ?? null, null, lines);
      await writeAudit(c, { orgId, userId: uid, action: 'post', entity: 'journal_entry', entityId: id, after: b, ip });
      return { id };
    });
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
      const entries = (await c.query('SELECT id,entry_date::text AS date,narration,reference,reverses_id FROM journal_entries ORDER BY entry_date DESC, id DESC LIMIT $1 OFFSET $2', [lim, off])).rows;
      const lines = entries.length
        ? (await c.query('SELECT entry_id,account_id,debit,credit,memo FROM journal_lines WHERE entry_id = ANY($1) ORDER BY id', [entries.map((e) => e.id)])).rows
        : [];
      return entries.map((e) => ({
        id: Number(e.id), date: e.date, narration: e.narration, reference: e.reference, reversesId: e.reverses_id ? Number(e.reverses_id) : null,
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
