// Stock quantities and weighted average cost. Quantities are in 1/1000 units (qty_milli), values in paise.
import { PoolClient } from 'pg';

export interface OnHand { qtyMilli: number; value: number }

/** Quantity and value on hand for one item, from its movement history. Call with the item row locked when about to move stock. */
export async function onHand(c: PoolClient, itemId: number): Promise<OnHand> {
  const r = (await c.query('SELECT COALESCE(SUM(qty_milli),0) AS q, COALESCE(SUM(value),0) AS v FROM stock_moves WHERE item_id=$1', [itemId])).rows[0];
  return { qtyMilli: Number(r.q), value: Number(r.v) };
}

/**
 * Cost of taking qtyMilli out of stock at weighted average cost. Taking everything out takes the exact remaining value,
 * so rounding never leaves a few paise stranded in stock.
 */
export function issueCost(stock: OnHand, qtyMilli: number): number {
  if (qtyMilli > stock.qtyMilli) throw new Error('Not enough stock');
  if (qtyMilli === stock.qtyMilli) return stock.value;
  return Math.round((stock.value * qtyMilli) / stock.qtyMilli);
}

export async function recordMove(c: PoolClient, orgId: number, m: { itemId: number; date: string; kind: 'purchase' | 'sale' | 'adjustment' | 'void'; qtyMilli: number; value: number; docId?: number | null; entryId?: number | null; note?: string }) {
  await c.query('INSERT INTO stock_moves(org_id,item_id,move_date,kind,qty_milli,value,doc_id,entry_id,note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [orgId, m.itemId, m.date, m.kind, m.qtyMilli, m.value, m.docId ?? null, m.entryId ?? null, m.note ?? null]);
}
