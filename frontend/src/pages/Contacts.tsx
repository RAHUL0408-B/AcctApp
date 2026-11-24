import { useCallback, useEffect, useState } from 'react';
import { api, fmt, today } from '../api';
import type { Org } from '../App';
import { COUNTRY_NAMES, countryFrom, countryName } from '../countries';
import { Badge, PageHeader, Select } from '../kit';
import { Combo } from '../combo';
import { AccountCombo } from '../ledgerdialog';
import { DataTable, ExportMenu, Icon, RowMenu, exportTable, type Column } from '../table';
import { Button, Callout, Card, ErrorMsg, Field, Ok, useAction , ask } from '../ui';
import type { Account } from './Lines';

export interface Contact {
  id: number; kind: string; name: string; gstin: string | null; pan: string | null; stateCode: string | null; email?: string | null; phone?: string | null;
  isIndividual?: boolean; country?: string; bankAccountName?: string | null; bankName?: string | null; bankAccountNo?: string | null; bankIfsc?: string | null;
  defaultSalesAccountId?: number | null; defaultPurchaseAccountId?: number | null; isArchived?: boolean;
  msmeType?: string | null; udyamNo?: string | null; msmeAgreedDays?: number | null;
  addressLine1?: string | null; addressLine2?: string | null; city?: string | null; pincode?: string | null;
  shipLine1?: string | null; shipLine2?: string | null; shipCity?: string | null; shipStateCode?: string | null; shipPincode?: string | null;
  constitution?: string | null; isSez?: boolean; defaultTdsSection?: string | null; lowerTdsRateBp?: number | null; lowerTdsCert?: string | null; rcmDefault?: boolean;
}
interface Statement { contact: { name: string }; openingBalance: number; closingBalance: number; lines: { date: string; ref: string; type: string; amount: number; balance: number }[] }
interface TdsSection { code: string; description: string }

/** Kinds of business (constitution). Individuals and HUFs deduct TDS at the lower rate. */
export const CONSTITUTION: [string, string][] = [
  ['individual', 'Individual / Proprietor'], ['huf', 'Hindu Undivided Family (HUF)'], ['partnership', 'Partnership firm'], ['llp', 'Limited Liability Partnership (LLP)'],
  ['private_company', 'Private limited company'], ['public_company', 'Public limited company'], ['opc', 'One Person Company (OPC)'], ['aop', 'Association of Persons (AOP)'],
  ['boi', 'Body of Individuals (BOI)'], ['trust', 'Trust'], ['society', 'Society'], ['cooperative', 'Co-operative society'], ['government', 'Government / Government body'],
  ['local_authority', 'Local authority'], ['ajp', 'Artificial juridical person'], ['foreign_company', 'Foreign company'], ['other', 'Other'],
];
const constitutionName = (k?: string | null) => CONSTITUTION.find(([v]) => v === k)?.[1] ?? '';
const individualKind = (k: string) => k === 'individual' || k === 'huf';

const blank = { kind: 'customer' as string, name: '', gstin: '', registered: 'yes' as 'yes' | 'no', pan: '', stateCode: '', email: '', phone: '', country: 'India',
  constitution: '', addressLine1: '', addressLine2: '', city: '', pincode: '', sameShip: true, shipLine1: '', shipLine2: '', shipCity: '', shipStateCode: '', shipPincode: '',
  defaultTdsSection: '', lowerTdsRate: '', lowerTdsCert: '', rcmDefault: false,
  bankAccountName: '', bankName: '', bankAccountNo: '', bankIfsc: '', defaultSalesAccountId: '', defaultPurchaseAccountId: '', msmeType: '', udyamNo: '', msmeAgreedDays: '' };
type Form = typeof blank;

const TEMPLATE = 'Name,Type,GSTIN,PAN,State Code,Email,Phone,Bank Account Name,Bank Name,Bank Account Number,IFSC,Constitution,TDS Section,Address,Address Line 2,City,PIN Code\n'
  + 'Acme Pvt Ltd,Customer,,AAACA1234A,27,accounts@acme.example,9876543210,Acme Pvt Ltd,HDFC Bank,12345678901,HDFC0000001,Private limited company,,1 MG Road,,Pune,411001\n';
function saveText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
/** A message carried from a form to the list it returns to. */
let flash = '';
const address = (c: Contact) => [c.addressLine1, c.addressLine2, [c.city, c.pincode].filter(Boolean).join(' ')].filter(Boolean).join(', ');

type Props = { org: Org; canPost: boolean; canManage?: boolean; accounts?: Account[]; only?: 'customer' | 'supplier'; sub?: string; go?: (p: string) => void; restricted?: boolean; page?: string };

/**
 * Customers, suppliers or both. The list (search, sort, columns, export, ⋮ actions), a page per contact with its
 * statement (customers/12), and the add / edit form on its own page (customers/new, customers/edit-12).
 */
export function Contacts(p: Props) {
  const { sub } = p;
  if (sub === 'new') return <ContactForm {...p} />;
  if (sub && /^edit-\d+$/.test(sub)) return <ContactForm {...p} id={Number(sub.slice(5))} />;
  if (sub && /^\d+$/.test(sub)) return <ContactPage {...p} id={Number(sub)} />;
  return <ContactList {...p} />;
}

const pageOf = (p: Props) => p.page ?? (p.only === 'customer' ? 'customers' : p.only === 'supplier' ? 'suppliers' : 'contacts');
const goTo = (p: Props, to: string) => { if (p.go) p.go(to); else location.hash = `#/o/${p.org.id}/${to}`; };

function ContactList(p: Props) {
  const { org, canPost, canManage = false, accounts = [], only, restricted = false } = p;
  const [list, setList] = useState<Contact[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [ok, setOk] = useState(flash);
  useEffect(() => { flash = ''; }, []); // shown once (cleared after mounting, so React's double render in development keeps it)
  const [importing, setImporting] = useState(false);
  const [csv, setCsv] = useState(''), [fileName, setFileName] = useState('');
  const [problems, setProblems] = useState<{ row: number; name: string; column: string; value: string; problem: string; fix: string }[]>([]);
  const { error, busy, run, setError } = useAction();
  const load = useCallback(() => api<Contact[]>(`/orgs/${org.id}/contacts?archived=${showArchived}`).then(setList), [org.id, showArchived]);
  useEffect(() => { load(); }, [load]);

  const shown = list.filter((c) => !only || c.kind === only || c.kind === 'both');
  const label = only === 'customer' ? 'Customers' : only === 'supplier' ? 'Suppliers' : 'All contacts';
  const acctName = (id?: number | null) => { const a = accounts.find((x) => x.id === id); return a ? `${a.code} ${a.name}` : ''; };
  const page = pageOf(p);

  const archive = (c: Contact) => run(async () => { await api(`/orgs/${org.id}/contacts/${c.id}/archive`, { body: { archived: !c.isArchived } }); setOk(c.isArchived ? `${c.name} restored.` : `${c.name} archived.`); load(); });
  const remove = (c: Contact) => run(async () => {
    if (!await ask(`Delete ${c.name}? This cannot be undone. A contact that has invoices or bills can only be archived.`)) return;
    await api(`/orgs/${org.id}/contacts/${c.id}`, { method: 'DELETE' }); setOk(`${c.name} deleted.`); load();
  });
  const runImport = (dryRun: boolean) => run(async () => {
    setProblems([]);
    const r = await api(`/orgs/${org.id}/import/contacts`, { body: { csv, dryRun } });
    if (!r.ok) {
      setProblems(r.problems ?? []);
      setError(`Nothing imported: ${r.problems?.length ? `${new Set(r.problems.map((x: { row: number }) => x.row)).size} row(s) need changes` : r.errors.slice(0, 5).join(' · ')}. Fix them in your file and try again.`);
      return;
    }
    setOk(dryRun ? `Looks good: ${r.wouldImport} contact(s) ready to import.` : `Imported ${r.imported} contact(s).${r.errors.length ? ` ${r.errors.join(' · ')}` : ''}`);
    if (!dryRun) { setCsv(''); setFileName(''); setImporting(false); load(); }
  });
  const problemsFile = () => exportTable(org.id, {
    title: 'Contact import errors', subtitle: `${fileName || 'Pasted data'}: change these cells in your file, then import it again`,
    columns: [{ header: 'Row in file' }, { header: 'Name' }, { header: 'Column' }, { header: 'What is there now' }, { header: 'Problem' }, { header: 'What to change' }],
    rows: problems.map((x) => [x.row, x.name, x.column, x.value, x.problem, x.fix]),
  }, 'xlsx');

  const columns: Column<Contact>[] = [
    { key: 'name', label: 'Name', value: (c) => c.name, render: (c) => (
      <button type="button" className="text-left font-medium text-brand-700 hover:underline" onClick={() => goTo(p, `${page}/${c.id}`)}>{c.name}
        {c.isArchived && <span className="ml-2 rounded bg-slate-100 px-1.5 text-xs text-slate-500">archived</span>}</button>) },
    { key: 'kind', label: 'Type', value: (c) => c.kind, render: (c) => <Badge text={c.kind} /> },
    { key: 'gstin', label: 'GSTIN', value: (c) => c.gstin ?? (c.country && c.country !== 'IN' ? 'Overseas' : 'Unregistered') },
    { key: 'pan', label: 'PAN', value: (c) => c.pan },
    { key: 'state', label: 'State', value: (c) => c.stateCode },
    { key: 'country', label: 'Country', value: (c) => countryName(c.country, c.isSez), hidden: true },
    { key: 'constitution', label: 'Constitution', value: (c) => constitutionName(c.constitution), hidden: true },
    { key: 'email', label: 'Email', value: (c) => c.email, hidden: true },
    { key: 'phone', label: 'Phone', value: (c) => c.phone, hidden: true },
    { key: 'address', label: 'Address', value: (c) => address(c), hidden: true },
    { key: 'bank', label: 'Bank', value: (c) => (c.bankAccountNo ? `${c.bankName ?? 'A/c'} ••${c.bankAccountNo.slice(-4)}` : '') },
    { key: 'tds', label: 'TDS section', value: (c) => c.defaultTdsSection, hidden: true },
    { key: 'sales', label: 'Default sales', value: (c) => acctName(c.defaultSalesAccountId) },
    { key: 'purchase', label: 'Default purchase', value: (c) => acctName(c.defaultPurchaseAccountId) },
  ];

  return (
    <>
      <PageHeader title={label} subtitle="Click a name to see the contact and its statement. GSTIN sets the state for GST; a PAN is needed for the normal TDS rate."
        actions={<>
          {canManage && <Button variant="ghost" onClick={() => { setImporting(!importing); setOk(''); setError(''); setProblems([]); }}>{importing ? 'Close import' : 'Import'}</Button>}
          {canPost && <Button onClick={() => goTo(p, `${page}/new`)}>{`New ${only ?? 'contact'}`}</Button>}
        </>} />
      <div className="mb-3 space-y-2"><ErrorMsg msg={error} /><Ok msg={ok} /></div>

      {importing && canManage && (
        <Card title="Import contacts">
          <p className="mb-3 text-sm text-slate-600">Add many contacts at once from a CSV file. Existing contacts with the same name and GSTIN are skipped. Start from the blank template for the right columns.</p>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Button variant="ghost" onClick={() => saveText('contacts-import-template.csv', TEMPLATE)}>Download blank template</Button>
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border-2 border-dashed border-brand-300 bg-brand-50/50 px-4 py-2 font-medium text-brand-700 hover:border-brand-500 hover:bg-brand-50">
              <Icon name="download" className="rotate-180 text-brand-600" />{fileName ? `Chosen: ${fileName}` : 'Choose CSV file…'}
              <input aria-label="Contacts CSV file" type="file" accept=".csv" className="sr-only"
                onChange={async (e) => { const f = e.target.files?.[0]; if (f) { setFileName(f.name); setCsv(await f.text()); setProblems([]); } }} /></label>
          </div>
          {csv && (() => { const rows = csv.split(/\r?\n/).filter((l) => l.trim()).length - 1; return (
            <p className="mt-3 text-sm text-slate-600" data-testid="import-summary">{fileName ?? 'File'}: {rows} contact{rows === 1 ? '' : 's'} to bring in. Check it first, then import.</p>); })()}
          <div className="mt-3 flex gap-3"><Button variant="ghost" disabled={busy || !csv} onClick={() => runImport(true)}>Check (dry run)</Button><Button disabled={busy || !csv} onClick={() => runImport(false)}>Import</Button></div>
          {problems.length > 0 && (
            <div className="mt-4" data-testid="import-problems">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-semibold text-slate-800">{problems.length} problem(s) to fix</p>
                <Button variant="ghost" onClick={() => run(problemsFile)}>Download errors (Excel)</Button>
              </div>
              <table className="w-full text-sm"><thead><tr className="text-left"><th>Row</th><th>Name</th><th>Column</th><th>Now</th><th>What to change</th></tr></thead>
                <tbody>{problems.slice(0, 50).map((x, i) => <tr key={i}><td>{x.row}</td><td>{x.name}</td><td>{x.column}</td><td className="font-mono text-xs">{x.value || '(empty)'}</td><td><b>{x.problem}.</b> {x.fix}</td></tr>)}</tbody></table>
              {problems.length > 50 && <p className="mt-1 text-xs text-slate-500">The Excel file lists all {problems.length}.</p>}
            </div>
          )}
        </Card>
      )}

      <Card>
        <DataTable id={`contacts-${only ?? 'all'}`} rows={shown} columns={columns} rowKey={(c) => c.id} orgId={org.id} exportTitle={label}
          searchLabel={`Search ${label.toLowerCase()}`} empty={`No ${label.toLowerCase()} yet.`} initialSort={{ key: 'name', dir: 1 }}
          rowClass={(c) => (c.isArchived ? 'text-slate-400' : '')}
          toolbar={<label className="flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />Show archived</label>}
          trailing={(c) => (
            <RowMenu label={`Actions for ${c.name}`} actions={[
              { label: 'Statement', icon: 'statement', onClick: () => goTo(p, `${page}/${c.id}`), hidden: restricted },
              { label: 'Edit', icon: 'edit', onClick: () => goTo(p, `${page}/edit-${c.id}`), hidden: !canPost || restricted },
              { label: c.isArchived ? 'Restore' : 'Archive', icon: c.isArchived ? 'restore' : 'archive', onClick: () => archive(c), hidden: !canPost || restricted },
              { label: 'Delete', icon: 'trash', onClick: () => remove(c), hidden: !canManage, danger: true },
            ]} />)} />
      </Card>
    </>
  );
}

/** One contact: the basics, an Edit button, and the statement for any dates, with export. */
function ContactPage(p: Props & { id: number }) {
  const { org, id, canPost, restricted } = p;
  const [c, setC] = useState<Contact | null>(null);
  const [stmt, setStmt] = useState<Statement | null>(null);
  const [range, setRange] = useState({ from: '', to: today() });
  const { error, busy, run } = useAction();
  const load = (r = range) => run(async () => {
    const q = new URLSearchParams(); if (r.from) q.set('from', r.from); if (r.to) q.set('to', r.to);
    setStmt(await api(`/orgs/${org.id}/contacts/${id}/statement?${q}`));
  });
  useEffect(() => {
    api<Contact[]>(`/orgs/${org.id}/contacts?archived=true`).then((l) => setC(l.find((x) => x.id === id) ?? null));
    if (!restricted) load();
  }, [org.id, id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!c) return <p className="text-slate-500">Loading…</p>;
  const facts: [string, string][] = ([
    ['Type', c.kind], ['GSTIN', c.gstin ?? (c.country && c.country !== 'IN' ? 'Overseas' : 'Not registered under GST')], ['PAN', c.pan ?? ''],
    ['State', c.stateCode ?? ''], ['Country', countryName(c.country, c.isSez)], ['Constitution', constitutionName(c.constitution)],
    ['Email', c.email ?? ''], ['Phone', c.phone ?? ''], ['Address', address(c)], ['TDS section', c.defaultTdsSection ?? ''],
  ] as [string, string][]).filter(([, v]) => v);
  const label = (t: string) => ({ invoice: 'Invoice', bill: 'Bill', credit_note: 'Credit note', debit_note: 'Debit note', payment: 'Payment' }[t] ?? t);
  const build = () => ({
    title: `Statement: ${c.name}`, subtitle: `${range.from || 'From the start'} to ${range.to || today()}`,
    columns: [{ header: 'Date' }, { header: 'Type' }, { header: 'Reference' }, { header: 'Amount', money: true }, { header: 'Balance', money: true }],
    rows: [...(stmt!.openingBalance ? [['', '', 'Opening balance', null, stmt!.openingBalance]] : []),
      ...stmt!.lines.map((l) => [l.date, label(l.type), l.ref, l.amount, l.balance]), ['', '', 'Closing balance', null, stmt!.closingBalance]],
    boldRows: [stmt!.lines.length + (stmt!.openingBalance ? 1 : 0)],
  });
  return (
    <>
      <PageHeader title={c.name} subtitle={`${constitutionName(c.constitution) || 'Contact'}${c.isArchived ? ' · archived' : ''}`}
        actions={canPost && !restricted ? <Button onClick={() => goTo(p, `${pageOf(p)}/edit-${c.id}`)}><span className="inline-flex items-center gap-1.5"><Icon name="edit" className="text-white" />Edit contact</span></Button> : null} />
      <Card title="Details">
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">{facts.map(([k, v]) => <div key={k}><dt className="text-xs font-medium uppercase text-slate-500">{k}</dt><dd className="text-slate-800">{v}</dd></div>)}</dl>
      </Card>
      {!restricted && stmt && (
        <Card title={`Statement: ${c.name}`} actions={<ExportMenu orgId={org.id} build={build} />}>
          <div className="mb-3 flex flex-wrap items-end gap-3">
            <Field label="From" type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
            <Field label="To" type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
            <Button disabled={busy} onClick={() => load()}>Update</Button>
            <Button variant="ghost" onClick={() => { const r = { from: '', to: today() }; setRange(r); load(r); }}>All dates</Button>
          </div>
          <ErrorMsg msg={error} />
          <table className="w-full text-sm" data-testid="statement"><thead><tr className="text-left"><th>Date</th><th>Type</th><th>Reference</th><th className="text-right">Amount</th><th className="text-right">Balance</th></tr></thead>
            <tbody>{stmt.openingBalance !== 0 && <tr><td /><td /><td>Opening balance</td><td /><td className="text-right">{fmt(stmt.openingBalance)}</td></tr>}
              {stmt.lines.map((l, i) => <tr key={i}><td>{l.date}</td><td>{label(l.type)}</td><td>{l.ref}</td><td className="text-right">{fmt(l.amount)}</td><td className="text-right">{fmt(l.balance)}</td></tr>)}
              <tr className="border-t-2 font-semibold"><td /><td /><td>Balance</td><td /><td className="text-right" data-testid="statement-closing">{fmt(stmt.closingBalance)}</td></tr></tbody></table>
        </Card>
      )}
    </>
  );
}

/** Add or edit a contact, on its own page. */
/**
 * The full add / edit contact form in a box over the page, so a contact can be added or corrected from an invoice or
 * bill without losing what was typed there.
 */
export function ContactEditor({ org, accounts, id, kind, name, onDone }: { org: Org; accounts?: Account[]; id?: number; kind?: 'customer' | 'supplier'; name?: string; onDone: (saved: { id: number; msg: string } | null) => void }) {
  return (
    <div className="fixed inset-0 z-[80] overflow-y-auto bg-slate-900/40 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onDone(null); }}>
      <div role="dialog" aria-modal="true" aria-label={id ? 'Edit contact' : 'New contact'} className="mx-auto max-w-5xl space-y-4 rounded-xl bg-slate-50 p-5 shadow-2xl">
        <ContactForm org={org} canPost accounts={accounts} only={kind} id={id} startName={name} onDone={onDone} />
      </div>
    </div>
  );
}

function ContactForm(p: Props & { id?: number; startName?: string; onDone?: (saved: { id: number; msg: string } | null) => void }) {
  const { org, accounts = [], only, id } = p;
  const [states, setStates] = useState<{ code: string; name: string }[]>([]);
  const [tds, setTds] = useState<TdsSection[]>([]);
  const [f, setF] = useState<Form>({ ...blank, kind: only ?? 'customer', name: p.startName ?? '' });
  const [loaded, setLoaded] = useState(!id);
  const { error, busy, run, setError } = useAction();
  useEffect(() => {
    api('/config/states').then(setStates);
    api<TdsSection[]>(`/orgs/${org.id}/tds-sections`).catch(() => api<TdsSection[]>('/config/tds-sections')).then(setTds).catch(() => setTds([]));
    if (!id) return;
    api<Contact[]>(`/orgs/${org.id}/contacts?archived=true`).then((l) => {
      const c = l.find((x) => x.id === id);
      if (!c) { setError('Contact not found'); return; }
      const ship = !!(c.shipLine1 || c.shipCity || c.shipPincode);
      setF({ kind: c.kind, name: c.name, gstin: c.gstin ?? '', registered: c.gstin ? 'yes' : 'no', pan: c.pan ?? '', stateCode: c.stateCode ?? '', email: c.email ?? '', phone: c.phone ?? '',
        country: countryName(c.country, c.isSez), constitution: c.constitution ?? (c.isIndividual ? 'individual' : ''),
        addressLine1: c.addressLine1 ?? '', addressLine2: c.addressLine2 ?? '', city: c.city ?? '', pincode: c.pincode ?? '', sameShip: !ship,
        shipLine1: c.shipLine1 ?? '', shipLine2: c.shipLine2 ?? '', shipCity: c.shipCity ?? '', shipStateCode: c.shipStateCode ?? '', shipPincode: c.shipPincode ?? '',
        defaultTdsSection: c.defaultTdsSection ?? '', lowerTdsRate: c.lowerTdsRateBp != null ? String(c.lowerTdsRateBp / 100) : '', lowerTdsCert: c.lowerTdsCert ?? '', rcmDefault: !!c.rcmDefault,
        bankAccountName: c.bankAccountName ?? '', bankName: c.bankName ?? '', bankAccountNo: c.bankAccountNo ?? '', bankIfsc: c.bankIfsc ?? '',
        defaultSalesAccountId: c.defaultSalesAccountId ? String(c.defaultSalesAccountId) : '', defaultPurchaseAccountId: c.defaultPurchaseAccountId ? String(c.defaultPurchaseAccountId) : '',
        msmeType: c.msmeType ?? '', udyamNo: c.udyamNo ?? '', msmeAgreedDays: c.msmeAgreedDays ? String(c.msmeAgreedDays) : '' });
      setLoaded(true);
    });
  }, [org.id, id]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k: keyof Form) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const country = countryFrom(f.country);
  const india = country?.code === 'IN';
  const unregistered = india && f.registered === 'no';
  const supplier = f.kind !== 'customer';
  const incomeAccts = accounts.filter((a) => a.type === 'income'), costAccts = accounts.filter((a) => a.type === 'expense' || a.type === 'asset');
  const opt = (v: string, k: string) => (v.trim() ? { [k]: v.trim() } : {});

  const save = () => run(async () => {
    if (!f.name.trim()) throw new Error('Enter the name.');
    if (!country) throw new Error(`"${f.country}" is not a country in the list. Start typing and pick one.`);
    if (india && f.registered === 'yes' && !f.gstin.trim()) throw new Error('Enter the GSTIN, or choose "Not registered under GST".');
    if (unregistered && !f.stateCode) throw new Error('Choose the state of this unregistered party: it decides CGST + SGST or IGST.');
    const rate = f.lowerTdsRate.trim() ? Number(f.lowerTdsRate) : null;
    if (rate != null && (!Number.isFinite(rate) || rate < 0 || rate > 30)) throw new Error('Lower TDS rate must be a percentage from 0 to 30.');
    if (rate != null && !f.defaultTdsSection) throw new Error('A lower-deduction certificate is for one TDS section: choose the default TDS section too.');
    const body = {
      kind: f.kind, name: f.name.trim(), country: country.code, isSez: country.sez, isIndividual: individualKind(f.constitution),
      ...(f.constitution ? { constitution: f.constitution } : {}),
      ...(india && f.registered === 'yes' ? { gstin: f.gstin.trim().toUpperCase() } : {}), ...opt(f.pan.toUpperCase(), 'pan'), ...(f.stateCode && india ? { stateCode: f.stateCode } : {}),
      ...opt(f.email, 'email'), ...opt(f.phone, 'phone'),
      ...opt(f.addressLine1, 'addressLine1'), ...opt(f.addressLine2, 'addressLine2'), ...opt(f.city, 'city'), ...opt(f.pincode, 'pincode'),
      ...(f.sameShip ? {} : { ...opt(f.shipLine1, 'shipLine1'), ...opt(f.shipLine2, 'shipLine2'), ...opt(f.shipCity, 'shipCity'), ...opt(f.shipStateCode, 'shipStateCode'), ...opt(f.shipPincode, 'shipPincode') }),
      ...(f.defaultTdsSection ? { defaultTdsSection: f.defaultTdsSection } : {}),
      ...(supplier && rate != null ? { lowerTdsRateBp: Math.round(rate * 100) } : {}), ...(supplier ? opt(f.lowerTdsCert, 'lowerTdsCert') : {}),
      rcmDefault: supplier && f.rcmDefault,
      ...opt(f.bankAccountName, 'bankAccountName'), ...opt(f.bankName, 'bankName'), ...opt(f.bankAccountNo.replace(/\s/g, ''), 'bankAccountNo'), ...opt(f.bankIfsc.toUpperCase(), 'bankIfsc'),
      defaultSalesAccountId: f.defaultSalesAccountId ? Number(f.defaultSalesAccountId) : null, defaultPurchaseAccountId: f.defaultPurchaseAccountId ? Number(f.defaultPurchaseAccountId) : null,
      ...(supplier && f.msmeType ? { msmeType: f.msmeType } : {}), ...(supplier ? opt(f.udyamNo.toUpperCase(), 'udyamNo') : {}), ...(supplier && f.msmeAgreedDays ? { msmeAgreedDays: Number(f.msmeAgreedDays) } : {}),
    };
    let savedId = id;
    if (id) await api(`/orgs/${org.id}/contacts/${id}`, { method: 'PUT', body });
    else savedId = Number((await api(`/orgs/${org.id}/contacts`, { body })).id);
    if (p.onDone) { p.onDone({ id: savedId!, msg: id ? `${f.name.trim()} updated.` : `${f.name.trim()} added.` }); return; }
    flash = id ? 'Contact updated.' : 'Contact added.';
    goTo(p, pageOf(p));
  });
  if (!loaded) return <><ErrorMsg msg={error} /><p className="text-slate-500">Loading…</p></>;

  return (
    <>
      <PageHeader title={id ? `Edit ${f.name || 'contact'}` : `New ${only ?? 'contact'}`} subtitle="Fields marked * are needed. The GSTIN decides the state and whether CGST + SGST or IGST applies." />
      <Card title="Who they are">
        <div className="grid gap-3 md:grid-cols-3">
          {!only && <Select label="Type" aria-label="Contact type" value={f.kind} onChange={set('kind')}><option value="customer">Customer</option><option value="supplier">Supplier</option><option value="both">Both</option></Select>}
          <Field label="Name *" aria-label="Name" value={f.name} onChange={set('name')} />
          <Select label="Constitution of business" aria-label="Constitution" value={f.constitution} onChange={set('constitution')}>
            <option value="">Choose…</option>{CONSTITUTION.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</Select>
          <label className="block text-sm"><span className="mb-1 block font-medium text-slate-600">Country *</span>
            <Combo ariaLabel="Country" value={f.country} onText={(v) => setF((x) => ({ ...x, country: v }))} placeholder="Start typing a country" max={300}
              options={COUNTRY_NAMES.map((n) => ({ text: n }))} invalid={!!f.country.trim() && !countryFrom(f.country)} /></label>
          {india && (
            <fieldset className="text-sm md:col-span-2"><legend className="mb-1 font-medium text-slate-600">GST registration *</legend>
              <div className="flex flex-wrap gap-4 pt-1.5">
                <label className="inline-flex items-center gap-2"><input type="radio" name="gst-reg" checked={f.registered === 'yes'} onChange={() => setF({ ...f, registered: 'yes' })} />Registered under GST</label>
                <label className="inline-flex items-center gap-2"><input type="radio" name="gst-reg" checked={f.registered === 'no'} onChange={() => setF({ ...f, registered: 'no', gstin: '' })} />Not registered under GST</label>
              </div></fieldset>)}
          {india && <Field label={f.registered === 'yes' ? 'GSTIN *' : 'GSTIN (not registered)'} aria-label="GSTIN" value={f.gstin} disabled={f.registered === 'no'} onChange={set('gstin')} />}
          <Field label="PAN" value={f.pan} onChange={set('pan')} />
          {india && <Select label={unregistered ? 'State *' : 'State (if no GSTIN)'} aria-label="State" value={f.stateCode} onChange={set('stateCode')}><option value="">—</option>{states.map((s) => <option key={s.code} value={s.code}>{s.code} {s.name}</option>)}</Select>}
          <Field label="Email" value={f.email} onChange={set('email')} />
          <Field label="Phone" value={f.phone} onChange={set('phone')} />
        </div>
        {country && !india && <div className="mt-3"><Callout tone="info">Overseas party: invoices to them are exports (IGST, or zero-rated under LUT if your LUT is entered in Settings, Duties and taxes).</Callout></div>}
        {country?.sez && <div className="mt-3"><Callout tone="info">SEZ unit: supplies to it are zero-rated like exports (with IGST, or under LUT).</Callout></div>}
      </Card>

      <Card title="Billing address">
        <div className="grid gap-3 md:grid-cols-4">
          <div className="md:col-span-2"><Field label="Address line 1" value={f.addressLine1} onChange={set('addressLine1')} /></div>
          <div className="md:col-span-2"><Field label="Address line 2" value={f.addressLine2} onChange={set('addressLine2')} /></div>
          <Field label="City" value={f.city} onChange={set('city')} />
          <Field label="PIN code" inputMode="numeric" value={f.pincode} onChange={set('pincode')} />
        </div>
        <label className="mt-4 flex items-center gap-2 text-sm"><input type="checkbox" checked={f.sameShip} onChange={(e) => setF({ ...f, sameShip: e.target.checked })} />Delivery address is the same as the billing address</label>
        {!f.sameShip && (
          <div className="mt-3 grid gap-3 md:grid-cols-4">
            <div className="md:col-span-2"><Field label="Delivery address line 1" value={f.shipLine1} onChange={set('shipLine1')} /></div>
            <div className="md:col-span-2"><Field label="Delivery address line 2" value={f.shipLine2} onChange={set('shipLine2')} /></div>
            <Field label="Delivery city" value={f.shipCity} onChange={set('shipCity')} />
            <Select label="Delivery state" value={f.shipStateCode} onChange={set('shipStateCode')}><option value="">—</option>{states.map((s) => <option key={s.code} value={s.code}>{s.code} {s.name}</option>)}</Select>
            <Field label="Delivery PIN code" inputMode="numeric" value={f.shipPincode} onChange={set('shipPincode')} />
          </div>)}
      </Card>

      {!supplier && (
        <Card title="TDS this customer deducts">
          <div className="grid gap-3 md:grid-cols-3">
            <Select label="TDS section the customer deducts" aria-label="Customer TDS section" value={f.defaultTdsSection} onChange={set('defaultTdsSection')}>
              <option value="">No TDS</option>{tds.map((s) => <option key={s.code} value={s.code}>{s.code} {s.description}</option>)}</Select>
          </div>
          <p className="mt-2 text-xs text-slate-500">Filled in on new invoices for this customer: the TDS is shown as TDS receivable and the customer pays the net. It can be changed or typed by hand on each invoice.</p>
        </Card>)}

      {supplier && (
        <Card title="Tax on bills from this supplier">
          <div className="grid gap-3 md:grid-cols-3">
            <Select label="Default TDS section" aria-label="Default TDS section" value={f.defaultTdsSection} onChange={set('defaultTdsSection')}>
              <option value="">No TDS</option>{tds.map((s) => <option key={s.code} value={s.code}>{s.code} {s.description}</option>)}</Select>
            <Field label="Lower TDS rate % (section 197 certificate)" aria-label="Lower TDS rate" inputMode="decimal" placeholder="Leave empty if none" value={f.lowerTdsRate} onChange={set('lowerTdsRate')} />
            <Field label="Certificate number" aria-label="Lower TDS certificate" value={f.lowerTdsCert} onChange={set('lowerTdsCert')} />
          </div>
          <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={f.rcmDefault} onChange={(e) => setF({ ...f, rcmDefault: e.target.checked })} />GST on their bills is paid by us under reverse charge (RCM)</label>
          <p className="mt-2 text-xs text-slate-500">These fill in a new bill once this supplier is chosen. {f.constitution ? (individualKind(f.constitution) ? 'Individual / HUF: the lower TDS rate applies (e.g. 1% under 194C).' : 'Not an individual or HUF: the other TDS rate applies (e.g. 2% under 194C).') : 'Choose the constitution: individuals and HUFs pay a lower TDS rate.'}
            {unregistered && ' Not registered under GST: bills default to "Supply from unregistered dealer" (no GST).'}</p>
        </Card>)}

      <Card title="Bank account">
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="Account holder name" value={f.bankAccountName} onChange={set('bankAccountName')} />
          <Field label="Bank name" value={f.bankName} onChange={set('bankName')} />
          <Field label="Account number" inputMode="numeric" value={f.bankAccountNo} onChange={set('bankAccountNo')} />
          <Field label="IFSC code" maxLength={11} value={f.bankIfsc} onChange={(e) => setF({ ...f, bankIfsc: e.target.value.toUpperCase() })} />
        </div>
      </Card>

      {supplier && (
        <Card title="MSME (Udyam) status">
          <div className="grid gap-3 md:grid-cols-3">
            <Select label="MSME type" aria-label="MSME type" value={f.msmeType} onChange={set('msmeType')}>
              <option value="">Not MSME, or not known</option><option value="micro">Micro enterprise</option><option value="small">Small enterprise</option><option value="medium">Medium enterprise</option></Select>
            <Field label="Udyam registration number" aria-label="Udyam number" placeholder="UDYAM-MH-26-0012345" value={f.udyamNo} onChange={(e) => setF({ ...f, udyamNo: e.target.value.toUpperCase() })} />
            <Field label="Payment days agreed in writing" aria-label="Agreed payment days" inputMode="numeric" placeholder="None: 15 days apply" value={f.msmeAgreedDays} onChange={(e) => setF({ ...f, msmeAgreedDays: e.target.value.replace(/\D/g, '') })} />
          </div>
          {(f.msmeType === 'micro' || f.msmeType === 'small') && <p className="mt-2 text-xs text-slate-500">Section 43B(h): pay this supplier within {f.msmeAgreedDays ? Math.min(Number(f.msmeAgreedDays), 45) : 15} days of each bill, or the expense is allowed only in the year it is paid. Tax, Compliance checks lists what is due.</p>}
        </Card>)}

      <Card title="Default accounts">
        <div className="grid gap-3 md:grid-cols-3">
          {f.kind !== 'supplier' && <label className="block text-sm"><span className="mb-1 block font-medium text-slate-600">Default sales account</span>
            <AccountCombo orgId={org.id} ariaLabel="Default sales account" accounts={incomeAccts} type="income" allowNone noneLabel="None (use the item or 4000)" value={f.defaultSalesAccountId} onChange={(v) => setF((x) => ({ ...x, defaultSalesAccountId: v }))} /></label>}
          {supplier && <label className="block text-sm"><span className="mb-1 block font-medium text-slate-600">Default purchase account</span>
            <AccountCombo orgId={org.id} ariaLabel="Default purchase account" accounts={costAccts} type="expense" allowNone noneLabel="None (choose on each bill)" value={f.defaultPurchaseAccountId} onChange={(v) => setF((x) => ({ ...x, defaultPurchaseAccountId: v }))} /></label>}
        </div>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={busy} onClick={save}>{id ? 'Save changes' : 'Add contact'}</Button>
        <Button variant="ghost" onClick={() => (p.onDone ? p.onDone(null) : history.back())}>Cancel</Button>
      </div>
      <ErrorMsg msg={error} />
    </>
  );
}
