// One invoice, bill, credit or debit note opened on its own: shown locked (read only) with its lines, totals, payments,
// attachments and history. Edit, duplicate, void, archive and the PDF are in the bar at the top. Attachments can be
// added or opened without touching the posted entry.
import { useCallback, useEffect, useState } from 'react';
import { api, download, fileToBase64, fmt } from './api';
import { Badge } from './kit';
import { Icon } from './table';
import { Button, Callout, ErrorMsg, Ok, ask, useAction } from './ui';

export interface DocFull {
  id: number; number: string; docType: string; contactId: number; contactName: string; issueDate: string; dueDate: string | null; status: string; supplyType: string;
  placeOfSupply?: string | null; currency: string; foreignTotal: number | null; subtotal: number; cgst: number; sgst: number; igst: number; cess: number; total: number;
  tdsAmount: number; tdsSection: string | null; netPayable: number; outstanding?: number; supplierRef?: string | null; notes?: string | null; isArchived?: boolean;
  lines: { description: string; hsnSac: string | null; unit: string | null; qtyMilli: number; rate: number; taxable: number; gstRateBp: number; cgst: number; sgst: number; igst: number; cess: number }[];
  payments: { id: number; date: string; amount: number; reference: string | null; batchId: number | null }[];
}
interface Attachment { id: number; name: string }
interface Hist { id: number; at: string; user: string; action: string; particulars?: string; changes?: { field: string; from: string; to: string }[] }
interface Batch { id: number; side: string; date: string; reference: string | null; total: number; status: string; account: string; items: { paymentId: number; documentId: number; number: string; contact: string; amount: number }[] }

const TYPE: Record<string, string> = { invoice: 'Invoice', credit_note: 'Credit note', bill: 'Bill', debit_note: 'Debit note' };
const ACTION: Record<string, string> = { create: 'Created', edit: 'Edited', void: 'Voided', email: 'Emailed', unlink_payment: 'Payment unlinked', attach: 'File attached', payment: 'Payment recorded', unlink_from_batch: 'Unlinked from a batch' };

export function DocView({ orgId, id, full, canEdit, go, onClose, onEdit, onDuplicate, onVoid, onArchive, onPdf, onPay, onNote, onChanged }: {
  orgId: number; id: number; full: boolean; canEdit: boolean; go?: (p: string) => void; onClose: () => void;
  onEdit: () => void; onDuplicate: () => void; onVoid: () => void; onArchive: () => void; onPdf: () => void; onPay?: () => void; onNote?: () => void; onChanged: () => void;
}) {
  const [d, setD] = useState<DocFull | null>(null);
  const [files, setFiles] = useState<Attachment[]>([]);
  const [hist, setHist] = useState<Hist[]>([]);
  const [batch, setBatch] = useState<Batch | null>(null);
  const [pick, setPick] = useState<Set<number>>(new Set());
  const [ok, setOk] = useState('');
  const { error, busy, run } = useAction();
  const load = useCallback(async () => {
    const [doc, atts] = await Promise.all([api<DocFull>(`/orgs/${orgId}/documents/${id}`), api<Attachment[]>(`/orgs/${orgId}/files?linkType=document&linkId=${id}`).catch(() => [])]);
    setD(doc); setFiles(atts);
    api<Hist[]>(`/orgs/${orgId}/history?entity=document&entityId=${id}&limit=50`).then(setHist).catch(() => setHist([]));
  }, [orgId, id]);
  useEffect(() => { load().catch(() => undefined); }, [load]);

  // Adding a file never touches the posted entry: it is attached to the document as it is.
  const attach = (list: FileList | null) => run(async () => {
    const all = Array.from(list ?? []); if (!all.length) return;
    for (const f of all) await api(`/orgs/${orgId}/files`, { body: { name: f.name, mime: f.type || 'application/octet-stream', dataBase64: await fileToBase64(f), linkType: 'document', linkId: id } });
    setOk(`${all.length} file${all.length === 1 ? '' : 's'} attached. The posted entry is unchanged.`); await load();
  });
  const unlink = (paymentId: number) => run(async () => {
    if (!await ask({ title: 'Unlink this payment?', message: 'Its entry is reversed and the document becomes outstanding again.', confirmLabel: 'Unlink' })) return;
    await api(`/orgs/${orgId}/payments/${paymentId}`, { method: 'DELETE' }); setOk('Payment unlinked.'); await load(); onChanged();
  });
  const openBatch = (batchId: number) => run(async () => { const b = await api<Batch>(`/orgs/${orgId}/payment-batches/${batchId}`); setBatch(b); setPick(new Set([id])); });
  const unlinkFromBatch = () => run(async () => {
    if (!batch || !pick.size) return;
    const names = batch.items.filter((i) => pick.has(i.documentId)).map((i) => i.number);
    const amt = batch.items.filter((i) => pick.has(i.documentId)).reduce((s, i) => s + i.amount, 0);
    if (!await ask({ title: `Unlink ${names.length} document${names.length === 1 ? '' : 's'} from batch #${batch.id}?`, confirmLabel: 'Unlink',
      message: `${names.join(', ')} (₹${fmt(amt)}) become outstanding again and that share of the batch ${batch.side === 'pay' ? 'payment' : 'receipt'} is reversed. The other documents in the batch stay paid. The batch's bank match is released, because its total changes to ₹${fmt(batch.total - amt)}.` })) return;
    const r = await api(`/orgs/${orgId}/payment-batches/${batch.id}/unlink`, { body: { documentIds: [...pick] } });
    setBatch(null); setOk(`${r.unlinked} document${r.unlinked === 1 ? '' : 's'} unlinked from the batch. Batch total now ₹${fmt(r.batchTotal)}.`); await load(); onChanged();
  });

  if (!d) return <div className="rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-500">{error ? <ErrorMsg msg={error} /> : 'Loading…'}</div>;
  const sales = d.docType === 'invoice' || d.docType === 'credit_note';
  const status = d.status === 'void' ? 'void' : (d.docType === 'invoice' || d.docType === 'bill') && (d.outstanding ?? 0) === 0 ? 'paid' : (d.outstanding ?? 0) < d.total ? 'part paid' : 'posted';
  const cur = d.currency === 'INR' ? '₹' : `${d.currency} `;
  const intra = d.cgst > 0 || d.sgst > 0;
  const contactPage = sales ? 'customers' : 'suppliers';
  const row = (label: string, value: string, strong = false, testId?: string) => <tr className={strong ? 'total-row' : ''}><td className="py-1 pr-6 text-slate-600">{label}</td><td className="py-1 text-right tabular-nums" data-testid={testId}>{value}</td></tr>;

  return (
    <section role="region" aria-label={`${TYPE[d.docType] ?? d.docType} ${d.number}`} data-testid="doc-view" className="mb-4 rounded-xl border border-brand-100 bg-white p-5 shadow-sm">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-brand-700">{TYPE[d.docType] ?? d.docType}</p>
          <h2 className="flex items-center gap-2 text-xl font-semibold text-slate-900"><Icon name="lock" size={16} className="text-slate-400" />{d.number} <Badge text={status} />{d.isArchived && <Badge text="archived" />}</h2>
          <p className="text-sm text-slate-600">{go ? <button type="button" className="link" onClick={() => go(`${contactPage}/${d.contactId}`)}>{d.contactName}</button> : d.contactName} · {d.issueDate}{d.dueDate ? ` · due ${d.dueDate}` : ''}{d.supplierRef ? ` · supplier bill no. ${d.supplierRef}` : ''}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canEdit && d.status !== 'void' && <Button onClick={onEdit}><span className="inline-flex items-center gap-1.5"><Icon name="edit" className="text-white" />Edit</span></Button>}
          {full && onPay && d.status !== 'void' && (d.outstanding ?? 0) > 0 && (d.docType === 'invoice' || d.docType === 'bill') && <Button variant="ghost" onClick={onPay}>{sales ? 'Receive payment' : 'Record payment'}</Button>}
          {full && onNote && d.status !== 'void' && (d.docType === 'invoice' || d.docType === 'bill') && <Button variant="ghost" onClick={onNote}>{sales ? 'Credit note' : 'Debit note'}</Button>}
          {full && <Button variant="ghost" onClick={onDuplicate}><span className="inline-flex items-center gap-1.5"><Icon name="copy" />Duplicate</span></Button>}
          <Button variant="ghost" onClick={onPdf}><span className="inline-flex items-center gap-1.5"><Icon name="pdf" />PDF</span></Button>
          {full && d.status !== 'void' && <Button variant="ghost" onClick={onVoid}><span className="inline-flex items-center gap-1.5"><Icon name="void" />Void</span></Button>}
          {full && <Button variant="ghost" onClick={onArchive}><span className="inline-flex items-center gap-1.5"><Icon name={d.isArchived ? 'restore' : 'archive'} />{d.isArchived ? 'Restore' : 'Archive'}</span></Button>}
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </div>
      </div>
      <div className="mb-3 space-y-2"><ErrorMsg msg={error} /><Ok msg={ok} /></div>
      {d.status !== 'void'
        ? <Callout tone="info">This {(TYPE[d.docType] ?? 'document').toLowerCase()} is posted and locked. Click <b>Edit</b> to change it: the posted version is cancelled with a reversing entry and kept in the history. Attachments can be added without editing.</Callout>
        : <Callout tone="warning">This document is void: its entry was reversed. It stays here for the record.</Callout>}

      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm" aria-label="Lines">
          <thead><tr className="text-left"><th>Description</th><th>HSN/SAC</th><th className="text-right">Qty</th><th>Unit</th><th className="text-right">Rate</th><th className="text-right">Taxable</th><th className="text-right">GST</th><th className="text-right">GST amount</th></tr></thead>
          <tbody>{d.lines.map((l, i) => (
            <tr key={i}><td>{l.description}</td><td>{l.hsnSac ?? '—'}</td><td className="text-right tabular-nums">{l.qtyMilli / 1000}</td><td>{l.unit ?? ''}</td>
              <td className="text-right tabular-nums">{fmt(l.rate)}</td><td className="text-right tabular-nums">{fmt(l.taxable)}</td><td className="text-right">{l.gstRateBp / 100}%</td>
              <td className="text-right tabular-nums">{fmt(l.cgst + l.sgst + l.igst)}</td></tr>))}</tbody>
        </table>
      </div>
      <div className="mt-3 grid gap-4 lg:grid-cols-2">
        <div className="space-y-3 text-sm">
          <div><p className="mb-1 font-semibold text-slate-700">Payments</p>
            {d.payments.length === 0 ? <p className="text-slate-500">None yet.</p> : <ul className="space-y-1">{d.payments.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-100 px-2 py-1">
                <span>{p.date} · ₹{fmt(p.amount)}{p.reference ? ` · ${p.reference}` : ''}{p.batchId ? <> · <button type="button" className="link" onClick={() => go?.(`batch-payments/${p.batchId}`)}>batch #{p.batchId}</button></> : null}</span>
                {full && (p.batchId ? <Button variant="ghost" className="!px-3 !py-1" onClick={() => openBatch(p.batchId!)}>Unlink…</Button>
                  : <Button variant="ghost" className="!px-3 !py-1" onClick={() => unlink(p.id)}>Unlink</Button>)}
              </li>))}</ul>}</div>
          <div><p className="mb-1 font-semibold text-slate-700">Attachments</p>
            {files.length === 0 ? <p className="text-slate-500">No files attached.</p> : <ul className="space-y-0.5">{files.map((a) => <li key={a.id}><button type="button" className="link" onClick={() => run(() => download(`/orgs/${orgId}/files/${a.id}/download`, a.name))}>{a.name}</button></li>)}</ul>}
            {full && <label className="mt-2 inline-flex cursor-pointer items-center gap-2 rounded-md border-2 border-dashed border-brand-300 bg-brand-50/50 px-3 py-1.5 font-medium text-brand-700 hover:border-brand-500">
              <Icon name="plus" className="text-brand-600" />Add attachment<input aria-label="Add attachment" type="file" multiple className="sr-only" disabled={busy} onChange={(e) => { attach(e.target.files); e.target.value = ''; }} /></label>}</div>
        </div>
        <table className="ml-auto w-full max-w-sm text-sm" data-testid="view-totals"><tbody>
          {row('Taxable value', `${cur}${fmt(d.subtotal)}`)}
          {intra ? <>{row('CGST', `${cur}${fmt(d.cgst)}`)}{row('SGST', `${cur}${fmt(d.sgst)}`)}</> : row('IGST', `${cur}${fmt(d.igst)}`)}
          {d.cess > 0 && row('Cess', `${cur}${fmt(d.cess)}`)}
          {row('Total', `${cur}${fmt(d.total)}`, true, 'view-total')}
          {d.tdsAmount > 0 && <>{row(`TDS${d.tdsSection ? ` u/s ${d.tdsSection}` : ''}`, `− ₹${fmt(d.tdsAmount)}`)}{row(sales ? 'Net receivable' : 'Net payable', `₹${fmt(d.netPayable)}`, true)}</>}
          {(d.docType === 'invoice' || d.docType === 'bill') && d.status !== 'void' && row('Outstanding', `₹${fmt(d.outstanding ?? 0)}`, true, 'view-outstanding')}
        </tbody></table>
      </div>
      {d.notes && <p className="mt-3 text-sm text-slate-600"><span className="font-medium">Notes:</span> {d.notes}</p>}
      {hist.length > 0 && (
        <details className="mt-4 text-sm"><summary className="cursor-pointer font-semibold text-brand-800">History ({hist.length})</summary>
          <ul className="mt-2 space-y-1">{hist.map((h) => <li key={h.id} className="text-slate-600"><span className="text-slate-500">{new Date(h.at).toLocaleString('en-IN')}</span> · {h.user} · <b>{ACTION[h.action] ?? h.action.replace(/_/g, ' ')}</b>{h.particulars ? ` · ${h.particulars}` : ''}
            {!!h.changes?.length && <span className="block pl-4 text-xs">{h.changes.map((c) => `${c.field}: ${c.from || '—'} → ${c.to || '—'}`).join('; ')}</span>}</li>)}</ul></details>)}

      {batch && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-900/40 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) setBatch(null); }}>
          <div role="dialog" aria-modal="true" aria-label={`Batch ${batch.side === 'pay' ? 'payment' : 'receipt'} #${batch.id}`} className="w-full max-w-2xl rounded-xl border border-brand-100 bg-white p-5 shadow-2xl">
            <h2 className="text-base font-semibold text-brand-900">Batch {batch.side === 'pay' ? 'payment' : 'receipt'} #{batch.id} · {batch.date} · {batch.account}</h2>
            <p className="mb-3 text-xs text-slate-500">Tick the documents to take out of this batch. The others stay paid by it.</p>
            <table className="w-full text-sm"><thead><tr className="text-left"><th className="w-8" /><th>Document</th><th>{batch.side === 'pay' ? 'Supplier' : 'Customer'}</th><th className="text-right">Allocated (₹)</th></tr></thead>
              <tbody>{batch.items.map((i) => <tr key={i.documentId}><td><input type="checkbox" aria-label={`Unlink ${i.number}`} checked={pick.has(i.documentId)} onChange={() => setPick((s) => { const n = new Set(s); if (n.has(i.documentId)) n.delete(i.documentId); else n.add(i.documentId); return n; })} /></td>
                <td>{i.number}{i.documentId === id && <span className="ml-1 text-xs text-brand-700">(this one)</span>}</td><td>{i.contact}</td><td className="text-right tabular-nums">{fmt(i.amount)}</td></tr>)}</tbody>
              <tfoot><tr><td /><td colSpan={2}>Batch total</td><td className="text-right tabular-nums">{fmt(batch.total)}</td></tr></tfoot></table>
            <div className="mt-4 flex justify-end gap-2"><Button variant="ghost" onClick={() => setBatch(null)}>Cancel</Button><Button disabled={busy || !pick.size} onClick={unlinkFromBatch}>Unlink {pick.size} selected</Button></div>
          </div>
        </div>)}
    </section>
  );
}
