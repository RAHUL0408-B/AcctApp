// Stock on hand, movement history and stock adjustments for items with stock tracking turned on.
import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { withOrg } from '../db/db';
import { writeAudit } from '../audit/audit';
import { AuthGuard, Ip, UserId, parse } from '../common/guard';
import { requireOrg } from '../tenancy/acl';
import { ensureAccount, insertEntry } from '../ledger/post';
import { validateLines } from '../ledger/ledger';
import { issueCost, onHand, recordMove } from './stock';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

@Controller('orgs/:orgId/stock')
@UseGuards(AuthGuard)
export class InventoryController {
  /** Every tracked item with quantity, value and average cost; the total should equal the Inventory account balance. */
  @Get()
  async list(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number) {
    await requireOrg(uid, orgId, 'read');
    return withOrg(orgId, async (c) => {
      const items = (await c.query(
        `SELECT i.id, i.code, i.name, COALESCE(SUM(m.qty_milli),0) AS q, COALESCE(SUM(m.value),0) AS v
           FROM items i LEFT JOIN stock_moves m ON m.item_id=i.id WHERE i.track_stock GROUP BY i.id ORDER BY i.name`)).rows
        .map((r) => {
          const qtyMilli = Number(r.q), value = Number(r.v);
          return { id: Number(r.id), code: r.code, name: r.name, quantity: qtyMilli / 1000, value, averageCost: qtyMilli ? Math.round((value * 1000) / qtyMilli) : 0 };
        });
      const ledger = Number((await c.query("SELECT COALESCE(SUM(l.debit-l.credit),0) AS b FROM journal_lines l JOIN accounts a ON a.id=l.account_id WHERE a.code='1200'")).rows[0].b);
      const total = items.reduce((s, i) => s + i.value, 0);
      return { items, totalValue: total, inventoryAccountBalance: ledger, agrees: total === ledger };
    });
  }

  @Get(':itemId/moves')
  async moves(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('itemId', ParseIntPipe) itemId: number) {
    await requireOrg(uid, orgId, 'read');
    return withOrg(orgId, async (c) => {
      let qty = 0, value = 0;
      return (await c.query(
        `SELECT m.id, m.move_date::text AS date, m.kind, m.qty_milli, m.value, m.note, d.number
           FROM stock_moves m LEFT JOIN documents d ON d.id=m.doc_id WHERE m.item_id=$1 ORDER BY m.id`, [itemId])).rows.map((r) => {
        qty += Number(r.qty_milli); value += Number(r.value);
        return { id: Number(r.id), date: r.date, kind: r.kind, quantity: Number(r.qty_milli) / 1000, value: Number(r.value), reference: r.number ?? r.note, balanceQuantity: qty / 1000, balanceValue: value };
      });
    });
  }

  /**
   * Adjust stock for a count difference, damage or opening stock. Adding stock needs a unit cost; removing stock is valued at
   * average cost. The other side goes to the chosen account (default: Cost of Goods Sold).
   */
  @Post('adjust')
  async adjust(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'manage');
    const b = parse(z.object({
      itemId: z.number().int().positive(), date, quantity: z.number().refine((q) => q !== 0, 'Quantity cannot be zero'),
      unitCost: z.number().int().min(0).optional(), accountId: z.number().int().positive().optional(), reason: z.string().min(1).max(300),
    }), body);
    return withOrg(orgId, async (c) => {
      const item = (await c.query('SELECT id,name,track_stock FROM items WHERE id=$1 FOR UPDATE', [b.itemId])).rows[0];
      if (!item) throw new NotFoundException('Item not found');
      if (!item.track_stock) throw new BadRequestException('Turn on stock tracking for this item first');
      const qtyMilli = Math.round(b.quantity * 1000);
      let value: number;
      if (qtyMilli > 0) {
        if (b.unitCost === undefined) throw new BadRequestException('Give a unit cost when adding stock');
        value = Math.round((qtyMilli * b.unitCost) / 1000);
      } else {
        const s = await onHand(c, b.itemId);
        if (-qtyMilli > s.qtyMilli) throw new BadRequestException(`Only ${s.qtyMilli / 1000} on hand`);
        value = -issueCost(s, -qtyMilli);
      }
      const inventory = await ensureAccount(c, orgId, '1200');
      const other = b.accountId ?? await ensureAccount(c, orgId, '5050');
      if (other === inventory) throw new BadRequestException('Choose an account other than Inventory');
      if (!(await c.query('SELECT 1 FROM accounts WHERE id=$1 AND is_active', [other])).rowCount) throw new BadRequestException('Account not found');
      let entryId: number | null = null;
      if (value !== 0) {
        const abs = Math.abs(value);
        const lines = validateLines(value > 0
          ? [{ accountId: inventory, debit: abs }, { accountId: other, credit: abs }]
          : [{ accountId: other, debit: abs }, { accountId: inventory, credit: abs }]);
        entryId = await insertEntry(c, orgId, uid, b.date, `Stock adjustment: ${item.name} (${b.reason})`, null, null, lines);
      }
      await recordMove(c, orgId, { itemId: b.itemId, date: b.date, kind: 'adjustment', qtyMilli, value, entryId, note: b.reason });
      await writeAudit(c, { orgId, userId: uid, action: 'stock_adjust', entity: 'item', entityId: b.itemId, after: { ...b, value }, ip });
      return { value, entryId, onHand: await onHand(c, b.itemId) };
    });
  }
}
