// Shared line-item editor used by invoices, bills, quotes, purchase orders and repeating invoices.
import { useEffect, useMemo, useState } from 'react';
import { api, fmt, toPaise } from '../api';
import type { Org } from '../App';
import { Icon } from '../table';
import { Button, ErrorMsg, Field, useAction } from '../ui';
import { ContactEditor, type Contact } from './Contacts';
import { Combo } from '../combo';

export interface Line { description: string; hsnSac: string; quantity: string; rate: string; gstRateBp: string; accountId: string; itemId?: string; trackingOptionId?: string;
  /** GST unit quantity code (UQC), e.g. NOS, KGS, HRS. */ unit?: string;
  /** Compensation cess, in percent (for example "22"). */ cess?: string;
  /** "1" when the input credit on this purchase line is blocked under section 17(5). */ itcBlocked?: string }
export interface Account { id: number; code: string; name: string; type: string; group?: string }
export interface Item { id: number; code: string; name: string; kind: string; hsnSac: string | null; unit?: string | null; saleRate: number; purchaseRate: number; gstRateBp: number; salesAccountId: number | null; purchaseAccountId: number | null; trackStock?: boolean }
export interface TrackingCategory { id: number; name: string; options: { id: number; name: string }[] }
export const emptyLine = (): Line => ({ description: '', hsnSac: '', quantity: '1', rate: '', gstRateBp: '1800', accountId: '', unit: '' });

/** GST unit quantity codes (UQC), as accepted in GSTR-1 and e-invoices. Services usually use OTH or NOS. */
export const UNITS: [string, string][] = [
  ['BAG', 'Bags'], ['BAL', 'Bale'], ['BDL', 'Bundles'], ['BKL', 'Buckles'], ['BOU', 'Billion of units'], ['BOX', 'Box'], ['BTL', 'Bottles'], ['BUN', 'Bunches'], ['CAN', 'Cans'], ['CBM', 'Cubic metres'], ['CCM', 'Cubic centimetres'], ['CMS', 'Centimetres'], ['CTN', 'Cartons'], ['DOZ', 'Dozens'], ['DRM', 'Drums'], ['GGK', 'Great gross'], ['GMS', 'Grams'], ['GRS', 'Gross'], ['GYD', 'Gross yards'], ['KGS', 'Kilograms'], ['KLR', 'Kilolitres'], ['KME', 'Kilometres'], ['LTR', 'Litres'], ['MLS', 'Millilitres (MLS)'], ['MLT', 'Millilitres'], ['MTR', 'Metres'], ['MTS', 'Metric tonnes'], ['NOS', 'Numbers'], ['OTH', 'Others'], ['PAC', 'Packs'], ['PCS', 'Pieces'], ['PRS', 'Pairs'], ['QTL', 'Quintals'], ['ROL', 'Rolls'], ['SET', 'Sets'], ['SQF', 'Square feet'], ['SQM', 'Square metres'], ['SQY', 'Square yards'], ['TBS', 'Tablets'], ['TGM', 'Ten grams'], ['THD', 'Thousands'], ['TON', 'Tonnes'], ['TUB', 'Tubes'], ['UGS', 'US gallons'], ['UNT', 'Units'], ['YDS', 'Yards'],
];

/** Convert editor lines to the API shape (rate in paise, numbers parsed). Throws on a bad amount. */
export function linesToApi(lines: Line[]) {
  return lines.map((l) => ({ description: l.description, quantity: Number(l.quantity), rate: toPaise(l.rate), gstRateBp: Number(l.gstRateBp),
    ...(l.hsnSac ? { hsnSac: l.hsnSac } : {}), ...(l.unit ? { unit: l.unit } : {}), ...(l.accountId ? { accountId: Number(l.accountId) } : {}),
    ...(l.itemId ? { itemId: Number(l.itemId) } : {}), ...(l.trackingOptionId ? { trackingOptionId: Number(l.trackingOptionId) } : {}),
    ...(l.cess && Number(l.cess) > 0 ? { cessRateBp: Math.round(Number(l.cess) * 100) } : {}), ...(l.itcBlocked === '1' ? { itcBlocked: true } : {}) }));
}

/** Document lines as the API returns them -> editor lines. */
export function linesFromApi(lines: { description: string; hsnSac?: string | null; unit?: string | null; quantity?: number; qtyMilli?: number; rate: number; gstRateBp: number; accountId?: number | null; itemId?: number | null; trackingOptionId?: number | null; cessRateBp?: number; itcBlocked?: boolean }[]): Line[] {
  return lines.map((l) => ({ description: l.description, hsnSac: l.hsnSac ?? '', unit: l.unit ?? '', quantity: String(l.quantity ?? (l.qtyMilli ?? 1000) / 1000), rate: String(l.rate / 100), gstRateBp: String(l.gstRateBp),
    accountId: l.accountId ? String(l.accountId) : '', ...(l.itemId ? { itemId: String(l.itemId) } : {}), ...(l.trackingOptionId ? { trackingOptionId: String(l.trackingOptionId) } : {}),
    ...(l.cessRateBp ? { cess: String(l.cessRateBp / 100) } : {}), ...(l.itcBlocked ? { itcBlocked: '1' } : {}) }));
}

/**
 * Customer or supplier: a themed dropdown to type and search, "+ Create new contact" at the bottom, and a pencil that
 * opens the full contact form over the page (nothing typed on the invoice or bill is lost).
 */
export function ContactPicker({ label, contacts, value, onChange, org, accounts, kind, onSaved }: {
  label: string; contacts: Contact[]; value: string; onChange: (id: string) => void;
  /** With these, the pencil and "+ Create new contact" open the contact form; onSaved reloads the list. */
  org?: Org; accounts?: Account[]; kind?: 'customer' | 'supplier'; onSaved?: (id: number, msg: string) => void; onEdit?: (c: Contact) => void;
}) {
  const selected = contacts.find((c) => String(c.id) === value);
  const [text, setText] = useState(selected?.name ?? '');
  const [editing, setEditing] = useState<{ id?: number; name?: string } | null>(null);
  const [pending, setPending] = useState<number | null>(null);
  useEffect(() => { setText(selected?.name ?? ''); }, [selected?.name]);
  const resolve = (v: string) => contacts.find((c) => c.name.toLowerCase() === v.trim().toLowerCase());
  const change = (v: string) => { setText(v); const hit = resolve(v); onChange(hit ? String(hit.id) : ''); };
  // The list can arrive after the name was typed (slow network, or the contact was just added): match again when it does.
  useEffect(() => {
    if (pending && contacts.some((c) => c.id === pending)) { onChange(String(pending)); setPending(null); return; }
    const hit = resolve(text); if (hit && String(hit.id) !== value) onChange(String(hit.id));
  }, [contacts]); // eslint-disable-line react-hooks/exhaustive-deps
  const canEdit = !!(org && onSaved);
  return (
    <div>
      <label className="block text-sm"><span className="mb-1 block font-medium text-slate-600">{label}</span>
        <div className="flex items-center gap-1">
          <Combo className="flex-1" ariaLabel="Contact" value={text} onText={change} placeholder="Start typing a name…"
            options={contacts.map((c) => ({ text: c.name, sub: c.gstin ?? (c.kind === 'both' ? '' : c.kind) }))}
            onCreate={canEdit ? (t) => setEditing({ name: t }) : undefined} createLabel={`Create new ${kind ?? 'contact'}`} />
          {selected && canEdit && <button type="button" aria-label={`Edit ${selected.name}`} title={`Edit ${selected.name}`} onClick={() => setEditing({ id: selected.id })}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-300 bg-white hover:bg-slate-50"><Icon name="edit" /></button>}
        </div></label>
      {text.trim() && !value && <p className="mt-1 text-xs text-amber-700">No contact with this name. Pick one from the list{canEdit ? ', or choose "Create new" at the bottom of it' : ', or add it under Contacts'}.</p>}
      {editing && org && <ContactEditor org={org} accounts={accounts} id={editing.id} name={editing.name} kind={kind}
        onDone={(r) => { setEditing(null); if (r) { setPending(r.id); onSaved!(r.id, r.msg); } }} />}
    </div>
  );
}

const lineAmount = (qty: string, rate: string) => { try { return Math.round(Math.round(Number(qty || 0) * 1000) * toPaise(rate || '0') / 1000); } catch { return 0; } };

/** GST split the way the server works it out: same state = CGST + SGST (half rate each), different state = IGST. */
export function taxSummary(lines: Line[], intra: boolean, noTax = false) {
  const byRate = new Map<number, { taxable: number; cgst: number; sgst: number; igst: number }>();
  let subtotal = 0, cess = 0;
  for (const l of lines) {
    const taxable = lineAmount(l.quantity, l.rate), bp = Number(l.gstRateBp) || 0;
    subtotal += taxable;
    if (!noTax && Number(l.cess) > 0) cess += Math.round(taxable * Math.round(Number(l.cess) * 100) / 10000);
    if (noTax || !bp) continue;
    const cur = byRate.get(bp) ?? { taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    cur.taxable += taxable;
    if (intra) { const half = Math.round(taxable * (bp / 2) / 10000); cur.cgst += half; cur.sgst += half; } else cur.igst += Math.round(taxable * bp / 10000);
    byRate.set(bp, cur);
  }
  const rows = [...byRate.entries()].sort((a, b) => a[0] - b[0]);
  const cgst = rows.reduce((s, [, r]) => s + r.cgst, 0), sgst = rows.reduce((s, [, r]) => s + r.sgst, 0), igst = rows.reduce((s, [, r]) => s + r.igst, 0);
  return { subtotal, rows, cgst, sgst, igst, cess, gst: cgst + sgst + igst, total: subtotal + cgst + sgst + igst + cess };
}

type ItemForm = { id?: number; code: string; name: string; kind: string; hsnSac: string; unit: string; rate: string; gstRateBp: string; accountId: string; line?: number };

export function LinesEditor({ org, lines, setLines, sales, accounts, currency = 'INR', intra = true, noTax = false, contactDefaultId, tds, dutyOk = false }:
  { org: Org; lines: Line[]; setLines: (l: Line[]) => void; sales: boolean; accounts: Account[]; currency?: string; intra?: boolean; noTax?: boolean;
    /** Customs duty may be added as a line (export and SEZ invoices, when the organisation says duty applies). */ dutyOk?: boolean;
    /** The chosen contact's default sales or purchase account, shown as what "Default" means. */ contactDefaultId?: number | null;
    /** TDS this bill will carry, to show the balance payable after it. */ tds?: { section: string; amount: number } | null }) {
  const [rates, setRates] = useState<{ rateBp: number; label: string }[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [tracking, setTracking] = useState<TrackingCategory[]>([]);
  const [itemForm, setItemForm] = useState<ItemForm | null>(null);
  const [search, setSearch] = useState('');
  const { error, busy, run } = useAction();
  const loadItems = () => api<Item[]>(`/orgs/${org.id}/items`).then((l) => { setItems(l); return l; });
  useEffect(() => { api('/config/gst-rates').then(setRates); loadItems(); api<TrackingCategory[]>(`/orgs/${org.id}/tracking`).then(setTracking); }, [org.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const trackingOptions = tracking.flatMap((c) => c.options.map((o) => ({ id: o.id, label: `${c.name}: ${o.name}` })));
  // Cess and blocked credit are rare, so their columns appear only when asked for (or when a line already uses them).
  const [extra, setExtra] = useState(false);
  const showExtra = extra || lines.some((l) => Number(l.cess) > 0 || l.itcBlocked === '1');
  const options = accounts.filter((a) => (sales ? a.type === 'income' : a.type === 'expense' || a.type === 'asset'));
  const dutyLedgers = dutyOk ? accounts.filter((a) => a.type === 'liability' && /duties/i.test(a.group ?? '')) : [];
  const set = (i: number, k: keyof Line, v: string) => setLines(lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  const total = (l: Line) => lineAmount(l.quantity, l.rate);
  const rowFor = (it: Item): Line => {
    const rate = sales ? it.saleRate : it.purchaseRate, acc = sales ? it.salesAccountId : it.purchaseAccountId;
    return { description: it.name, hsnSac: it.hsnSac ?? '', unit: it.unit ?? '', quantity: '1', rate: String(rate / 100), gstRateBp: String(it.gstRateBp), accountId: acc ? String(acc) : '', itemId: String(it.id) };
  };
  const addRow = (row: Line) => setLines(lines.length === 1 && !lines[0].description && !lines[0].rate ? [row] : [...lines, row]);
  const itemLabel = (i: Item) => `${i.code} · ${i.name}`;
  const pickItem = (text: string) => {
    setSearch(text);
    const t = text.trim().toLowerCase();
    const it = items.find((x) => itemLabel(x).toLowerCase() === t) ?? items.find((x) => x.code.toLowerCase() === t);
    if (it) { addRow(rowFor(it)); setSearch(''); }
  };
  const sum = taxSummary(lines, intra, noTax);
  const acct = (code: string) => { const a = accounts.find((x) => x.code === code); return a ? `${a.code} ${a.name}` : code; };
  const codes = sales ? ['2100', '2110', '2120'] : ['1300', '1310', '1320'];
  const cur = currency === 'INR' ? '₹' : currency + ' ';
  /** What the empty "Default" account choice resolves to on saving: the product's account, the contact's default, then 4000 / 5000. */
  const defaultFor = (l: Line) => {
    const it = items.find((x) => String(x.id) === l.itemId);
    const id = (it && (sales ? it.salesAccountId : it.purchaseAccountId)) || contactDefaultId || accounts.find((a) => a.code === (sales ? '4000' : '5000'))?.id;
    const a = accounts.find((x) => x.id === id);
    return a ? `${a.code} ${a.name}` : 'none set';
  };

  const openNewItem = () => setItemForm(itemForm && !itemForm.id ? null : { code: '', name: '', kind: 'service', hsnSac: '', unit: '', rate: '', gstRateBp: '1800', accountId: '' });
  const openEditItem = (i: number) => {
    const it = items.find((x) => String(x.id) === lines[i].itemId); if (!it) return;
    const acc = sales ? it.salesAccountId : it.purchaseAccountId;
    setItemForm({ id: it.id, code: it.code, name: it.name, kind: it.kind, hsnSac: it.hsnSac ?? '', unit: it.unit ?? '', rate: String((sales ? it.saleRate : it.purchaseRate) / 100), gstRateBp: String(it.gstRateBp), accountId: acc ? String(acc) : '', line: i });
  };
  const saveItem = () => run(async () => {
    if (!itemForm) return;
    const f = itemForm;
    if (f.id) {
      const it = items.find((x) => x.id === f.id)!;
      const rate = f.rate ? toPaise(f.rate) : 0;
      await api(`/orgs/${org.id}/items/${f.id}`, { method: 'PUT', body: { name: f.name, hsnSac: f.hsnSac || null, unit: f.unit || null, gstRateBp: Number(f.gstRateBp),
        saleRate: sales ? rate : it.saleRate, purchaseRate: sales ? it.purchaseRate ?? 0 : rate,
        salesAccountId: sales ? (f.accountId ? Number(f.accountId) : null) : it.salesAccountId, purchaseAccountId: sales ? it.purchaseAccountId : (f.accountId ? Number(f.accountId) : null) } });
      const list = await loadItems();
      const made = list.find((x) => x.id === f.id);
      if (made && f.line != null) setLines(lines.map((l, j) => (j === f.line ? { ...rowFor(made), quantity: l.quantity, trackingOptionId: l.trackingOptionId, cess: l.cess, itcBlocked: l.itcBlocked } : l)));
    } else {
      const r = await api(`/orgs/${org.id}/items`, { body: { code: f.code, name: f.name, kind: f.kind, gstRateBp: Number(f.gstRateBp), ...(f.unit ? { unit: f.unit } : {}),
        ...(sales ? { saleRate: f.rate ? toPaise(f.rate) : 0 } : { purchaseRate: f.rate ? toPaise(f.rate) : 0 }),
        ...(f.hsnSac ? { hsnSac: f.hsnSac } : {}), ...(f.accountId ? (sales ? { salesAccountId: Number(f.accountId) } : { purchaseAccountId: Number(f.accountId) }) : {}) } });
      const list = await loadItems();
      const made = list.find((x) => x.id === r.id);
      if (made) addRow(rowFor(made));
    }
    setItemForm(null);
  });
  const sel = 'w-full rounded-md border border-slate-300 bg-white px-3 py-2';

  return (
    <div className="mt-4">
      <div className="mb-2 flex flex-wrap items-center gap-3 text-sm">
        <Combo className="w-full max-w-md" ariaLabel="Add from catalogue" value={search} onText={pickItem} placeholder="Search products and services"
          icon={<Icon name="search" className="text-slate-400" />} columns={['Item code', 'Product', 'HSN/SAC']}
          options={items.map((i) => ({ text: itemLabel(i), lead: i.code, label: i.name, sub: i.hsnSac ?? '' }))}
          onCreate={(t) => { if (!itemForm || itemForm.id) openNewItem(); if (t.trim()) setItemForm((x) => (x ? { ...x, name: t.trim() } : x)); }} createLabel="Create a new product or service" />
        <button type="button" className="text-brand-700 underline" onClick={openNewItem}>{itemForm && !itemForm.id ? 'Cancel new item' : '+ Create a new product or service'}</button>
      </div>
      {itemForm && (
        <div className="mb-3 rounded-lg border border-slate-200 bg-slate-50 p-3" data-testid="item-form">
          <p className="mb-2 text-sm font-semibold text-slate-700">{itemForm.id ? `Edit product: ${itemForm.code}` : 'New product or service'}</p>
          <div className="grid gap-3 md:grid-cols-4">
            {!itemForm.id && <Field label="Code" value={itemForm.code} onChange={(e) => setItemForm({ ...itemForm, code: e.target.value })} />}
            <Field label="Name" value={itemForm.name} onChange={(e) => setItemForm({ ...itemForm, name: e.target.value })} />
            {!itemForm.id && <label className="block text-sm"><span className="mb-1 block font-medium text-slate-600">Kind</span>
              <select aria-label="New item kind" className={sel} value={itemForm.kind} onChange={(e) => setItemForm({ ...itemForm, kind: e.target.value })}><option value="service">Service</option><option value="goods">Goods</option></select></label>}
            <Field label="HSN / SAC" value={itemForm.hsnSac} onChange={(e) => setItemForm({ ...itemForm, hsnSac: e.target.value })} />
            <label className="block text-sm"><span className="mb-1 block font-medium text-slate-600">Unit (UQC)</span>
              <select aria-label="Item unit" className={sel} value={itemForm.unit} onChange={(e) => setItemForm({ ...itemForm, unit: e.target.value })}><option value="">—</option>{UNITS.map(([c, n]) => <option key={c} value={c}>{c} · {n}</option>)}</select></label>
            <Field label={sales ? 'Sale price (₹)' : 'Purchase price (₹)'} inputMode="decimal" value={itemForm.rate} onChange={(e) => setItemForm({ ...itemForm, rate: e.target.value })} />
            <label className="block text-sm"><span className="mb-1 block font-medium text-slate-600">GST rate</span>
              <select aria-label="New item GST rate" className={sel} value={itemForm.gstRateBp} onChange={(e) => setItemForm({ ...itemForm, gstRateBp: e.target.value })}>{rates.map((r) => <option key={r.rateBp} value={r.rateBp}>{r.label}</option>)}</select></label>
            <label className="block text-sm"><span className="mb-1 block font-medium text-slate-600">{sales ? 'Default sales account' : 'Default purchase account'}</span>
              <select aria-label="New item account" className={sel} value={itemForm.accountId} onChange={(e) => setItemForm({ ...itemForm, accountId: e.target.value })}><option value="">Default</option>{options.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select></label>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button disabled={busy || !itemForm.name || (!itemForm.id && !itemForm.code)} onClick={saveItem}>{itemForm.id ? 'Save product and update this line' : 'Save and add to this document'}</Button>
            <Button variant="ghost" onClick={() => setItemForm(null)}>Cancel</Button><ErrorMsg msg={error} /></div>
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
      <label className="mb-2 flex items-center gap-2 text-xs text-slate-600"><input type="checkbox" aria-label="Show cess and blocked credit" checked={showExtra} disabled={showExtra && !extra}
        onChange={(e) => setExtra(e.target.checked)} />Compensation cess{!sales && ' or blocked input credit (section 17(5))'}</label>
      <table className="w-full text-sm">
        <thead><tr className="text-left text-slate-500"><th>Description</th><th className="w-24">HSN/SAC</th><th className="w-20">Qty</th><th className="w-24">Unit</th><th className="w-28">Rate ({currency === 'INR' ? '₹' : currency})</th><th className="w-24">GST</th><th className="w-52">Account</th>{trackingOptions.length > 0 && <th className="w-44">Cost centre</th>}{showExtra && <th className="w-20">Cess %</th>}{showExtra && !sales && <th className="w-20" title="Input credit blocked under section 17(5)">No ITC</th>}<th className="w-28 text-right">Amount</th><th className="w-8" /></tr></thead>
        <tbody>{lines.map((l, i) => (
          <tr key={i}>
            <td className="pr-1"><div className="flex items-center gap-1"><input aria-label={`Description ${i + 1}`} className="w-full rounded border border-slate-300 px-2 py-1" value={l.description} onChange={(e) => set(i, 'description', e.target.value)} />
              {l.itemId && <button type="button" aria-label={`Edit product on line ${i + 1}`} title="Edit this product" onClick={() => openEditItem(i)} className="rounded p-1 hover:bg-slate-100"><Icon name="edit" size={14} /></button>}
              {items.find((x) => String(x.id) === l.itemId)?.trackStock && <span title="Stock is tracked for this item" className="rounded bg-brand-50 px-1.5 text-xs text-brand-700">stock</span>}</div></td>
            <td className="pr-1"><input aria-label={`HSN ${i + 1}`} className="w-full rounded border border-slate-300 px-2 py-1" value={l.hsnSac} onChange={(e) => set(i, 'hsnSac', e.target.value)} /></td>
            <td className="pr-1"><input aria-label={`Qty ${i + 1}`} className="w-full rounded border border-slate-300 px-2 py-1 text-right" value={l.quantity} onChange={(e) => set(i, 'quantity', e.target.value)} /></td>
            <td className="pr-1"><select aria-label={`Unit ${i + 1}`} className="w-full rounded border border-slate-300 px-1 py-1" value={l.unit ?? ''} onChange={(e) => set(i, 'unit', e.target.value)}>
              <option value="">—</option>{UNITS.map(([c, n]) => <option key={c} value={c} title={n}>{c}</option>)}</select></td>
            <td className="pr-1"><input aria-label={`Rate ${i + 1}`} className="w-full rounded border border-slate-300 px-2 py-1 text-right" inputMode="decimal" value={l.rate} onChange={(e) => set(i, 'rate', e.target.value)} /></td>
            <td className="pr-1"><select aria-label={`GST ${i + 1}`} className="w-full rounded border border-slate-300 px-1 py-1" value={l.gstRateBp} onChange={(e) => set(i, 'gstRateBp', e.target.value)}>
              {rates.map((r) => <option key={r.rateBp} value={r.rateBp}>{r.label}</option>)}</select></td>
            <td className="pr-1"><select aria-label={`Account ${i + 1}`} className="w-full rounded border border-slate-300 px-1 py-1" value={l.accountId} onChange={(e) => set(i, 'accountId', e.target.value)}>
              <option value="">Default: {defaultFor(l)}</option>{options.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
              {dutyLedgers.length > 0 && <optgroup label="Duties and taxes (customs duty)">{dutyLedgers.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</optgroup>}</select></td>
            {trackingOptions.length > 0 && <td className="pr-1"><select aria-label={`Cost centre ${i + 1}`} className="w-full rounded border border-slate-300 px-1 py-1" value={l.trackingOptionId ?? ''} onChange={(e) => set(i, 'trackingOptionId', e.target.value)}>
              <option value="">—</option>{trackingOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select></td>}
            {showExtra && <td className="pr-1"><input aria-label={`Cess ${i + 1}`} inputMode="decimal" placeholder="0" className="w-full rounded border border-slate-300 px-2 py-1 text-right" value={l.cess ?? ''} onChange={(e) => set(i, 'cess', e.target.value)} /></td>}
            {showExtra && !sales && <td className="text-center"><input type="checkbox" aria-label={`Blocked credit ${i + 1}`} checked={l.itcBlocked === '1'} onChange={(e) => set(i, 'itcBlocked', e.target.checked ? '1' : '')} /></td>}
            <td className="text-right tabular-nums">{fmt(total(l))}</td>
            <td>{lines.length > 1 && <button type="button" aria-label={`Remove line ${i + 1}`} className="text-slate-400 hover:text-red-600" onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</button>}</td>
          </tr>))}</tbody>
      </table>
      <button type="button" className="mt-2 text-sm text-brand-700 underline" onClick={() => setLines([...lines, emptyLine()])}>+ Add line</button>
      {dutyOk && <button type="button" className="ml-4 mt-2 text-sm text-brand-700 underline" onClick={() => setLines([...lines, { ...emptyLine(), description: 'Customs duty', gstRateBp: '0', accountId: dutyLedgers[0] ? String(dutyLedgers[0].id) : '' }])}>+ Add customs duty</button>}

      <div className="mt-4 flex justify-end">
        <table className="w-full max-w-md text-sm" data-testid="doc-totals">
          <tbody>
            <tr><td className="py-1 text-slate-600">Taxable value (before GST){currency !== 'INR' ? ` (${currency})` : ''}</td><td className="py-1 text-right font-medium tabular-nums" data-testid="taxable-total">{cur}{fmt(sum.subtotal)}</td></tr>
            {sum.rows.flatMap(([bp, r]) => intra
              ? [<tr key={`c${bp}`} className="text-slate-600"><td className="py-0.5 pl-3">CGST @ {bp / 200}% on {cur}{fmt(r.taxable)}<span className="block text-[11px] text-slate-400">{acct(codes[0])}</span></td><td className="py-0.5 text-right tabular-nums">{cur}{fmt(r.cgst)}</td></tr>,
                 <tr key={`s${bp}`} className="text-slate-600"><td className="py-0.5 pl-3">SGST @ {bp / 200}% on {cur}{fmt(r.taxable)}<span className="block text-[11px] text-slate-400">{acct(codes[1])}</span></td><td className="py-0.5 text-right tabular-nums">{cur}{fmt(r.sgst)}</td></tr>]
              : [<tr key={`i${bp}`} className="text-slate-600"><td className="py-0.5 pl-3">IGST @ {bp / 100}% on {cur}{fmt(r.taxable)}<span className="block text-[11px] text-slate-400">{acct(codes[2])}</span></td><td className="py-0.5 text-right tabular-nums">{cur}{fmt(r.igst)}</td></tr>])}
            {sum.cess > 0 && <tr className="text-slate-600"><td className="py-0.5 pl-3">Compensation cess</td><td className="py-0.5 text-right tabular-nums" data-testid="cess-total">{cur}{fmt(sum.cess)}</td></tr>}
            {!sales && lines.some((l) => l.itcBlocked === '1') && <tr className="text-amber-700"><td colSpan={2} className="py-0.5 pl-3 text-xs">GST on lines marked "No ITC" is added to their cost and is not claimed.</td></tr>}
            <tr><td className="py-1 text-slate-600">Total GST</td><td className="py-1 text-right font-medium tabular-nums" data-testid="gst-total">{cur}{fmt(sum.gst)}</td></tr>
            <tr className="border-t-2 border-slate-300"><td className="pt-2 font-semibold">Total {sales ? 'invoice' : 'bill'} value</td><td className="pt-2 text-right text-base font-semibold tabular-nums" data-testid="grand-total">{cur}{fmt(sum.total)}</td></tr>
            {tds && <>
              <tr className="text-slate-600"><td className="py-1 pl-3">Less TDS u/s {tds.section}</td><td className="py-1 text-right tabular-nums" data-testid="tds-total">− {cur}{fmt(tds.amount)}</td></tr>
              <tr className="border-t border-slate-300"><td className="pt-1 font-semibold">Balance payable after TDS</td><td className="pt-1 text-right font-semibold tabular-nums" data-testid="net-payable">{cur}{fmt(sum.total - tds.amount)}</td></tr></>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
