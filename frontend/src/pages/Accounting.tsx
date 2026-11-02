// Products and services, fixed assets and organisation settings.
import { useCallback, useEffect, useState } from 'react';
import { api, fmt, toPaise, today } from '../api';
import type { Org } from '../App';
import { Badge, Empty, PageHeader, Select } from '../kit';
import { Button, Card, ErrorMsg, Field, Ok, useAction } from '../ui';
import type { Account, Item } from './Lines';

export function Items({ org, canPost, accounts }: { org: Org; canPost: boolean; accounts: Account[] }) {
  const [items, setItems] = useState<Item[]>([]);
  const [rates, setRates] = useState<{ rateBp: number; label: string }[]>([]);
  const [show, setShow] = useState(false);
  const [f, setF] = useState({ code: '', name: '', kind: 'service', hsnSac: '', saleRate: '', purchaseRate: '', gstRateBp: '1800', salesAccountId: '', trackStock: false });
  const { error, busy, run } = useAction();
  const load = useCallback(() => api<Item[]>(`/orgs/${org.id}/items`).then(setItems), [org.id]);
  useEffect(() => { load(); api('/config/gst-rates').then(setRates); }, [load]);
  const save = () => run(async () => {
    await api(`/orgs/${org.id}/items`, { body: { code: f.code, name: f.name, kind: f.kind, gstRateBp: Number(f.gstRateBp), saleRate: f.saleRate ? toPaise(f.saleRate) : 0, purchaseRate: f.purchaseRate ? toPaise(f.purchaseRate) : 0,
      ...(f.hsnSac ? { hsnSac: f.hsnSac } : {}), ...(f.salesAccountId ? { salesAccountId: Number(f.salesAccountId) } : {}), trackStock: f.kind === 'goods' && f.trackStock } });
    setF({ ...f, code: '', name: '', hsnSac: '', saleRate: '', purchaseRate: '' }); setShow(false); load();
  });
  return (
    <>
      <PageHeader title="Products and services" subtitle="Saved items fill in HSN/SAC, price and GST rate when you raise an invoice or bill." actions={canPost && <Button onClick={() => setShow(!show)}>{show ? 'Close' : 'New item'}</Button>} />
      <div className="mb-3"><ErrorMsg msg={error} /></div>
      {show && (
        <Card title="New item">
          <div className="grid gap-3 md:grid-cols-4">
            <Field label="Code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />
            <Field label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            <Select label="Kind" aria-label="Item kind" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="service">Service</option><option value="goods">Goods</option></Select>
            <Field label="HSN / SAC" value={f.hsnSac} onChange={(e) => setF({ ...f, hsnSac: e.target.value })} />
            <Field label="Sale price (₹)" value={f.saleRate} onChange={(e) => setF({ ...f, saleRate: e.target.value })} />
            <Field label="Purchase price (₹)" value={f.purchaseRate} onChange={(e) => setF({ ...f, purchaseRate: e.target.value })} />
            <Select label="GST rate" aria-label="Item GST rate" value={f.gstRateBp} onChange={(e) => setF({ ...f, gstRateBp: e.target.value })}>{rates.map((r) => <option key={r.rateBp} value={r.rateBp}>{r.label}</option>)}</Select>
            {f.kind === 'goods' && <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" aria-label="Track stock" checked={f.trackStock} onChange={(e) => setF({ ...f, trackStock: e.target.checked })} />Track stock quantity and cost</label>}
            <Select label="Sales account" aria-label="Item sales account" value={f.salesAccountId} onChange={(e) => setF({ ...f, salesAccountId: e.target.value })}><option value="">Default (4000)</option>{accounts.filter((a) => a.type === 'income').map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</Select>
          </div>
          <div className="mt-3"><Button disabled={busy} onClick={save}>Save item</Button></div>
        </Card>
      )}
      <Card>
        {items.length === 0 ? <Empty text="No products or services yet." /> : (
          <table className="w-full text-sm"><thead><tr className="text-left text-slate-500"><th>Code</th><th>Name</th><th>Kind</th><th>HSN/SAC</th><th className="text-right">Sale</th><th className="text-right">Purchase</th><th className="text-right">GST</th><th /></tr></thead>
            <tbody>{items.map((i) => (
              <tr key={i.id} className="border-t border-slate-100"><td className="py-2 font-medium">{i.code}</td><td>{i.name}</td><td>{i.kind}{i.trackStock && <span className="ml-1 rounded bg-brand-50 px-1.5 text-xs text-brand-700">stock</span>}</td><td>{i.hsnSac ?? ''}</td><td className="text-right">{fmt(i.saleRate)}</td><td className="text-right">{fmt(i.purchaseRate)}</td><td className="text-right">{i.gstRateBp / 100}%</td>
                <td className="text-right">{canPost && <Button variant="ghost" onClick={() => run(async () => { await api(`/orgs/${org.id}/items/${i.id}/archive`, { method: 'POST', body: {} }); load(); })}>Archive</Button>}</td></tr>))}</tbody></table>
        )}
      </Card>
    </>
  );
}

interface Asset { id: number; name: string; purchaseDate: string; cost: number; residual: number; method: string; rateBp: number; status: string; accumulated: number; bookValue: number }

export function FixedAssets({ org, canManage }: { org: Org; canManage: boolean }) {
  const [list, setList] = useState<Asset[]>([]);
  const [show, setShow] = useState(false);
  const [f, setF] = useState({ name: '', purchaseDate: today(), cost: '', residual: '0', method: 'slm', rate: '10' });
  const [through, setThrough] = useState(today());
  const [ok, setOk] = useState('');
  const { error, busy, run } = useAction();
  const load = useCallback(() => api<Asset[]>(`/orgs/${org.id}/fixed-assets`).then(setList), [org.id]);
  useEffect(() => { load(); }, [load]);
  const totalBook = list.filter((a) => a.status === 'active').reduce((s, a) => s + a.bookValue, 0);
  return (
    <>
      <PageHeader title="Fixed assets" subtitle="Asset register with monthly depreciation posted to the ledger." actions={canManage && <Button onClick={() => setShow(!show)}>{show ? 'Close' : 'New asset'}</Button>} />
      <div className="mb-3 space-y-2"><ErrorMsg msg={error} /><Ok msg={ok} /></div>
      {show && (
        <Card title="New asset">
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            <Field label="Purchase date" type="date" value={f.purchaseDate} onChange={(e) => setF({ ...f, purchaseDate: e.target.value })} />
            <Field label="Cost (₹)" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} />
            <Field label="Residual value (₹)" value={f.residual} onChange={(e) => setF({ ...f, residual: e.target.value })} />
            <Select label="Method" aria-label="Depreciation method" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}><option value="slm">Straight line</option><option value="wdv">Written down value</option></Select>
            <Field label="Rate per year (%)" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} />
          </div>
          <div className="mt-3"><Button disabled={busy} onClick={() => run(async () => {
            await api(`/orgs/${org.id}/fixed-assets`, { body: { name: f.name, purchaseDate: f.purchaseDate, cost: toPaise(f.cost), residual: toPaise(f.residual || '0'), method: f.method, rateBp: Math.round(Number(f.rate) * 100) } });
            setShow(false); load();
          })}>Save asset</Button></div>
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
      <Card title={`Register (book value of active assets ₹${fmt(totalBook)})`}>
        {list.length === 0 ? <Empty text="No assets yet." /> : (
          <table className="w-full text-sm"><thead><tr className="text-left text-slate-500"><th>Asset</th><th>Bought</th><th>Method</th><th className="text-right">Cost</th><th className="text-right">Accumulated</th><th className="text-right">Book value</th><th>Status</th><th /></tr></thead>
            <tbody>{list.map((a) => (
              <tr key={a.id} className="border-t border-slate-100"><td className="py-2 font-medium">{a.name}</td><td>{a.purchaseDate}</td><td>{a.method === 'slm' ? 'SLM' : 'WDV'} {a.rateBp / 100}%</td>
                <td className="text-right">{fmt(a.cost)}</td><td className="text-right">{fmt(a.accumulated)}</td><td className="text-right">{fmt(a.bookValue)}</td><td><Badge text={a.status} /></td>
                <td className="text-right">{canManage && a.status === 'active' && <Button variant="ghost" onClick={() => run(async () => { await api(`/orgs/${org.id}/fixed-assets/${a.id}/dispose`, { body: { date: today() } }); load(); })}>Dispose</Button>}</td></tr>))}</tbody></table>
        )}
        <p className="mt-3 text-xs text-slate-500">Income Tax Act block depreciation is not modelled. Disposal stops depreciation; post the sale and any gain or loss with a manual journal.</p>
      </Card>
    </>
  );
}

export function OrgSettings({ org, canManage, onSaved }: { org: Org; canManage: boolean; onSaved: () => void }) {
  const [f, setF] = useState({ name: org.name, gstin: org.gstin ?? '', pan: '', gstScheme: 'regular', lutNumber: '', requireApproval: false });
  const [through, setThrough] = useState('');
  const [ok, setOk] = useState('');
  const { error, busy, run } = useAction();
  useEffect(() => { api(`/orgs/${org.id}/settings`).then((s) => setF({ name: s.name, gstin: s.gstin ?? '', pan: s.pan ?? '', gstScheme: s.gstScheme, lutNumber: s.lutNumber ?? '', requireApproval: s.requireApproval })); }, [org.id]);
  return (
    <>
      <PageHeader title="Organisation settings" subtitle="Business details used on invoices and to decide CGST/SGST vs IGST." />
      <div className="mb-3 space-y-2"><ErrorMsg msg={error} /><Ok msg={ok} /></div>
      <Card title="Business details">
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Business name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} disabled={!canManage} />
          <Field label="GSTIN" value={f.gstin} onChange={(e) => setF({ ...f, gstin: e.target.value.toUpperCase() })} disabled={!canManage} />
          <Field label="PAN" value={f.pan} onChange={(e) => setF({ ...f, pan: e.target.value.toUpperCase() })} disabled={!canManage} />
          <Select label="GST scheme" aria-label="GST scheme" value={f.gstScheme} disabled={!canManage} onChange={(e) => setF({ ...f, gstScheme: e.target.value })}>
            <option value="regular">Regular</option><option value="composition">Composition (no GST on sales, no input credit)</option></Select>
          <Field label="LUT number (for exports without GST)" value={f.lutNumber} onChange={(e) => setF({ ...f, lutNumber: e.target.value.toUpperCase() })} disabled={!canManage} />
          <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" aria-label="Require approval" disabled={!canManage} checked={f.requireApproval} onChange={(e) => setF({ ...f, requireApproval: e.target.checked })} />Staff need approval for invoices and bills</label>
        </div>
        {canManage && <div className="mt-3"><Button disabled={busy} onClick={() => run(async () => {
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
  useEffect(() => { api(`/orgs/${org.id}/settings`).then((s) => setF({ invoiceDueDays: s.invoiceDueDays ?? '', billDueDays: s.billDueDays ?? '', invoiceTerms: s.invoiceTerms ?? '' })); }, [org.id]);
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
            ? <Field label="Invoices are due this many days after the invoice date" aria-label="Invoice due days" type="number" min={0} max={365} value={f.invoiceDueDays} disabled={!canManage} onChange={(e) => setF({ ...f, invoiceDueDays: e.target.value })} />
            : <Field label="Bills are due this many days after the bill date" aria-label="Bill due days" type="number" min={0} max={365} value={f.billDueDays} disabled={!canManage} onChange={(e) => setF({ ...f, billDueDays: e.target.value })} />}
        </div>
        <p className="mt-2 text-xs text-slate-500">Leave empty for no default. A due date typed on the document always wins.</p>
        {sales && (
          <label className="mt-4 block text-sm"><span className="mb-1 block font-medium text-slate-600">Terms printed on every invoice</span>
            <textarea aria-label="Invoice terms" rows={3} maxLength={500} disabled={!canManage} className="w-full rounded-md border border-slate-300 px-3 py-2" placeholder="e.g. Please pay by NEFT to HDFC Bank, A/c 0001234, IFSC HDFC0000001" value={f.invoiceTerms} onChange={(e) => setF({ ...f, invoiceTerms: e.target.value })} /></label>
        )}
        {canManage && <div className="mt-3"><Button disabled={busy} onClick={save}>Save</Button></div>}
      </Card>
    </>
  );
}
