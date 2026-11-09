import { useCallback, useEffect, useState } from 'react';
import { api, fmt, today } from '../api';
import type { Org } from '../App';
import { Badge, Empty, PageHeader, Select } from '../kit';
import { Button, Card, ErrorMsg, Field, Ok, useAction } from '../ui';
import type { Account } from './Lines';

export interface Contact {
  id: number; kind: string; name: string; gstin: string | null; pan: string | null; stateCode: string | null; email?: string | null; phone?: string | null;
  isIndividual?: boolean; country?: string; bankAccountName?: string | null; bankName?: string | null; bankAccountNo?: string | null; bankIfsc?: string | null;
  defaultSalesAccountId?: number | null; defaultPurchaseAccountId?: number | null; isArchived?: boolean;
  msmeType?: string | null; udyamNo?: string | null; msmeAgreedDays?: number | null;
}
interface Statement { contact: { name: string }; openingBalance: number; closingBalance: number; lines: { date: string; ref: string; type: string; amount: number; balance: number }[] }

const blank = { kind: 'customer' as string, name: '', gstin: '', pan: '', stateCode: '', email: '', phone: '', isIndividual: false, country: 'IN',
  bankAccountName: '', bankName: '', bankAccountNo: '', bankIfsc: '', defaultSalesAccountId: '', defaultPurchaseAccountId: '', msmeType: '', udyamNo: '', msmeAgreedDays: '' };

const TEMPLATE = 'Name,Type,GSTIN,PAN,State Code,Email,Phone,Bank Account Name,Bank Name,Bank Account Number,IFSC\nAcme Pvt Ltd,Customer,,AAACA1234A,27,accounts@acme.example,9876543210,Acme Pvt Ltd,HDFC Bank,12345678901,HDFC0000001\n';
const csvCell = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function saveText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Customers or suppliers (or both): add, edit, archive, delete, import, export, and a running-balance statement for any date range. */
export function Contacts({ org, canPost, canManage = false, accounts = [], only, startNew = false, restricted = false }: { org: Org; canPost: boolean; canManage?: boolean; accounts?: Account[]; only?: 'customer' | 'supplier'; startNew?: boolean; restricted?: boolean }) {
  const [list, setList] = useState<Contact[]>([]);
  const [states, setStates] = useState<{ code: string; name: string }[]>([]);
  const [show, setShow] = useState(startNew);
  useEffect(() => { if (startNew) setShow(true); }, [startNew]);
  const [editing, setEditing] = useState<number | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [stmt, setStmt] = useState<Statement | null>(null);
  const [stmtFor, setStmtFor] = useState<Contact | null>(null);
  const [range, setRange] = useState({ from: '', to: today() });
  const [f, setF] = useState<typeof blank>({ ...blank, kind: only ?? 'customer' });
  const [ok, setOk] = useState('');
  const [importing, setImporting] = useState(false);
  const [csv, setCsv] = useState('');
  const { error, busy, run, setError } = useAction();
  const load = useCallback(() => api<Contact[]>(`/orgs/${org.id}/contacts?archived=${showArchived}`).then(setList), [org.id, showArchived]);
  useEffect(() => { load(); api('/config/states').then(setStates); }, [load]);

  const shown = list.filter((c) => !only || c.kind === only || c.kind === 'both');
  const body = () => ({
    kind: f.kind, name: f.name, isIndividual: f.isIndividual, country: f.country || 'IN',
    ...(f.gstin ? { gstin: f.gstin.toUpperCase() } : {}), ...(f.pan ? { pan: f.pan.toUpperCase() } : {}), ...(f.stateCode ? { stateCode: f.stateCode } : {}),
    ...(f.email ? { email: f.email } : {}), ...(f.phone ? { phone: f.phone } : {}),
    ...(f.bankAccountName ? { bankAccountName: f.bankAccountName } : {}), ...(f.bankName ? { bankName: f.bankName } : {}),
    ...(f.bankAccountNo ? { bankAccountNo: f.bankAccountNo.replace(/\s/g, '') } : {}), ...(f.bankIfsc ? { bankIfsc: f.bankIfsc.toUpperCase() } : {}),
    defaultSalesAccountId: f.defaultSalesAccountId ? Number(f.defaultSalesAccountId) : null, defaultPurchaseAccountId: f.defaultPurchaseAccountId ? Number(f.defaultPurchaseAccountId) : null,
    ...(f.msmeType ? { msmeType: f.msmeType } : {}), ...(f.udyamNo.trim() ? { udyamNo: f.udyamNo.trim().toUpperCase() } : {}), ...(f.msmeAgreedDays ? { msmeAgreedDays: Number(f.msmeAgreedDays) } : {}),
  });
  const reset = () => { setF({ ...blank, kind: only ?? 'customer' }); setEditing(null); setShow(false); };
  const save = () => run(async () => {
    if (editing) await api(`/orgs/${org.id}/contacts/${editing}`, { method: 'PUT', body: body() });
    else await api(`/orgs/${org.id}/contacts`, { body: body() });
    setOk(editing ? 'Contact updated.' : 'Contact added.'); reset(); load();
  });
  const edit = (c: Contact) => {
    setOk(''); setError('');
    setF({ kind: c.kind, name: c.name, gstin: c.gstin ?? '', pan: c.pan ?? '', stateCode: c.stateCode ?? '', email: c.email ?? '', phone: c.phone ?? '', isIndividual: !!c.isIndividual, country: c.country ?? 'IN',
      bankAccountName: c.bankAccountName ?? '', bankName: c.bankName ?? '', bankAccountNo: c.bankAccountNo ?? '', bankIfsc: c.bankIfsc ?? '',
      defaultSalesAccountId: c.defaultSalesAccountId ? String(c.defaultSalesAccountId) : '', defaultPurchaseAccountId: c.defaultPurchaseAccountId ? String(c.defaultPurchaseAccountId) : '',
      msmeType: c.msmeType ?? '', udyamNo: c.udyamNo ?? '', msmeAgreedDays: c.msmeAgreedDays ? String(c.msmeAgreedDays) : '' });
    setEditing(c.id); setShow(true); window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const archive = (c: Contact) => run(async () => { await api(`/orgs/${org.id}/contacts/${c.id}/archive`, { body: { archived: !c.isArchived } }); setOk(c.isArchived ? `${c.name} restored.` : `${c.name} archived.`); load(); });
  const remove = (c: Contact) => run(async () => {
    if (!window.confirm(`Delete ${c.name}? This cannot be undone. A contact that has invoices or bills can only be archived.`)) return;
    await api(`/orgs/${org.id}/contacts/${c.id}`, { method: 'DELETE' }); setOk(`${c.name} deleted.`); load();
  });
  const loadStatement = (c: Contact, r = range) => run(async () => {
    const q = new URLSearchParams(); if (r.from) q.set('from', r.from); if (r.to) q.set('to', r.to);
    setStmtFor(c); setStmt(await api(`/orgs/${org.id}/contacts/${c.id}/statement?${q}`));
  });

  const exportCsv = () => {
    const head = ['Name', 'Type', 'GSTIN', 'PAN', 'State Code', 'Email', 'Phone', 'Bank Account Name', 'Bank Name', 'Bank Account Number', 'IFSC', 'Default Sales Account', 'Default Purchase Account', 'Archived'];
    const acct = (id?: number | null) => { const a = accounts.find((x) => x.id === id); return a ? `${a.code} ${a.name}` : ''; };
    const rows = shown.map((c) => [c.name, c.kind, c.gstin, c.pan, c.stateCode, c.email, c.phone, c.bankAccountName, c.bankName, c.bankAccountNo, c.bankIfsc, acct(c.defaultSalesAccountId), acct(c.defaultPurchaseAccountId), c.isArchived ? 'Yes' : 'No']);
    saveText(`contacts-${today()}.csv`, [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n');
  };
  const runImport = (dryRun: boolean) => run(async () => {
    const r = await api(`/orgs/${org.id}/import/contacts`, { body: { csv, dryRun } });
    if (!r.ok) { setError(`Nothing imported. ${r.errors.slice(0, 5).join(' · ')}${r.errors.length > 5 ? ` (+${r.errors.length - 5} more)` : ''}`); return; }
    setOk(dryRun ? `Looks good: ${r.wouldImport} contact(s) ready to import.` : `Imported ${r.imported} contact(s).${r.errors.length ? ` ${r.errors.join(' · ')}` : ''}`);
    if (!dryRun) { setCsv(''); setImporting(false); load(); }
  });
  const label = only === 'customer' ? 'Customers' : only === 'supplier' ? 'Suppliers' : 'All contacts';
  const incomeAccts = accounts.filter((a) => a.type === 'income'), costAccts = accounts.filter((a) => a.type === 'expense' || a.type === 'asset');
  const acctName = (id?: number | null) => { const a = accounts.find((x) => x.id === id); return a ? `${a.code} ${a.name}` : '—'; };

  return (
    <>
      <PageHeader title={label} subtitle="GSTIN sets the state for GST. A PAN is needed for the normal TDS rate."
        actions={<>
          <Button variant="ghost" onClick={exportCsv} disabled={!shown.length}>Export</Button>
          {canManage && <Button variant="ghost" onClick={() => { setImporting(!importing); setOk(''); setError(''); }}>{importing ? 'Close import' : 'Import'}</Button>}
          {canPost && <Button onClick={() => { if (show) reset(); else { setF({ ...blank, kind: only ?? 'customer' }); setEditing(null); setShow(true); } }}>{show ? 'Close' : `New ${only ?? 'contact'}`}</Button>}
        </>} />
      <div className="mb-3 space-y-2"><ErrorMsg msg={error} /><Ok msg={ok} /></div>

      {importing && canManage && (
        <Card title="Import contacts">
          <p className="mb-3 text-sm text-slate-600">Add many contacts at once from a CSV file. Existing contacts with the same name and GSTIN are skipped. Use the blank template for the right columns.</p>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Button variant="ghost" onClick={() => saveText('contacts-import-template.csv', TEMPLATE)}>Download blank template</Button>
            <input aria-label="Contacts CSV file" type="file" accept=".csv" onChange={async (e) => e.target.files?.[0] && setCsv(await e.target.files[0].text())} />
          </div>
          <textarea aria-label="Contacts CSV data" className="mt-3 h-32 w-full rounded border border-slate-300 p-2 font-mono text-xs" placeholder="Choose a file or paste CSV here" value={csv} onChange={(e) => setCsv(e.target.value)} />
          <div className="mt-3 flex gap-3"><Button variant="ghost" disabled={busy || !csv} onClick={() => runImport(true)}>Check (dry run)</Button><Button disabled={busy || !csv} onClick={() => runImport(false)}>Import</Button></div>
        </Card>
      )}

      {show && canPost && (
        <Card title={editing ? `Edit ${f.name || 'contact'}` : `Add ${only ?? 'customer or supplier'}`}>
          <div className="grid gap-3 md:grid-cols-3">
            {!only && <Select label="Type" aria-label="Contact type" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="customer">Customer</option><option value="supplier">Supplier</option><option value="both">Both</option></Select>}
            <Field label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            <Field label="GSTIN" value={f.gstin} onChange={(e) => setF({ ...f, gstin: e.target.value })} />
            <Field label="PAN" value={f.pan} onChange={(e) => setF({ ...f, pan: e.target.value })} />
            <Field label="Country (2 letters)" aria-label="Country" maxLength={2} value={f.country} onChange={(e) => setF({ ...f, country: e.target.value.toUpperCase() })} />
            <Select label="State (if no GSTIN)" aria-label="State" value={f.stateCode} onChange={(e) => setF({ ...f, stateCode: e.target.value })}><option value="">—</option>{states.map((s) => <option key={s.code} value={s.code}>{s.code} {s.name}</option>)}</Select>
            <Field label="Email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
            <Field label="Phone" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
            <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" checked={f.isIndividual} onChange={(e) => setF({ ...f, isIndividual: e.target.checked })} /> Individual / HUF (lower TDS rate)</label>
          </div>
          <h3 className="mb-2 mt-5 text-sm font-semibold text-slate-700">Bank account details</h3>
          <div className="grid gap-3 md:grid-cols-4">
            <Field label="Account holder name" value={f.bankAccountName} onChange={(e) => setF({ ...f, bankAccountName: e.target.value })} />
            <Field label="Bank name" value={f.bankName} onChange={(e) => setF({ ...f, bankName: e.target.value })} />
            <Field label="Account number" inputMode="numeric" value={f.bankAccountNo} onChange={(e) => setF({ ...f, bankAccountNo: e.target.value })} />
            <Field label="IFSC code" maxLength={11} value={f.bankIfsc} onChange={(e) => setF({ ...f, bankIfsc: e.target.value.toUpperCase() })} />
          </div>
          {f.kind !== 'customer' && <>
            <h3 className="mb-2 mt-5 text-sm font-semibold text-slate-700">MSME (Udyam) status</h3>
            <div className="grid gap-3 md:grid-cols-3">
              <Select label="MSME type" aria-label="MSME type" value={f.msmeType} onChange={(e) => setF({ ...f, msmeType: e.target.value })}>
                <option value="">Not MSME, or not known</option><option value="micro">Micro enterprise</option><option value="small">Small enterprise</option><option value="medium">Medium enterprise</option></Select>
              <Field label="Udyam registration number" aria-label="Udyam number" placeholder="UDYAM-MH-26-0012345" value={f.udyamNo} onChange={(e) => setF({ ...f, udyamNo: e.target.value.toUpperCase() })} />
              <Field label="Payment days agreed in writing" aria-label="Agreed payment days" inputMode="numeric" placeholder="None: 15 days apply" value={f.msmeAgreedDays} onChange={(e) => setF({ ...f, msmeAgreedDays: e.target.value.replace(/\D/g, '') })} />
            </div>
            {(f.msmeType === 'micro' || f.msmeType === 'small') && <p className="mt-2 text-xs text-slate-500">Section 43B(h): pay this supplier within {f.msmeAgreedDays ? Math.min(Number(f.msmeAgreedDays), 45) : 15} days of each bill, or the expense is allowed only in the year it is paid. Tax, Compliance checks lists what is due.</p>}
          </>}
          <h3 className="mb-2 mt-5 text-sm font-semibold text-slate-700">Default accounts</h3>
          <div className="grid gap-3 md:grid-cols-3">
            <Select label="Default sales account" value={f.defaultSalesAccountId} onChange={(e) => setF({ ...f, defaultSalesAccountId: e.target.value })}><option value="">None (use the item or 4000)</option>{incomeAccts.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</Select>
            <Select label="Default purchase account" value={f.defaultPurchaseAccountId} onChange={(e) => setF({ ...f, defaultPurchaseAccountId: e.target.value })}><option value="">None (choose on each bill)</option>{costAccts.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</Select>
          </div>
          <div className="mt-4 flex gap-3"><Button disabled={busy} onClick={save}>{editing ? 'Save changes' : 'Add contact'}</Button>{editing && <Button variant="ghost" onClick={reset}>Cancel</Button>}</div>
        </Card>
      )}

      <Card actions={<label className="flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />Show archived</label>}>
        {shown.length === 0 ? <Empty text={`No ${label.toLowerCase()} yet.`} /> : (
          <table className="w-full text-sm"><thead><tr className="text-left text-slate-500"><th>Name</th><th>Type</th><th>GSTIN</th><th>PAN</th><th>State</th><th>Bank</th><th>Default sales</th><th>Default purchase</th><th /></tr></thead>
            <tbody>{shown.map((c) => (
              <tr key={c.id} className={`border-t border-slate-100 ${c.isArchived ? 'text-slate-400' : ''}`}>
                <td className="py-2 font-medium">{c.name}{c.isArchived && <span className="ml-2 rounded bg-slate-100 px-1.5 text-xs text-slate-500">archived</span>}</td>
                <td><Badge text={c.kind} /></td><td>{c.gstin ?? '—'}</td><td>{c.pan ?? '—'}</td><td>{c.stateCode ?? '—'}</td>
                <td>{c.bankAccountNo ? `${c.bankName ?? 'A/c'} ••${c.bankAccountNo.slice(-4)}` : '—'}</td><td>{acctName(c.defaultSalesAccountId)}</td><td>{acctName(c.defaultPurchaseAccountId)}</td>
                <td className="whitespace-nowrap text-right">
                  {!restricted && <Button variant="ghost" onClick={() => loadStatement(c)}>Statement</Button>}
                  {canPost && !restricted && <> <Button variant="ghost" onClick={() => edit(c)}>Edit</Button> <Button variant="ghost" onClick={() => archive(c)}>{c.isArchived ? 'Restore' : 'Archive'}</Button></>}
                  {canManage && <> <Button variant="ghost" className="text-red-700" onClick={() => remove(c)}>Delete</Button></>}
                </td></tr>))}</tbody></table>
        )}
      </Card>

      {stmt && stmtFor && (
        <Card title={`Statement: ${stmt.contact.name}`} actions={<Button variant="ghost" onClick={() => { setStmt(null); setStmtFor(null); }}>Close</Button>}>
          <div className="mb-3 flex flex-wrap items-end gap-3">
            <Field label="From" type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
            <Field label="To" type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
            <Button disabled={busy} onClick={() => loadStatement(stmtFor)}>Update</Button>
            <Button variant="ghost" onClick={() => { const r = { from: '', to: today() }; setRange(r); loadStatement(stmtFor, r); }}>All dates</Button>
          </div>
          <table className="w-full text-sm" data-testid="statement"><thead><tr className="text-left text-slate-500"><th>Date</th><th>Reference</th><th className="text-right">Amount</th><th className="text-right">Balance</th></tr></thead>
            <tbody>{stmt.openingBalance !== 0 && <tr><td /><td>Opening balance</td><td /><td className="text-right">{fmt(stmt.openingBalance)}</td></tr>}
              {stmt.lines.map((l, i) => <tr key={i} className="border-t border-slate-100"><td>{l.date}</td><td>{l.ref}</td><td className="text-right">{fmt(l.amount)}</td><td className="text-right">{fmt(l.balance)}</td></tr>)}
              <tr className="border-t-2 font-semibold"><td /><td>Balance</td><td /><td className="text-right" data-testid="statement-closing">{fmt(stmt.closingBalance)}</td></tr></tbody></table>
        </Card>
      )}
    </>
  );
}
