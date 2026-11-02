// Quotes, purchase orders and repeating invoices.
import { useCallback, useEffect, useState } from 'react';
import { api, fmt, today } from '../api';
import type { Org } from '../App';
import { Badge, Empty, PageHeader, Select } from '../kit';
import { Button, Card, ErrorMsg, Field, Ok, useAction } from '../ui';
import type { Contact } from './Contacts';
import { Account, emptyLine, Line, LinesEditor, linesToApi } from './Lines';

interface Pre { id: number; kind: string; number: string; contactName: string; issueDate: string; expiryDate: string | null; status: string; total: number; convertedDocId: number | null }

export function PreDocs({ org, kind, canPost, accounts, startNew = false }: { org: Org; kind: 'quote' | 'purchase_order'; canPost: boolean; accounts: Account[]; startNew?: boolean }) {
  const sales = kind === 'quote';
  const [list, setList] = useState<Pre[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [show, setShow] = useState(startNew);
  useEffect(() => { if (startNew) setShow(true); }, [startNew]);
  const [f, setF] = useState({ contactId: '', issueDate: today(), expiryDate: '' });
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const [ok, setOk] = useState('');
  const { error, busy, run } = useAction();
  const load = useCallback(() => api<Pre[]>(`/orgs/${org.id}/pre-documents?kind=${kind}`).then(setList), [org.id, kind]);
  useEffect(() => { load(); api<Contact[]>(`/orgs/${org.id}/contacts`).then((c) => setContacts(c.filter((x) => x.kind === 'both' || x.kind === (sales ? 'customer' : 'supplier')))); }, [load, org.id, sales]);

  const create = () => run(async () => {
    const r = await api(`/orgs/${org.id}/pre-documents`, { body: { kind, contactId: Number(f.contactId), issueDate: f.issueDate, ...(f.expiryDate ? { expiryDate: f.expiryDate } : {}), lines: linesToApi(lines) } });
    setOk(`Created ${r.number}: total ₹${fmt(r.total)}`); setLines([emptyLine()]); setShow(false); load();
  });
  const status = (id: number, s: string) => run(async () => { await api(`/orgs/${org.id}/pre-documents/${id}/status`, { body: { status: s } }); load(); });
  const convert = (p: Pre) => run(async () => { const r = await api(`/orgs/${org.id}/pre-documents/${p.id}/convert`, { body: { issueDate: today() } }); setOk(`${p.number} converted to ${r.number}.`); load(); });

  return (
    <>
      <PageHeader title={sales ? 'Quotes' : 'Purchase orders'} subtitle={sales ? 'Offers to customers. Nothing is posted to the books until you convert a quote to an invoice.' : 'Orders to suppliers. Converting one creates the bill.'}
        actions={canPost && <Button onClick={() => setShow(!show)}>{show ? 'Close' : sales ? 'New quote' : 'New purchase order'}</Button>} />
      <div className="mb-3 space-y-2"><ErrorMsg msg={error} /><Ok msg={ok} /></div>
      {show && (
        <Card title={sales ? 'New quote' : 'New purchase order'}>
          <div className="grid gap-3 md:grid-cols-3">
            <Select label={sales ? 'Customer' : 'Supplier'} aria-label="Contact" value={f.contactId} onChange={(e) => setF({ ...f, contactId: e.target.value })}><option value="">Select…</option>{contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
            <Field label="Date" type="date" value={f.issueDate} onChange={(e) => setF({ ...f, issueDate: e.target.value })} />
            <Field label={sales ? 'Valid until' : 'Delivery by'} type="date" value={f.expiryDate} onChange={(e) => setF({ ...f, expiryDate: e.target.value })} />
          </div>
          <LinesEditor org={org} lines={lines} setLines={setLines} sales={sales} accounts={accounts} />
          <div className="mt-4"><Button disabled={busy} onClick={create}>Create</Button></div>
        </Card>
      )}
      <Card>
        {list.length === 0 ? <Empty text="Nothing here yet." /> : (
          <table className="w-full text-sm"><thead><tr className="text-left text-slate-500"><th>Number</th><th>Contact</th><th>Date</th><th className="text-right">Total</th><th>Status</th><th /></tr></thead>
            <tbody>{list.map((p) => (
              <tr key={p.id} className="border-t border-slate-100"><td className="py-2 font-medium">{p.number}</td><td>{p.contactName}</td><td>{p.issueDate}</td><td className="text-right">{fmt(p.total)}</td><td><Badge text={p.status} /></td>
                <td className="space-x-1 text-right">{canPost && p.status !== 'converted' && p.status !== 'declined' && <>
                  {p.status === 'draft' && <Button variant="ghost" onClick={() => status(p.id, 'sent')}>Mark sent</Button>}
                  {(p.status === 'draft' || p.status === 'sent') && sales && <Button variant="ghost" onClick={() => status(p.id, 'accepted')}>Accepted</Button>}
                  {sales && <Button variant="ghost" onClick={() => status(p.id, 'declined')}>Declined</Button>}
                  <Button disabled={busy} onClick={() => convert(p)}>{sales ? 'Convert to invoice' : 'Convert to bill'}</Button></>}</td></tr>))}</tbody></table>
        )}
      </Card>
    </>
  );
}

interface Rec { id: number; contactName: string; frequency: string; nextDate: string; endDate: string | null; autoEmail: boolean; active: boolean }

export function Recurring({ org, canPost, accounts }: { org: Org; canPost: boolean; accounts: Account[] }) {
  const [list, setList] = useState<Rec[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [show, setShow] = useState(false);
  const [f, setF] = useState({ contactId: '', frequency: 'monthly', nextDate: today(), endDate: '', dueDays: '15', autoEmail: false });
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const { error, busy, run } = useAction();
  const load = useCallback(() => api<Rec[]>(`/orgs/${org.id}/recurring`).then(setList), [org.id]);
  useEffect(() => { load(); api<Contact[]>(`/orgs/${org.id}/contacts`).then((c) => setContacts(c.filter((x) => x.kind !== 'supplier'))); }, [load, org.id]);
  const create = () => run(async () => {
    await api(`/orgs/${org.id}/recurring`, { body: { contactId: Number(f.contactId), frequency: f.frequency, nextDate: f.nextDate, ...(f.endDate ? { endDate: f.endDate } : {}), dueDays: Number(f.dueDays), autoEmail: f.autoEmail, lines: linesToApi(lines) } });
    setLines([emptyLine()]); setShow(false); load();
  });
  return (
    <>
      <PageHeader title="Repeating invoices" subtitle="Invoices created automatically on a schedule, and optionally emailed to the customer."
        actions={canPost && <Button onClick={() => setShow(!show)}>{show ? 'Close' : 'New repeating invoice'}</Button>} />
      <div className="mb-3"><ErrorMsg msg={error} /></div>
      {show && (
        <Card title="New repeating invoice">
          <div className="grid gap-3 md:grid-cols-3">
            <Select label="Customer" aria-label="Contact" value={f.contactId} onChange={(e) => setF({ ...f, contactId: e.target.value })}><option value="">Select…</option>{contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
            <Select label="Repeat" aria-label="Frequency" value={f.frequency} onChange={(e) => setF({ ...f, frequency: e.target.value })}>{['weekly', 'monthly', 'quarterly', 'yearly'].map((x) => <option key={x}>{x}</option>)}</Select>
            <Field label="First invoice date" type="date" value={f.nextDate} onChange={(e) => setF({ ...f, nextDate: e.target.value })} />
            <Field label="Stop after (optional)" type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} />
            <Field label="Payment due (days)" value={f.dueDays} onChange={(e) => setF({ ...f, dueDays: e.target.value })} />
            <label className="flex items-center gap-2 pt-6 text-sm"><input type="checkbox" checked={f.autoEmail} onChange={(e) => setF({ ...f, autoEmail: e.target.checked })} /> Email each invoice automatically</label>
          </div>
          <LinesEditor org={org} lines={lines} setLines={setLines} sales accounts={accounts} />
          <div className="mt-4"><Button disabled={busy} onClick={create}>Save schedule</Button></div>
        </Card>
      )}
      <Card>
        {list.length === 0 ? <Empty text="No repeating invoices yet." /> : (
          <table className="w-full text-sm"><thead><tr className="text-left text-slate-500"><th>Customer</th><th>Repeats</th><th>Next invoice</th><th>Ends</th><th>Email</th><th>Status</th><th /></tr></thead>
            <tbody>{list.map((r) => (
              <tr key={r.id} className="border-t border-slate-100"><td className="py-2">{r.contactName}</td><td>{r.frequency}</td><td>{r.nextDate}</td><td>{r.endDate ?? '—'}</td><td>{r.autoEmail ? 'Yes' : 'No'}</td><td><Badge text={r.active ? 'active' : 'done'} /></td>
                <td className="text-right">{canPost && r.active && <Button variant="ghost" onClick={() => run(async () => { await api(`/orgs/${org.id}/recurring/${r.id}/stop`, { method: 'POST', body: {} }); load(); })}>Stop</Button>}</td></tr>))}</tbody></table>
        )}
      </Card>
    </>
  );
}
