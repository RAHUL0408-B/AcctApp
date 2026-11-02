// Stock on hand at weighted average cost, movement history and stock adjustments.
import { useCallback, useEffect, useState } from 'react';
import { api, fmt, toPaise, today } from '../api';
import type { Org } from '../App';
import { Empty, PageHeader, Select, Stat } from '../kit';
import { Button, Card, ErrorMsg, Field, Ok, useAction } from '../ui';

interface StockItem { id: number; code: string; name: string; quantity: number; value: number; averageCost: number }
interface Move { id: number; date: string; kind: string; quantity: number; value: number; reference: string | null; balanceQuantity: number; balanceValue: number }

export function Inventory({ org, canManage }: { org: Org; canManage: boolean }) {
  const [s, setS] = useState<{ items: StockItem[]; totalValue: number; inventoryAccountBalance: number; agrees: boolean } | null>(null);
  const [moves, setMoves] = useState<{ item: StockItem; list: Move[] } | null>(null);
  const [f, setF] = useState({ itemId: '', quantity: '', unitCost: '', reason: '', date: today() });
  const [ok, setOk] = useState('');
  const { error, busy, run } = useAction();
  const load = useCallback(() => api(`/orgs/${org.id}/stock`).then(setS), [org.id]);
  useEffect(() => { load(); }, [load]);
  const open = (item: StockItem) => run(async () => setMoves({ item, list: await api<Move[]>(`/orgs/${org.id}/stock/${item.id}/moves`) }));
  const adjust = () => run(async () => {
    const qty = Number(f.quantity);
    const r = await api(`/orgs/${org.id}/stock/adjust`, { body: { itemId: Number(f.itemId), date: f.date, quantity: qty, reason: f.reason, ...(qty > 0 ? { unitCost: toPaise(f.unitCost) } : {}) } });
    setOk(`Adjusted: ${r.value >= 0 ? 'added' : 'removed'} stock worth ₹${fmt(Math.abs(r.value))}.`); setF({ ...f, quantity: '', unitCost: '', reason: '' }); load();
  });
  if (!s) return <p>Loading…</p>;
  return (
    <>
      <PageHeader title="Inventory" subtitle="Quantities and value of goods with stock tracking turned on. Purchases add stock at cost; sales take it out at average cost." />
      <div className="mb-3 space-y-2"><ErrorMsg msg={error} /><Ok msg={ok} /></div>
      <div className="grid gap-4 md:grid-cols-3">
        <Stat label="Stock value" value={`₹${fmt(s.totalValue)}`} sub={`${s.items.length} tracked item(s)`} testId="stock-value" />
        <Stat label="Inventory account balance" value={`₹${fmt(s.inventoryAccountBalance)}`} />
        <Stat label="Stock agrees with the ledger" value={s.agrees ? 'Yes' : 'No'} tone={s.agrees ? 'good' : 'bad'} />
      </div>
      <Card title="Stock on hand">
        {s.items.length === 0 ? <Empty text="No tracked items. Turn on stock tracking when you add a goods item under Products and services." /> : (
          <table className="w-full text-sm"><thead><tr className="text-left"><th>Code</th><th>Item</th><th className="text-right">Quantity</th><th className="text-right">Average cost</th><th className="text-right">Value</th><th /></tr></thead>
            <tbody>{s.items.map((i) => (
              <tr key={i.id}><td className="font-medium">{i.code}</td><td>{i.name}</td><td className="text-right">{i.quantity}</td><td className="text-right">{fmt(i.averageCost)}</td>
                <td className="text-right">{fmt(i.value)}</td><td className="text-right"><Button variant="ghost" onClick={() => open(i)}>History</Button></td></tr>))}</tbody></table>
        )}
      </Card>
      {moves && (
        <Card title={`Movements: ${moves.item.name}`} actions={<button className="text-sm text-brand-700 underline" onClick={() => setMoves(null)}>Close</button>}>
          <table className="w-full text-sm" data-testid="stock-moves"><thead><tr className="text-left"><th>Date</th><th>Type</th><th>Reference</th><th className="text-right">Quantity</th><th className="text-right">Value</th><th className="text-right">Balance qty</th><th className="text-right">Balance value</th></tr></thead>
            <tbody>{moves.list.map((m) => <tr key={m.id}><td>{m.date}</td><td className="capitalize">{m.kind}</td><td>{m.reference ?? ''}</td><td className="text-right">{m.quantity}</td><td className="text-right">{fmt(m.value)}</td><td className="text-right">{m.balanceQuantity}</td><td className="text-right">{fmt(m.balanceValue)}</td></tr>)}</tbody></table>
        </Card>
      )}
      {canManage && s.items.length > 0 && (
        <Card title="Adjust stock">
          <p className="mb-3 text-sm text-slate-600">Use a negative quantity for damage or a stock-count shortfall (valued at average cost). Adding stock needs a unit cost. The other side posts to Cost of Goods Sold.</p>
          <div className="grid gap-3 md:grid-cols-5">
            <Select label="Item" aria-label="Adjust item" value={f.itemId} onChange={(e) => setF({ ...f, itemId: e.target.value })}><option value="">Select…</option>{s.items.map((i) => <option key={i.id} value={i.id}>{i.code} · {i.name}</option>)}</Select>
            <Field label="Quantity (+ or −)" value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} />
            <Field label="Unit cost (₹, when adding)" value={f.unitCost} onChange={(e) => setF({ ...f, unitCost: e.target.value })} disabled={Number(f.quantity) < 0} />
            <Field label="Date" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
            <Field label="Reason" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
          </div>
          <div className="mt-3"><Button disabled={busy || !f.itemId || !f.quantity || !f.reason} onClick={adjust}>Post adjustment</Button></div>
        </Card>
      )}
    </>
  );
}
