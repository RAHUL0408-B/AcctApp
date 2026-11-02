import { BadRequestException, Body, ConflictException, Controller, Get, NotFoundException, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { withOrg } from '../db/db';
import { writeAudit } from '../audit/audit';
import { AuthGuard, Ip, UserId, parse } from '../common/guard';
import { parseStatement } from '../common/csv';
import { requireOrg } from '../tenancy/acl';
import { insertEntry } from '../ledger/post';
import { matchRule } from '../extras/calc';

const num = (r: any, ...keys: string[]) => { for (const k of keys) if (r[k] != null) r[k] = Number(r[k]); return r; }; // null stays null

@Controller('orgs/:orgId')
@UseGuards(AuthGuard)
export class BankController {
  @Get('bank-accounts')
  async list(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number) {
    await requireOrg(uid, orgId, 'read');
    return withOrg(orgId, async (c) => (await c.query(
      `SELECT b.id, b.name, b.account_id AS "accountId", a.name AS "accountName",
              COALESCE((SELECT SUM(debit-credit) FROM journal_lines WHERE account_id=b.account_id),0) AS "bookBalance",
              COALESCE((SELECT SUM(amount) FROM bank_transactions WHERE bank_account_id=b.id),0) AS "statementTotal",
              (SELECT COUNT(*) FROM bank_transactions WHERE bank_account_id=b.id AND status='unreconciled') AS unreconciled
         FROM bank_accounts b JOIN accounts a ON a.id=b.account_id ORDER BY b.name`)).rows.map((r) => num(r, 'id', 'accountId', 'bookBalance', 'statementTotal', 'unreconciled')));
  }

  @Post('bank-accounts')
  async add(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'manage');
    const b = parse(z.object({ name: z.string().min(1).max(100), accountId: z.number().int().positive(), last4: z.string().length(4).optional() }), body);
    return withOrg(orgId, async (c) => {
      const a = (await c.query('SELECT type FROM accounts WHERE id=$1', [b.accountId])).rows[0];
      if (!a || a.type !== 'asset') throw new BadRequestException('Pick an asset account (e.g. 1010 Bank Account)');
      if ((await c.query('SELECT 1 FROM bank_accounts WHERE account_id=$1', [b.accountId])).rowCount) throw new ConflictException('That account is already a bank account');
      const r = (await c.query('INSERT INTO bank_accounts(org_id,name,account_id,account_no_last4) VALUES ($1,$2,$3,$4) RETURNING id', [orgId, b.name, b.accountId, b.last4 ?? null])).rows[0];
      await writeAudit(c, { orgId, userId: uid, action: 'create', entity: 'bank_account', entityId: r.id, after: b, ip });
      return { id: Number(r.id) };
    });
  }

  @Post('bank-accounts/:id/import')
  async importCsv(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'post');
    const b = parse(z.object({ csv: z.string().min(1).max(5_000_000) }), body);
    let rows;
    try { rows = parseStatement(b.csv); } catch (e) { throw new BadRequestException((e as Error).message); }
    return withOrg(orgId, async (c) => {
      if (!(await c.query('SELECT 1 FROM bank_accounts WHERE id=$1', [id])).rowCount) throw new NotFoundException('Bank account not found');
      let imported = 0;
      const rules = (await c.query('SELECT match_text AS "matchText", direction, account_id FROM bank_rules WHERE active ORDER BY id')).rows
        .map((x) => ({ matchText: x.matchText, direction: x.direction, accountId: Number(x.account_id) }));
      for (const r of rows) {
        const rule = matchRule(rules, r.description, r.amount);
        const res = await c.query('INSERT INTO bank_transactions(org_id,bank_account_id,txn_date,description,amount,reference,import_hash,rule_account_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING',
          [orgId, id, r.date, r.description, r.amount, r.reference, r.hash, rule?.accountId ?? null]);
        imported += res.rowCount ?? 0;
      }
      await writeAudit(c, { orgId, userId: uid, action: 'import_statement', entity: 'bank_account', entityId: id, after: { rows: rows.length, imported }, ip });
      return { imported, skippedDuplicates: rows.length - imported };
    });
  }

  @Get('bank-accounts/:id/transactions')
  async txns(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number, @Query('status') status?: string) {
    await requireOrg(uid, orgId, 'read');
    return withOrg(orgId, async (c) => (await c.query(
      `SELECT id, txn_date::text AS date, description, amount, reference, status, matched_entry_id AS "matchedEntryId", rule_account_id AS "ruleAccountId"
         FROM bank_transactions WHERE bank_account_id=$1 AND ($2::text IS NULL OR status=$2) ORDER BY txn_date, id`, [id, status ?? null])).rows
      .map((r) => num(r, 'id', 'amount', 'matchedEntryId', 'ruleAccountId')));
  }

  /** Ledger entries that touch this bank account for the same amount within a week and are not matched yet. */
  @Get('bank-transactions/:txnId/suggestions')
  async suggestions(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('txnId', ParseIntPipe) txnId: number) {
    await requireOrg(uid, orgId, 'read');
    return withOrg(orgId, async (c) => {
      const t = (await c.query('SELECT t.*, b.account_id FROM bank_transactions t JOIN bank_accounts b ON b.id=t.bank_account_id WHERE t.id=$1', [txnId])).rows[0];
      if (!t) throw new NotFoundException('Transaction not found');
      const amt = Number(t.amount);
      return (await c.query(
        `SELECT e.id, e.entry_date::text AS date, e.narration, e.reference
           FROM journal_entries e JOIN journal_lines l ON l.entry_id=e.id
          WHERE l.account_id=$1 AND (l.debit - l.credit) = $2
            AND e.entry_date BETWEEN $3::date - 7 AND $3::date + 7
            AND NOT EXISTS (SELECT 1 FROM bank_transactions x WHERE x.matched_entry_id=e.id)
          ORDER BY ABS(e.entry_date - $3::date), e.id LIMIT 10`, [t.account_id, amt, t.txn_date])).rows.map((r) => num(r, 'id'));
    });
  }

  @Post('bank-transactions/:txnId/reconcile')
  async reconcile(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('txnId', ParseIntPipe) txnId: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'post');
    const b = parse(z.object({ entryId: z.number().int().positive() }), body);
    return withOrg(orgId, async (c) => {
      const t = await lockTxn(c, txnId);
      const ok = await c.query('SELECT 1 FROM journal_lines WHERE entry_id=$1 AND account_id=$2 AND (debit-credit)=$3', [b.entryId, t.account_id, t.amount]);
      if (!ok.rowCount) throw new BadRequestException('That entry has no line on this bank account for exactly this amount');
      if ((await c.query('SELECT 1 FROM bank_transactions WHERE matched_entry_id=$1', [b.entryId])).rowCount) throw new ConflictException('Entry is already matched to another bank line');
      await c.query("UPDATE bank_transactions SET status='reconciled', matched_entry_id=$2 WHERE id=$1", [txnId, b.entryId]);
      await writeAudit(c, { orgId, userId: uid, action: 'reconcile', entity: 'bank_transaction', entityId: txnId, after: b, ip });
      return { reconciled: true };
    });
  }

  /** No matching entry yet: post one against a chosen account (e.g. bank charges) and reconcile it. */
  @Post('bank-transactions/:txnId/categorize')
  async categorize(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('txnId', ParseIntPipe) txnId: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'post');
    const b = parse(z.object({ accountId: z.number().int().positive(), narration: z.string().max(300).optional() }), body);
    return withOrg(orgId, async (c) => {
      const t = await lockTxn(c, txnId);
      if (Number(t.account_id) === b.accountId) throw new BadRequestException('Choose a different account from the bank account');
      if (!(await c.query('SELECT 1 FROM accounts WHERE id=$1 AND is_active', [b.accountId])).rowCount) throw new BadRequestException('Account not found');
      const amt = Number(t.amount), abs = Math.abs(amt);
      const lines = amt > 0
        ? [{ accountId: Number(t.account_id), debit: abs, credit: 0 }, { accountId: b.accountId, debit: 0, credit: abs }]
        : [{ accountId: b.accountId, debit: abs, credit: 0 }, { accountId: Number(t.account_id), debit: 0, credit: abs }];
      const eid = await insertEntry(c, orgId, uid, String(t.txn_date_text), b.narration ?? t.description, t.reference, null, lines);
      await c.query("UPDATE bank_transactions SET status='reconciled', matched_entry_id=$2 WHERE id=$1", [txnId, eid]);
      await writeAudit(c, { orgId, userId: uid, action: 'categorize', entity: 'bank_transaction', entityId: txnId, after: { ...b, entryId: eid }, ip });
      return { entryId: eid };
    });
  }

  @Post('bank-transactions/:txnId/unreconcile')
  async unreconcile(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('txnId', ParseIntPipe) txnId: number, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'post');
    return withOrg(orgId, async (c) => {
      const r = await c.query("UPDATE bank_transactions SET status='unreconciled', matched_entry_id=NULL WHERE id=$1 AND status='reconciled'", [txnId]);
      if (!r.rowCount) throw new NotFoundException('No reconciled transaction with that id');
      await writeAudit(c, { orgId, userId: uid, action: 'unreconcile', entity: 'bank_transaction', entityId: txnId, ip });
      return { ok: true };
    });
  }
}

async function lockTxn(c: import('pg').PoolClient, id: number) {
  const t = (await c.query(
    `SELECT t.*, t.txn_date::text AS txn_date_text, b.account_id FROM bank_transactions t JOIN bank_accounts b ON b.id=t.bank_account_id WHERE t.id=$1 FOR UPDATE OF t`, [id])).rows[0];
  if (!t) throw new NotFoundException('Transaction not found');
  if (t.status === 'reconciled') throw new ConflictException('Already reconciled');
  t.amount = Number(t.amount);
  return t;
}
