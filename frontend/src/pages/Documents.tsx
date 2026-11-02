import { useCallback, useEffect, useState } from 'react';
import { api, download, fmt, toPaise, today } from '../api';
import type { Org } from '../App';
import { Badge, Empty, PageHeader, Select } from '../kit';
import { Button, Card, ErrorMsg, Field, Ok, useAction } from '../ui';
import type { Contact } from './Contacts';
import { Account, emptyLine, Line, LinesEditor, linesToApi } from './Lines';

interface Doc { id: number; docType: string; number: string; contactName: string; issueDate: string; dueDate: string | null; total: number; tdsAmount: number; status: string; outstanding?: number; currency: string; foreignTotal: number | null; supplyType: string }

const SUPPLY = {
  sales: [['regular', 'Regular'], ['export_lut', 'Export under LUT (no GST)'], ['export_igst', 'Export with IGST'], ['sez_lut', 'SEZ under LUT (no GST)'], ['sez_igst', 'SEZ with IGST']],
  purchases: [['regular', 'Regular'], ['reverse_charge', 'Reverse charge (you pay the GST)']],
} as const;

const TYPES = { sales: [['invoice', 'Invoice'], ['credit_note', 'Credit note']], purchases: [['bill', 'Bill'], ['debit_note', 'Debit note']] } as const;

export function Documents({ org, kind, canPost, accounts }: { org: Org; kind: 'sales' | 'purchases'; canPost: boolean; accounts: Account[] }) {
  const types = TYPES[kind];
  const [docs, setDocs] = useState<Doc[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [tds, setTds] = useState<{ code: string; description: string }[]>([]);
  const [docType, setDocType] = useState<string>(types[0][0]);
  const [f, setF] = useState({ contactId: '', issueDate: today(), dueDate: '', supplierRef: '', tdsSection: '', originalDocId: '', supplyType: 'regular', currency: 'INR', fxRate: '' });
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const [showForm, setShowForm] = useState(false);
  const [ok, setOk] = useState('');
  const [pay, setPay] = useState<{ id: number; amount: string; accountId: string; currency: string; foreign: string } | null>(null);
  const { error, busy, run, setError } = useAction();

  const load = useCallback(() => api<Doc[]>(`/orgs/${org.id}/documents`).then((d) => setDocs(d.filter((x) => types.some(([t]) => t === x.docType)))), [org.id, kind]);
  useEffect(() => {
    load();
    api<Contact[]>(`/orgs/${org.id}/contacts`).then((c) => setContacts(c.filter((x) => x.kind === 'both' || x.kind === (kind === 'sales' ? 'customer' : 'supplier'))));
    api('/config/tds-sections').then(setTds);
  }, [load, org.id, kind]);

  const bankOptions = accounts.filter((a) => a.type === 'asset' && ['1000', '1010'].includes(a.code));
  const foreign = f.currency !== 'INR';
  // Line rates are typed in the document's currency; the API takes the smallest unit (paise, cents).
  const create = (forApproval = false) => run(async () => {
    setOk('');
    const body = { docType, contactId: Number(f.contactId), issueDate: f.issueDate, lines: linesToApi(lines), supplyType: f.supplyType,
      ...(foreign ? { currency: f.currency, fxRate: Number(f.fxRate) } : {}),
      ...(f.dueDate ? { dueDate: f.dueDate } : {}), ...(f.supplierRef ? { supplierRef: f.supplierRef } : {}),
      ...(f.tdsSection && docType === 'bill' ? { tdsSection: f.tdsSection } : {}), ...(f.originalDocId ? { originalDocId: Number(f.originalDocId) } : {}) };
    if (forApproval) {
      const d = await api(`/orgs/${org.id}/drafts`, { body });
      setOk(`Sent for approval (total ${foreign ? f.currency + ' ' : '₹'}${fmt(d.total)}). It reaches the books once an owner or accountant approves it.`);
      setLines([emptyLine()]); setShowForm(false); return;
    }
    const r = await api(`/orgs/${org.id}/documents`, { body });
    setOk(`Created ${r.number}: total ₹${fmt(r.total)}${r.foreignTotal ? ` (${r.currency} ${fmt(r.foreignTotal)})` : ''}${r.tdsAmount ? `, TDS ₹${fmt(r.tdsAmount)}, net payable ₹${fmt(r.netPayable)}` : ''}${r.rcm && (r.rcm.cgst + r.rcm.sgst + r.rcm.igst) ? `, reverse-charge GST ₹${fmt(r.rcm.cgst + r.rcm.sgst + r.rcm.igst)} to pay` : ''}`);
    setLines([emptyLine()]); setShowForm(false); load();
  });
  const doPay = () => run(async () => {
    if (!pay) return;
    const r = await api(`/orgs/${org.id}/documents/${pay.id}/payments`, { body: { date: today(), amount: toPaise(pay.amount), accountId: Number(pay.accountId),
      ...(pay.currency !== 'INR' ? { foreignAmount: toPaise(pay.foreign) } : {}) } });
    setPay(null); setOk(`Payment recorded.${r.fxGain ? ` Exchange ${r.fxGain > 0 ? 'gain' : 'loss'} ₹${fmt(Math.abs(r.fxGain))}.` : ''}`); load();
  });
  const doVoid = (d: Doc) => run(async () => { await api(`/orgs/${org.id}/documents/${d.id}/void`, { body: { date: today(), reason: 'Voided from the app' } }); setOk(`${d.number} voided.`); load(); });
  const email = (d: Doc) => run(async () => { const r = await api(`/orgs/${org.id}/documents/${d.id}/send`, { body: {} }); setOk(`${d.number} queued to ${r.queuedTo}.`); });
  const remind = () => run(async () => { const r = await api(`/orgs/${org.id}/documents/remind-overdue`, { method: 'POST', body: {} }); setOk(`${r.reminders} overdue reminder(s) queued.`); });

  const title = kind === 'sales' ? 'Invoices' : 'Bills';
  const overdue = (d: Doc) => d.status === 'posted' && (d.outstanding ?? 0) > 0 && !!d.dueDate && d.dueDate < today() && (d.docType === 'invoice' || d.docType === 'bill');

  return (
    <>
      <PageHeader title={title} subtitle={kind === 'sales' ? 'Invoices and credit notes you send to customers' : 'Bills and debit notes from your suppliers'}
        actions={canPost && <>{kind === 'sales' && <Button variant="ghost" disabled={busy} onClick={remind}>Send overdue reminders</Button>}<Button onClick={() => setShowForm(!showForm)}>{showForm ? 'Close' : `New ${kind === 'sales' ? 'invoice' : 'bill'}`}</Button></>} />
      <div className="mb-3 space-y-2"><ErrorMsg msg={error} /><Ok msg={ok} /></div>
      {showForm && canPost && (
        <Card title={kind === 'sales' ? 'New sales document' : 'New purchase document'}>
          <div className="grid gap-3 md:grid-cols-4">
            <Select label="Type" aria-label="Document type" value={docType} onChange={(e) => setDocType(e.target.value)}>{types.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
            <Select label={kind === 'sales' ? 'Customer' : 'Supplier'} aria-label="Contact" value={f.contactId} onChange={(e) => setF({ ...f, contactId: e.target.value })}>
              <option value="">Select…</option>{contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
            <Field label="Date" type="date" value={f.issueDate} onChange={(e) => setF({ ...f, issueDate: e.target.value })} />
            <Field label="Due date" type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} />
            {docType === 'bill' && <Field label="Supplier bill no." value={f.supplierRef} onChange={(e) => setF({ ...f, supplierRef: e.target.value })} />}
            {docType === 'bill' && <Select label="TDS section" aria-label="TDS section" value={f.tdsSection} onChange={(e) => setF({ ...f, tdsSection: e.target.value })}>
              <option value="">No TDS</option>{tds.map((t) => <option key={t.code} value={t.code}>{t.code} · {t.description}</option>)}</Select>}
            <Select label="Supply type" aria-label="Supply type" value={f.supplyType} onChange={(e) => setF({ ...f, supplyType: e.target.value })}>{SUPPLY[kind].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
            <Field label="Currency" aria-label="Currency" value={f.currency} maxLength={3} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} />
            {foreign && <Field label={`Rupees per 1 ${f.currency}`} aria-label="Exchange rate" inputMode="decimal" value={f.fxRate} onChange={(e) => setF({ ...f, fxRate: e.target.value })} />}
            {(docType === 'credit_note' || docType === 'debit_note') && <Select label="Against" aria-label="Original document" value={f.originalDocId} onChange={(e) => setF({ ...f, originalDocId: e.target.value })}>
              <option value="">—</option>{docs.filter((d) => d.status === 'posted' && (d.docType === 'invoice' || d.docType === 'bill')).map((d) => <option key={d.id} value={d.id}>{d.number} · {d.contactName}</option>)}</Select>}
          </div>
          <LinesEditor org={org} lines={lines} setLines={setLines} sales={kind === 'sales'} accounts={accounts} currency={f.currency} />
          <div className="mt-4 flex items-center gap-3"><Button disabled={busy} onClick={() => create()}>Create</Button>
            {(docType === 'invoice' || docType === 'bill') && <Button variant="ghost" disabled={busy} onClick={() => create(true)}>Submit for approval</Button>}
            <p className="text-xs text-slate-500">GST (CGST+SGST or IGST) and TDS are worked out from the place of supply and the chosen section when you create the document.</p></div>
        </Card>
      )}
      <Card>
        {docs.length === 0 ? <Empty text="Nothing here yet." /> : (
          <table className="w-full text-sm">
            <thead><tr className="text-left text-slate-500"><th>Number</th><th>Contact</th><th>Date</th><th>Due</th><th className="text-right">Total</th><th className="text-right">TDS</th><th className="text-right">Outstanding</th><th className="pl-4">Status</th><th /></tr></thead>
            <tbody>{docs.map((d) => (
              <tr key={d.id} className="border-t border-slate-100">
                <td className="py-2 font-medium">{d.number}</td><td>{d.contactName}</td><td>{d.issueDate}</td>
                <td className={overdue(d) ? 'font-medium text-red-700' : ''}>{d.dueDate ?? ''}</td>
                <td className="text-right">{fmt(d.total)}{d.currency !== 'INR' && d.foreignTotal != null && <span className="block text-xs text-slate-500">{d.currency} {fmt(d.foreignTotal)}</span>}</td><td className="text-right">{d.tdsAmount ? fmt(d.tdsAmount) : ''}</td>
                <td className="text-right">{d.outstanding !== undefined && (d.docType === 'invoice' || d.docType === 'bill') && d.status === 'posted' ? fmt(d.outstanding) : ''}</td>
                <td className="pl-4"><Badge text={d.status === 'posted' && (d.docType === 'invoice' || d.docType === 'bill') && d.outstanding === 0 ? 'paid' : d.status} /></td>
                <td className="space-x-1 whitespace-nowrap text-right">
                  <Button variant="ghost" onClick={() => { setError(''); download(`/orgs/${org.id}/documents/${d.id}/pdf`, `${d.number.replace(/\//g, '-')}.pdf`).catch((e) => setError(e.message)); }}>PDF</Button>
                  {canPost && kind === 'sales' && d.status === 'posted' && <Button variant="ghost" onClick={() => email(d)}>Email</Button>}
                  {canPost && d.status === 'posted' && (d.docType === 'invoice' || d.docType === 'bill') && (d.outstanding ?? 0) > 0 && <Button variant="ghost" onClick={() => setPay({ id: d.id, amount: d.currency === 'INR' ? String((d.outstanding ?? 0) / 100) : '', accountId: '', currency: d.currency, foreign: '' })}>Pay</Button>}
                  {canPost && d.status === 'posted' && <Button variant="ghost" onClick={() => doVoid(d)}>Void</Button>}
                </td>
              </tr>))}</tbody>
          </table>
        )}
        {pay && (
          <div className="mt-4 flex flex-wrap items-end gap-3 rounded bg-slate-50 p-3">
            {pay.currency !== 'INR' && <Field label={`Amount in ${pay.currency}`} value={pay.foreign} onChange={(e) => setPay({ ...pay, foreign: e.target.value })} />}
            <Field label={pay.currency !== 'INR' ? 'Rupees received / paid' : 'Amount (₹)'} value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} />
            <Select label="Bank / cash account" aria-label="Payment account" value={pay.accountId} onChange={(e) => setPay({ ...pay, accountId: e.target.value })}>
              <option value="">Select…</option>{bankOptions.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</Select>
            <Button disabled={busy || !pay.accountId} onClick={doPay}>Record payment</Button><Button variant="ghost" onClick={() => setPay(null)}>Cancel</Button>
          </div>
        )}
      </Card>
    </>
  );
}
