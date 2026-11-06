// Shared line-item editor used by invoices, bills, quotes, purchase orders and repeating invoices.
import { useEffect, useMemo, useState } from 'react';
import { api, fmt, toPaise } from '../api';
import type { Org } from '../App';
import { Button, ErrorMsg, Field, useAction } from '../ui';
import type { Contact } from './Contacts';

export interface Line { description: string; hsnSac: string; quantity: string; rate: string; gstRateBp: string; accountId: string; itemId?: string; trackingOptionId?: string }
export interface Account { id: number; code: string; name: string; type: string }
export interface Item { id: number; code: string; name: string; kind: string; hsnSac: string | null; saleRate: number; purchaseRate: number; gstRateBp: number; salesAccountId: number | null; purchaseAccountId: number | null; trackStock?: boolean }
export interface TrackingCategory { id: number; name: string; options: { id: number; name: string }[] }
export const emptyLine = (): Line => ({ description: '', hsnSac: '', quantity: '1', rate: '', gstRateBp: '1800', accountId: '' });

/** Convert editor lines to the API shape (rate in paise, numbers parsed). Throws on a bad amount. */
export function linesToApi(lines: Line[]) {
  return lines.map((l) => ({ description: l.description, quantity: Number(l.quantity), rate: toPaise(l.rate), gstRateBp: Number(l.gstRateBp),
    ...(l.hsnSac ? { hsnSac: l.hsnSac } : {}), ...(l.accountId ? { accountId: Number(l.accountId) } : {}),
    ...(l.itemId ? { itemId: Number(l.itemId) } : {}), ...(l.trackingOptionId ? { trackingOptionId: Number(l.trackingOptionId) } : {}) }));
}

/** Document lines as the API returns them -> editor lines. */
export function linesFromApi(lines: { description: string; hsnSac?: string | null; quantity?: number; qtyMilli?: number; rate: number; gstRateBp: number; accountId?: number | null; itemId?: number | null; trackingOptionId?: number | null }[]): Line[] {
  return lines.map((l) => ({ description: l.description, hsnSac: l.hsnSac ?? '', quantity: String(l.quantity ?? (l.qtyMilli ?? 1000) / 1000), rate: String(l.rate / 100), gstRateBp: String(l.gstRateBp),
    accountId: l.accountId ? String(l.accountId) : '', ...(l.itemId ? { itemId: String(l.itemId) } : {}), ...(l.trackingOptionId ? { trackingOptionId: String(l.trackingOptionId) } : {}) }));
}

/** Customer or supplier: type to search, or pick from the list. */
export function ContactPicker({ label, contacts, value, onChange }: { label: string; contacts: Contact[]; value: string; onChange: (id: string) => void }) {
  const selected = contacts.find((c) => String(c.id) === value);
  const [text, setText] = useState(selected?.name ?? '');
  useEffect(() => { setText(selected?.name ?? ''); }, [selected?.name]);
  const listId = useMemo(() => `contacts-${Math.random().toString(36).slice(2)}`, []);
  const resolve = (v: string) => contacts.find((c) => c.name.toLowerCase() === v.trim().toLowerCase());
  const change = (v: string) => { setText(v); const hit = resolve(v); onChange(hit ? String(hit.id) : ''); };
  // The list can arrive after the name was typed (slow network, or the contact was just added): match again when it does.
  useEffect(() => { const hit = resolve(text); if (hit && String(hit.id) !== value) onChange(String(hit.id)); }, [contacts]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div>
      <Field label={label} aria-label="Contact" list={listId} autoComplete="off" placeholder="Start typing a name…" value={text} onChange={(e) => change(e.target.value)} />
      <datalist id={listId}>{contacts.map((c) => <option key={c.id} value={c.name}>{c.gstin ?? ''}</option>)}</datalist>
      {text.trim() && !value && <p className="mt-1 text-xs text-amber-700">No contact with this name. Pick one from the list, or add it under Contacts.</p>}
    </div>
  );
}

const lineAmount = (qty: string, rate: string) => { try { return Math.round(Math.round(Number(qty || 0) * 1000) * toPaise(rate || '0') / 1000); } catch { return 0; } };

/** GST split the way the server works it out: same state = CGST + SGST (half rate each), different state = IGST. */
export function taxSummary(lines: Line[], intra: boolean, noTax = false) {
  const byRate = new Map<number, { taxable: number; cgst: number; sgst: number; igst: number }>();
  let subtotal = 0;
  for (const l of lines) {
    const taxable = lineAmount(l.quantity, l.rate), bp = Number(l.gstRateBp) || 0;
    subtotal += taxable;
    if (noTax || !bp) continue;
    const cur = byRate.get(bp) ?? { taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    cur.taxable += taxable;
    if (intra) { const half = Math.round(taxable * (bp / 2) / 10000); cur.cgst += half; cur.sgst += half; } else cur.igst += Math.round(taxable * bp / 10000);
    byRate.set(bp, cur);
  }
  const rows = [...byRate.entries()].sort((a, b) => a[0] - b[0]);
  const cgst = rows.reduce((s, [, r]) => s + r.cgst, 0), sgst = rows.reduce((s, [, r]) => s + r.sgst, 0), igst = rows.reduce((s, [, r]) => s + r.igst, 0);
  return { subtotal, rows, cgst, sgst, igst, gst: cgst + sgst + igst, total: subtotal + cgst + sgst + igst };
}

export function LinesEditor({ org, lines, setLines, sales, accounts, currency = 'INR', intra = true, noTax = false }:
  { org: Org; lines: Line[]; setLines: (l: Line[]) => void; sales: boolean; accounts: Account[]; currency?: string; intra?: boolean; noTax?: boolean }) {
  const [rates, setRates] = useState<{ rateBp: number; label: string }[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [tracking, setTracking] = useState<TrackingCategory[]>([]);
  const [newItem, setNewItem] = useState<null | { code: string; name: string; kind: string; hsnSac: string; rate: string; gstRateBp: string; accountId: string }>(null);
  const { error, busy, run } = useAction();
  const loadItems = () => api<Item[]>(`/orgs/${org.id}/items`).then(setItems);
  useEffect(() => { api('/config/gst-rates').then(setRates); loadItems(); api<TrackingCategory[]>(`/orgs/${org.id}/tracking`).then(setTracking); }, [org.id]);
  const trackingOptions = tracking.flatMap((c) => c.options.map((o) => ({ id: o.id, label: `${c.name}: ${o.name}` })));
  const options = accounts.filter((a) => (sales ? a.type === 'income' : a.type === 'expense' || a.type === 'asset'));
  const set = (i: number, k: keyof Line, v: string) => setLines(lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  const total = (l: Line) => lineAmount(l.quantity, l.rate);
  const rowFor = (it: Item): Line => {
    const rate = sales ? it.saleRate : it.purchaseRate, acc = sales ? it.salesAccountId : it.purchaseAccountId;
    return { description: it.name, hsnSac: it.hsnSac ?? '', quantity: '1', rate: String(rate / 100), gstRateBp: String(it.gstRateBp), accountId: acc ? String(acc) : '', itemId: String(it.id) };
  };
  const addRow = (row: Line) => setLines(lines.length === 1 && !lines[0].description && !lines[0].rate ? [row] : [...lines, row]);
  const addItem = (id: string) => { const it = items.find((x) => x.id === Number(id)); if (it) addRow(rowFor(it)); };
  const sum = taxSummary(lines, intra, noTax);
  const acct = (code: string) => { const a = accounts.find((x) => x.code === code); return a ? `${a.code} ${a.name}` : code; };
  const codes = sales ? ['2100', '2110', '2120'] : ['1300', '1310', '1320'];
  const cur = currency === 'INR' ? '₹' : currency + ' ';

  const saveNewItem = () => run(async () => {
    if (!newItem) return;
    const r = await api(`/orgs/${org.id}/items`, { body: { code: newItem.code, name: newItem.name, kind: newItem.kind, gstRateBp: Number(newItem.gstRateBp),
      ...(sales ? { saleRate: newItem.rate ? toPaise(newItem.rate) : 0 } : { purchaseRate: newItem.rate ? toPaise(newItem.rate) : 0 }),
      ...(newItem.hsnSac ? { hsnSac: newItem.hsnSac } : {}), ...(newItem.accountId ? (sales ? { salesAccountId: Number(newItem.accountId) } : { purchaseAccountId: Number(newItem.accountId) }) : {}) } });
    const list = await api<Item[]>(`/orgs/${org.id}/items`);
    setItems(list);
    const made = list.find((x) => x.id === r.id);
    if (made) addRow(rowFor(made));
    setNewItem(null);
  });

  return (
    <div className="mt-4">
      <div className="mb-2 flex flex-wrap items-center gap-3 text-sm">
        <select aria-label="Add from catalogue" className="rounded border border-slate-300 px-2 py-1" value="" onChange={(e) => addItem(e.target.value)}>
          <option value="">Add product or service…</option>{items.map((i) => <option key={i.id} value={i.id}>{i.code} · {i.name}</option>)}</select>
        <button type="button" className="text-brand-700 underline" onClick={() => setNewItem(newItem ? null : { code: '', name: '', kind: 'service', hsnSac: '', rate: '', gstRateBp: '1800', accountId: '' })}>{newItem ? 'Cancel new item' : '+ Create a new product or service'}</button>
      </div>
      {newItem && (
        <div className="mb-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
          <div className="grid gap-3 md:grid-cols-4">
            <Field label="Code" value={newItem.code} onChange={(e) => setNewItem({ ...newItem, code: e.target.value })} />
            <Field label="Name" value={newItem.name} onChange={(e) => setNewItem({ ...newItem, name: e.target.value })} />
            <label className="block text-sm"><span className="mb-1 block font-medium text-slate-600">Kind</span>
              <select aria-label="New item kind" className="w-full rounded-md border border-slate-300 bg-white px-3 py-2" value={newItem.kind} onChange={(e) => setNewItem({ ...newItem, kind: e.target.value })}><option value="service">Service</option><option value="goods">Goods</option></select></label>
            <Field label="HSN / SAC" value={newItem.hsnSac} onChange={(e) => setNewItem({ ...newItem, hsnSac: e.target.value })} />
            <Field label={sales ? 'Sale price (₹)' : 'Purchase price (₹)'} inputMode="decimal" value={newItem.rate} onChange={(e) => setNewItem({ ...newItem, rate: e.target.value })} />
            <label className="block text-sm"><span className="mb-1 block font-medium text-slate-600">GST rate</span>
              <select aria-label="New item GST rate" className="w-full rounded-md border border-slate-300 bg-white px-3 py-2" value={newItem.gstRateBp} onChange={(e) => setNewItem({ ...newItem, gstRateBp: e.target.value })}>{rates.map((r) => <option key={r.rateBp} value={r.rateBp}>{r.label}</option>)}</select></label>
            <label className="block text-sm"><span className="mb-1 block font-medium text-slate-600">{sales ? 'Default sales account' : 'Default purchase account'}</span>
              <select aria-label="New item account" className="w-full rounded-md border border-slate-300 bg-white px-3 py-2" value={newItem.accountId} onChange={(e) => setNewItem({ ...newItem, accountId: e.target.value })}><option value="">Default</option>{options.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select></label>
          </div>
          <div className="mt-3 flex items-center gap-3"><Button disabled={busy || !newItem.code || !newItem.name} onClick={saveNewItem}>Save and add to this document</Button><ErrorMsg msg={error} /></div>
        </div>
      )}
      {trackingOptions.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          <label className="font-medium text-slate-600" htmlFor="cc-all">Cost centre for the whole document</label>
          <select id="cc-all" aria-label="Cost centre for all lines" className="rounded border border-slate-300 bg-white px-2 py-1" value={lines.every((l) => (l.trackingOptionId ?? '') === (lines[0].trackingOptionId ?? '')) ? lines[0].trackingOptionId ?? '' : 'mixed'}
            onChange={(e) => e.target.value !== 'mixed' && setLines(lines.map((l) => ({ ...l, trackingOptionId: e.target.value })))}>
            <option value="">None</option>
            {!lines.every((l) => (l.trackingOptionId ?? '') === (lines[0].trackingOptionId ?? '')) && <option value="mixed">Different on each line</option>}
            {trackingOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select>
          <span className="text-xs text-slate-500">Sets every line below. You can still change a single line.</span>
        </div>
      )}
      <table className="w-full text-sm">
        <thead><tr className="text-left text-slate-500"><th>Description</th><th className="w-24">HSN/SAC</th><th className="w-20">Qty</th><th className="w-28">Rate ({currency === 'INR' ? '₹' : currency})</th><th className="w-24">GST</th><th className="w-48">Account</th>{trackingOptions.length > 0 && <th className="w-44">Cost centre</th>}<th className="w-28 text-right">Amount</th><th className="w-8" /></tr></thead>
        <tbody>{lines.map((l, i) => {
          const bp = Number(l.gstRateBp) || 0;
          return (
            <tr key={i}>
              <td className="pr-1"><div className="flex items-center gap-1"><input aria-label={`Description ${i + 1}`} className="w-full rounded border border-slate-300 px-2 py-1" value={l.description} onChange={(e) => set(i, 'description', e.target.value)} />
                {items.find((x) => String(x.id) === l.itemId)?.trackStock && <span title="Stock is tracked for this item" className="rounded bg-brand-50 px-1.5 text-xs text-brand-700">stock</span>}</div></td>
              <td className="pr-1"><input aria-label={`HSN ${i + 1}`} className="w-full rounded border border-slate-300 px-2 py-1" value={l.hsnSac} onChange={(e) => set(i, 'hsnSac', e.target.value)} /></td>
              <td className="pr-1"><input aria-label={`Qty ${i + 1}`} className="w-full rounded border border-slate-300 px-2 py-1 text-right" value={l.quantity} onChange={(e) => set(i, 'quantity', e.target.value)} /></td>
              <td className="pr-1"><input aria-label={`Rate ${i + 1}`} className="w-full rounded border border-slate-300 px-2 py-1 text-right" inputMode="decimal" value={l.rate} onChange={(e) => set(i, 'rate', e.target.value)} /></td>
              <td className="pr-1"><select aria-label={`GST ${i + 1}`} className="w-full rounded border border-slate-300 px-1 py-1" value={l.gstRateBp} onChange={(e) => set(i, 'gstRateBp', e.target.value)}>
                {rates.map((r) => <option key={r.rateBp} value={r.rateBp}>{r.label}</option>)}</select>
                {bp > 0 && !noTax && <span className="block text-[11px] text-slate-500">{intra ? `CGST ${bp / 200}% + SGST ${bp / 200}%` : `IGST ${bp / 100}%`}</span>}</td>
              <td className="pr-1"><select aria-label={`Account ${i + 1}`} className="w-full rounded border border-slate-300 px-1 py-1" value={l.accountId} onChange={(e) => set(i, 'accountId', e.target.value)}>
                <option value="">Default</option>{options.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select></td>
              {trackingOptions.length > 0 && <td className="pr-1"><select aria-label={`Cost centre ${i + 1}`} className="w-full rounded border border-slate-300 px-1 py-1" value={l.trackingOptionId ?? ''} onChange={(e) => set(i, 'trackingOptionId', e.target.value)}>
                <option value="">—</option>{trackingOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select></td>}
              <td className="text-right">{fmt(total(l))}</td>
              <td>{lines.length > 1 && <button type="button" aria-label={`Remove line ${i + 1}`} className="text-slate-400 hover:text-red-600" onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</button>}</td>
            </tr>);
        })}</tbody>
      </table>
      <button type="button" className="mt-2 text-sm text-brand-700 underline" onClick={() => setLines([...lines, emptyLine()])}>+ Add line</button>

      <div className="mt-4 flex justify-end">
        <table className="w-full max-w-md text-sm" data-testid="doc-totals">
          <tbody>
            <tr><td className="py-1 text-slate-600">Taxable value (before GST){currency !== 'INR' ? ` (${currency})` : ''}</td><td className="py-1 text-right font-medium" data-testid="taxable-total">{cur}{fmt(sum.subtotal)}</td></tr>
            {sum.rows.map(([bp, r]) => intra
              ? <tr key={bp} className="text-slate-600"><td className="py-0.5 pl-3">CGST {bp / 200}% + SGST {bp / 200}% on {cur}{fmt(r.taxable)}<span className="block text-[11px] text-slate-500">{acct(codes[0])} · {acct(codes[1])}</span></td><td className="py-0.5 text-right">{cur}{fmt(r.cgst)} + {cur}{fmt(r.sgst)}</td></tr>
              : <tr key={bp} className="text-slate-600"><td className="py-0.5 pl-3">IGST {bp / 100}% on {cur}{fmt(r.taxable)}<span className="block text-[11px] text-slate-500">{acct(codes[2])}</span></td><td className="py-0.5 text-right">{cur}{fmt(r.igst)}</td></tr>)}
            <tr><td className="py-1 text-slate-600">Total GST</td><td className="py-1 text-right font-medium" data-testid="gst-total">{cur}{fmt(sum.gst)}</td></tr>
            <tr className="border-t-2 border-slate-300"><td className="pt-2 font-semibold">Total {sales ? 'invoice' : 'bill'} value</td><td className="pt-2 text-right text-base font-semibold" data-testid="grand-total">{cur}{fmt(sum.total)}</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
