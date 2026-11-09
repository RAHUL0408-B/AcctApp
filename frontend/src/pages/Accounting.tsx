// Products and services, fixed assets and organisation settings.
import { useCallback, useEffect, useState } from 'react';
import { api, download, fileToBase64, fmt, toPaise, today } from '../api';
import type { Org } from '../App';
import { Badge, Empty, PageHeader, Select } from '../kit';
import { Button, Card, ErrorMsg, Field, Ok, useAction } from '../ui';
import type { Account, Item } from './Lines';

export function Items({ org, canPost, accounts }: { org: Org; canPost: boolean; accounts: Account[] }) {
  const [items, setItems] = useState<Item[]>([]);
  const [rates, setRates] = useState<{ rateBp: number; label: string }[]>([]);
  const [show, setShow] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const blank = { code: '', name: '', kind: 'service', hsnSac: '', saleRate: '', purchaseRate: '', gstRateBp: '1800', salesAccountId: '', purchaseAccountId: '', trackStock: false };
  const [f, setF] = useState(blank);
  const { error, busy, run } = useAction();
  const load = useCallback(() => api<Item[]>(`/orgs/${org.id}/items`).then(setItems), [org.id]);
  useEffect(() => { load(); api('/config/gst-rates').then(setRates); }, [load]);
  const income = accounts.filter((a) => a.type === 'income'), costs = accounts.filter((a) => a.type === 'expense' || a.type === 'asset');
  const acct = (id: number | null) => { const a = accounts.find((x) => x.id === id); return a ? `${a.code} ${a.name}` : '—'; };
  const reset = () => { setF(blank); setEditing(null); setShow(false); };
  const save = () => run(async () => {
    const common = { name: f.name, gstRateBp: Number(f.gstRateBp), saleRate: f.saleRate ? toPaise(f.saleRate) : 0, purchaseRate: f.purchaseRate ? toPaise(f.purchaseRate) : 0 };
    if (editing) {
      await api(`/orgs/${org.id}/items/${editing}`, { method: 'PUT', body: { ...common, hsnSac: f.hsnSac || null, salesAccountId: f.salesAccountId ? Number(f.salesAccountId) : null, purchaseAccountId: f.purchaseAccountId ? Number(f.purchaseAccountId) : null } });
    } else {
      await api(`/orgs/${org.id}/items`, { body: { ...common, code: f.code, kind: f.kind, ...(f.hsnSac ? { hsnSac: f.hsnSac } : {}), ...(f.salesAccountId ? { salesAccountId: Number(f.salesAccountId) } : {}),
        ...(f.purchaseAccountId ? { purchaseAccountId: Number(f.purchaseAccountId) } : {}), trackStock: f.kind === 'goods' && f.trackStock } });
    }
    reset(); load();
  });
  const edit = (i: Item) => {
    setF({ code: i.code, name: i.name, kind: i.kind, hsnSac: i.hsnSac ?? '', saleRate: i.saleRate ? String(i.saleRate / 100) : '', purchaseRate: i.purchaseRate ? String(i.purchaseRate / 100) : '', gstRateBp: String(i.gstRateBp),
      salesAccountId: i.salesAccountId ? String(i.salesAccountId) : '', purchaseAccountId: i.purchaseAccountId ? String(i.purchaseAccountId) : '', trackStock: !!i.trackStock });
    setEditing(i.id); setShow(true); window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  return (
    <>
      <PageHeader title="Products and services" subtitle="Saved items fill in HSN/SAC, price, GST rate and the default account when you raise an invoice or bill." actions={canPost && <Button onClick={() => { if (show) reset(); else { setF(blank); setEditing(null); setShow(true); } }}>{show ? 'Close' : 'New item'}</Button>} />
      <div className="mb-3"><ErrorMsg msg={error} /></div>
      {show && (
        <Card title={editing ? `Edit ${f.name || 'item'}` : 'New item'}>
          <div className="grid gap-3 md:grid-cols-4">
            <Field label="Code" value={f.code} disabled={!!editing} onChange={(e) => setF({ ...f, code: e.target.value })} />
            <Field label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            <Select label="Kind" aria-label="Item kind" value={f.kind} disabled={!!editing} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="service">Service</option><option value="goods">Goods</option></Select>
            <Field label="HSN / SAC" value={f.hsnSac} onChange={(e) => setF({ ...f, hsnSac: e.target.value })} />
            <Field label="Sale price (₹)" value={f.saleRate} onChange={(e) => setF({ ...f, saleRate: e.target.value })} />
            <Field label="Purchase price (₹)" value={f.purchaseRate} onChange={(e) => setF({ ...f, purchaseRate: e.target.value })} />
            <Select label="GST rate" aria-label="Item GST rate" value={f.gstRateBp} onChange={(e) => setF({ ...f, gstRateBp: e.target.value })}>{rates.map((r) => <option key={r.rateBp} value={r.rateBp}>{r.label}</option>)}</Select>
            {f.kind === 'goods' && !editing && <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" aria-label="Track stock" checked={f.trackStock} onChange={(e) => setF({ ...f, trackStock: e.target.checked })} />Track stock quantity and cost</label>}
            <Select label="Default sales account" aria-label="Item sales account" value={f.salesAccountId} onChange={(e) => setF({ ...f, salesAccountId: e.target.value })}><option value="">Default (4000)</option>{income.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</Select>
            <Select label="Default purchase account" aria-label="Item purchase account" value={f.purchaseAccountId} onChange={(e) => setF({ ...f, purchaseAccountId: e.target.value })}><option value="">Default (5000)</option>{costs.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</Select>
          </div>
          <p className="mt-2 text-xs text-slate-500">Invoices post this item to its default sales account, bills to its default purchase account. Stock-tracked goods always go to Inventory on a bill.</p>
          <div className="mt-3 flex gap-3"><Button disabled={busy} onClick={save}>{editing ? 'Save changes' : 'Save item'}</Button>{editing && <Button variant="ghost" onClick={reset}>Cancel</Button>}</div>
        </Card>
      )}
      <Card>
        {items.length === 0 ? <Empty text="No products or services yet." /> : (
          <table className="w-full text-sm"><thead><tr className="text-left text-slate-500"><th>Code</th><th>Name</th><th>Kind</th><th>HSN/SAC</th><th className="text-right">Sale</th><th className="text-right">Purchase</th><th className="text-right">GST</th><th>Sales a/c</th><th>Purchase a/c</th><th /></tr></thead>
            <tbody>{items.map((i) => (
              <tr key={i.id} className="border-t border-slate-100"><td className="py-2 font-medium">{i.code}</td><td>{i.name}</td><td>{i.kind}{i.trackStock && <span className="ml-1 rounded bg-brand-50 px-1.5 text-xs text-brand-700">stock</span>}</td><td>{i.hsnSac ?? ''}</td><td className="text-right">{fmt(i.saleRate)}</td><td className="text-right">{fmt(i.purchaseRate)}</td><td className="text-right">{i.gstRateBp / 100}%</td>
                <td>{acct(i.salesAccountId)}</td><td>{acct(i.purchaseAccountId)}</td>
                <td className="whitespace-nowrap text-right">{canPost && <><Button variant="ghost" onClick={() => edit(i)}>Edit</Button> <Button variant="ghost" onClick={() => run(async () => { await api(`/orgs/${org.id}/items/${i.id}/archive`, { method: 'POST', body: {} }); load(); })}>Archive</Button></>}</td></tr>))}</tbody></table>
        )}
      </Card>
    </>
  );
}

interface Asset { id: number; code: string; name: string; group: string | null; purchaseDate: string; cost: number; residual: number; method: string; rateBp: number; usefulLifeMonths: number | null; dayBasis: string; status: string; accumulated: number; bookValue: number; disposedOn: string | null; disposalProceeds: number | null; disposalGain: number | null }
interface AssetGroup { name: string; itRateBp: number; lifeYears: number; examples: string }
interface Attachment { id: number; name: string }

const METHODS = [['wdv', 'Written down value (rate %)'], ['slm', 'Straight line (rate %)'], ['slm_life', 'Straight line over useful life']] as const;
const methodText = (a: Asset) => (a.method === 'slm_life' ? `SLM ${Math.round((a.usefulLifeMonths ?? 0) / 12 * 100) / 100} yrs` : `${a.method === 'slm' ? 'SLM' : 'WDV'} ${a.rateBp / 100}%`);

export function FixedAssets({ org, canManage, accounts = [] }: { org: Org; canManage: boolean; accounts?: Account[] }) {
  const [list, setList] = useState<Asset[]>([]);
  const [groups, setGroups] = useState<AssetGroup[]>([]);
  const [show, setShow] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const blank = { name: '', code: '', group: '', purchaseDate: today(), cost: '', residual: '0', method: 'wdv', rate: '15', lifeYears: '', dayBasis: 'months' };
  const [f, setF] = useState(blank);
  const [files, setFiles] = useState<File[]>([]);
  const [existing, setExisting] = useState<Attachment[]>([]);
  const [through, setThrough] = useState(today());
  const [disposing, setDisposing] = useState<{ id: number; name: string; date: string; proceeds: string; accountId: string; preview: any | null } | null>(null);
  const [ok, setOk] = useState('');
  const { error, busy, run } = useAction();
  const load = useCallback(() => api<Asset[]>(`/orgs/${org.id}/fixed-assets`).then(setList), [org.id]);
  useEffect(() => { load(); api<AssetGroup[]>(`/orgs/${org.id}/asset-groups`).then(setGroups); }, [load, org.id]);
  useEffect(() => { if (show && !editing && !f.code) api(`/orgs/${org.id}/fixed-assets-next-code`).then((r) => setF((x) => (x.code ? x : { ...x, code: r.code }))); }, [show, editing, org.id, list.length]);
  const totalBook = list.filter((a) => a.status === 'active').reduce((s, a) => s + a.bookValue, 0);
  const proceedAccounts = accounts.filter((a) => a.type === 'asset' && !['1100', '1200', '1600', '1690'].includes(a.code));
  const group = groups.find((g) => g.name === f.group);

  const pickGroup = (name: string) => {
    const g = groups.find((x) => x.name === name);
    // A group fills in the usual Income Tax Act written-down-value rate. The user can change anything afterwards.
    setF({ ...f, group: name, ...(g && f.method !== 'slm_life' ? { rate: String(g.itRateBp / 100) } : {}), ...(g && f.method === 'slm_life' ? { lifeYears: String(g.lifeYears) } : {}) });
  };
  const pickMethod = (method: string) => setF({ ...f, method, ...(method === 'slm_life' && group ? { lifeYears: String(group.lifeYears) } : {}) });
  const reset = () => { setF(blank); setEditing(null); setFiles([]); setExisting([]); setShow(false); };
  const payload = () => ({ name: f.name, ...(f.code.trim() ? { code: f.code.trim() } : {}), ...(f.group ? { group: f.group } : {}), purchaseDate: f.purchaseDate, cost: toPaise(f.cost), residual: toPaise(f.residual || '0'), method: f.method, dayBasis: f.dayBasis,
    ...(f.method === 'slm_life' ? { usefulLifeMonths: Math.round(Number(f.lifeYears) * 12) } : { rateBp: Math.round(Number(f.rate) * 100) }) });
  const save = () => run(async () => {
    const r = editing ? await api(`/orgs/${org.id}/fixed-assets/${editing}`, { method: 'PUT', body: payload() }) : await api(`/orgs/${org.id}/fixed-assets`, { body: payload() });
    const id = editing ?? r.id;
    let note = '';
    for (const file of files) {
      try { await api(`/orgs/${org.id}/files`, { body: { name: file.name, mime: file.type || 'application/octet-stream', dataBase64: await fileToBase64(file), linkType: 'asset', linkId: id } }); }
      catch (e) { note = ` The asset was saved, but ${file.name} could not be attached: ${(e as Error).message}`; }
    }
    setOk(`${editing ? 'Updated' : 'Added'} asset ${r.code}.${note}`); reset(); load();
  });
  const edit = async (a: Asset) => {
    setOk('');
    setF({ name: a.name, code: a.code, group: a.group ?? '', purchaseDate: a.purchaseDate.slice(0, 10), cost: String(a.cost / 100), residual: String(a.residual / 100), method: a.method, rate: String(a.rateBp / 100), lifeYears: a.usefulLifeMonths ? String(a.usefulLifeMonths / 12) : '', dayBasis: a.dayBasis });
    setExisting(await api<Attachment[]>(`/orgs/${org.id}/files?linkType=asset&linkId=${a.id}`).catch(() => []));
    setFiles([]); setEditing(a.id); setShow(true); window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const exportRegister = (format: 'xlsx' | 'pdf') => run(() => download(`/orgs/${org.id}/export/fixed-assets?format=${format}&asOf=${today()}`, `fixed-asset-register.${format === 'xlsx' ? 'xlsx' : 'pdf'}`));

  const disposeCall = (d: NonNullable<typeof disposing>, preview: boolean) => api(`/orgs/${org.id}/fixed-assets/${d.id}/dispose`, { body: { date: d.date, proceeds: d.proceeds ? toPaise(d.proceeds) : 0, ...(d.accountId ? { accountId: Number(d.accountId) } : {}), preview } });
  const previewDisposal = () => run(async () => { if (disposing) setDisposing({ ...disposing, preview: await disposeCall(disposing, true) }); });
  const postDisposal = () => run(async () => {
    if (!disposing) return;
    const r = await disposeCall(disposing, false);
    setOk(`${disposing.name} disposed. ${r.gain >= 0 ? 'Profit' : 'Loss'} on sale ₹${fmt(Math.abs(r.gain))} posted to the books.`); setDisposing(null); load();
  });
  const dis = disposing?.preview;

  return (
    <>
      <PageHeader title="Fixed assets" subtitle="Asset register with depreciation posted to the ledger." actions={<>
        <Button variant="ghost" disabled={busy} onClick={() => exportRegister('xlsx')}>Export Excel</Button>
        <Button variant="ghost" disabled={busy} onClick={() => exportRegister('pdf')}>Export PDF</Button>
        {canManage && <Button onClick={() => { if (show) reset(); else { setF(blank); setEditing(null); setShow(true); } }}>{show ? 'Close' : 'New asset'}</Button>}</>} />
      <div className="mb-3 space-y-2"><ErrorMsg msg={error} /><Ok msg={ok} /></div>
      {show && (
        <Card title={editing ? `Edit ${f.name || 'asset'}` : 'New asset'}>
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Asset code" aria-label="Asset code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />
            <Field label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            <Select label="Asset group" aria-label="Asset group" value={f.group} onChange={(e) => pickGroup(e.target.value)}><option value="">Select a group…</option>{groups.map((g) => <option key={g.name} value={g.name}>{g.name}</option>)}</Select>
            <Field label="Purchase date" type="date" value={f.purchaseDate} onChange={(e) => setF({ ...f, purchaseDate: e.target.value })} />
            <Field label="Cost (₹)" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} />
            <Field label="Residual value (₹)" value={f.residual} onChange={(e) => setF({ ...f, residual: e.target.value })} />
            <Select label="Depreciation method" aria-label="Depreciation method" value={f.method} onChange={(e) => pickMethod(e.target.value)}>{METHODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
            {f.method === 'slm_life' ? <Field label="Useful life (years)" aria-label="Useful life" inputMode="decimal" value={f.lifeYears} onChange={(e) => setF({ ...f, lifeYears: e.target.value })} />
              : <Field label="Rate per year (%)" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} />}
            <Select label="Charge depreciation by" aria-label="Depreciation basis" value={f.dayBasis} onChange={(e) => setF({ ...f, dayBasis: e.target.value })}><option value="months">Whole months (1/12 a month)</option><option value="actual_days">Actual days (days / days in year)</option></Select>
          </div>
          {group
            ? <p className="mt-2 rounded bg-slate-50 px-3 py-2 text-xs text-slate-600"><b>{group.name}</b>: {group.examples}. Income Tax Act written-down-value rate <b>{group.itRateBp / 100}%</b>; Companies Act useful life <b>{group.lifeYears} years</b>. Choosing the group filled the {f.method === 'slm_life' ? 'life' : 'rate'}; you can change it.</p>
            : <p className="mt-2 text-xs text-slate-500">Pick a group to fill in the usual rate. For example an air conditioner or refrigerator goes under Plant and machinery (15% WDV), a computer or laptop under Computers and software (40% WDV).</p>}
          <div className="mt-3 text-sm"><span className="mb-1 block font-medium text-slate-600">Attach documents (purchase bill, warranty, photos)</span>
            <input aria-label="Attach documents" type="file" multiple onChange={(e) => setFiles([...files, ...Array.from(e.target.files ?? [])])} />
            <ul className="mt-1 text-xs text-slate-600">{existing.map((a) => <li key={a.id}><button className="underline" onClick={() => run(() => download(`/orgs/${org.id}/files/${a.id}/download`, a.name))}>{a.name}</button> (attached)</li>)}
              {files.map((x, i) => <li key={i}>{x.name} <button className="text-red-700" onClick={() => setFiles(files.filter((_, j) => j !== i))}>remove</button></li>)}</ul></div>
          <div className="mt-3 flex gap-3"><Button disabled={busy} onClick={save}>{editing ? 'Save changes' : 'Save asset'}</Button>{editing && <Button variant="ghost" onClick={reset}>Cancel</Button>}</div>
        </Card>
      )}
      {canManage && (
        <Card title="Run depreciation">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Post depreciation up to" type="date" value={through} onChange={(e) => setThrough(e.target.value)} />
            <Button disabled={busy} onClick={() => run(async () => { const r = await api(`/orgs/${org.id}/fixed-assets/run-depreciation`, { body: { through } }); setOk(`Posted ${r.entriesPosted} entries, ₹${fmt(r.totalDepreciation)} in total.`); load(); })}>Run</Button>
            <p className="text-xs text-slate-500">Posts one entry per asset per month-end (Dr Depreciation, Cr Accumulated Depreciation). Running it twice does not double-post.</p>
          </div>
        </Card>
      )}
      {disposing && (
        <Card title={`Dispose of ${disposing.name}`} actions={<Button variant="ghost" onClick={() => setDisposing(null)}>Cancel</Button>}>
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Date of disposal" type="date" value={disposing.date} onChange={(e) => setDisposing({ ...disposing, date: e.target.value, preview: null })} />
            <Field label="Sale proceeds (₹)" aria-label="Sale proceeds" inputMode="decimal" value={disposing.proceeds} onChange={(e) => setDisposing({ ...disposing, proceeds: e.target.value, preview: null })} />
            <Select label="Proceeds credited to" aria-label="Proceeds account" value={disposing.accountId} onChange={(e) => setDisposing({ ...disposing, accountId: e.target.value, preview: null })}><option value="">Select bank or cash…</option>{proceedAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</Select>
          </div>
          <div className="mt-3 flex gap-3"><Button variant="ghost" disabled={busy} onClick={previewDisposal}>Calculate gain / loss</Button></div>
          {dis && (
            <div className="mt-4 rounded border border-slate-200 p-3 text-sm" data-testid="disposal-preview">
              <table className="w-full max-w-md"><tbody>
                <tr><td>Cost</td><td className="text-right">{fmt(dis.cost)}</td></tr>
                <tr><td>Depreciation to date{dis.pendingDepreciation > 0 && ` (incl. ₹${fmt(dis.pendingDepreciation)} still to post up to ${dis.depreciatedThrough})`}</td><td className="text-right">{fmt(dis.accumulatedDepreciation)}</td></tr>
                <tr className="border-t"><td>Book value at disposal</td><td className="text-right">{fmt(dis.bookValue)}</td></tr>
                <tr><td>Sale proceeds</td><td className="text-right">{fmt(dis.proceeds)}</td></tr>
                <tr className="border-t font-semibold"><td>{dis.gain >= 0 ? 'Profit on sale' : 'Loss on sale'}</td><td className={`text-right ${dis.gain >= 0 ? 'text-green-700' : 'text-red-700'}`}>{fmt(Math.abs(dis.gain))}</td></tr></tbody></table>
              <p className="mt-2 text-xs text-slate-500">Posting books: Dr proceeds account, Dr Accumulated Depreciation, Cr Fixed Assets (cost), and the {dis.gain >= 0 ? 'profit to Profit on Sale of Fixed Assets' : 'loss to Loss on Sale of Fixed Assets'}. Depreciation is charged to the last month end before the disposal date.</p>
              <div className="mt-3"><Button disabled={busy || (dis.proceeds > 0 && !disposing.accountId)} onClick={postDisposal}>Post disposal entry</Button></div>
            </div>
          )}
        </Card>
      )}
      <Card title={`Register (book value of active assets ₹${fmt(totalBook)})`}>
        {list.length === 0 ? <Empty text="No assets yet." /> : (
          <table className="w-full text-sm"><thead><tr className="text-left text-slate-500"><th>Code</th><th>Asset</th><th>Group</th><th>Bought</th><th>Method</th><th className="text-right">Cost</th><th className="text-right">Accumulated</th><th className="text-right">Book value</th><th>Status</th><th /></tr></thead>
            <tbody>{list.map((a) => (
              <tr key={a.id} className="border-t border-slate-100"><td className="py-2">{a.code}</td><td className="font-medium">{a.name}</td><td>{a.group ?? '—'}</td><td>{a.purchaseDate.slice(0, 10)}</td><td>{methodText(a)}{a.dayBasis === 'actual_days' ? ' · days' : ''}</td>
                <td className="text-right">{fmt(a.cost)}</td><td className="text-right">{fmt(a.accumulated)}</td><td className="text-right">{fmt(a.bookValue)}</td>
                <td><Badge text={a.status} />{a.status === 'disposed' && a.disposalGain != null && <span className={`block text-xs ${a.disposalGain >= 0 ? 'text-green-700' : 'text-red-700'}`}>{a.disposalGain >= 0 ? 'profit' : 'loss'} ₹{fmt(Math.abs(a.disposalGain))}</span>}</td>
                <td className="whitespace-nowrap text-right">{canManage && a.status === 'active' && <><Button variant="ghost" onClick={() => edit(a)}>Edit</Button> <Button variant="ghost" onClick={() => setDisposing({ id: a.id, name: a.name, date: today(), proceeds: '', accountId: '', preview: null })}>Dispose</Button></>}</td></tr>))}</tbody></table>
        )}
        <p className="mt-3 text-xs text-slate-500">Cost, dates and depreciation settings lock once depreciation is posted. The Income Tax half-rate rule for assets used under 180 days is not applied.</p>
      </Card>
    </>
  );
}

export function OrgSettings({ org, canManage, onSaved }: { org: Org; canManage: boolean; onSaved: () => void }) {
  const [f, setF] = useState({ name: org.name, gstin: org.gstin ?? '', pan: '', gstScheme: 'regular', lutNumber: '', requireApproval: false });
  const [through, setThrough] = useState('');
  const [ok, setOk] = useState('');
  const { error, busy, run } = useAction();
  // The fields stay locked until the saved values arrive, so nothing typed earlier is overwritten (and then saved blank).
  const [loaded, setLoaded] = useState(false);
  // Only the newest load may fill the form: a load that was abandoned (React runs effects twice in development) is ignored.
  useEffect(() => { let live = true; api(`/orgs/${org.id}/settings`).then((s) => { if (!live) return; setF({ name: s.name, gstin: s.gstin ?? '', pan: s.pan ?? '', gstScheme: s.gstScheme, lutNumber: s.lutNumber ?? '', requireApproval: s.requireApproval }); setLoaded(true); }); return () => { live = false; }; }, [org.id]);
  const editable = canManage && loaded;
  return (
    <>
      <PageHeader title="Organisation settings" subtitle="Business details used on invoices and to decide CGST/SGST vs IGST." />
      <div className="mb-3 space-y-2"><ErrorMsg msg={error} /><Ok msg={ok} /></div>
      <Card title="Business details">
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Business name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} disabled={!editable} />
          <Field label="GSTIN" value={f.gstin} onChange={(e) => setF({ ...f, gstin: e.target.value.toUpperCase() })} disabled={!editable} />
          <Field label="PAN" value={f.pan} onChange={(e) => setF({ ...f, pan: e.target.value.toUpperCase() })} disabled={!editable} />
          <Select label="GST scheme" aria-label="GST scheme" value={f.gstScheme} disabled={!editable} onChange={(e) => setF({ ...f, gstScheme: e.target.value })}>
            <option value="regular">Regular</option><option value="composition">Composition (no GST on sales, no input credit)</option></Select>
          <Field label="LUT number (for exports without GST)" value={f.lutNumber} onChange={(e) => setF({ ...f, lutNumber: e.target.value.toUpperCase() })} disabled={!editable} />
          <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" aria-label="Require approval" disabled={!editable} checked={f.requireApproval} onChange={(e) => setF({ ...f, requireApproval: e.target.checked })} />Staff need approval for invoices and bills</label>
        </div>
        {canManage && <div className="mt-3"><Button disabled={busy || !loaded} onClick={() => run(async () => {
          const r = await api(`/orgs/${org.id}/settings`, { method: 'PUT', body: { name: f.name, gstin: f.gstin || null, pan: f.pan || null, gstScheme: f.gstScheme, lutNumber: f.lutNumber || null, requireApproval: f.requireApproval } });
          setOk(`Saved. State code is now ${r.stateCode ?? 'not set'}.`); onSaved();
        })}>Save</Button></div>}
      </Card>
      {canManage && (
        <Card title="Lock the books">
          <p className="mb-3 text-sm text-slate-600">After you file a return, lock the period. Nothing can then be posted on or before this date, for every user.</p>
          <div className="flex items-end gap-3"><Field label="Lock up to and including" type="date" value={through} onChange={(e) => setThrough(e.target.value)} />
            <Button disabled={busy || !through} onClick={() => run(async () => { await api(`/orgs/${org.id}/lock`, { body: { through } }); setOk(`Books locked through ${through}.`); })}>Lock</Button></div>
        </Card>
      )}
    </>
  );
}

/** Sales settings (invoice payment terms and terms printed on invoices) or purchases settings (bill payment terms). */
export function DocDefaults({ org, side, canManage }: { org: Org; side: 'sales' | 'purchases'; canManage: boolean }) {
  const [f, setF] = useState({ invoiceDueDays: '', billDueDays: '', invoiceTerms: '' });
  const [ok, setOk] = useState('');
  const { error, busy, run } = useAction();
  const [loaded, setLoaded] = useState(false); // locked until the saved values arrive, so typing is never overwritten
  useEffect(() => { let live = true; api(`/orgs/${org.id}/settings`).then((s) => { if (!live) return; setF({ invoiceDueDays: s.invoiceDueDays ?? '', billDueDays: s.billDueDays ?? '', invoiceTerms: s.invoiceTerms ?? '' }); setLoaded(true); }); return () => { live = false; }; }, [org.id]);
  const days = (v: string) => (v === '' ? null : Number(v));
  const save = () => run(async () => {
    await api(`/orgs/${org.id}/settings`, { method: 'PUT', body: side === 'sales' ? { invoiceDueDays: days(String(f.invoiceDueDays)), invoiceTerms: f.invoiceTerms || null } : { billDueDays: days(String(f.billDueDays)) } });
    setOk('Saved. New documents will use these defaults.');
  });
  const sales = side === 'sales';
  return (
    <>
      <PageHeader title={sales ? 'Sales settings' : 'Purchases settings'} subtitle={sales ? 'Defaults for new invoices.' : 'Defaults for new bills.'} />
      <div className="mb-3 space-y-2"><ErrorMsg msg={error} /><Ok msg={ok} /></div>
      <Card title="Payment terms">
        <div className="grid gap-3 md:grid-cols-2">
          {sales
            ? <Field label="Invoices are due this many days after the invoice date" aria-label="Invoice due days" type="number" min={0} max={365} value={f.invoiceDueDays} disabled={!canManage || !loaded} onChange={(e) => setF({ ...f, invoiceDueDays: e.target.value })} />
            : <Field label="Bills are due this many days after the bill date" aria-label="Bill due days" type="number" min={0} max={365} value={f.billDueDays} disabled={!canManage || !loaded} onChange={(e) => setF({ ...f, billDueDays: e.target.value })} />}
        </div>
        <p className="mt-2 text-xs text-slate-500">Leave empty for no default. A due date typed on the document always wins.</p>
        {sales && (
          <label className="mt-4 block text-sm"><span className="mb-1 block font-medium text-slate-600">Terms printed on every invoice</span>
            <textarea aria-label="Invoice terms" rows={3} maxLength={500} disabled={!canManage || !loaded} className="w-full rounded-md border border-slate-300 px-3 py-2" placeholder="e.g. Please pay by NEFT to HDFC Bank, A/c 0001234, IFSC HDFC0000001" value={f.invoiceTerms} onChange={(e) => setF({ ...f, invoiceTerms: e.target.value })} /></label>
        )}
        {canManage && <div className="mt-3"><Button disabled={busy || !loaded} onClick={save}>Save</Button></div>}
      </Card>
    </>
  );
}
