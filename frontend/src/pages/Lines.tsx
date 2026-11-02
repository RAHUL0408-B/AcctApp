// Shared line-item editor used by invoices, bills, quotes, purchase orders and repeating invoices.
import { useEffect, useState } from 'react';
import { api, fmt, toPaise } from '../api';
import type { Org } from '../App';

export interface Line { description: string; hsnSac: string; quantity: string; rate: string; gstRateBp: string; accountId: string }
export interface Account { id: number; code: string; name: string; type: string }
export interface Item { id: number; code: string; name: string; kind: string; hsnSac: string | null; saleRate: number; purchaseRate: number; gstRateBp: number; salesAccountId: number | null; purchaseAccountId: number | null }
export const emptyLine = (): Line => ({ description: '', hsnSac: '', quantity: '1', rate: '', gstRateBp: '1800', accountId: '' });

/** Convert editor lines to the API shape (rate in paise, numbers parsed). Throws on a bad amount. */
export function linesToApi(lines: Line[]) {
  return lines.map((l) => ({ description: l.description, quantity: Number(l.quantity), rate: toPaise(l.rate), gstRateBp: Number(l.gstRateBp),
    ...(l.hsnSac ? { hsnSac: l.hsnSac } : {}), ...(l.accountId ? { accountId: Number(l.accountId) } : {}) }));
}

export function LinesEditor({ org, lines, setLines, sales, accounts }: { org: Org; lines: Line[]; setLines: (l: Line[]) => void; sales: boolean; accounts: Account[] }) {
  const [rates, setRates] = useState<{ rateBp: number; label: string }[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  useEffect(() => { api('/config/gst-rates').then(setRates); api<Item[]>(`/orgs/${org.id}/items`).then(setItems); }, [org.id]);
  const options = accounts.filter((a) => (sales ? a.type === 'income' : a.type === 'expense' || a.type === 'asset'));
  const set = (i: number, k: keyof Line, v: string) => setLines(lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  const total = (l: Line) => { try { return Math.round(Number(l.quantity || 0) * toPaise(l.rate || '0')); } catch { return 0; } };
  const addItem = (id: string) => {
    const it = items.find((x) => x.id === Number(id)); if (!it) return;
    const rate = sales ? it.saleRate : it.purchaseRate, acc = sales ? it.salesAccountId : it.purchaseAccountId;
    const row: Line = { description: it.name, hsnSac: it.hsnSac ?? '', quantity: '1', rate: String(rate / 100), gstRateBp: String(it.gstRateBp), accountId: acc ? String(acc) : '' };
    setLines(lines.length === 1 && !lines[0].description && !lines[0].rate ? [row] : [...lines, row]);
  };
  const subtotal = lines.reduce((s, l) => s + total(l), 0);
  return (
    <div className="mt-4">
      <div className="mb-2 flex items-center gap-3 text-sm">
        <select aria-label="Add from catalogue" className="rounded border border-slate-300 px-2 py-1" value="" onChange={(e) => addItem(e.target.value)}>
          <option value="">Add product or service…</option>{items.map((i) => <option key={i.id} value={i.id}>{i.code} · {i.name}</option>)}</select>
      </div>
      <table className="w-full text-sm">
        <thead><tr className="text-left text-slate-500"><th>Description</th><th className="w-24">HSN/SAC</th><th className="w-20">Qty</th><th className="w-28">Rate (₹)</th><th className="w-24">GST</th><th className="w-48">Account</th><th className="w-28 text-right">Amount</th><th className="w-8" /></tr></thead>
        <tbody>{lines.map((l, i) => (
          <tr key={i}>
            <td className="pr-1"><input aria-label={`Description ${i + 1}`} className="w-full rounded border border-slate-300 px-2 py-1" value={l.description} onChange={(e) => set(i, 'description', e.target.value)} /></td>
            <td className="pr-1"><input aria-label={`HSN ${i + 1}`} className="w-full rounded border border-slate-300 px-2 py-1" value={l.hsnSac} onChange={(e) => set(i, 'hsnSac', e.target.value)} /></td>
            <td className="pr-1"><input aria-label={`Qty ${i + 1}`} className="w-full rounded border border-slate-300 px-2 py-1 text-right" value={l.quantity} onChange={(e) => set(i, 'quantity', e.target.value)} /></td>
            <td className="pr-1"><input aria-label={`Rate ${i + 1}`} className="w-full rounded border border-slate-300 px-2 py-1 text-right" inputMode="decimal" value={l.rate} onChange={(e) => set(i, 'rate', e.target.value)} /></td>
            <td className="pr-1"><select aria-label={`GST ${i + 1}`} className="w-full rounded border border-slate-300 px-1 py-1" value={l.gstRateBp} onChange={(e) => set(i, 'gstRateBp', e.target.value)}>
              {rates.map((r) => <option key={r.rateBp} value={r.rateBp}>{r.label}</option>)}</select></td>
            <td className="pr-1"><select aria-label={`Account ${i + 1}`} className="w-full rounded border border-slate-300 px-1 py-1" value={l.accountId} onChange={(e) => set(i, 'accountId', e.target.value)}>
              <option value="">Default</option>{options.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select></td>
            <td className="text-right">{fmt(total(l))}</td>
            <td>{lines.length > 1 && <button type="button" aria-label={`Remove line ${i + 1}`} className="text-slate-400 hover:text-red-600" onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</button>}</td>
          </tr>))}</tbody>
        <tfoot><tr><td colSpan={6} className="pt-2 text-right text-slate-500">Subtotal before GST</td><td className="pt-2 text-right font-medium">{fmt(subtotal)}</td><td /></tr></tfoot>
      </table>
      <button type="button" className="mt-2 text-sm text-brand-700 underline" onClick={() => setLines([...lines, emptyLine()])}>+ Add line</button>
    </div>
  );
}
