// Things that save typing: saved invoice/bill templates, journal rules that post themselves on a schedule, and bulk actions.
import { BadRequestException, Body, ConflictException, Controller, Delete, Get, NotFoundException, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { getPool, withOrg } from '../db/db';
import { writeAudit } from '../audit/audit';
import { AuthGuard, Ip, UserId, parse } from '../common/guard';
import { requireOrg } from '../tenancy/acl';
import { LedgerError, reverseLines, validateLines } from '../ledger/ledger';
import { insertEntry } from '../ledger/post';
import { nextDate } from '../extras/calc';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const lineSchema = z.object({ accountId: z.number().int().positive(), debit: z.number().int().min(0).default(0), credit: z.number().int().min(0).default(0), memo: z.string().max(200).optional(), trackingOptionId: z.number().int().positive().optional() });
const num = (r: any, ...ks: string[]) => { for (const k of ks) if (r[k] != null) r[k] = Number(r[k]); return r; };

@Controller('orgs/:orgId')
@UseGuards(AuthGuard)
export class AutomationController {
  // ---------- saved invoice and bill templates ----------
  @Get('doc-templates')
  async templates(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number) {
    await requireOrg(uid, orgId, 'read');
    return withOrg(orgId, async (c) => (await c.query('SELECT id,name,doc_type AS "docType",payload FROM doc_templates ORDER BY name')).rows.map((r) => num(r, 'id')));
  }

  /** Save what is on the form (contact, lines, terms, supply type) so the next invoice or bill can start from it. */
  @Post('doc-templates')
  async saveTemplate(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'post');
    const b = parse(z.object({ name: z.string().trim().min(1).max(80), docType: z.enum(['invoice', 'bill']), payload: z.object({
      contactId: z.number().int().positive().optional(), supplyType: z.string().optional(), notes: z.string().max(500).optional(), dueDays: z.number().int().min(0).max(365).optional(),
      tdsSection: z.string().optional(), lines: z.array(z.object({ description: z.string().max(300), hsnSac: z.string().optional(), quantity: z.number().positive(), rate: z.number().int().min(0),
        gstRateBp: z.number().int().min(0).max(5000), accountId: z.number().int().positive().optional(), itemId: z.number().int().positive().optional() })).min(1).max(200) }) }), body);
    return withOrg(orgId, async (c) => {
      const r = (await c.query(`INSERT INTO doc_templates(org_id,name,doc_type,payload,created_by) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (org_id,doc_type,name) DO UPDATE SET payload=EXCLUDED.payload RETURNING id`, [orgId, b.name, b.docType, b.payload, uid])).rows[0];
      await writeAudit(c, { orgId, userId: uid, action: 'save', entity: 'doc_template', entityId: r.id, after: { name: b.name, docType: b.docType }, ip });
      return { id: Number(r.id) };
    });
  }

  @Delete('doc-templates/:id')
  async deleteTemplate(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number) {
    await requireOrg(uid, orgId, 'post');
    return withOrg(orgId, async (c) => { if (!(await c.query('DELETE FROM doc_templates WHERE id=$1', [id])).rowCount) throw new NotFoundException('Template not found'); return { ok: true }; });
  }

  // ---------- journal rules ----------
  @Get('journal-rules')
  async rules(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number) {
    await requireOrg(uid, orgId, 'read');
    return withOrg(orgId, async (c) => (await c.query(`SELECT id,name,narration,lines,frequency,next_date::text AS "nextDate",end_date::text AS "endDate",active,runs,last_run::text AS "lastRun" FROM journal_rules ORDER BY active DESC, id DESC`)).rows.map((r) => num(r, 'id', 'runs')));
  }

  @Post('journal-rules')
  async addRule(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'post');
    const b = parse(z.object({ name: z.string().trim().min(1).max(80), narration: z.string().trim().min(1).max(300), lines: z.array(lineSchema).min(2).max(50),
      frequency: z.enum(['weekly', 'monthly', 'quarterly', 'yearly']), startDate: date, endDate: date.optional() }), body);
    if (b.endDate && b.endDate < b.startDate) throw new BadRequestException('The end date is before the start date');
    try { validateLines(b.lines); } catch (e) { if (e instanceof LedgerError) throw new BadRequestException(e.message); throw e; }
    return withOrg(orgId, async (c) => {
      const ids = [...new Set(b.lines.map((l) => l.accountId))];
      if ((await c.query('SELECT id FROM accounts WHERE id = ANY($1) AND is_active', [ids])).rowCount !== ids.length) throw new BadRequestException('Every line needs an active account');
      const centres = [...new Set(b.lines.map((l) => l.trackingOptionId).filter((x): x is number => !!x))];
      if (centres.length && (await c.query('SELECT id FROM tracking_options WHERE id = ANY($1) AND active', [centres])).rowCount !== centres.length) throw new BadRequestException('Unknown cost centre');
      const r = (await c.query('INSERT INTO journal_rules(org_id,name,narration,lines,frequency,next_date,end_date,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
        [orgId, b.name, b.narration, JSON.stringify(b.lines), b.frequency, b.startDate, b.endDate ?? null, uid])).rows[0];
      await writeAudit(c, { orgId, userId: uid, action: 'create', entity: 'journal_rule', entityId: r.id, after: { name: b.name, frequency: b.frequency }, ip });
      return { id: Number(r.id) };
    });
  }

  @Post('journal-rules/:id/stop')
  async stopRule(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'post');
    return withOrg(orgId, async (c) => {
      if (!(await c.query('UPDATE journal_rules SET active=false WHERE id=$1', [id])).rowCount) throw new NotFoundException('Rule not found');
      await writeAudit(c, { orgId, userId: uid, action: 'stop', entity: 'journal_rule', entityId: id, ip });
      return { ok: true };
    });
  }

  /** Post everything that is due now instead of waiting for the daily job. */
  @Post('journal-rules/run')
  async runNow(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number) {
    await requireOrg(uid, orgId, 'post');
    return { created: await runJournalRulesFor(orgId) };
  }

  // ---------- bulk actions ----------
  /** "Delete" several journal entries at once. Posted entries cannot be erased, so each is reversed with a mirror entry. */
  @Post('journal/bulk-reverse')
  async bulkReverse(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'post');
    const b = parse(z.object({ ids: z.array(z.number().int().positive()).min(1).max(200), date, reason: z.string().min(1).max(300).default('Deleted from the app') }), body);
    return withOrg(orgId, async (c) => {
      const reversed: number[] = [], failed: { id: number; reason: string }[] = [];
      for (const id of b.ids) {
        await c.query('SAVEPOINT one');
        try {
          const orig = (await c.query('SELECT * FROM journal_entries WHERE id=$1', [id])).rows[0];
          if (!orig) throw new NotFoundException('Entry not found');
          if (orig.reverses_id) throw new BadRequestException('This is already a reversal');
          if ((await c.query('SELECT 1 FROM journal_entries WHERE reverses_id=$1', [id])).rowCount) throw new ConflictException('Already reversed');
          if ((await c.query('SELECT 1 FROM documents WHERE journal_entry_id=$1', [id])).rowCount) throw new ConflictException('Belongs to an invoice or bill: cancel that document instead');
          if ((await c.query('SELECT 1 FROM payments WHERE journal_entry_id=$1', [id])).rowCount) throw new ConflictException('Belongs to a payment: unlink the payment instead');
          const ls = (await c.query('SELECT account_id,debit,credit,memo,tracking_option_id FROM journal_lines WHERE entry_id=$1', [id])).rows
            .map((r) => ({ accountId: Number(r.account_id), debit: Number(r.debit), credit: Number(r.credit), memo: r.memo ?? undefined, trackingOptionId: r.tracking_option_id ? Number(r.tracking_option_id) : null }));
          await insertEntry(c, orgId, uid, b.date, `Reversal of #${id}: ${b.reason}`, orig.reference, id, reverseLines(ls), orig.kind);
          await c.query('RELEASE SAVEPOINT one'); reversed.push(id);
        } catch (e: any) { await c.query('ROLLBACK TO SAVEPOINT one'); failed.push({ id, reason: e?.message ?? 'Could not be reversed' }); }
      }
      await writeAudit(c, { orgId, userId: uid, action: 'bulk_reverse', entity: 'journal_entry', after: { reversed: reversed.length, failed: failed.length }, ip });
      return { reversed, failed };
    });
  }

  /** Hide invoices or bills from the main list (or bring them back) without cancelling them. */
  @Post('documents/bulk-archive')
  async bulkArchive(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'post');
    const b = parse(z.object({ ids: z.array(z.number().int().positive()).min(1).max(500), archived: z.boolean().default(true) }), body);
    return withOrg(orgId, async (c) => {
      const n = (await c.query('UPDATE documents SET is_archived=$2 WHERE id = ANY($1)', [b.ids, b.archived])).rowCount ?? 0;
      await writeAudit(c, { orgId, userId: uid, action: b.archived ? 'archive' : 'unarchive', entity: 'document', after: { ids: b.ids }, ip });
      return { updated: n };
    });
  }
}

/** Post every due run of every active rule in one organisation. Catches up at most 24 missed runs per rule. */
export async function runJournalRulesFor(orgId: number, today = new Date().toISOString().slice(0, 10)) {
  let created = 0;
  const due = await withOrg(orgId, async (c) => (await c.query('SELECT * FROM journal_rules WHERE active AND next_date <= $1::date ORDER BY id', [today])).rows);
  for (const r of due) {
    let next: string = r.next_date;
    const anchor = Number(String(r.next_date).slice(8, 10));
    for (let i = 0; i < 24 && next <= today && (!r.end_date || next <= r.end_date); i++) {
      const on = next;
      const ok = await withOrg(orgId, async (c) => {
        await insertEntry(c, orgId, Number(r.created_by), on, r.narration, `RULE-${r.id}`, null, validateLines(r.lines));
        await c.query('UPDATE journal_rules SET last_run=$2, runs=runs+1 WHERE id=$1', [r.id, on]);
        return true;
      }).catch(async (e) => {
        await withOrg(orgId, (c) => c.query('UPDATE journal_rules SET active=false WHERE id=$1', [r.id]));
        console.error(JSON.stringify({ level: 'error', msg: 'journal rule failed and was paused', id: r.id, error: (e as Error).message }));
        return false;
      });
      if (!ok) break;
      created++;
      next = nextDate(next, r.frequency, anchor);
      await withOrg(orgId, (c) => c.query('UPDATE journal_rules SET next_date=$2, active = ($3::date IS NULL OR $2::date <= $3::date) WHERE id=$1', [r.id, next, r.end_date]));
    }
  }
  return created;
}

/** Worker job: run the due journal rules of every organisation. */
export async function runJournalRules(today = new Date().toISOString().slice(0, 10)) {
  let created = 0;
  for (const o of (await getPool().query('SELECT id FROM organizations')).rows) created += await runJournalRulesFor(Number(o.id), today);
  return { created };
}
