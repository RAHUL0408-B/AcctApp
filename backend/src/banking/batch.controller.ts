// Batch payments: pay several supplier bills (or receive several customer invoices) with one bank payment, as one
// journal entry, so it matches the single line on the bank statement. Undoing a batch reverses the whole entry.
import { BadRequestException, Body, ConflictException, Controller, Delete, Get, NotFoundException, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { withOrg } from '../db/db';
import { writeAudit } from '../audit/audit';
import { AuthGuard, Ip, UserId, parse } from '../common/guard';
import { requireOrg } from '../tenancy/acl';
import { accountIdByCode, insertEntry } from '../ledger/post';
import { reverseLines, Line } from '../ledger/ledger';
import { OUTSTANDING_SQL } from '../accounting/documents.controller';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

@Controller('orgs/:orgId')
@UseGuards(AuthGuard)
export class BatchPaymentsController {
  @Get('payment-batches')
  async list(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Query('side') side?: string) {
    await requireOrg(uid, orgId, 'read');
    return withOrg(orgId, async (c) => {
      const rows = (await c.query(
        `SELECT b.id, b.side, b.pay_date::text AS date, b.reference, b.total::float8 AS total, b.status, a.name AS account,
                (SELECT json_agg(json_build_object('documentId', d.id, 'number', d.number, 'contact', ct.name, 'amount', p.amount::float8) ORDER BY d.id)
                   FROM payments p JOIN documents d ON d.id=p.doc_id JOIN contacts ct ON ct.id=d.contact_id WHERE p.batch_id=b.id) AS items
           FROM payment_batches b JOIN accounts a ON a.id=b.account_id
          WHERE ($1::text IS NULL OR b.side=$1) ORDER BY b.id DESC LIMIT 200`, [side === 'pay' || side === 'receive' ? side : null])).rows;
      return rows.map((r) => ({ ...r, id: Number(r.id), items: r.items ?? [] }));
    });
  }

  @Post('payment-batches')
  async create(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'post');
    const b = parse(z.object({
      date, accountId: z.number().int().positive(), reference: z.string().max(100).optional(),
      items: z.array(z.object({ documentId: z.number().int().positive(), amount: z.number().int().positive() })).min(1).max(200),
    }), body);
    if (new Set(b.items.map((i) => i.documentId)).size !== b.items.length) throw new BadRequestException('Each invoice or bill can appear only once in a batch');
    return withOrg(orgId, async (c) => {
      const bank = (await c.query('SELECT type FROM accounts WHERE id=$1 AND is_active', [b.accountId])).rows[0];
      if (!bank || bank.type !== 'asset') throw new BadRequestException('Pay from/into a cash or bank (asset) account');
      let side: 'pay' | 'receive' | null = null, total = 0;
      const docs: { id: number; number: string; amount: number }[] = [];
      for (const it of b.items) {
        const d = (await c.query(`${OUTSTANDING_SQL} WHERE d.id=$1 FOR UPDATE OF d`, [it.documentId])).rows[0];
        if (!d) throw new NotFoundException(`Document ${it.documentId} not found`);
        if (d.status !== 'posted') throw new ConflictException(`${d.number} is void`);
        if (d.doc_type !== 'invoice' && d.doc_type !== 'bill') throw new BadRequestException(`${d.number}: only invoices and bills can be paid`);
        if (d.currency !== 'INR') throw new BadRequestException(`${d.number} is in ${d.currency}: pay foreign-currency documents one at a time`);
        const s = d.doc_type === 'bill' ? 'pay' : 'receive';
        if (side && side !== s) throw new BadRequestException('A batch holds either bills (a payment) or invoices (a receipt), not both');
        side = s;
        if (it.amount > Number(d.outstanding)) throw new BadRequestException(`${d.number}: Rs ${(it.amount / 100).toFixed(2)} is more than the Rs ${(Number(d.outstanding) / 100).toFixed(2)} still due`);
        docs.push({ id: Number(d.id), number: d.number, amount: it.amount });
        total += it.amount;
      }
      const control = await accountIdByCode(c, side === 'pay' ? '2000' : '1100');
      const lines: Line[] = side === 'pay'
        ? [{ accountId: control, debit: total, credit: 0 }, { accountId: b.accountId, debit: 0, credit: total }]
        : [{ accountId: b.accountId, debit: total, credit: 0 }, { accountId: control, debit: 0, credit: total }];
      const label = `Batch ${side === 'pay' ? 'payment' : 'receipt'}${b.reference ? ` ${b.reference}` : ''}: ${docs.map((d) => d.number).join(', ')}`.slice(0, 480);
      const eid = await insertEntry(c, orgId, uid, b.date, label, b.reference ?? 'BATCH', null, lines);
      const batch = (await c.query('INSERT INTO payment_batches(org_id,side,pay_date,account_id,reference,total,journal_entry_id,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
        [orgId, side, b.date, b.accountId, b.reference ?? null, total, eid, uid])).rows[0];
      for (const d of docs) {
        await c.query('INSERT INTO payments(org_id,doc_id,pay_date,amount,account_id,journal_entry_id,reference,created_by,bank_amount,fx_gain,batch_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10)',
          [orgId, d.id, b.date, d.amount, b.accountId, eid, b.reference ?? `Batch ${batch.id}`, uid, d.amount, batch.id]);
      }
      await writeAudit(c, { orgId, userId: uid, action: 'batch_payment', entity: 'payment_batch', entityId: batch.id, after: { side, total, documents: docs.map((d) => d.number) }, ip });
      return { id: Number(batch.id), side, total, journalEntryId: eid, count: docs.length };
    });
  }

  /** Undo a batch: its entry is reversed, the invoices or bills become outstanding again, and any bank match is released. */
  @Delete('payment-batches/:id')
  async undo(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'post');
    return withOrg(orgId, async (c) => {
      const bt = (await c.query('SELECT * FROM payment_batches WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!bt) throw new NotFoundException('Batch not found');
      if (bt.status !== 'posted') throw new ConflictException('This batch was already undone');
      const ls = (await c.query('SELECT account_id,debit,credit FROM journal_lines WHERE entry_id=$1', [bt.journal_entry_id])).rows
        .map((r) => ({ accountId: Number(r.account_id), debit: Number(r.debit), credit: Number(r.credit) }));
      const on = new Date().toISOString().slice(0, 10);
      const vid = await insertEntry(c, orgId, uid, on, `Batch ${bt.side === 'pay' ? 'payment' : 'receipt'} #${id} undone`, bt.reference ?? 'BATCH', Number(bt.journal_entry_id), reverseLines(ls));
      await c.query("UPDATE bank_transactions SET status='unreconciled', matched_entry_id=NULL WHERE matched_entry_id=$1", [bt.journal_entry_id]);
      await c.query('DELETE FROM payments WHERE batch_id=$1', [id]);
      await c.query("UPDATE payment_batches SET status='undone', undo_entry_id=$2 WHERE id=$1", [id, vid]);
      await writeAudit(c, { orgId, userId: uid, action: 'undo_batch_payment', entity: 'payment_batch', entityId: id, before: { total: Number(bt.total) }, ip });
      return { undone: true, reversalEntryId: vid };
    });
  }
}
