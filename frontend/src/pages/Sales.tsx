// Quotes, purchase orders and repeating invoices.
import { useCallback, useEffect, useState } from 'react';
import { api, fmt, today } from '../api';
import type { Org } from '../App';
import { Badge, Empty, PageHeader, Select } from '../kit';
import { Button, Card, ErrorMsg, Field, Ok, useAction } from '../ui';
import type { Contact } from './Contacts';
import { Account, ContactPicker, emptyLine, Line, LinesEditor, linesFromApi, linesToApi } from './Lines';

interface Pre { id: number; kind: string; number: string; contactName: string; issueDate: string; expiryDate: string | null; status: string; total: number; convertedDocId: number | null }

export function PreDocs({ org, kind, canPost, accounts, startNew = false }: { org: Org; kind: 'quote' | 'purchase_order'; canPost: boolean; accounts: Account[]; startNew?: boolean }) {
  const sales = kind === 'quote';
  const [list, setList] = useState<Pre[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [orgState, setOrgState] = useState<string | null>(org.gstin ? org.gstin.slice(0, 2) : null);
  const [show, setShow] = useState(startNew);
  useEffect(() => { if (startNew) setShow(true); }, [startNew]);
  const [editing, setEditing] = useState<number | null>(null);
  const [f, setF] = useState({ contactId: '', issueDate: today(), expiryDate: '', notes: '' });
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  // Converting: the quote or order is shown as the invoice or bill that will be posted, so it can be changed first.
  const [conv, setConv] = useState<{ id: number; number: string; contactId: string; issueDate: string; dueDate: string; docNumber: string; supplierRef: string; notes: string; lines: Line[] } | null>(null);
  const [ok, setOk] = useState('');
  const { error, busy, run } = useAction();
  const load = useCallback(() => api<Pre[]>(`/orgs/${org.id}/pre-documents?kind=${kind}`).then(setList), [org.id, kind]);
  useEffect(() => {
    load(); api(`/orgs/${org.id}/settings`).then((s) => setOrgState(s.stateCode ?? null)).catch(() => undefined);
    api<Contact[]>(`/orgs/${org.id}/contacts`).then((c) => setContacts(c.filter((x) => x.kind === 'both' || x.kind === (sales ? 'customer' : 'supplier'))));
  }, [load, org.id, sales]);
  const intraFor = (contactId: string) => { const st = contacts.find((c) => String(c.id) === contactId)?.stateCode; return orgState && st ? orgState === st : true; };

  const reset = () => { setF({ contactId: '', issueDate: today(), expiryDate: '', notes: '' }); setLines([emptyLine()]); setEditing(null); setShow(false); };
  const create = () => run(async () => {
    if (!f.contactId) throw new Error(`Choose a ${sales ? 'customer' : 'supplier'} from the list`);
    const b = { contactId: Number(f.contactId), issueDate: f.issueDate, ...(f.expiryDate ? { expiryDate: f.expiryDate } : {}), ...(f.notes ? { notes: f.notes } : {}), lines: linesToApi(lines) };
    if (editing) { const r = await api(`/orgs/${org.id}/pre-documents/${editing}`, { method: 'PUT', body: b }); setOk(`Updated: total ₹${fmt(r.total)}`); }
    else { const r = await api(`/orgs/${org.id}/pre-documents`, { body: { kind, ...b } }); setOk(`Created ${r.number}: total ₹${fmt(r.total)}`); }
    reset(); load();
  });
  const startEdit = (p: Pre) => run(async () => {
    setOk('');
    const d = await api(`/orgs/${org.id}/pre-documents/${p.id}`);
    setF({ contactId: String(d.contactId), issueDate: d.issueDate, expiryDate: d.expiryDate ?? '', notes: d.notes ?? '' });
    setLines(linesFromApi(d.lines.map((l: any) => ({ ...l, rate: l.rate })))); setEditing(p.id); setConv(null); setShow(true); window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  const status = (id: number, s: string) => run(async () => { await api(`/orgs/${org.id}/pre-documents/${id}/status`, { body: { status: s } }); load(); });
  const startConvert = (p: Pre) => run(async () => {
    setOk('');
    const d = await api(`/orgs/${org.id}/pre-documents/${p.id}`);
    setConv({ id: p.id, number: p.number, contactId: String(d.contactId), issueDate: today(), dueDate: '', docNumber: '', supplierRef: sales ? '' : p.number, notes: d.notes ?? '', lines: linesFromApi(d.lines) });
    setShow(false); setEditing(null); window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  const post = () => run(async () => {
    if (!conv) return;
    const r = await api(`/orgs/${org.id}/pre-documents/${conv.id}/convert`, { body: { issueDate: conv.issueDate, ...(conv.dueDate ? { dueDate: conv.dueDate } : {}), contactId: Number(conv.contactId), lines: linesToApi(conv.lines),
      ...(conv.docNumber.trim() ? { number: conv.docNumber.trim() } : {}), ...(!sales && conv.supplierRef ? { supplierRef: conv.supplierRef } : {}), ...(conv.notes ? { notes: conv.notes } : {}) } });
    setOk(`${conv.number} converted to ${r.number}.`); setConv(null); load();
  });

  return (
    <>
      <PageHeader title={sales ? 'Quotes' : 'Purchase orders'} subtitle={sales ? 'Offers to customers. Nothing is posted to the books until you convert a quote to an invoice.' : 'Orders to suppliers. Converting one creates the bill.'}
        actions={canPost && <Button onClick={() => { if (show) reset(); else { setEditing(null); setConv(null); setShow(true); } }}>{show ? 'Close' : sales ? 'New quote' : 'New purchase order'}</Button>} />
      <div className="mb-3 space-y-2"><ErrorMsg msg={error} /><Ok msg={ok} /></div>
      {show && (
        <Card title={editing ? `Edit ${sales ? 'quote' : 'purchase order'}` : sales ? 'New quote' : 'New purchase order'}>
          <div className="grid gap-3 md:grid-cols-3">
            <ContactPicker label={sales ? 'Customer' : 'Supplier'} contacts={contacts} value={f.contactId} onChange={(id) => setF({ ...f, contactId: id })} />
            <Field label="Date" type="date" value={f.issueDate} onChange={(e) => setF({ ...f, issueDate: e.target.value })} />
            <Field label={sales ? 'Valid until' : 'Delivery by'} type="date" value={f.expiryDate} onChange={(e) => setF({ ...f, expiryDate: e.target.value })} />
          </div>
          <LinesEditor org={org} lines={lines} setLines={setLines} sales={sales} accounts={accounts} intra={intraFor(f.contactId)} />
          <div className="mt-4 flex gap-3"><Button disabled={busy} onClick={create}>{editing ? 'Save changes' : 'Create'}</Button>{editing && <Button variant="ghost" onClick={reset}>Cancel</Button>}</div>
        </Card>
      )}
      {conv && (
        <Card title={`Review before posting: ${conv.number} becomes ${sales ? 'an invoice' : 'a bill'}`} actions={<Button variant="ghost" onClick={() => setConv(null)}>Cancel</Button>}>
          <p className="mb-3 rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">Nothing is in the books yet. Change anything below, then post. The {sales ? 'invoice' : 'bill'} is posted with the lines as they are here.</p>
          <div className="grid gap-3 md:grid-cols-4">
            <ContactPicker label={sales ? 'Customer' : 'Supplier'} contacts={contacts} value={conv.contactId} onChange={(id) => setConv({ ...conv, contactId: id })} />
            <Field label="Date" type="date" value={conv.issueDate} onChange={(e) => setConv({ ...conv, issueDate: e.target.value })} />
            <Field label="Due date" type="date" value={conv.dueDate} onChange={(e) => setConv({ ...conv, dueDate: e.target.value })} />
            <Field label={`${sales ? 'Invoice' : 'Bill'} number`} aria-label="Document number" placeholder="Automatic" value={conv.docNumber} onChange={(e) => setConv({ ...conv, docNumber: e.target.value })} />
            {!sales && <Field label="Supplier bill no." value={conv.supplierRef} onChange={(e) => setConv({ ...conv, supplierRef: e.target.value })} />}
          </div>
          <LinesEditor org={org} lines={conv.lines} setLines={(l) => setConv({ ...conv, lines: l })} sales={sales} accounts={accounts} intra={intraFor(conv.contactId)} />
          <label className="mt-4 block text-sm"><span className="mb-1 block font-medium text-slate-600">Notes</span><textarea aria-label="Notes" rows={2} maxLength={500} className="w-full rounded-md border border-slate-300 px-3 py-2" value={conv.notes} onChange={(e) => setConv({ ...conv, notes: e.target.value })} /></label>
          <div className="mt-4 flex gap-3"><Button disabled={busy || !conv.contactId} onClick={post}>{sales ? 'Post invoice' : 'Post bill'}</Button><Button variant="ghost" onClick={() => setConv(null)}>Cancel</Button></div>
        </Card>
      )}
      <Card>
        {list.length === 0 ? <Empty text="Nothing here yet." /> : (
          <table className="w-full text-sm"><thead><tr className="text-left text-slate-500"><th>Number</th><th>Contact</th><th>Date</th><th className="text-right">Total</th><th>Status</th><th /></tr></thead>
            <tbody>{list.map((p) => (
              <tr key={p.id} className="border-t border-slate-100"><td className="py-2 font-medium">{p.number}</td><td>{p.contactName}</td><td>{p.issueDate}</td><td className="text-right">{fmt(p.total)}</td><td><Badge text={p.status} /></td>
                <td className="space-x-1 whitespace-nowrap text-right">{canPost && p.status !== 'converted' && <Button variant="ghost" onClick={() => startEdit(p)}>Edit</Button>}
                  {canPost && p.status !== 'converted' && p.status !== 'declined' && <>
                  {p.status === 'draft' && <Button variant="ghost" onClick={() => status(p.id, 'sent')}>Mark sent</Button>}
                  {(p.status === 'draft' || p.status === 'sent') && sales && <Button variant="ghost" onClick={() => status(p.id, 'accepted')}>Accepted</Button>}
                  {sales && <Button variant="ghost" onClick={() => status(p.id, 'declined')}>Declined</Button>}
                  <Button disabled={busy} onClick={() => startConvert(p)}>{sales ? 'Convert to invoice' : 'Convert to bill'}</Button></>}</td></tr>))}</tbody></table>
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
