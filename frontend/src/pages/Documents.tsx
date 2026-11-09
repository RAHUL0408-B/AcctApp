import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, download, fileToBase64, fmt, toPaise, today } from '../api';
import type { Org } from '../App';
import { Badge, Empty, PageHeader, Select } from '../kit';
import { Button, Card, ErrorMsg, Field, Ok, useAction } from '../ui';
import type { Contact } from './Contacts';
import { Account, ContactPicker, emptyLine, Line, LinesEditor, linesFromApi, linesToApi } from './Lines';

interface Doc { id: number; docType: string; number: string; contactName: string; issueDate: string; dueDate: string | null; total: number; tdsAmount: number; status: string; outstanding?: number; currency: string; foreignTotal: number | null; supplyType: string; isArchived?: boolean }
interface Template { id: number; name: string; docType: string; payload: any }
interface Attachment { id: number; name: string; size: number }

const SUPPLY = {
  sales: [['regular', 'Regular'], ['export_lut', 'Export under LUT (no GST)'], ['export_igst', 'Export with IGST'], ['sez_lut', 'SEZ under LUT (no GST)'], ['sez_igst', 'SEZ with IGST']],
  purchases: [['regular', 'Regular'], ['reverse_charge', 'Reverse charge (you pay the GST)']],
} as const;

const TYPES = { sales: [['invoice', 'Invoice'], ['credit_note', 'Credit note']], purchases: [['bill', 'Bill'], ['debit_note', 'Debit note']] } as const;

const blankForm = { contactId: '', issueDate: today(), dueDate: '', supplierRef: '', tdsSection: '', originalDocId: '', supplyType: 'regular', currency: 'INR', fxRate: '', number: '', notes: '' };

export function Documents({ org, kind, canPost, accounts, startNew = false, restricted = false }: { org: Org; kind: 'sales' | 'purchases'; canPost: boolean; accounts: Account[]; startNew?: boolean; restricted?: boolean }) {
  // A restricted (sales) role can create and view, but not pay, edit, delete, archive or email.
  const full = canPost && !restricted;
  const types = TYPES[kind];
  const sales = kind === 'sales';
  const [docs, setDocs] = useState<Doc[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [states, setStates] = useState<{ code: string; name: string }[]>([]);
  const [orgState, setOrgState] = useState<string | null>(org.gstin ? org.gstin.slice(0, 2) : null);
  const [tds, setTds] = useState<{ code: string; description: string }[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [docType, setDocType] = useState<string>(types[0][0]);
  const [f, setF] = useState(blankForm);
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const [intraOverride, setIntraOverride] = useState<boolean | null>(null);
  const [posChoice, setPosChoice] = useState('');
  const [showForm, setShowForm] = useState(startNew);
  useEffect(() => { if (startNew) setShowForm(true); }, [startNew]);
  const [editing, setEditing] = useState<{ id: number; number: string; payments: { id: number; date: string; amount: number }[] } | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [existingFiles, setExistingFiles] = useState<Attachment[]>([]);
  const [nextNumber, setNextNumber] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [showArchived, setShowArchived] = useState(false);
  /** One or several documents as PDF, in the organisation's invoice template. Several go into a single file, each starting on a new page. */
  const downloadPdf = (ids: number[], name?: string) => run(() => ids.length === 1
    ? download(`/orgs/${org.id}/documents/${ids[0]}/pdf`, `${(name ?? 'document').replace(/\//g, '-')}.pdf`)
    : download(`/orgs/${org.id}/documents-pdf?ids=${ids.join(',')}`, 'documents.pdf'));
  const [ok, setOk] = useState('');
  const [pay, setPay] = useState<{ id: number; number: string; amount: string; accountId: string; date: string; reference: string; currency: string; foreign: string } | null>(null);
  const { error, busy, run, setError } = useAction();

  const load = useCallback(() => api<Doc[]>(`/orgs/${org.id}/documents?archived=${showArchived}`).then((d) => setDocs(d.filter((x) => types.some(([t]) => t === x.docType) && (showArchived || !x.isArchived)))), [org.id, kind, showArchived]);
  const loadTemplates = useCallback(() => api<Template[]>(`/orgs/${org.id}/doc-templates`).then((t) => setTemplates(t.filter((x) => x.docType === (sales ? 'invoice' : 'bill')))), [org.id, sales]);
  useEffect(() => {
    load(); loadTemplates();
    api<Contact[]>(`/orgs/${org.id}/contacts`).then((c) => setContacts(c.filter((x) => x.kind === 'both' || x.kind === (sales ? 'customer' : 'supplier'))));
    api('/config/tds-sections').then(setTds); api('/config/states').then(setStates);
    api(`/orgs/${org.id}/settings`).then((s) => setOrgState(s.stateCode ?? null)).catch(() => undefined);
  }, [load, loadTemplates, org.id, kind]);
  useEffect(() => { setSelected(new Set()); }, [docs]);

  // The number the system will give, shown so it can be changed.
  useEffect(() => {
    if (editing || !showForm) return;
    api(`/orgs/${org.id}/documents-next-number?type=${docType}&date=${f.issueDate}`).then((r) => setNextNumber(r.number)).catch(() => setNextNumber(''));
  }, [org.id, docType, f.issueDate, showForm, editing, docs.length]);

  const contact = contacts.find((c) => String(c.id) === f.contactId);
  const foreign = f.currency !== 'INR';
  const regular = f.supplyType === 'regular';
  // Same state = CGST + SGST, different state = IGST. Worked out from the GSTIN (state code) of the party; the user can change it.
  const contactState = contact?.stateCode ?? null;
  const autoIntra = orgState && contactState ? orgState === contactState : true;
  const intra = !regular ? false : intraOverride ?? autoIntra;
  const noTax = f.supplyType.endsWith('_lut') || f.supplyType === 'reverse_charge';
  const registered = !!contact?.gstin;

  const changeSupply = (wantIntra: boolean) => {
    if (registered && wantIntra !== autoIntra && !window.confirm(`This party has a GST number, so the system chose ${autoIntra ? 'intrastate (CGST + SGST)' : 'interstate (IGST)'} from its state. Change it to ${wantIntra ? 'intrastate (CGST + SGST)' : 'interstate (IGST)'}? The GST on this document will not match the party's registration.`)) return;
    setIntraOverride(wantIntra === autoIntra ? null : wantIntra);
  };
  /** Place of supply to send. Only needed when the user overrode what the GSTIN says. */
  const placeOfSupply = (): string | undefined => {
    if (!regular || intraOverride === null || !orgState) return undefined;
    const supplierState = sales ? orgState : contactState, buyerState = sales ? contactState : orgState;
    if (intra) return sales ? orgState : contactState ?? undefined;     // supplier's state = place of supply
    const other = sales ? contactState : orgState;                       // want a different state from the supplier's
    if (other && other !== supplierState) return other;
    return posChoice || buyerState || undefined;
  };
  const needsPosChoice = regular && intraOverride === false && (sales ? contactState === orgState : orgState === contactState);

  const body = () => ({
    docType, contactId: Number(f.contactId), issueDate: f.issueDate, lines: linesToApi(lines), supplyType: f.supplyType,
    ...(placeOfSupply() ? { placeOfSupply: placeOfSupply() } : {}),
    ...(foreign ? { currency: f.currency, fxRate: Number(f.fxRate) } : {}),
    ...(f.dueDate ? { dueDate: f.dueDate } : {}), ...(f.supplierRef ? { supplierRef: f.supplierRef } : {}), ...(f.number.trim() ? { number: f.number.trim() } : {}), ...(f.notes ? { notes: f.notes } : {}),
    ...(f.tdsSection && docType === 'bill' ? { tdsSection: f.tdsSection } : {}), ...(f.originalDocId ? { originalDocId: Number(f.originalDocId) } : {}),
  });
  const resetForm = () => { setF(blankForm); setLines([emptyLine()]); setIntraOverride(null); setPosChoice(''); setFiles([]); setExistingFiles([]); setEditing(null); setShowForm(false); };
  const uploadAll = async (docId: number) => {
    for (const file of files) await api(`/orgs/${org.id}/files`, { body: { name: file.name, mime: file.type || 'application/octet-stream', dataBase64: await fileToBase64(file), linkType: 'document', linkId: docId } });
  };

  const create = (forApproval = false) => run(async () => {
    setOk('');
    if (!f.contactId) throw new Error(`Choose a ${sales ? 'customer' : 'supplier'} from the list`);
    const b = body();
    if (forApproval) {
      const d = await api(`/orgs/${org.id}/drafts`, { body: b });
      setOk(`Sent for approval (total ${foreign ? f.currency + ' ' : '₹'}${fmt(d.total)}). It reaches the books once an owner or accountant approves it.`);
      resetForm(); return;
    }
    const r = editing ? await api(`/orgs/${org.id}/documents/${editing.id}`, { method: 'PUT', body: b }) : await api(`/orgs/${org.id}/documents`, { body: b });
    let attachNote = '';
    try { await uploadAll(r.id); } catch (e) { attachNote = ` The document was saved, but a file could not be attached: ${(e as Error).message}`; }
    setOk(`${editing ? 'Updated' : 'Created'} ${r.number}: total ₹${fmt(r.total)}${r.foreignTotal ? ` (${r.currency} ${fmt(r.foreignTotal)})` : ''}${r.tdsAmount ? `, TDS ₹${fmt(r.tdsAmount)}, net payable ₹${fmt(r.netPayable)}` : ''}${r.rcm && (r.rcm.cgst + r.rcm.sgst + r.rcm.igst) ? `, reverse-charge GST ₹${fmt(r.rcm.cgst + r.rcm.sgst + r.rcm.igst)} to pay` : ''}.${attachNote}`);
    resetForm(); load();
  });

  const startEdit = (d: Doc) => run(async () => {
    setOk('');
    const full = await api(`/orgs/${org.id}/documents/${d.id}`);
    const atts = await api<Attachment[]>(`/orgs/${org.id}/files?linkType=document&linkId=${d.id}`);
    setDocType(full.docType);
    setF({ contactId: String(full.contactId), issueDate: full.issueDate, dueDate: full.dueDate ?? '', supplierRef: full.supplierRef ?? '', tdsSection: full.tdsSection ?? '', originalDocId: full.originalDocId ? String(full.originalDocId) : '',
      supplyType: full.supplyType, currency: full.currency, fxRate: full.currency !== 'INR' ? String(full.fxRate) : '', number: full.number, notes: full.notes ?? '' });
    setLines(linesFromApi(full.lines)); setFiles([]); setExistingFiles(atts);
    // Keep the intrastate/interstate choice the document was issued with, even if the GSTIN would suggest the other.
    const st = contacts.find((c) => c.id === full.contactId)?.stateCode ?? null;
    const auto = orgState && st ? orgState === st : true;
    const was = full.igst > 0 ? false : full.cgst > 0 ? true : auto;
    setIntraOverride(was === auto ? null : was); setPosChoice(full.placeOfSupply ?? '');
    setEditing({ id: d.id, number: full.number, payments: full.payments });
    setShowForm(true); window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  const useTemplate = (id: string) => {
    const tpl = templates.find((x) => x.id === Number(id)); if (!tpl) return;
    const p = tpl.payload;
    if (p.contactId) setF((x) => ({ ...x, contactId: String(p.contactId), supplyType: p.supplyType ?? x.supplyType, notes: p.notes ?? '', tdsSection: p.tdsSection ?? '' }));
    else setF((x) => ({ ...x, supplyType: p.supplyType ?? x.supplyType, notes: p.notes ?? '', tdsSection: p.tdsSection ?? '' }));
    setLines(linesFromApi(p.lines));
    if (p.dueDays != null) setF((x) => ({ ...x, dueDate: new Date(Date.parse(x.issueDate) + p.dueDays * 86400000).toISOString().slice(0, 10) }));
  };
  const saveTemplate = () => run(async () => {
    const name = window.prompt('Name this template (for example "Monthly retainer"):'); if (!name?.trim()) return;
    const dueDays = f.dueDate ? Math.max(0, Math.round((Date.parse(f.dueDate) - Date.parse(f.issueDate)) / 86400000)) : undefined;
    await api(`/orgs/${org.id}/doc-templates`, { body: { name: name.trim(), docType: sales ? 'invoice' : 'bill', payload: {
      ...(f.contactId ? { contactId: Number(f.contactId) } : {}), supplyType: f.supplyType, ...(f.notes ? { notes: f.notes } : {}), ...(dueDays != null ? { dueDays } : {}), ...(f.tdsSection ? { tdsSection: f.tdsSection } : {}), lines: linesToApi(lines) } } });
    setOk(`Template "${name.trim()}" saved. Choose it under "Start from a template" on any new ${sales ? 'invoice' : 'bill'}. Each line posts to its product's default account.`); loadTemplates();
  });

  const bankOptions = accounts.filter((a) => a.type === 'asset' && ['1000', '1010'].includes(a.code));
  const doPay = () => run(async () => {
    if (!pay) return;
    const r = await api(`/orgs/${org.id}/documents/${pay.id}/payments`, { body: { date: pay.date, amount: toPaise(pay.amount), accountId: Number(pay.accountId), ...(pay.reference ? { reference: pay.reference } : {}),
      ...(pay.currency !== 'INR' ? { foreignAmount: toPaise(pay.foreign) } : {}) } });
    setPay(null); setOk(`Payment recorded.${r.fxGain ? ` Exchange ${r.fxGain > 0 ? 'gain' : 'loss'} ₹${fmt(Math.abs(r.fxGain))}.` : ''}`); load();
  });
  const unlinkPayment = (paymentId: number) => run(async () => {
    if (!window.confirm('Unlink this payment? Its entry is reversed and the document becomes outstanding again.')) return;
    await api(`/orgs/${org.id}/payments/${paymentId}`, { method: 'DELETE' });
    if (editing) setEditing({ ...editing, payments: editing.payments.filter((p) => p.id !== paymentId) });
    setOk('Payment unlinked.'); load();
  });
  const doVoid = (d: Doc) => run(async () => {
    if (!window.confirm(`Delete ${d.number}? Posted entries cannot be erased from the books, so it is cancelled with a reversing entry and shows as void.`)) return;
    await api(`/orgs/${org.id}/documents/${d.id}/void`, { body: { date: today(), reason: 'Deleted from the app' } }); setOk(`${d.number} deleted (cancelled with a reversing entry).`); load();
  });
  const bulk = (action: 'delete' | 'archive' | 'restore') => run(async () => {
    const ids = [...selected]; if (!ids.length) return;
    if (action === 'delete') {
      if (!window.confirm(`Delete ${ids.length} document(s)? Each is cancelled with a reversing entry. Ones with payments or credit notes are skipped.`)) return;
      const r = await api(`/orgs/${org.id}/documents/bulk-void`, { body: { ids, date: today(), reason: 'Deleted from the app' } });
      setOk(`${r.voided.length} deleted.${r.failed.length ? ` ${r.failed.length} skipped: ${r.failed.map((x: any) => `${x.number ?? x.id} (${x.reason})`).join('; ')}` : ''}`);
    } else {
      await api(`/orgs/${org.id}/documents/bulk-archive`, { body: { ids, archived: action === 'archive' } });
      setOk(`${ids.length} ${action === 'archive' ? 'archived' : 'restored'}.`);
    }
    load();
  });
  const email = (d: Doc) => run(async () => { const r = await api(`/orgs/${org.id}/documents/${d.id}/send`, { body: {} }); setOk(`${d.number} queued to ${r.queuedTo}.`); });
  const remind = () => run(async () => { const r = await api(`/orgs/${org.id}/documents/remind-overdue`, { method: 'POST', body: {} }); setOk(`${r.reminders} overdue reminder(s) queued.`); });
  const toggle = (id: number) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allSelected = docs.length > 0 && selected.size === docs.length;

  const title = sales ? 'Invoices' : 'Bills';
  const overdue = (d: Doc) => d.status === 'posted' && (d.outstanding ?? 0) > 0 && !!d.dueDate && d.dueDate < today() && (d.docType === 'invoice' || d.docType === 'bill');
  const payLabel = sales ? 'Receive payment' : 'Pay';
  const stateName = (code: string | null) => (code ? `${code} ${states.find((s) => s.code === code)?.name ?? ''}`.trim() : 'not known');
  const canEdit = (d: Doc) => full && d.status === 'posted' && (d.docType === 'invoice' || d.docType === 'bill' || d.docType === 'credit_note' || d.docType === 'debit_note');
  const supplyOptions = useMemo(() => SUPPLY[kind], [kind]);

  return (
    <>
      <PageHeader title={title} subtitle={sales ? 'Invoices and credit notes you send to customers' : 'Bills and debit notes from your suppliers'}
        actions={canPost && <>{sales && full && <Button variant="ghost" disabled={busy} onClick={remind}>Send overdue reminders</Button>}<Button onClick={() => { if (showForm) resetForm(); else { setEditing(null); setShowForm(true); } }}>{showForm ? 'Close' : `New ${sales ? 'invoice' : 'bill'}`}</Button></>} />
      <div className="mb-3 space-y-2"><ErrorMsg msg={error} /><Ok msg={ok} /></div>
      {showForm && canPost && (
        <Card title={editing ? `Edit ${editing.number}` : sales ? 'New sales document' : 'New purchase document'}
          actions={!editing && templates.length > 0 && <select aria-label="Start from a template" className="rounded border border-slate-300 px-2 py-1 text-sm" value="" onChange={(e) => useTemplate(e.target.value)}><option value="">Start from a template…</option>{templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>}>
          {editing && <p className="mb-3 rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">Saving cancels the posted version with a reversing entry and posts the corrected one under the same number. This is not possible once a payment has been recorded: unlink it first.</p>}
          {editing && editing.payments.length > 0 && (
            <div className="mb-3 rounded border border-slate-200 p-3 text-sm"><p className="mb-1 font-medium">Payments on this document</p>
              {editing.payments.map((p) => <div key={p.id} className="flex items-center justify-between py-1"><span>{p.date} · ₹{fmt(p.amount)}</span><Button variant="ghost" onClick={() => unlinkPayment(p.id)}>Unlink</Button></div>)}</div>
          )}
          <div className="grid gap-3 md:grid-cols-4">
            <Select label="Type" aria-label="Document type" value={docType} disabled={!!editing} onChange={(e) => setDocType(e.target.value)}>{types.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
            <ContactPicker label={sales ? 'Customer' : 'Supplier'} contacts={contacts} value={f.contactId} onChange={(id) => { setF({ ...f, contactId: id }); setIntraOverride(null); }} />
            <Field label="Date" type="date" value={f.issueDate} onChange={(e) => setF({ ...f, issueDate: e.target.value })} />
            <Field label="Due date" type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} />
            <Field label={`${docType === 'credit_note' ? 'Credit note' : docType === 'debit_note' ? 'Debit note' : sales ? 'Invoice' : 'Bill'} number`} aria-label="Document number" placeholder={nextNumber || 'Automatic'} value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} />
            {docType === 'bill' && <Field label="Supplier bill no." value={f.supplierRef} onChange={(e) => setF({ ...f, supplierRef: e.target.value })} />}
            {docType === 'bill' && <Select label="TDS section" aria-label="TDS section" value={f.tdsSection} onChange={(e) => setF({ ...f, tdsSection: e.target.value })}>
              <option value="">No TDS</option>{tds.map((t) => <option key={t.code} value={t.code}>{t.code} · {t.description}</option>)}</Select>}
            <Select label="Supply type" aria-label="Supply type" value={f.supplyType} onChange={(e) => { setF({ ...f, supplyType: e.target.value }); setIntraOverride(null); }}>{supplyOptions.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
            <Field label="Currency" aria-label="Currency" value={f.currency} maxLength={3} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} />
            {foreign && <Field label={`Rupees per 1 ${f.currency}`} aria-label="Exchange rate" inputMode="decimal" value={f.fxRate} onChange={(e) => setF({ ...f, fxRate: e.target.value })} />}
            {(docType === 'credit_note' || docType === 'debit_note') && <Select label="Against" aria-label="Original document" value={f.originalDocId} onChange={(e) => setF({ ...f, originalDocId: e.target.value })}>
              <option value="">—</option>{docs.filter((d) => d.status === 'posted' && (d.docType === 'invoice' || d.docType === 'bill')).map((d) => <option key={d.id} value={d.id}>{d.number} · {d.contactName}</option>)}</Select>}
          </div>

          {regular && (
            <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm" data-testid="supply-box">
              <div className="flex flex-wrap items-center gap-4">
                <span className="font-medium text-slate-700">Place of supply</span>
                <label className="flex items-center gap-1"><input type="radio" name="supply-kind" aria-label="Intrastate supply" checked={intra} onChange={() => changeSupply(true)} />Intrastate (CGST + SGST)</label>
                <label className="flex items-center gap-1"><input type="radio" name="supply-kind" aria-label="Interstate supply" checked={!intra} onChange={() => changeSupply(false)} />Interstate (IGST)</label>
                {needsPosChoice && <Select label="State of supply" value={posChoice} onChange={(e) => setPosChoice(e.target.value)}><option value="">Choose state…</option>{states.filter((s) => s.code !== orgState).map((s) => <option key={s.code} value={s.code}>{s.code} {s.name}</option>)}</Select>}
              </div>
              <p className="mt-1 text-xs text-slate-500">
                {!contact ? `Choose a ${sales ? 'customer' : 'supplier'}: the type is picked from their GSTIN state compared with yours (${stateName(orgState)}).`
                  : registered ? `Chosen automatically: your state is ${stateName(orgState)}, theirs is ${stateName(contactState)}.${intraOverride !== null ? ' You changed it.' : ''}`
                  : `This party has no GST number, so it is treated as unregistered. You can change the supply type freely.${contactState ? '' : ' No state is set, so intrastate is assumed.'}`}
              </p>
            </div>
          )}

          <LinesEditor org={org} lines={lines} setLines={setLines} sales={sales} accounts={accounts} currency={f.currency} intra={intra} noTax={noTax} />

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <label className="block text-sm"><span className="mb-1 block font-medium text-slate-600">Notes (printed on the document)</span>
              <textarea aria-label="Notes" rows={2} maxLength={500} className="w-full rounded-md border border-slate-300 px-3 py-2" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></label>
            <div className="text-sm"><span className="mb-1 block font-medium text-slate-600">Attach documents (PDF, image, Excel, Word; max 10 MB each)</span>
              <input aria-label="Attach documents" type="file" multiple onChange={(e) => setFiles([...files, ...Array.from(e.target.files ?? [])])} />
              <ul className="mt-1 space-y-0.5 text-xs text-slate-600">
                {existingFiles.map((a) => <li key={a.id}><button className="underline" onClick={() => run(() => download(`/orgs/${org.id}/files/${a.id}/download`, a.name))}>{a.name}</button> (attached)</li>)}
                {files.map((x, i) => <li key={i}>{x.name} <button className="text-red-700" onClick={() => setFiles(files.filter((_, j) => j !== i))}>remove</button></li>)}</ul></div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3"><Button disabled={busy} onClick={() => create()}>{editing ? 'Save changes' : 'Create'}</Button>
            {!editing && (docType === 'invoice' || docType === 'bill') && <Button variant="ghost" disabled={busy} onClick={() => create(true)}>Submit for approval</Button>}
            {(docType === 'invoice' || docType === 'bill') && <Button variant="ghost" disabled={busy} onClick={saveTemplate}>Save as template</Button>}
            {editing && <Button variant="ghost" onClick={resetForm}>Cancel</Button>}
            <p className="text-xs text-slate-500">GST (CGST+SGST or IGST) and TDS are worked out when you save. Each line posts to its account: the product's default, then the contact's default.</p></div>
        </Card>
      )}
      <Card actions={<label className="flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />Show archived</label>}>
        {full && selected.size > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-2 rounded bg-brand-50 px-3 py-2 text-sm"><b>{selected.size} selected</b>
            <Button variant="danger" disabled={busy} onClick={() => bulk('delete')}>Delete selected</Button>
            <Button variant="ghost" disabled={busy} onClick={() => downloadPdf([...selected])}>Download as one PDF</Button>
            <Button variant="ghost" disabled={busy} onClick={() => bulk(showArchived ? 'restore' : 'archive')}>{showArchived ? 'Restore selected' : 'Archive selected'}</Button>
            <Button variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button></div>
        )}
        {docs.length === 0 ? <Empty text="Nothing here yet." /> : (
          <table className="w-full text-sm">
            <thead><tr className="text-left text-slate-500">{full && <th className="w-8"><input type="checkbox" aria-label="Select all" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(docs.map((d) => d.id)))} /></th>}<th>Number</th><th>Contact</th><th>Date</th><th>Due</th><th className="text-right">Total</th><th className="text-right">TDS</th><th className="text-right">Outstanding</th><th className="pl-4">Status</th><th /></tr></thead>
            <tbody>{docs.map((d) => (
              <tr key={d.id} className={`border-t border-slate-100 ${d.isArchived ? 'text-slate-400' : ''}`}>
                {full && <td><input type="checkbox" aria-label={`Select ${d.number}`} checked={selected.has(d.id)} onChange={() => toggle(d.id)} /></td>}
                <td className="py-2 font-medium">{d.number}</td><td>{d.contactName}</td><td>{d.issueDate}</td>
                <td className={overdue(d) ? 'font-medium text-red-700' : ''}>{d.dueDate ?? ''}</td>
                <td className="text-right">{canEdit(d)
                  ? <button className="underline decoration-dotted hover:text-brand-700" title="Click to edit" aria-label={`Edit ${d.number}`} onClick={() => startEdit(d)}>{fmt(d.total)}</button> : fmt(d.total)}
                  {d.currency !== 'INR' && d.foreignTotal != null && <span className="block text-xs text-slate-500">{d.currency} {fmt(d.foreignTotal)}</span>}</td><td className="text-right">{d.tdsAmount ? fmt(d.tdsAmount) : ''}</td>
                <td className="text-right">{d.outstanding !== undefined && (d.docType === 'invoice' || d.docType === 'bill') && d.status === 'posted' ? fmt(d.outstanding) : ''}</td>
                <td className="pl-4"><Badge text={d.status === 'posted' && (d.docType === 'invoice' || d.docType === 'bill') && d.outstanding === 0 ? 'paid' : d.status} />{d.isArchived && <span className="ml-1 text-xs">archived</span>}</td>
                <td className="space-x-1 whitespace-nowrap text-right">
                  <Button variant="ghost" onClick={() => { setError(''); downloadPdf([d.id], d.number); }}>PDF</Button>
                  {full && sales && d.status === 'posted' && <Button variant="ghost" onClick={() => email(d)}>Email</Button>}
                  {full && d.status === 'posted' && (d.docType === 'invoice' || d.docType === 'bill') && (d.outstanding ?? 0) > 0 && <Button variant="ghost" onClick={() => setPay({ id: d.id, number: d.number, amount: d.currency === 'INR' ? String((d.outstanding ?? 0) / 100) : '', accountId: '', date: today(), reference: '', currency: d.currency, foreign: '' })}>{payLabel}</Button>}
                  {canEdit(d) && <Button variant="ghost" onClick={() => startEdit(d)}>Edit</Button>}
                  {full && d.status === 'posted' && <Button variant="ghost" className="text-red-700" onClick={() => doVoid(d)}>Delete</Button>}
                </td>
              </tr>))}</tbody>
          </table>
        )}
        {pay && (
          <div className="mt-4 flex flex-wrap items-end gap-3 rounded bg-slate-50 p-3">
            <p className="w-full text-sm font-medium">{sales ? 'Receive payment for' : 'Pay'} {pay.number}</p>
            <Field label="Date" type="date" value={pay.date} onChange={(e) => setPay({ ...pay, date: e.target.value })} />
            {pay.currency !== 'INR' && <Field label={`Amount in ${pay.currency}`} value={pay.foreign} onChange={(e) => setPay({ ...pay, foreign: e.target.value })} />}
            <Field label={pay.currency !== 'INR' ? 'Rupees received / paid' : 'Amount (₹)'} value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} />
            <Select label="Bank / cash account" aria-label="Payment account" value={pay.accountId} onChange={(e) => setPay({ ...pay, accountId: e.target.value })}>
              <option value="">Select…</option>{bankOptions.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</Select>
            <Field label="Reference (optional)" value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} />
            <Button disabled={busy || !pay.accountId} onClick={doPay}>Record payment</Button><Button variant="ghost" onClick={() => setPay(null)}>Cancel</Button>
          </div>
        )}
      </Card>
    </>
  );
}
