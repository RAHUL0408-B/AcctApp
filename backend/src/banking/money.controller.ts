// Spend money, receive money and transfer money: direct bank transactions without an invoice or bill.
// Each posts one balanced journal entry that the bank reconciliation will later suggest as a match.
import { BadRequestException, Body, Controller, NotFoundException, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { PoolClient } from 'pg';
import { z } from 'zod';
import { withOrg } from '../db/db';
import { writeAudit } from '../audit/audit';
import { AuthGuard, Ip, UserId, parse } from '../common/guard';
import { requireOrg } from '../tenancy/acl';
import { insertEntry } from '../ledger/post';
import { Line, validateLines } from '../ledger/ledger';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const moneySchema = z.object({
  date, payee: z.string().min(1).max(200), reference: z.string().max(60).optional(),
  lines: z.array(z.object({ accountId: z.number().int().positive(), amount: z.number().int().positive(), description: z.string().max(300).optional() })).min(1).max(50),
});

async function bankAccount(c: PoolClient, id: number) {
  const b = (await c.query('SELECT id, name, account_id FROM bank_accounts WHERE id=$1', [id])).rows[0];
  if (!b) throw new NotFoundException('Bank account not found');
  return { id: Number(b.id), name: b.name as string, accountId: Number(b.account_id) };
}

@Controller('orgs/:orgId')
@UseGuards(AuthGuard)
export class MoneyController {
  @Post('bank-accounts/:id/spend')
  spend(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number, @Body() body: unknown, @Ip() ip: string) {
    return this.direct('spend', uid, orgId, id, body, ip);
  }

  @Post('bank-accounts/:id/receive')
  receive(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number, @Body() body: unknown, @Ip() ip: string) {
    return this.direct('receive', uid, orgId, id, body, ip);
  }

  /** Spend: Dr each line's account / Cr bank. Receive: Dr bank / Cr each line's account. */
  private async direct(kind: 'spend' | 'receive', uid: number, orgId: number, bankId: number, body: unknown, ip: string) {
    await requireOrg(uid, orgId, 'post');
    const b = parse(moneySchema, body);
    return withOrg(orgId, async (c) => {
      const bank = await bankAccount(c, bankId);
      const ids = [...new Set(b.lines.map((l) => l.accountId))];
      if (ids.includes(bank.accountId)) throw new BadRequestException('A line cannot post to the bank account itself; use Transfer money between banks');
      if ((await c.query('SELECT id FROM accounts WHERE id = ANY($1) AND is_active', [ids])).rowCount !== ids.length) throw new BadRequestException('One or more accounts do not exist or are inactive');
      const total = b.lines.reduce((s, l) => s + l.amount, 0);
      const out = kind === 'spend';
      const lines: Line[] = [
        ...b.lines.map((l) => ({ accountId: l.accountId, debit: out ? l.amount : 0, credit: out ? 0 : l.amount, memo: l.description })),
        { accountId: bank.accountId, debit: out ? 0 : total, credit: out ? total : 0 },
      ];
      const narration = `${out ? 'Spent' : 'Received'}: ${b.payee}${b.lines.length === 1 && b.lines[0].description ? ` - ${b.lines[0].description}` : ''}`;
      const entryId = await insertEntry(c, orgId, uid, b.date, narration, b.reference ?? null, null, validateLines(lines));
      await writeAudit(c, { orgId, userId: uid, action: kind, entity: 'bank_account', entityId: bankId, after: { ...b, entryId, total }, ip });
      return { entryId, total, bank: bank.name };
    });
  }

  /** Move money between two of the organisation's bank accounts: Dr destination / Cr source. */
  @Post('bank-transfers')
  async transfer(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'post');
    const b = parse(z.object({ date, fromBankAccountId: z.number().int().positive(), toBankAccountId: z.number().int().positive(),
      amount: z.number().int().positive(), reference: z.string().max(60).optional() }), body);
    if (b.fromBankAccountId === b.toBankAccountId) throw new BadRequestException('Choose two different bank accounts');
    return withOrg(orgId, async (c) => {
      const from = await bankAccount(c, b.fromBankAccountId), to = await bankAccount(c, b.toBankAccountId);
      const entryId = await insertEntry(c, orgId, uid, b.date, `Transfer from ${from.name} to ${to.name}`, b.reference ?? null, null,
        validateLines([{ accountId: to.accountId, debit: b.amount, credit: 0 }, { accountId: from.accountId, debit: 0, credit: b.amount }]));
      await writeAudit(c, { orgId, userId: uid, action: 'transfer', entity: 'bank_account', entityId: from.id, after: { ...b, entryId }, ip });
      return { entryId };
    });
  }
}
