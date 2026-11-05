import { BadRequestException, Body, ConflictException, Controller, Get, NotFoundException, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { withOrg } from '../db/db';
import { writeAudit } from '../audit/audit';
import { AuthGuard, Ip, UserId, parse } from '../common/guard';
import { parseStatement } from '../common/csv';
import { requireOrg } from '../tenancy/acl';
import { insertEntry } from '../ledger/post';
import { reverseLines } from '../ledger/ledger';
import { recordPayment } from './documents.controller';
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

  /**
   * Open invoices (money in) or bills (money out) to match a bank line against. With no search text, only documents whose outstanding
   * amount is exactly the bank amount are returned; with text, any open document of that direction whose number or contact matches.
   */
  @Get('bank-transactions/:txnId/document-matches')
  async documentMatches(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('txnId', ParseIntPipe) txnId: number, @Query('q') q?: string) {
    await requireOrg(uid, orgId, 'read');
    return withOrg(orgId, async (c) => {
      const t = (await c.query('SELECT amount FROM bank_transactions WHERE id=$1', [txnId])).rows[0];
      if (!t) throw new NotFoundException('Transaction not found');
      return openDocsFor(c, Number(t.amount), q?.trim() || null);
    });
  }

  /** Match a bank line to an invoice or bill: records the payment on it (for the bank amount) and reconciles the line. */
  @Post('bank-transactions/:txnId/match-document')
  async matchDocument(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('txnId', ParseIntPipe) txnId: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'post');
    const b = parse(z.object({ documentId: z.number().int().positive() }), body);
    return withOrg(orgId, async (c) => {
      const t = await lockTxn(c, txnId);
      const r = await payFromBankLine(c, orgId, uid, t, b.documentId, ip);
      await writeAudit(c, { orgId, userId: uid, action: 'match_document', entity: 'bank_transaction', entityId: txnId, after: { documentId: b.documentId, ...r }, ip });
      return r;
    });
  }

  /** Match every unreconciled line that has exactly one open invoice or bill for the same amount. Lines with none or several are left for you to check. */
  @Post('bank-accounts/:id/auto-match-documents')
  async autoMatch(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'post');
    return withOrg(orgId, async (c) => {
      const lines = (await c.query("SELECT id FROM bank_transactions WHERE bank_account_id=$1 AND status='unreconciled' ORDER BY txn_date, id", [id])).rows;
      let matched = 0, ambiguous = 0;
      for (const l of lines) {
        const t = await lockTxn(c, Number(l.id));
        const found = await openDocsFor(c, t.amount, null);
        if (found.length > 1) { ambiguous++; continue; }
        if (found.length !== 1) continue;
        await c.query('SAVEPOINT one');
        try { await payFromBankLine(c, orgId, uid, t, found[0].id, ip); await c.query('RELEASE SAVEPOINT one'); matched++; }
        catch { await c.query('ROLLBACK TO SAVEPOINT one'); }
      }
      await writeAudit(c, { orgId, userId: uid, action: 'auto_match_documents', entity: 'bank_account', entityId: id, after: { matched, ambiguous }, ip });
      return { matched, ambiguous, checked: lines.length };
    });
  }

  /**
   * Take a bank line back out of a wrong match. If the line was matched to an invoice or bill, that payment is unlinked too:
   * its entry is reversed and the invoice or bill becomes outstanding again.
   */
  @Post('bank-transactions/:txnId/unlink')
  async unlink(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('txnId', ParseIntPipe) txnId: number, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'post');
    return withOrg(orgId, async (c) => {
      const t = (await c.query("SELECT id, matched_entry_id FROM bank_transactions WHERE id=$1 AND status='reconciled' FOR UPDATE", [txnId])).rows[0];
      if (!t) throw new NotFoundException('No reconciled transaction with that id');
      const pay = (await c.query('SELECT p.id, p.journal_entry_id, d.number FROM payments p JOIN documents d ON d.id=p.doc_id WHERE p.journal_entry_id=$1 FOR UPDATE OF p', [t.matched_entry_id])).rows[0];
      let reversalEntryId: number | null = null;
      if (pay) {
        const ls = (await c.query('SELECT account_id,debit,credit,tracking_option_id FROM journal_lines WHERE entry_id=$1', [pay.journal_entry_id])).rows
          .map((r) => ({ accountId: Number(r.account_id), debit: Number(r.debit), credit: Number(r.credit), trackingOptionId: r.tracking_option_id ? Number(r.tracking_option_id) : null }));
        reversalEntryId = await insertEntry(c, orgId, uid, new Date().toISOString().slice(0, 10), `Payment unlinked from ${pay.number}`, pay.number, Number(pay.journal_entry_id), reverseLines(ls));
        await c.query('DELETE FROM payments WHERE id=$1', [pay.id]);
      }
      await c.query("UPDATE bank_transactions SET status='unreconciled', matched_entry_id=NULL WHERE id=$1", [txnId]);
      await writeAudit(c, { orgId, userId: uid, action: 'unlink', entity: 'bank_transaction', entityId: txnId, after: { paymentUnlinked: !!pay, documentNumber: pay?.number ?? null }, ip });
      return { ok: true, paymentUnlinked: !!pay, documentNumber: pay?.number ?? null, reversalEntryId };
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

/** Open invoices (for money in) or bills (for money out). Exact outstanding match when no search text is given. */
async function openDocsFor(c: import('pg').PoolClient, amount: number, q: string | null) {
  const abs = Math.abs(amount), type = amount > 0 ? 'invoice' : 'bill';
  const rows = (await c.query(
    `SELECT * FROM (
       SELECT d.id, d.number, d.doc_type, d.issue_date::text AS date, ct.name AS "contactName", d.net_payable - COALESCE(p.paid,0) - COALESCE(n.noted,0) AS outstanding, d.currency
         FROM documents d JOIN contacts ct ON ct.id=d.contact_id
         LEFT JOIN (SELECT doc_id, SUM(amount) paid FROM payments GROUP BY doc_id) p ON p.doc_id=d.id
         LEFT JOIN (SELECT original_doc_id, SUM(total) noted FROM documents WHERE status='posted' AND original_doc_id IS NOT NULL GROUP BY original_doc_id) n ON n.original_doc_id=d.id
        WHERE d.doc_type=$1 AND d.status='posted' AND d.currency='INR') x
      WHERE outstanding > 0 AND (($2::text IS NULL AND outstanding = $3) OR ($2::text IS NOT NULL AND (number ILIKE '%' || $2 || '%' OR "contactName" ILIKE '%' || $2 || '%')))
      ORDER BY (outstanding = $3) DESC, date DESC LIMIT 20`, [type, q, abs])).rows;
  return rows.map((r) => ({ id: Number(r.id), number: r.number, docType: r.doc_type as string, date: r.date as string, contactName: r.contactName as string, outstanding: Number(r.outstanding), exact: Number(r.outstanding) === abs }));
}

/** Pay an invoice or bill from a bank line, for the line's amount, then reconcile the line to that payment. */
async function payFromBankLine(c: import('pg').PoolClient, orgId: number, uid: number, t: any, documentId: number, ip: string) {
  const abs = Math.abs(Number(t.amount));
  const doc = (await c.query('SELECT doc_type, currency FROM documents WHERE id=$1', [documentId])).rows[0];
  if (!doc) throw new NotFoundException('Document not found');
  if (Number(t.amount) > 0 && doc.doc_type !== 'invoice') throw new BadRequestException('Money received can only be matched to an invoice');
  if (Number(t.amount) < 0 && doc.doc_type !== 'bill') throw new BadRequestException('Money paid out can only be matched to a bill');
  if (doc.currency !== 'INR') throw new BadRequestException('Record payments on foreign-currency documents from the invoice or bill screen');
  const pay = await recordPayment(c, orgId, uid, documentId, { date: String(t.txn_date_text), amount: abs, accountId: Number(t.account_id), reference: t.reference ?? undefined }, ip);
  await c.query("UPDATE bank_transactions SET status='reconciled', matched_entry_id=$2 WHERE id=$1", [t.id, pay.journalEntryId]);
  return { reconciled: true, paymentId: pay.id, outstandingAfter: pay.outstandingAfter };
}
