// Quotes, purchase orders and repeating invoices.
import { useCallback, useEffect, useState } from 'react';
import { api, fmt, today } from '../api';
import type { Org } from '../App';
import { Badge, Empty, PageHeader, Select } from '../kit';
import { DataTable, RowMenu, type Column } from '../table';
import { Button, Callout, Card, ErrorMsg, Field, Ok, useAction } from '../ui';
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
          <div className="mb-3"><Callout tone="warning" title="Nothing is in the books yet">Change anything below, then post. The {sales ? 'invoice' : 'bill'} is posted with the lines as they are here.</Callout></div>
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
        <DataTable id={`pre-${kind}`} rows={list} rowKey={(p) => p.id} orgId={org.id} exportTitle={sales ? 'Quotes' : 'Purchase orders'} empty="Nothing here yet."
          searchLabel={`Search ${sales ? 'quotes' : 'purchase orders'}`}
          columns={[
            { key: 'number', label: 'Number', value: (p) => p.number, render: (p) => (canPost && p.status !== 'converted'
              ? <button type="button" className="font-medium text-brand-700 hover:underline" onClick={() => startEdit(p)}>{p.number}</button> : <b>{p.number}</b>) },
            { key: 'contact', label: sales ? 'Customer' : 'Supplier', value: (p) => p.contactName },
            { key: 'date', label: 'Date', value: (p) => p.issueDate },
            { key: 'expiry', label: sales ? 'Valid until' : 'Delivery by', value: (p) => p.expiryDate, hidden: true },
            { key: 'total', label: 'Total', value: (p) => p.total, money: true, noSearch: true },
            { key: 'status', label: 'Status', value: (p) => p.status, render: (p) => <Badge text={p.status} /> },
          ]}
          trailing={(p) => canPost && p.status !== 'converted' ? (
            <span className="inline-flex items-center gap-1">
              {p.status !== 'declined' && <Button variant="ghost" className="!px-3 !py-1.5" disabled={busy} onClick={() => startConvert(p)}>{sales ? 'Convert to invoice' : 'Convert to bill'}</Button>}
              <RowMenu label={`Actions for ${p.number}`} actions={[
                { label: 'Edit', icon: 'edit', onClick: () => startEdit(p) },
                { label: 'Mark sent', icon: 'mail', onClick: () => status(p.id, 'sent'), hidden: p.status !== 'draft' },
                { label: 'Accepted', icon: 'check', onClick: () => status(p.id, 'accepted'), hidden: !sales || !(p.status === 'draft' || p.status === 'sent') },
                { label: 'Declined', icon: 'trash', onClick: () => status(p.id, 'declined'), hidden: !sales || p.status === 'declined', danger: true },
              ]} />
            </span>) : null} />
      </Card>
    </>
  );
}

interface Rec { id: number; contactId: number; contactName: string; frequency: string; nextDate: string; endDate: string | null; autoEmail: boolean; active: boolean; tdsSection?: string | null; made?: number; postedTotal?: number;
  dueDays: number; notes: string | null; lines: any[]; postMode: 'auto' | 'review'; supplyType: string; isArchived?: boolean }
interface Due { id: number; recurringId: number; dueDate: string; notes: string | null; docType: string; contactName: string; lines: any[] }

/** Placeholders a narration can use; filled in on each run. */
const PLACEHOLDERS: [string, string][] = [['{month}', 'Nov-26'], ['{month_long}', 'November 2026'], ['{date}', 'DD-MM-YYYY'], ['{period}', '01-11-2026 to 30-11-2026'], ['{quarter}', 'Q3 2026-27'], ['{fy}', '2026-27'], ['{year}', '2026']];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** What the first narration will read, the way the server fills it in (monthly runs). */
const preview = (t: string, on: string) => {
  const y = Number(on.slice(0, 4)), m = Number(on.slice(5, 7)) - 1, fy = m >= 3 ? y : y - 1, fyl = `${fy}-${String((fy + 1) % 100).padStart(2, '0')}`;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate(), mm = on.slice(5, 7);
  const v: Record<string, string> = { '{month}': `${MON[m]}-${String(y % 100).padStart(2, '0')}`, '{month_long}': `${MONTH[m]} ${y}`, '{date}': `${on.slice(8, 10)}-${mm}-${y}`, '{year}': String(y), '{fy}': fyl,
    '{quarter}': `Q${Math.floor(((m + 9) % 12) / 3) + 1} ${fyl}`, '{period}': `01-${mm}-${y} to ${last}-${mm}-${y}` };
  return t.replace(/\{[a-z_]+\}/g, (k) => v[k] ?? k);
};
const SUPPLY_OPTS = { invoice: [['regular', 'Regular'], ['export_lut', 'Export under LUT (no GST)'], ['export_igst', 'Export with IGST'], ['sez_lut', 'SEZ under LUT (no GST)'], ['sez_igst', 'SEZ with IGST']],
  bill: [['regular', 'Regular'], ['reverse_charge', 'Reverse charge (you pay the GST)'], ['unregistered', 'Supply from unregistered dealer (no GST)']] } as const;

/** Repeating invoices, or (kind="bill") repeating bills such as rent, maintenance contracts and subscriptions. */
export function Recurring({ org, canPost, accounts, kind = 'invoice', go }: { org: Org; canPost: boolean; accounts: Account[]; kind?: 'invoice' | 'bill'; go?: (p: string) => void }) {
  const bill = kind === 'bill';
  const noun = bill ? 'bill' : 'invoice';
  const blank = () => ({ contactId: '', frequency: 'monthly', nextDate: today(), endDate: '', dueDays: '15', autoEmail: false, tdsSection: '', notes: '', postMode: bill ? 'review' : 'auto', supplyType: 'regular' });
  const [list, setList] = useState<Rec[]>([]);
  const [due, setDue] = useState<Due[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [tds, setTds] = useState<{ code: string; description: string }[]>([]);
  const [show, setShow] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [ok, setOk] = useState('');
  const [f, setF] = useState(blank());
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const { error, run } = useAction();
  const form = useAction();
  const load = useCallback(() => {
    api<Rec[]>(`/orgs/${org.id}/recurring${bill ? '?type=bill' : ''}`).then(setList);
    api<Due[]>(`/orgs/${org.id}/recurring-due`).then((d) => setDue(d.filter((x) => x.docType === kind))).catch(() => setDue([]));
  }, [org.id, bill, kind]);
  useEffect(() => {
    load();
    api<Contact[]>(`/orgs/${org.id}/contacts`).then((c) => setContacts(c.filter((x) => x.kind !== (bill ? 'customer' : 'supplier'))));
    if (bill) api('/config/tds-sections').then(setTds);
    // Arrived from "Make it repeating" on an invoice or bill: start from its details.
    try {
      const raw = sessionStorage.getItem('repeat-from');
      if (raw) {
        const d = JSON.parse(raw);
        if (d.kind === kind) {
          sessionStorage.removeItem('repeat-from');
          setF({ ...blank(), contactId: d.contactId ?? '', notes: d.notes ?? '', tdsSection: d.tdsSection ?? '', supplyType: d.supplyType ?? 'regular' });
          if (Array.isArray(d.lines) && d.lines.length) setLines(d.lines);
          setShow(true);
        }
      }
    } catch { /* storage may be off */ }
  }, [load, org.id, bill]); // eslint-disable-line react-hooks/exhaustive-deps
  const contact = contacts.find((c) => String(c.id) === f.contactId);
  const reset = () => { setF(blank()); setLines([emptyLine()]); setEditing(null); setShow(false); form.setError(''); };
  const save = () => form.run(async () => {
    if (!f.contactId) throw new Error(`Choose the ${bill ? 'supplier' : 'customer'}.`);
    const body = { docType: kind, contactId: Number(f.contactId), frequency: f.frequency, nextDate: f.nextDate, ...(f.endDate ? { endDate: f.endDate } : {}), dueDays: Number(f.dueDays),
      autoEmail: !bill && f.postMode === 'auto' && f.autoEmail, ...(bill && f.tdsSection ? { tdsSection: f.tdsSection } : {}), ...(f.notes ? { notes: f.notes } : {}),
      postMode: f.postMode, supplyType: f.supplyType, lines: linesToApi(lines) };
    if (editing) await api(`/orgs/${org.id}/recurring/${editing}`, { method: 'PUT', body });
    else await api(`/orgs/${org.id}/recurring`, { body });
    // Anything already due (a start date today or in the past) is made now rather than at the next daily run.
    const made = f.nextDate <= today() ? (await api(`/orgs/${org.id}/recurring/run`, { body: {} }).catch(() => ({ created: 0 }))).created : 0;
    setOk(editing ? 'Schedule saved.' : `Saved. ${f.postMode === 'review' ? `Each ${noun} waits under "Due for posting" (and on the dashboard) for you to check and post.` : made ? `${made} ${noun}(s) already due were posted.` : `The first ${noun} is created on ${f.nextDate}.`}`);
    reset(); load();
  });
  const edit = (r: Rec) => {
    setOk(''); setEditing(r.id); setShow(true);
    setF({ contactId: String(r.contactId), frequency: r.frequency, nextDate: r.nextDate, endDate: r.endDate ?? '', dueDays: String(r.dueDays ?? 15), autoEmail: r.autoEmail, tdsSection: r.tdsSection ?? '', notes: r.notes ?? '', postMode: r.postMode, supplyType: r.supplyType ?? 'regular' });
    setLines(linesFromApi(r.lines)); window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const archive = (r: Rec) => run(async () => { await api(`/orgs/${org.id}/recurring/${r.id}/archive`, { body: { archived: !r.isArchived } }); setOk(r.isArchived ? 'Schedule restored.' : 'Schedule archived: it stops and is hidden.'); load(); });
  const remove = (r: Rec) => run(async () => {
    if (!window.confirm(`Delete the repeating ${noun} for ${r.contactName}? No more ${noun}s will be made. The ${r.made ?? 0} ${noun}(s) already posted from it stay in the books: they are NOT reversed.`)) return;
    await api(`/orgs/${org.id}/recurring/${r.id}`, { method: 'DELETE' }); setOk('Schedule deleted. The ones posted earlier are still in the books.'); load();
  });
  const skip = (d: Due) => run(async () => { if (!window.confirm(`Skip the ${noun} for ${d.contactName} dated ${d.dueDate}? Nothing is posted for it.`)) return; await api(`/orgs/${org.id}/recurring-due/${d.id}`, { body: { status: 'skipped' } }); load(); });
  const shown = list.filter((r) => showArchived || !r.isArchived);
  const columns: Column<Rec>[] = [
    { key: 'contact', label: bill ? 'Supplier' : 'Customer', value: (r) => r.contactName },
    { key: 'freq', label: 'Repeats', value: (r) => r.frequency },
    { key: 'next', label: `Next ${noun}`, value: (r) => (r.active ? r.nextDate : null) },
    { key: 'end', label: 'Ends', value: (r) => r.endDate },
    { key: 'mode', label: 'Posting', value: (r) => (r.postMode === 'review' ? 'Waits for review' : 'Automatic') },
    { key: 'extra', label: bill ? 'TDS' : 'Email', value: (r) => (bill ? r.tdsSection ?? 'No' : r.autoEmail ? 'Yes' : 'No') },
    { key: 'notes', label: 'Narration', value: (r) => r.notes, hidden: true },
    { key: 'made', label: 'Made', value: (r) => r.made ?? 0, noSearch: true },
    { key: 'total', label: 'Posted total', value: (r) => r.postedTotal ?? 0, money: true, noSearch: true },
    { key: 'status', label: 'Status', value: (r) => (r.isArchived ? 'archived' : r.active ? 'active' : 'done'), render: (r) => <Badge text={r.isArchived ? 'archived' : r.active ? 'active' : 'done'} /> },
  ];
  return (
    <>
      <PageHeader title={bill ? 'Repeating bills' : 'Repeating invoices'} subtitle={bill ? 'Rent, maintenance contracts, subscriptions. Each bill waits for you to add the supplier’s bill number or copy and post it, unless you choose automatic posting.' : 'Invoices made on a schedule: posted automatically (and emailed if you like), or kept for you to review first.'}
        actions={canPost && <Button onClick={() => (show ? reset() : (setEditing(null), setShow(true)))}>{show ? 'Close' : `New repeating ${noun}`}</Button>} />
      <div className="mb-3 space-y-2"><ErrorMsg msg={error} /><Ok msg={ok} /></div>
      {due.length > 0 && (
        <Card title={`Due for posting (${due.length})`}>
          <table className="w-full text-sm" data-testid="recurring-due"><thead><tr className="text-left"><th>Date</th><th>{bill ? 'Supplier' : 'Customer'}</th><th>Narration</th><th /></tr></thead>
            <tbody>{due.map((d) => <tr key={d.id}><td>{d.dueDate}</td><td>{d.contactName}</td><td>{d.notes ?? '—'}</td>
              <td className="space-x-1 whitespace-nowrap text-right">{canPost && <><Button onClick={() => go?.(`${bill ? 'bills' : 'invoices'}/new-from-due-${d.id}`)}>Open and post</Button><Button variant="ghost" onClick={() => skip(d)}>Skip</Button></>}</td></tr>)}</tbody></table>
        </Card>)}
      {show && (
        <Card title={editing ? `Edit repeating ${noun}` : `New repeating ${noun}`}>
          <div className="grid gap-3 md:grid-cols-4">
            <ContactPicker label={bill ? 'Supplier' : 'Customer'} contacts={contacts} value={f.contactId} onChange={(id) => { const c = contacts.find((x) => String(x.id) === id); setF({ ...f, contactId: id, ...(bill && c && !editing ? { tdsSection: c.defaultTdsSection ?? f.tdsSection, supplyType: c.rcmDefault ? 'reverse_charge' : !c.gstin ? 'unregistered' : 'regular' } : {}) }); }} />
            <Select label="Repeat" aria-label="Frequency" value={f.frequency} onChange={(e) => setF({ ...f, frequency: e.target.value })}>{['weekly', 'monthly', 'quarterly', 'yearly'].map((x) => <option key={x} value={x}>{x.charAt(0).toUpperCase() + x.slice(1)}</option>)}</Select>
            <div><Field label={`First ${noun} date`} type="date" value={f.nextDate} onChange={(e) => setF({ ...f, nextDate: e.target.value })} />
              {f.nextDate < today() && <p className="mt-1 text-xs text-amber-700">A past date: the runs already due (up to 12) are made as soon as you save.</p>}</div>
            <Field label="Stop after (optional)" type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} />
            <Field label="Payment due (days)" value={f.dueDays} onChange={(e) => setF({ ...f, dueDays: e.target.value })} />
            <Select label="Supply type" aria-label="Supply type" value={f.supplyType} onChange={(e) => setF({ ...f, supplyType: e.target.value })}>{SUPPLY_OPTS[kind].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
            {bill && <Select label="TDS section" aria-label="TDS section" value={f.tdsSection} onChange={(e) => setF({ ...f, tdsSection: e.target.value })}><option value="">No TDS</option>{tds.map((t) => <option key={t.code} value={t.code}>{t.code} · {t.description}</option>)}</Select>}
            <fieldset className="text-sm md:col-span-2"><legend className="mb-1 font-medium text-slate-600">Posting</legend>
              <label className="mr-4 inline-flex items-center gap-2"><input type="radio" name="post-mode" checked={f.postMode === 'review'} onChange={() => setF({ ...f, postMode: 'review', autoEmail: false })} />Wait for me to review and post</label>
              <label className="inline-flex items-center gap-2"><input type="radio" name="post-mode" checked={f.postMode === 'auto'} onChange={() => setF({ ...f, postMode: 'auto' })} />Post automatically</label></fieldset>
            {!bill && f.postMode === 'auto' && <label className="flex items-center gap-2 pt-6 text-sm"><input type="checkbox" checked={f.autoEmail} onChange={(e) => setF({ ...f, autoEmail: e.target.checked })} /> Email each invoice automatically</label>}
          </div>
          <div className="mt-3">
            <Field label="Narration on each one (printed as the notes)" aria-label="Narration" placeholder={`e.g. Being ${bill ? 'office rent' : 'retainer fees'} for {month}`} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
            <div className="mt-1 flex flex-wrap items-center gap-1 text-xs"><span className="text-slate-500">Insert:</span>
              {PLACEHOLDERS.map(([k, ex]) => <button key={k} type="button" title={`e.g. ${ex}`} className="rounded border border-slate-300 bg-white px-1.5 py-0.5 font-mono hover:bg-slate-50" onClick={() => setF({ ...f, notes: `${f.notes}${f.notes && !f.notes.endsWith(' ') ? ' ' : ''}${k}` })}>{k}</button>)}</div>
            {f.notes.includes('{') && <p className="mt-1 text-xs text-slate-600" data-testid="narration-preview">First one reads: <b>{preview(f.notes, f.nextDate || today())}</b></p>}
          </div>
          <LinesEditor org={org} lines={lines} setLines={setLines} sales={!bill} accounts={accounts} contactDefaultId={bill ? contact?.defaultPurchaseAccountId : contact?.defaultSalesAccountId} />
          <div className="mt-4 flex flex-wrap gap-3"><Button disabled={form.busy} onClick={save}>{editing ? 'Save changes' : 'Save schedule'}</Button><Button variant="ghost" onClick={reset}>Cancel</Button></div>
          <div className="mt-2"><ErrorMsg msg={form.error} /></div>
        </Card>
      )}
      <Card>
        <DataTable id={`recurring-${kind}`} rows={shown} columns={columns} rowKey={(r) => r.id} orgId={org.id} exportTitle={bill ? 'Repeating bills' : 'Repeating invoices'} empty={`No repeating ${noun}s yet.`}
          toolbar={<label className="flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />Show archived</label>}
          trailing={(r) => (canPost ? <RowMenu label={`Actions for ${r.contactName} schedule`} actions={[
            { label: 'Edit', icon: 'edit', onClick: () => edit(r), hidden: !!r.isArchived },
            { label: 'Stop', icon: 'lock', onClick: () => run(async () => { await api(`/orgs/${org.id}/recurring/${r.id}/stop`, { method: 'POST', body: {} }); load(); }), hidden: !r.active },
            { label: r.isArchived ? 'Restore' : 'Archive', icon: r.isArchived ? 'restore' : 'archive', onClick: () => archive(r) },
            { label: 'Delete', icon: 'trash', onClick: () => remove(r), danger: true },
          ]} /> : null)} />
      </Card>
    </>
  );
}
