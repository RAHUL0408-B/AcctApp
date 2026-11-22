import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, download, fileToBase64, fmt, toPaise, today } from '../api';
import type { Org } from '../App';
import { Badge, PageHeader, Select } from '../kit';
import { DataTable, Icon, RowMenu, type Column } from '../table';
import { Button, Callout, Card, ErrorMsg, Field, Ok, useAction } from '../ui';
import type { Contact } from './Contacts';
import { Account, ContactPicker, emptyLine, Line, LinesEditor, linesFromApi, linesToApi, taxSummary } from './Lines';

interface Doc { id: number; docType: string; number: string; contactId: number; contactName: string; issueDate: string; dueDate: string | null; total: number; subtotal: number; cgst: number; sgst: number; igst: number; cess: number;
  tdsAmount: number; tdsSection: string | null; netPayable: number; status: string; outstanding?: number; paid?: number; currency: string; foreignTotal: number | null; supplyType: string; isArchived?: boolean;
  supplierRef: string | null; placeOfSupply: string | null; notes: string | null; originalDocId: number | null; bookedCode: string | null }
interface Payment { id: number; date: string; amount: number; reference?: string | null; batchId?: number | null }
interface Template { id: number; name: string; docType: string; payload: any }
interface Attachment { id: number; name: string; size: number }
interface OrgSettings { stateCode: string | null; lutNumber: string | null; lutTo: string | null; requireApproval: boolean; invoiceDueDays: number | null; billDueDays: number | null; customsDuty?: boolean; strictInvoiceChecks?: boolean }

const SUPPLY = {
  sales: [['regular', 'Regular'], ['export_lut', 'Export under LUT (no GST)'], ['export_igst', 'Export with IGST'], ['sez_lut', 'SEZ under LUT (no GST)'], ['sez_igst', 'SEZ with IGST']],
  purchases: [['regular', 'Regular'], ['reverse_charge', 'Reverse charge (you pay the GST)'], ['unregistered', 'Supply from unregistered dealer (no GST)']],
} as const;
const SUPPLY_NAME: Record<string, string> = Object.fromEntries([...SUPPLY.sales, ...SUPPLY.purchases]);
const TYPES = { sales: [['invoice', 'Invoice'], ['credit_note', 'Credit note']], purchases: [['bill', 'Bill'], ['debit_note', 'Debit note']] } as const;
const TYPE_NAME: Record<string, string> = { invoice: 'Invoice', credit_note: 'Credit note', bill: 'Bill', debit_note: 'Debit note' };
/** Currencies offered even before any are saved in Settings, Currencies. */
const COMMON_CURRENCIES = ['USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD', 'CAD', 'JPY', 'CHF', 'CNY', 'HKD', 'SAR', 'QAR', 'KWD', 'OMR', 'BHD', 'NZD', 'ZAR', 'MYR', 'THB', 'NPR', 'LKR', 'BDT'];

const blankForm = { contactId: '', issueDate: today(), dueDate: '', supplierRef: '', tdsSection: '', originalDocId: '', supplyType: 'regular', currency: 'INR', fxRate: '', number: '', notes: '' };
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);

export function Documents({ org, kind, canPost, accounts, startNew = false, startType, openId, fromDueId, restricted = false, role = 'owner', go }:
  { org: Org; kind: 'sales' | 'purchases'; canPost: boolean; accounts: Account[]; startNew?: boolean; startType?: string; /** open this document (from a report) */ openId?: number; /** a due run of a repeating schedule to complete and post */ fromDueId?: number; restricted?: boolean; role?: string; go?: (p: string) => void }) {
  // A restricted (sales) role can create and view, but not pay, edit, delete, archive or email.
  const full = canPost && !restricted;
  const types = TYPES[kind];
  const sales = kind === 'sales';
  const [docs, setDocs] = useState<Doc[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [states, setStates] = useState<{ code: string; name: string }[]>([]);
  const [settings, setSettings] = useState<OrgSettings>({ stateCode: org.gstin ? org.gstin.slice(0, 2) : null, lutNumber: null, lutTo: null, requireApproval: false, invoiceDueDays: null, billDueDays: null });
  const orgState = settings.stateCode;
  const [tds, setTds] = useState<{ code: string; description: string }[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [docType, setDocType] = useState<string>(startType && types.some(([t]) => t === startType) ? startType : types[0][0]);
  const [f, setF] = useState(blankForm);
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const [intraOverride, setIntraOverride] = useState<boolean | null>(null);
  const [posChoice, setPosChoice] = useState('');
  const [showForm, setShowForm] = useState(startNew);
  const [fxDefaults, setRates] = useState<Record<string, number>>({});
  const [numberTouched, setNumberTouched] = useState(false);
  const [numberClash, setNumberClash] = useState('');
  const [dueTouched, setDueTouched] = useState(false);
  const [original, setOriginal] = useState<(Doc & { payments: Payment[] }) | null>(null);
  const [tdsPreview, setTdsPreview] = useState<{ section: string; amount: number } | null>(null);
  const [issues, setIssues] = useState<{ text: string; block: boolean }[]>([]);
  const [quickContact, setQuickContact] = useState<Contact | null>(null);
  const [allDocs, setAllDocs] = useState(false);
  useEffect(() => { if (startNew) { setShowForm(true); if (startType && types.some(([t]) => t === startType)) setDocType(startType); } }, [startNew, startType]); // eslint-disable-line react-hooks/exhaustive-deps
  const [editing, setEditing] = useState<{ id: number; number: string; payments: Payment[] } | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [existingFiles, setExistingFiles] = useState<Attachment[]>([]);
  const [nextNumber, setNextNumber] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [showArchived, setShowArchived] = useState(false);
  const [ok, setOk] = useState('');
  const [pay, setPay] = useState<{ doc: Doc; amount: string; accountId: string; date: string; reference: string; foreign: string } | null>(null);
  const [batch, setBatch] = useState<{ accountId: string; date: string; reference: string; amounts: Record<number, string> } | null>(null);
  const { error, busy, run, setError } = useAction();
  const form = useAction(); // errors from saving the form are shown under its buttons
  const formTop = useRef<HTMLDivElement>(null);

  /** One or several documents as PDF, in the organisation's invoice template. */
  const downloadPdf = (ids: number[], name?: string) => run(() => ids.length === 1
    ? download(`/orgs/${org.id}/documents/${ids[0]}/pdf`, `${(name ?? 'document').replace(/\//g, '-')}.pdf`)
    : download(`/orgs/${org.id}/documents-pdf?ids=${ids.join(',')}`, 'documents.pdf'));

  const load = useCallback(() => api<Doc[]>(`/orgs/${org.id}/documents?archived=${showArchived}`).then((d) => setDocs(d.filter((x) => types.some(([t]) => t === x.docType) && (showArchived || !x.isArchived)))), [org.id, kind, showArchived]); // eslint-disable-line react-hooks/exhaustive-deps
  const loadContacts = useCallback(() => api<Contact[]>(`/orgs/${org.id}/contacts`).then((c) => setContacts(c.filter((x) => x.kind === 'both' || x.kind === (sales ? 'customer' : 'supplier')))), [org.id, sales]);
  const loadTemplates = useCallback(() => api<Template[]>(`/orgs/${org.id}/doc-templates`).then((t) => setTemplates(t.filter((x) => x.docType === (sales ? 'invoice' : 'bill')))), [org.id, sales]);
  useEffect(() => {
    load(); loadTemplates(); loadContacts();
    api('/config/tds-sections').then(setTds); api('/config/states').then(setStates);
    api<{ code: string; rate: number }[]>(`/orgs/${org.id}/currencies`).then((l) => setRates(Object.fromEntries(l.map((x) => [x.code, x.rate])))).catch(() => undefined);
    api<OrgSettings>(`/orgs/${org.id}/settings`).then(setSettings).catch(() => undefined);
  }, [load, loadTemplates, loadContacts, org.id, kind]);
  useEffect(() => { setSelected(new Set()); }, [docs]);

  // The number the system will give: shown in the field, and kept unless the person types another.
  useEffect(() => {
    if (editing || !showForm) return;
    api(`/orgs/${org.id}/documents-next-number?type=${docType}&date=${f.issueDate || today()}`).then((r) => setNextNumber(r.number)).catch(() => setNextNumber(''));
  }, [org.id, docType, f.issueDate, showForm, editing, docs.length]);
  // Due date: the issue date plus the days set in Sales / Purchases settings, until the person changes it.
  const dueDays = sales ? settings.invoiceDueDays : settings.billDueDays;
  useEffect(() => {
    if (!showForm || dueTouched || editing || dueDays == null || !f.issueDate || (docType !== 'invoice' && docType !== 'bill')) return;
    setF((x) => (x.dueDate === addDays(x.issueDate, dueDays) ? x : { ...x, dueDate: addDays(x.issueDate, dueDays) }));
  }, [f.issueDate, f.dueDate, dueDays, dueTouched, editing, docType, showForm]);

  const contact = contacts.find((c) => String(c.id) === f.contactId);
  const foreign = f.currency !== 'INR';
  const regular = f.supplyType === 'regular';
  const contactState = contact?.stateCode ?? null;
  const autoIntra = orgState && contactState ? orgState === contactState : true;
  const intra = !regular ? false : intraOverride ?? autoIntra;
  const noTax = f.supplyType.endsWith('_lut') || f.supplyType === 'reverse_charge' || f.supplyType === 'unregistered';
  const registered = !!contact?.gstin;
  const isNote = docType === 'credit_note' || docType === 'debit_note';
  const lutValid = !!settings.lutNumber && (!settings.lutTo || settings.lutTo >= (f.issueDate || today()));

  /** What a contact's details say this document should be: export / SEZ, reverse charge, unregistered, TDS. */
  const defaultsFor = (c: Contact | undefined) => {
    if (!c) return {};
    if (sales) {
      if (c.country && c.country !== 'IN') return { supplyType: lutValid ? 'export_lut' : 'export_igst' };
      if (c.isSez) return { supplyType: lutValid ? 'sez_lut' : 'sez_igst' };
      return { supplyType: 'regular' };
    }
    return { supplyType: c.rcmDefault ? 'reverse_charge' : !c.gstin && (c.country ?? 'IN') === 'IN' ? 'unregistered' : 'regular', tdsSection: c.defaultTdsSection ?? '' };
  };
  const chooseContact = (id: string) => {
    const c = contacts.find((x) => String(x.id) === id);
    setF((x) => ({ ...x, contactId: id, originalDocId: x.contactId === id ? x.originalDocId : '', ...(editing ? {} : defaultsFor(c)) }));
    if (f.contactId !== id) setOriginal(null);
    setIntraOverride(null);
  };

  const changeSupply = (wantIntra: boolean) => setIntraOverride(wantIntra === autoIntra ? null : wantIntra);
  /** Place of supply to send. Only needed when the user overrode what the contact's state says. */
  const placeOfSupply = (): string | undefined => {
    if (!regular || intraOverride === null || !orgState) return undefined;
    const supplierState = sales ? orgState : contactState, buyerState = sales ? contactState : orgState;
    if (intra) return sales ? orgState : contactState ?? undefined;
    const other = sales ? contactState : orgState;
    if (other && other !== supplierState) return other;
    return posChoice || buyerState || undefined;
  };
  const needsPosChoice = regular && intraOverride === false && (sales ? contactState === orgState : orgState === contactState);
  const stateName = (code: string | null) => (code ? `${states.find((s) => s.code === code)?.name ?? ''} (${code})`.trim() : 'not known');

  // TDS this bill will carry, worked out by the server the same way as on saving.
  const subtotal = useMemo(() => taxSummary(lines, intra, noTax).subtotal, [lines, intra, noTax]);
  useEffect(() => {
    setTdsPreview(null);
    if (docType !== 'bill' || !f.tdsSection || !f.contactId || !subtotal || foreign) return;
    const t = setTimeout(() => {
      api(`/orgs/${org.id}/tds-preview?section=${encodeURIComponent(f.tdsSection)}&contactId=${f.contactId}&amount=${subtotal}&date=${f.issueDate}${editing ? `&except=${editing.id}` : ''}`)
        .then((r) => setTdsPreview({ section: r.section, amount: Math.min(r.tds, taxSummary(lines, intra, noTax).total) })).catch(() => setTdsPreview(null));
    }, 300);
    return () => clearTimeout(t);
  }, [org.id, docType, f.tdsSection, f.contactId, f.issueDate, subtotal, foreign, editing]); // eslint-disable-line react-hooks/exhaustive-deps

  // Particulars the law asks for on a tax invoice (Rule 46) that are still missing: shown while filling the form.
  useEffect(() => {
    setIssues([]);
    if (!showForm || !sales || !f.contactId || (docType !== 'invoice' && docType !== 'credit_note') || !lines.some((l) => l.description.trim())) return;
    const t = setTimeout(() => {
      api(`/orgs/${org.id}/documents-check`, { body: { docType, contactId: Number(f.contactId), supplyType: f.supplyType, issueDate: f.issueDate, total: taxSummary(lines, intra, noTax).total,
        lines: lines.filter((l) => l.description.trim()).map((l) => ({ description: l.description, hsnSac: l.hsnSac || undefined, unit: l.unit || undefined })) } })
        .then((r) => setIssues(r.issues ?? [])).catch(() => setIssues([]));
    }, 600);
    return () => clearTimeout(t);
  }, [org.id, showForm, sales, docType, f.contactId, f.supplyType, f.issueDate, lines, intra, noTax, contacts, settings.strictInvoiceChecks]); // eslint-disable-line react-hooks/exhaustive-deps

  const numberToSend = numberTouched ? f.number.trim() : '';
  const body = () => ({
    docType, contactId: Number(f.contactId), issueDate: f.issueDate, lines: linesToApi(lines), supplyType: f.supplyType,
    ...(placeOfSupply() ? { placeOfSupply: placeOfSupply() } : {}),
    ...(foreign ? { currency: f.currency, fxRate: Number(f.fxRate) } : {}),
    ...(f.dueDate ? { dueDate: f.dueDate } : {}), ...(f.supplierRef ? { supplierRef: f.supplierRef } : {}), ...(numberToSend ? { number: numberToSend } : editing ? { number: f.number } : {}), ...(f.notes ? { notes: f.notes } : {}),
    ...(f.tdsSection && docType === 'bill' ? { tdsSection: f.tdsSection } : {}), ...(f.originalDocId && isNote ? { originalDocId: Number(f.originalDocId) } : {}),
  });
  const resetForm = () => {
    setF(blankForm); setLines([emptyLine()]); setIntraOverride(null); setPosChoice(''); setFiles([]); setExistingFiles([]); setEditing(null); setShowForm(false);
    setNumberTouched(false); setNumberClash(''); setDueTouched(false); setOriginal(null); setQuickContact(null); form.setError('');
  };
  const uploadAll = async (docId: number) => {
    for (const file of files) await api(`/orgs/${org.id}/files`, { body: { name: file.name, mime: file.type || 'application/octet-stream', dataBase64: await fileToBase64(file), linkType: 'document', linkId: docId } });
  };

  // Staff (and sales people) send documents for approval when the organisation asks for it; owners and accountants post.
  const mustApprove = settings.requireApproval && (role === 'staff' || role === 'sales');
  const checkNumber = async () => {
    setNumberClash('');
    const n = numberToSend; if (!n) return;
    const r = await api(`/orgs/${org.id}/documents-number-check?type=${docType}&number=${encodeURIComponent(n)}${editing ? `&except=${editing.id}` : ''}`).catch(() => null);
    if (r && !r.free) setNumberClash(r.message);
  };

  const create = (forApproval = false) => form.run(async () => {
    setOk('');
    if (!f.contactId) throw new Error(`Choose a ${sales ? 'customer' : 'supplier'} from the list`);
    if (numberClash) throw new Error(numberClash);
    if (isNote && !f.originalDocId) throw new Error(`Choose the ${docType === 'credit_note' ? 'invoice' : 'bill'} this ${docType === 'credit_note' ? 'credit' : 'debit'} note is against.`);
    if (isNote && original && (original.outstanding ?? 0) <= 0) throw new Error(`${original.number} is fully ${sales ? 'received' : 'paid'}. Unlink its payment first (above), then create the note.`);
    const b = body();
    if (forApproval) {
      const d = await api(`/orgs/${org.id}/drafts`, { body: b });
      setOk(`Sent for approval (total ${foreign ? f.currency + ' ' : '₹'}${fmt(d.total)}). It reaches the books once an owner or accountant approves it.`);
      resetForm(); return;
    }
    let r;
    try { r = editing ? await api(`/orgs/${org.id}/documents/${editing.id}`, { method: 'PUT', body: b }) : await api(`/orgs/${org.id}/documents`, { body: b }); }
    catch (e) {
      if (editing || !/^Possible duplicate/.test((e as Error).message) || !window.confirm(`${(e as Error).message}\n\nPost this bill anyway?`)) throw e;
      r = await api(`/orgs/${org.id}/documents`, { body: { ...b, allowDuplicate: true } });
    }
    let attachNote = '';
    try { await uploadAll(r.id); } catch (e) { attachNote = ` The document was saved, but a file could not be attached: ${(e as Error).message}`; }
    if (dueRun && !editing) { await api(`/orgs/${org.id}/recurring-due/${dueRun}`, { body: { status: 'posted', documentId: r.id } }).catch(() => undefined); setDueRun(null); }
    let left = '';
    if (isNote && original) {
      const o = await api<Doc>(`/orgs/${org.id}/documents/${original.id}`).catch(() => null);
      if (o) left = ` Balance still to ${sales ? 'receive' : 'pay'} on ${o.number}: ₹${fmt(o.outstanding ?? 0)}.`;
    }
    setOk(`${editing ? 'Updated' : 'Created'} ${r.number}: total ₹${fmt(r.total)}${r.foreignTotal ? ` (${r.currency} ${fmt(r.foreignTotal)})` : ''}${r.tdsAmount ? `, TDS ₹${fmt(r.tdsAmount)}, net payable ₹${fmt(r.netPayable)}` : ''}${r.rcm && (r.rcm.cgst + r.rcm.sgst + r.rcm.igst) ? `, reverse-charge GST ₹${fmt(r.rcm.cgst + r.rcm.sgst + r.rcm.igst)} to pay` : ''}.${left}${attachNote}`);
    resetForm(); load();
  });

  const openForm = () => { resetForm(); setShowForm(true); setTimeout(() => formTop.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0); };
  const startEdit = (d: Doc) => run(async () => {
    setOk('');
    const fullDoc = await api(`/orgs/${org.id}/documents/${d.id}`);
    const atts = await api<Attachment[]>(`/orgs/${org.id}/files?linkType=document&linkId=${d.id}`);
    setDocType(fullDoc.docType);
    setF({ contactId: String(fullDoc.contactId), issueDate: fullDoc.issueDate, dueDate: fullDoc.dueDate ?? '', supplierRef: fullDoc.supplierRef ?? '', tdsSection: fullDoc.tdsSection ?? '', originalDocId: fullDoc.originalDocId ? String(fullDoc.originalDocId) : '',
      supplyType: fullDoc.supplyType, currency: fullDoc.currency, fxRate: fullDoc.currency !== 'INR' ? String(fullDoc.fxRate) : '', number: fullDoc.number, notes: fullDoc.notes ?? '' });
    setNumberTouched(true); setDueTouched(true); setNumberClash('');
    setLines(linesFromApi(fullDoc.lines)); setFiles([]); setExistingFiles(atts);
    const st = contacts.find((c) => c.id === fullDoc.contactId)?.stateCode ?? null;
    const auto = orgState && st ? orgState === st : true;
    const was = fullDoc.igst > 0 ? false : fullDoc.cgst > 0 ? true : auto;
    setIntraOverride(was === auto ? null : was); setPosChoice(fullDoc.placeOfSupply ?? '');
    setEditing({ id: d.id, number: fullDoc.number, payments: fullDoc.payments });
    setShowForm(true); setTimeout(() => formTop.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
  });
  /** A credit note against an invoice (or debit note against a bill): the original's lines are copied in and can be changed. */
  const noteAgainst = (d: Doc) => { resetForm(); setShowForm(true); setDocType(sales ? 'credit_note' : 'debit_note'); setF({ ...blankForm, contactId: String(d.contactId), originalDocId: String(d.id) }); };
  // Load the original when a note's "Against" is chosen: copy its lines, supply type and currency.
  useEffect(() => {
    if (!isNote || !f.originalDocId || editing) { if (!f.originalDocId) setOriginal(null); return; }
    let live = true;
    api(`/orgs/${org.id}/documents/${f.originalDocId}`).then((o) => {
      if (!live) return;
      setOriginal(o);
      setLines(linesFromApi(o.lines));
      setF((x) => ({ ...x, supplyType: o.supplyType, currency: o.currency, fxRate: o.currency !== 'INR' ? String(o.fxRate) : '', tdsSection: '' }));
      const auto = orgState && contactState ? orgState === contactState : true, was = o.igst > 0 ? false : o.cgst > 0 ? true : auto;
      setIntraOverride(was === auto ? null : was); setPosChoice(o.placeOfSupply ?? '');
    }).catch(() => setOriginal(null));
    return () => { live = false; };
  }, [f.originalDocId, docType, editing]); // eslint-disable-line react-hooks/exhaustive-deps

  const useTemplate = (id: string) => {
    const tpl = templates.find((x) => x.id === Number(id)); if (!tpl) return;
    const p = tpl.payload;
    if (p.contactId) setF((x) => ({ ...x, contactId: String(p.contactId), supplyType: p.supplyType ?? x.supplyType, notes: p.notes ?? '', tdsSection: p.tdsSection ?? '' }));
    else setF((x) => ({ ...x, supplyType: p.supplyType ?? x.supplyType, notes: p.notes ?? '', tdsSection: p.tdsSection ?? '' }));
    setLines(linesFromApi(p.lines));
    if (p.dueDays != null) { setDueTouched(true); setF((x) => ({ ...x, dueDate: addDays(x.issueDate, p.dueDays) })); }
  };
  const saveTemplate = () => form.run(async () => {
    const name = window.prompt('Name this template (for example "Monthly retainer"):'); if (!name?.trim()) return;
    const dd = f.dueDate ? Math.max(0, Math.round((Date.parse(f.dueDate) - Date.parse(f.issueDate)) / 86400000)) : undefined;
    await api(`/orgs/${org.id}/doc-templates`, { body: { name: name.trim(), docType: sales ? 'invoice' : 'bill', payload: {
      ...(f.contactId ? { contactId: Number(f.contactId) } : {}), supplyType: f.supplyType, ...(f.notes ? { notes: f.notes } : {}), ...(dd != null ? { dueDays: dd } : {}), ...(f.tdsSection ? { tdsSection: f.tdsSection } : {}), lines: linesToApi(lines) } } });
    setOk(`Template "${name.trim()}" saved. Choose it under "Start from a template" on any new ${sales ? 'invoice' : 'bill'}.`); loadTemplates();
  });
  /** Open the repeating schedule screen with this document's details already filled in. */
  const makeRepeating = () => {
    try { sessionStorage.setItem('repeat-from', JSON.stringify({ kind: sales ? 'invoice' : 'bill', contactId: f.contactId, lines, notes: f.notes, tdsSection: f.tdsSection, supplyType: f.supplyType, supplierRef: f.supplierRef })); } catch { /* storage may be off */ }
    go?.(sales ? 'recurring' : 'recurring-bills');
  };

  const bankOptions = accounts.filter((a) => a.type === 'asset' && (['1000', '1010'].includes(a.code) || /bank|cash/i.test(a.name)));
  const openPay = (d: Doc) => { setError(''); setPay({ doc: d, amount: d.currency === 'INR' ? String((d.outstanding ?? 0) / 100) : '', accountId: '', date: today(), reference: '', foreign: '' }); };
  const doPay = () => run(async () => {
    if (!pay) return;
    const r = await api(`/orgs/${org.id}/documents/${pay.doc.id}/payments`, { body: { date: pay.date, amount: toPaise(pay.amount), accountId: Number(pay.accountId), ...(pay.reference ? { reference: pay.reference } : {}),
      ...(pay.doc.currency !== 'INR' ? { foreignAmount: toPaise(pay.foreign) } : {}) } });
    setPay(null); setOk(`Payment recorded.${r.fxGain ? ` Exchange ${r.fxGain > 0 ? 'gain' : 'loss'} ₹${fmt(Math.abs(r.fxGain))}.` : ''}`); load();
  });
  const unlinkPayment = (paymentId: number, onDone?: () => void) => run(async () => {
    if (!window.confirm('Unlink this payment? Its entry is reversed and the document becomes outstanding again.')) return;
    await api(`/orgs/${org.id}/payments/${paymentId}`, { method: 'DELETE' });
    if (editing) setEditing({ ...editing, payments: editing.payments.filter((p) => p.id !== paymentId) });
    setOk('Payment unlinked.'); load(); onDone?.();
  });
  const doVoid = (d: Doc) => run(async () => {
    if (!window.confirm(`Delete ${d.number}? Posted entries cannot be erased from the books, so it is cancelled with a reversing entry and shows as void.`)) return;
    await api(`/orgs/${org.id}/documents/${d.id}/void`, { body: { date: today(), reason: 'Deleted from the app' } }); setOk(`${d.number} deleted (cancelled with a reversing entry).`); load();
  });
  const archiveOne = (d: Doc) => run(async () => { await api(`/orgs/${org.id}/documents/bulk-archive`, { body: { ids: [d.id], archived: !d.isArchived } }); setOk(`${d.number} ${d.isArchived ? 'restored' : 'archived'}.`); load(); });
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
  const payable = (d: Doc) => d.status === 'posted' && (d.docType === 'invoice' || d.docType === 'bill') && (d.outstanding ?? 0) > 0 && d.currency === 'INR';
  const batchDocs = docs.filter((d) => selected.has(d.id) && payable(d));
  const openBatch = () => setBatch({ accountId: '', date: today(), reference: '', amounts: Object.fromEntries(batchDocs.map((d) => [d.id, String((d.outstanding ?? 0) / 100)])) });
  // New ticks while the batch box is open join the batch at their outstanding amount.
  useEffect(() => { if (batch) setBatch((b) => b && ({ ...b, amounts: { ...Object.fromEntries(batchDocs.map((d) => [d.id, String((d.outstanding ?? 0) / 100)])), ...b.amounts } })); }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps
  const batchTotal = batch ? batchDocs.reduce((sum, d) => { try { return sum + toPaise(batch.amounts[d.id] || '0'); } catch { return sum; } }, 0) : 0;
  const doBatch = () => run(async () => {
    if (!batch) return;
    const items = batchDocs.map((d) => ({ documentId: d.id, amount: toPaise(batch.amounts[d.id] || '0') })).filter((i) => i.amount > 0);
    const r = await api(`/orgs/${org.id}/payment-batches`, { body: { date: batch.date, accountId: Number(batch.accountId), ...(batch.reference ? { reference: batch.reference } : {}), items } });
    setBatch(null); setSelected(new Set());
    setOk(`Batch ${sales ? 'receipt' : 'payment'} of ₹${fmt(r.total)} recorded for ${r.count} ${sales ? 'invoice' : 'bill'}(s), as one bank entry.`); load();
  });
  const email = (d: Doc) => run(async () => { const r = await api(`/orgs/${org.id}/documents/${d.id}/send`, { body: {} }); setOk(`${d.number} queued to ${r.queuedTo}.`); });
  const remind = (ids?: number[]) => run(async () => {
    const r = await api(`/orgs/${org.id}/documents/remind-overdue`, { method: 'POST', body: ids ? { ids } : {} });
    setOk(ids ? `${r.reminders} reminder(s) queued${r.reminders < ids.length ? ` (${ids.length - r.reminders} skipped: already paid, or the customer has no email address)` : ''}.` : `${r.reminders} overdue reminder(s) queued.`);
  });
  const toggle = (id: number) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const title = sales ? 'Invoices' : 'Bills';
  const overdue = (d: Doc) => d.status === 'posted' && (d.outstanding ?? 0) > 0 && !!d.dueDate && d.dueDate < today() && (d.docType === 'invoice' || d.docType === 'bill');
  const statusOf = (d: Doc) => {
    if (d.status !== 'posted') return d.status;
    if (d.docType !== 'invoice' && d.docType !== 'bill') return 'posted';
    if ((d.outstanding ?? 0) <= 0) return 'paid';
    if (overdue(d)) return 'overdue';
    return (d.paid ?? 0) > 0 ? 'part paid' : 'posted';
  };
  const payLabel = sales ? 'Receive payment' : 'Pay';
  const canEdit = (d: Doc) => full && d.status === 'posted';
  const contactPage = sales ? 'customers' : 'suppliers';
  // Opened from a report or ledger: show that document (in the edit form when it can be edited).
  const opened = useRef<number | null>(null);
  useEffect(() => {
    if (!openId || opened.current === openId || !docs.length) return;
    const d = docs.find((x) => x.id === openId);
    if (!d) return;
    opened.current = openId;
    if (canEdit(d)) startEdit(d); else setOk(`${d.number}: ${statusOf(d)}, total ₹${fmt(d.total)}. It cannot be edited; use the ⋮ menu for its PDF.`);
  }, [openId, docs]); // eslint-disable-line react-hooks/exhaustive-deps
  // A run of a repeating schedule that waits for review: fill the form from it; posting marks it done.
  const [dueRun, setDueRun] = useState<number | null>(null);
  useEffect(() => {
    if (!fromDueId || dueRun === fromDueId) return;
    api<any[]>(`/orgs/${org.id}/recurring-due`).then((list) => {
      const d = list.find((x) => x.id === fromDueId);
      if (!d) { setError('That repeating entry was already posted or skipped.'); return; }
      setDueRun(fromDueId); setShowForm(true); setDocType(d.docType);
      setF({ ...blankForm, contactId: String(d.contactId), issueDate: d.dueDate, dueDate: addDays(d.dueDate, d.dueDays ?? 0), tdsSection: d.tdsSection ?? '', supplyType: d.supplyType ?? 'regular', notes: d.notes ?? '' });
      setDueTouched(true); setLines(linesFromApi(d.lines));
      setOk(`Repeating ${d.docType} for ${d.contactName} dated ${d.dueDate}: add the ${d.docType === 'bill' ? "supplier's bill number and a copy" : 'details'}, check it, and create it.`);
    }).catch(() => undefined);
  }, [fromDueId]); // eslint-disable-line react-hooks/exhaustive-deps
  const shownDocs = showForm && f.contactId && !allDocs ? docs.filter((d) => String(d.contactId) === f.contactId) : docs;
  const partyOriginals = docs.filter((d) => d.status === 'posted' && d.docType === (sales ? 'invoice' : 'bill') && String(d.contactId) === f.contactId);
  const currencies = [...new Set(['INR', ...Object.keys(fxDefaults), ...COMMON_CURRENCIES, ...(f.currency ? [f.currency] : [])])];

  const columns: Column<Doc>[] = [
    { key: 'number', label: 'Number', value: (d) => d.number, render: (d) => (
      <button type="button" className="font-medium text-brand-700 hover:text-brand-900 hover:underline" title={canEdit(d) ? 'Open to view or edit' : 'Download PDF'}
        aria-label={`Open ${d.number}`} onClick={() => (canEdit(d) ? startEdit(d) : downloadPdf([d.id], d.number))}>{d.number}</button>) },
    { key: 'type', label: 'Type', value: (d) => TYPE_NAME[d.docType] ?? d.docType, hidden: true },
    { key: 'contact', label: sales ? 'Customer' : 'Supplier', value: (d) => d.contactName, render: (d) => (go
      ? <button type="button" className="text-left text-slate-800 hover:text-brand-700 hover:underline" onClick={() => go(`${contactPage}/${d.contactId}`)}>{d.contactName}</button> : d.contactName) },
    ...(!sales ? [{ key: 'ref', label: 'Supplier bill no.', value: (d: Doc) => d.supplierRef } as Column<Doc>] : []),
    { key: 'date', label: 'Date', value: (d) => d.issueDate },
    { key: 'due', label: 'Due', value: (d) => d.dueDate, render: (d) => <span className={overdue(d) ? 'font-medium text-red-700' : ''}>{d.dueDate ?? '—'}</span> },
    { key: 'taxable', label: 'Taxable value', value: (d) => d.subtotal, money: true, hidden: true, noSearch: true },
    { key: 'gst', label: 'GST', value: (d) => d.cgst + d.sgst + d.igst, money: true, hidden: true, noSearch: true },
    { key: 'cess', label: 'Cess', value: (d) => d.cess, money: true, hidden: true, noSearch: true },
    { key: 'total', label: 'Total', value: (d) => d.total, money: true, render: (d) => (
      <span>{go && d.bookedCode ? <button type="button" className="font-medium text-brand-700 hover:underline" title={`Open the ledger ${d.bookedCode} this was booked to`} aria-label={`Ledger of ${d.number}`} onClick={() => go(`reports/ledger-${d.bookedCode}`)}>{fmt(d.total)}</button> : fmt(d.total)}
        {d.currency !== 'INR' && d.foreignTotal != null && <span className="block text-xs text-slate-500">{d.currency} {fmt(d.foreignTotal)}</span>}</span>) },
    ...(!sales ? [{ key: 'tds', label: 'TDS', value: (d: Doc) => d.tdsAmount || null, money: true, noSearch: true } as Column<Doc>] : []),
    { key: 'outstanding', label: 'Outstanding', value: (d) => ((d.docType === 'invoice' || d.docType === 'bill') && d.status === 'posted' ? d.outstanding ?? null : null), money: true, noSearch: true },
    { key: 'status', label: 'Status', value: (d) => statusOf(d), render: (d) => <><Badge text={statusOf(d)} />{d.isArchived && <span className="ml-1 text-xs">archived</span>}</> },
    { key: 'supply', label: 'Supply type', value: (d) => SUPPLY_NAME[d.supplyType] ?? d.supplyType, hidden: true },
    { key: 'pos', label: 'Place of supply', value: (d) => d.placeOfSupply, hidden: true },
    { key: 'currency', label: 'Currency', value: (d) => d.currency, hidden: true },
    { key: 'notes', label: 'Notes', value: (d) => d.notes, hidden: true },
  ];

  return (
    <>
      <PageHeader title={title} subtitle={sales ? 'Invoices and credit notes you send to customers' : 'Bills and debit notes from your suppliers'}
        actions={canPost && <>{sales && full && <Button variant="ghost" disabled={busy} onClick={() => remind()}>Send overdue reminders</Button>}
          {full && go && <Button variant="ghost" onClick={() => go(sales ? 'recurring' : 'recurring-bills')}><span className="inline-flex items-center gap-1.5"><Icon name="repeat" />Repeating</span></Button>}
          <Button onClick={() => (showForm ? resetForm() : openForm())}>{showForm ? 'Close' : `New ${sales ? 'invoice' : 'bill'}`}</Button></>} />
      <div className="mb-3 space-y-2"><ErrorMsg msg={error} /><Ok msg={ok} /></div>
      {showForm && canPost && (
        <div ref={formTop}>
        <Card title={editing ? `Edit ${editing.number}` : sales ? 'New sales document' : 'New purchase document'}
          actions={!editing && templates.length > 0 && <select aria-label="Start from a template" className="rounded border border-slate-300 px-2 py-1 text-sm" value="" onChange={(e) => useTemplate(e.target.value)}><option value="">Start from a template…</option>{templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>}>
          {editing && <div className="mb-3"><Callout tone="warning" title="Editing a posted document">Saving cancels the posted version with a reversing entry and posts the corrected one under the same number. This is not possible once a payment has been recorded: unlink it first.</Callout></div>}
          {editing && editing.payments.length > 0 && (
            <div className="mb-3 rounded-lg border border-slate-200 p-3 text-sm"><p className="mb-1 font-medium">Payments on this document</p>
              {editing.payments.map((p) => <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-1"><span>{p.date} · ₹{fmt(p.amount)}{p.reference ? ` · ${p.reference}` : ''}{p.batchId ? ` · part of batch #${p.batchId}` : ''}</span>
                {p.batchId ? <Button variant="ghost" onClick={() => go?.(`batch-payments/${p.batchId}`)}>Open batch #{p.batchId}</Button> : <Button variant="ghost" onClick={() => unlinkPayment(p.id)}>Unlink</Button>}</div>)}</div>
          )}
          <div className="grid gap-3 md:grid-cols-4">
            <Select label="Type" aria-label="Document type" value={docType} disabled={!!editing} onChange={(e) => { setDocType(e.target.value); setOriginal(null); setF((x) => ({ ...x, originalDocId: '' })); }}>{types.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
            <ContactPicker label={sales ? 'Customer' : 'Supplier'} contacts={contacts} value={f.contactId} onChange={chooseContact} onEdit={full ? setQuickContact : undefined} />
            <Field label="Date" type="date" value={f.issueDate} onChange={(e) => setF({ ...f, issueDate: e.target.value })} />
            <Field label="Due date" type="date" value={f.dueDate} onChange={(e) => { setDueTouched(true); setF({ ...f, dueDate: e.target.value }); }} />
            <div><Field label={`${TYPE_NAME[docType]} number`} aria-label="Document number" value={numberTouched ? f.number : nextNumber} placeholder="Automatic"
              onChange={(e) => { setNumberTouched(true); setNumberClash(''); setF({ ...f, number: e.target.value }); }} onBlur={checkNumber} />
              {numberClash ? <p role="alert" className="mt-1 text-xs font-medium text-red-700">{numberClash}</p> : !editing && <p className="mt-1 text-xs text-slate-500">{numberTouched ? 'Your number' : 'Next in your series; type over it to change'}</p>}</div>
            {docType === 'bill' && <Field label="Supplier bill no." value={f.supplierRef} onChange={(e) => setF({ ...f, supplierRef: e.target.value })} />}
            {docType === 'bill' && <Select label="TDS section" aria-label="TDS section" value={f.tdsSection} onChange={(e) => setF({ ...f, tdsSection: e.target.value })}>
              <option value="">No TDS</option>{tds.map((t) => <option key={t.code} value={t.code}>{t.code} · {t.description}</option>)}</Select>}
            <Select label="Supply type" aria-label="Supply type" value={f.supplyType} onChange={(e) => { setF({ ...f, supplyType: e.target.value }); setIntraOverride(null); }}>{SUPPLY[kind].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
            <Select label="Currency" aria-label="Currency" value={f.currency} disabled={isNote && !!original}
              onChange={(e) => { const c = e.target.value; setF({ ...f, currency: c, fxRate: c !== 'INR' && fxDefaults[c] ? String(fxDefaults[c]) : c === 'INR' ? '' : f.fxRate }); }}>
              {currencies.map((c) => <option key={c} value={c}>{c}{fxDefaults[c] ? ` (default ₹${fxDefaults[c]})` : ''}</option>)}</Select>
            {foreign && <Field label={`Rupees per 1 ${f.currency}`} aria-label="Exchange rate" inputMode="decimal" value={f.fxRate} disabled={isNote && !!original} onChange={(e) => setF({ ...f, fxRate: e.target.value })} />}
            {isNote && (
              <label className="block text-sm"><span className="mb-1 block font-medium text-slate-600">Against {sales ? 'invoice' : 'bill'}</span>
                <input aria-label="Original document" list="note-originals" disabled={!f.contactId || !!editing} placeholder={f.contactId ? 'Type or pick a number…' : `Choose the ${sales ? 'customer' : 'supplier'} first`}
                  defaultValue={docs.find((d) => String(d.id) === f.originalDocId)?.number ?? ''} key={`${f.contactId}-${f.originalDocId}`}
                  onChange={(e) => { const hit = partyOriginals.find((d) => d.number.toLowerCase() === e.target.value.trim().toLowerCase()); if (hit) setF({ ...f, originalDocId: String(hit.id) }); }}
                  className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 shadow-sm disabled:bg-slate-100" />
                <datalist id="note-originals">{partyOriginals.map((d) => <option key={d.id} value={d.number}>{d.issueDate} · ₹{fmt(d.total)} · outstanding ₹{fmt(d.outstanding ?? 0)}</option>)}</datalist></label>)}
          </div>

          {quickContact && <QuickContact org={org} contact={quickContact} states={states} tds={tds} onClose={() => setQuickContact(null)} onSaved={(msg) => { setQuickContact(null); loadContacts(); setOk(msg); }} />}

          {isNote && original && (
            <div className="mt-3 space-y-2">
              <Callout tone="info" title={`Against ${original.number} dated ${original.issueDate}`}>
                Total ₹{fmt(original.total)} · still to {sales ? 'receive' : 'pay'} ₹{fmt(original.outstanding ?? 0)}. Its lines are copied below: change the quantities or rates to what is being {sales ? 'credited' : 'debited'}.
                {(original.outstanding ?? 0) > 0 && <> After this note the balance will be ₹{fmt(Math.max(0, (original.outstanding ?? 0) - taxSummary(lines, intra, noTax).total))}.</>}
              </Callout>
              {(original.outstanding ?? 0) <= 0 && (
                <Callout tone="warning" title={`${original.number} is already fully ${sales ? 'received' : 'paid'}`}>
                  A {sales ? 'credit' : 'debit'} note can only reduce what is still outstanding. Unlink the payment matched to {original.number} first, then create the note (and record the refund separately).
                  <div className="mt-2 flex flex-wrap gap-2">{original.payments.map((p) => p.batchId
                    ? <Button key={p.id} variant="ghost" onClick={() => go?.(`batch-payments/${p.batchId}`)}>Payment of ₹{fmt(p.amount)} on {p.date} is in batch #{p.batchId}: open it</Button>
                    : <Button key={p.id} variant="ghost" onClick={() => unlinkPayment(p.id, () => api(`/orgs/${org.id}/documents/${original.id}`).then(setOriginal))}>Unlink payment of ₹{fmt(p.amount)} on {p.date}</Button>)}</div>
                </Callout>)}
            </div>)}

          {regular && (
            <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm" data-testid="supply-box">
              <div className="flex flex-wrap items-center gap-4">
                <span className="font-medium text-slate-700">Place of supply</span>
                <label className="flex items-center gap-1"><input type="radio" name="supply-kind" aria-label="Intrastate supply" checked={intra} onChange={() => changeSupply(true)} />Intrastate (CGST + SGST)</label>
                <label className="flex items-center gap-1"><input type="radio" name="supply-kind" aria-label="Interstate supply" checked={!intra} onChange={() => changeSupply(false)} />Interstate (IGST)</label>
                {needsPosChoice && <Select label="State of supply" value={posChoice} onChange={(e) => setPosChoice(e.target.value)}><option value="">Choose state…</option>{states.filter((s) => s.code !== orgState).map((s) => <option key={s.code} value={s.code}>{s.code} {s.name}</option>)}</Select>}
              </div>
              <p className="mt-1 text-xs text-slate-500">
                {!contact ? `Choose a ${sales ? 'customer' : 'supplier'}: the type is picked from their state compared with yours (${stateName(orgState)}).`
                  : `Chosen from the states: yours is ${stateName(orgState)}, ${registered ? 'their GSTIN is in' : 'this unregistered party is in'} ${stateName(contactState)}.`}
              </p>
              {contact && intraOverride !== null && (
                <div className="mt-2">
                  <Callout tone="warning" title={`${intra ? 'CGST + SGST' : 'IGST'} does not match the ${sales ? 'customer' : 'supplier'}'s state`}>
                    {contact.name} is {registered ? 'registered' : 'an unregistered party'} in {stateName(contactState)} and you are in {stateName(orgState)}, so this is
                    {autoIntra ? ' an intrastate supply (CGST + SGST)' : ' an interstate supply (IGST)'}. Charging {intra ? 'CGST + SGST' : 'IGST'} instead is only right if the goods are delivered or the service is
                    received in {intra ? 'your state' : 'another state'} (section 10 / 12 of the IGST Act). Tax paid under the wrong head has to be paid again under the right one.
                    <div className="mt-2"><Button variant="ghost" onClick={() => setIntraOverride(null)}>Use {autoIntra ? 'CGST + SGST' : 'IGST'} as worked out</Button></div>
                  </Callout>
                </div>)}
            </div>
          )}
          {f.supplyType === 'unregistered' && <div className="mt-3"><Callout tone="info">Supply from an unregistered dealer: no GST is charged and no input credit is claimed. (Notified services under section 9(4) are under reverse charge instead.)</Callout></div>}

          {issues.length > 0 && (
            <div className="mt-3" data-testid="rule46-issues">
              <Callout tone="warning" title={settings.strictInvoiceChecks ? 'Details the law requires are missing: this invoice cannot be issued yet' : 'Details a tax invoice must show are missing (Rule 46, CGST Rules)'}>
                <ul className="list-disc space-y-0.5 pl-5">{issues.map((x, i) => <li key={i}>{x.text}</li>)}</ul>
                {!settings.strictInvoiceChecks && <p className="mt-1 text-xs">You can still issue it. The owner can make this a hard stop under Settings, Duties and taxes.</p>}
              </Callout>
            </div>)}

          <LinesEditor org={org} lines={lines} setLines={setLines} sales={sales} accounts={accounts} currency={f.currency} intra={intra} noTax={noTax}
            dutyOk={sales && !!settings.customsDuty && (f.supplyType.startsWith('export') || f.supplyType.startsWith('sez'))}
            contactDefaultId={sales ? contact?.defaultSalesAccountId : contact?.defaultPurchaseAccountId} tds={docType === 'bill' ? tdsPreview : null} />

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <label className="block text-sm"><span className="mb-1 block font-medium text-slate-600">Notes (printed on the document)</span>
              <textarea aria-label="Notes" rows={2} maxLength={500} className="w-full rounded-md border border-slate-300 px-3 py-2" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></label>
            <div className="text-sm"><span className="mb-1 block font-medium text-slate-600">Attachments (PDF, image, Excel, Word; max 10 MB each)</span>
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border-2 border-dashed border-brand-300 bg-brand-50/50 px-4 py-2 font-medium text-brand-700 hover:border-brand-500 hover:bg-brand-50">
                <Icon name="plus" className="text-brand-600" />Upload documents<input aria-label="Attach documents" type="file" multiple className="sr-only" onChange={(e) => { setFiles([...files, ...Array.from(e.target.files ?? [])]); e.target.value = ''; }} /></label>
              <ul className="mt-1 space-y-0.5 text-xs text-slate-600">
                {existingFiles.map((a) => <li key={a.id}><button className="underline" onClick={() => run(() => download(`/orgs/${org.id}/files/${a.id}/download`, a.name))}>{a.name}</button> (attached)</li>)}
                {files.map((x, i) => <li key={i}>{x.name} <button className="text-red-700" onClick={() => setFiles(files.filter((_, j) => j !== i))}>remove</button></li>)}</ul></div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            {mustApprove && !editing
              ? <Button disabled={form.busy || !!numberClash} onClick={() => create(true)}>Submit for approval</Button>
              : <Button disabled={form.busy || !!numberClash} onClick={() => create()}>{editing ? 'Save changes' : 'Create'}</Button>}
            {(docType === 'invoice' || docType === 'bill') && <Button variant="ghost" disabled={form.busy} onClick={saveTemplate}>Save as template</Button>}
            {!editing && (docType === 'invoice' || docType === 'bill') && go && full && <Button variant="ghost" onClick={makeRepeating}><span className="inline-flex items-center gap-1.5"><Icon name="repeat" />Make it repeating</span></Button>}
            <Button variant="ghost" onClick={resetForm}>Cancel</Button>
            <p className="text-xs text-slate-500">{mustApprove ? 'Your organisation asks for approval: an owner or accountant posts it.' : 'GST and TDS are worked out again when you save.'}</p></div>
          <div className="mt-3"><ErrorMsg msg={form.error} /></div>
        </Card>
        </div>
      )}
      <Card>
        {showForm && f.contactId && <div className="mb-2 flex flex-wrap items-center gap-2 text-sm text-slate-600">
          <span>{allDocs ? `All ${title.toLowerCase()}` : `Only ${contact?.name ?? 'this contact'}'s ${title.toLowerCase()}`}</span>
          <Button variant="ghost" onClick={() => setAllDocs(!allDocs)}>{allDocs ? `Show only ${contact?.name ?? 'this contact'}` : 'Show all'}</Button></div>}
        {full && selected.size > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-brand-50 px-3 py-2 text-sm"><b>{selected.size} selected</b>
            {batchDocs.length > 0 && <Button disabled={busy} onClick={openBatch}>{sales ? `Receive payment for ${batchDocs.length}` : `Pay ${batchDocs.length} bill(s) together`}</Button>}
            {sales && <Button variant="ghost" disabled={busy} onClick={() => remind([...selected])}><span className="inline-flex items-center gap-1.5"><Icon name="bell" />Send reminders</span></Button>}
            <Button variant="ghost" disabled={busy} onClick={() => downloadPdf([...selected])}>Download as one PDF</Button>
            <Button variant="ghost" disabled={busy} onClick={() => bulk(showArchived ? 'restore' : 'archive')}>{showArchived ? 'Restore selected' : 'Archive selected'}</Button>
            <Button variant="danger" disabled={busy} onClick={() => bulk('delete')}>Delete selected</Button>
            <Button variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button></div>
        )}
        <DataTable id={`docs-${kind}`} rows={shownDocs} columns={columns} rowKey={(d) => d.id} orgId={org.id} exportTitle={title} searchLabel={`Search ${title.toLowerCase()} by number, ${sales ? 'customer' : 'supplier'}, date or amount`}
          rowClass={(d) => (d.isArchived ? 'text-slate-400' : '')}
          toolbar={<label className="flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />Show archived</label>}
          leadingHead={full ? <input type="checkbox" aria-label="Select all" checked={shownDocs.length > 0 && shownDocs.every((d) => selected.has(d.id))} onChange={() => setSelected(shownDocs.every((d) => selected.has(d.id)) ? new Set() : new Set(shownDocs.map((d) => d.id)))} /> : undefined}
          leading={full ? (d) => <input type="checkbox" aria-label={`Select ${d.number}`} checked={selected.has(d.id)} onChange={() => toggle(d.id)} /> : undefined}
          trailing={(d) => (
            <span className="inline-flex items-center gap-1">
              {full && d.status === 'posted' && (d.docType === 'invoice' || d.docType === 'bill') && (d.outstanding ?? 0) > 0 && <Button variant="ghost" className="!px-3 !py-1.5" onClick={() => openPay(d)}>{payLabel}</Button>}
              {full && d.status === 'posted' && (d.docType === 'invoice' || d.docType === 'bill') && <Button variant="ghost" className="!px-3 !py-1.5" onClick={() => noteAgainst(d)}>{sales ? 'Credit note' : 'Debit note'}</Button>}
              <RowMenu label={`Actions for ${d.number}`} actions={[
                { label: 'Download PDF', icon: 'pdf', onClick: () => downloadPdf([d.id], d.number) },
                { label: 'Email', icon: 'mail', onClick: () => email(d), hidden: !(full && sales && d.status === 'posted') },
                { label: 'Send reminder', icon: 'bell', onClick: () => remind([d.id]), hidden: !(full && d.docType === 'invoice' && d.status === 'posted' && (d.outstanding ?? 0) > 0) },
                { label: 'Edit', icon: 'edit', onClick: () => startEdit(d), hidden: !canEdit(d) },
                { label: d.isArchived ? 'Restore' : 'Archive', icon: d.isArchived ? 'restore' : 'archive', onClick: () => archiveOne(d), hidden: !full },
                { label: 'Delete', icon: 'trash', onClick: () => doVoid(d), hidden: !(full && d.status === 'posted'), danger: true },
              ]} />
            </span>)} />
      </Card>

      {batch && batchDocs.length > 0 && (
        <div role="dialog" aria-label={sales ? 'Batch receipt' : 'Batch payment'} data-testid="batch-panel"
          className="fixed inset-x-2 bottom-2 z-40 mx-auto max-w-3xl rounded-xl border border-brand-200 bg-white p-4 shadow-2xl sm:inset-x-6">
          <div className="mb-2 flex items-start justify-between gap-3">
            <p className="text-sm font-semibold">{sales ? 'Batch receipt' : 'Batch payment'}: one bank {sales ? 'deposit' : 'payment'} for {batchDocs.length} {sales ? 'invoice' : 'bill'}(s)</p>
            <button type="button" aria-label="Close batch" onClick={() => setBatch(null)} className="rounded p-1 text-slate-500 hover:bg-slate-100">✕</button></div>
          <p className="mb-2 text-xs text-slate-500">Tick more {sales ? 'invoices' : 'bills'} in the list to add them; ✕ removes one.</p>
          <div className="max-h-48 overflow-y-auto">
            <table className="w-full text-sm"><thead><tr className="text-left"><th>Number</th><th>Contact</th><th className="text-right">Outstanding</th><th className="w-36 text-right">Amount (₹)</th><th className="w-8" /></tr></thead>
              <tbody>{batchDocs.map((d) => <tr key={d.id}><td className="py-1">{d.number}</td><td>{d.contactName}</td><td className="text-right">{fmt(d.outstanding ?? 0)}</td>
                <td className="text-right"><input aria-label={`Batch amount ${d.number}`} inputMode="decimal" className="w-32 rounded border border-slate-300 px-2 py-1 text-right" value={batch.amounts[d.id] ?? ''} onChange={(e) => setBatch({ ...batch, amounts: { ...batch.amounts, [d.id]: e.target.value } })} /></td>
                <td><button type="button" aria-label={`Remove ${d.number} from batch`} className="text-slate-400 hover:text-red-600" onClick={() => toggle(d.id)}>✕</button></td></tr>)}</tbody>
              <tfoot><tr className="border-t-2 border-slate-300 font-semibold"><td colSpan={3} className="pt-1">Total</td><td className="pt-1 text-right" data-testid="batch-total">₹{fmt(batchTotal)}</td><td /></tr></tfoot></table></div>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <Field label="Date" aria-label="Batch date" type="date" value={batch.date} onChange={(e) => setBatch({ ...batch, date: e.target.value })} />
            <Select label="Bank / cash account" aria-label="Batch account" value={batch.accountId} onChange={(e) => setBatch({ ...batch, accountId: e.target.value })}>
              <option value="">Select…</option>{bankOptions.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</Select>
            <Field label="Reference (optional)" aria-label="Batch reference" placeholder="e.g. NEFT UTR" value={batch.reference} onChange={(e) => setBatch({ ...batch, reference: e.target.value })} />
            <Button disabled={busy || !batch.accountId || batchTotal <= 0} onClick={doBatch}>{sales ? 'Record receipt' : 'Record batch payment'}</Button>
          </div>
          <p className="mt-2 text-xs text-slate-500">Posted as one bank entry, so it matches the single line on your bank statement. Undo it from Purchases, Batch payments.</p>
        </div>
      )}

      {pay && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) setPay(null); }}>
          <div role="dialog" aria-label={`${payLabel} for ${pay.doc.number}`} className="w-full max-w-lg rounded-xl bg-white p-5 shadow-2xl">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div><p className="text-lg font-semibold text-slate-900">{sales ? 'Receive payment' : 'Pay bill'} · {pay.doc.number}</p>
                <p className="text-sm text-slate-500">{pay.doc.contactName} · dated {pay.doc.issueDate}{pay.doc.dueDate ? ` · due ${pay.doc.dueDate}` : ''}</p></div>
              <button type="button" aria-label="Close" onClick={() => setPay(null)} className="rounded p-1 text-slate-500 hover:bg-slate-100">✕</button></div>
            <dl className="mb-4 grid grid-cols-3 gap-2 rounded-lg bg-slate-50 p-3 text-sm">
              <div><dt className="text-xs text-slate-500">Total</dt><dd className="font-medium">₹{fmt(pay.doc.total)}</dd></div>
              {pay.doc.tdsAmount > 0 && <div><dt className="text-xs text-slate-500">TDS</dt><dd className="font-medium">₹{fmt(pay.doc.tdsAmount)}</dd></div>}
              <div><dt className="text-xs text-slate-500">Outstanding</dt><dd className="font-semibold text-slate-900">₹{fmt(pay.doc.outstanding ?? 0)}</dd></div></dl>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Date" type="date" value={pay.date} onChange={(e) => setPay({ ...pay, date: e.target.value })} />
              {pay.doc.currency !== 'INR' && <Field label={`Amount in ${pay.doc.currency}`} value={pay.foreign} onChange={(e) => setPay({ ...pay, foreign: e.target.value })} />}
              <Field label={pay.doc.currency !== 'INR' ? 'Rupees received / paid' : 'Amount (₹)'} value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} />
              <Select label="Bank / cash account" aria-label="Payment account" value={pay.accountId} onChange={(e) => setPay({ ...pay, accountId: e.target.value })}>
                <option value="">Select…</option>{bankOptions.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</Select>
              <Field label="Reference (optional)" value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} />
            </div>
            <div className="mt-4 flex flex-wrap gap-3"><Button disabled={busy || !pay.accountId} onClick={doPay}>Record payment</Button><Button variant="ghost" onClick={() => setPay(null)}>Cancel</Button></div>
            <div className="mt-3"><ErrorMsg msg={error} /></div>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Quick edit of the chosen customer or supplier without leaving the invoice or bill. The rest of the contact (bank,
 * MSME, delivery address…) is kept as it is.
 */
function QuickContact({ org, contact, states, tds, onClose, onSaved }: { org: Org; contact: Contact; states: { code: string; name: string }[]; tds: { code: string; description: string }[]; onClose: () => void; onSaved: (msg: string) => void }) {
  const [c, setC] = useState({ name: contact.name, gstin: contact.gstin ?? '', stateCode: contact.stateCode ?? '', email: contact.email ?? '', phone: contact.phone ?? '',
    addressLine1: contact.addressLine1 ?? '', city: contact.city ?? '', pincode: contact.pincode ?? '', defaultTdsSection: contact.defaultTdsSection ?? '', rcmDefault: !!contact.rcmDefault });
  const { error, busy, run } = useAction();
  const supplier = contact.kind !== 'customer';
  const save = () => run(async () => {
    const x = contact as Contact & Record<string, unknown>;
    const keep = (k: string) => (x[k] == null || x[k] === '' ? {} : { [k]: x[k] });
    const opt = (k: string, v: string) => (v.trim() ? { [k]: v.trim() } : {});
    const body = {
      kind: contact.kind, name: c.name.trim(), country: contact.country ?? 'IN', isSez: !!contact.isSez, isIndividual: !!contact.isIndividual,
      ...keep('constitution'), ...keep('pan'), ...keep('addressLine2'), ...keep('shipLine1'), ...keep('shipLine2'), ...keep('shipCity'), ...keep('shipStateCode'), ...keep('shipPincode'),
      ...keep('bankAccountName'), ...keep('bankName'), ...keep('bankAccountNo'), ...keep('bankIfsc'), ...keep('msmeType'), ...keep('udyamNo'), ...keep('msmeAgreedDays'),
      ...keep('lowerTdsRateBp'), ...keep('lowerTdsCert'),
      defaultSalesAccountId: contact.defaultSalesAccountId ?? null, defaultPurchaseAccountId: contact.defaultPurchaseAccountId ?? null,
      ...opt('gstin', c.gstin.toUpperCase()), ...opt('stateCode', c.stateCode), ...opt('email', c.email), ...opt('phone', c.phone),
      ...opt('addressLine1', c.addressLine1), ...opt('city', c.city), ...opt('pincode', c.pincode),
      ...(supplier ? { ...opt('defaultTdsSection', c.defaultTdsSection), rcmDefault: c.rcmDefault } : {}),
    };
    await api(`/orgs/${org.id}/contacts/${contact.id}`, { method: 'PUT', body });
    onSaved(`${c.name} updated.`);
  });
  return (
    <div className="mt-3 rounded-lg border border-brand-200 bg-brand-50/30 p-3" role="group" aria-label={`Edit ${contact.name}`}>
      <p className="mb-2 text-sm font-semibold text-slate-800">Edit {contact.name}</p>
      <div className="grid gap-3 md:grid-cols-4">
        <Field label="Name" aria-label="Contact name" value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} />
        <Field label="GSTIN" aria-label="Contact GSTIN" value={c.gstin} onChange={(e) => setC({ ...c, gstin: e.target.value })} />
        <Select label="State" aria-label="Contact state" value={c.stateCode} onChange={(e) => setC({ ...c, stateCode: e.target.value })}><option value="">—</option>{states.map((s) => <option key={s.code} value={s.code}>{s.code} {s.name}</option>)}</Select>
        <Field label="Email" aria-label="Contact email" value={c.email} onChange={(e) => setC({ ...c, email: e.target.value })} />
        <Field label="Address" aria-label="Contact address" value={c.addressLine1} onChange={(e) => setC({ ...c, addressLine1: e.target.value })} />
        <Field label="City" aria-label="Contact city" value={c.city} onChange={(e) => setC({ ...c, city: e.target.value })} />
        <Field label="PIN code" aria-label="Contact PIN code" value={c.pincode} onChange={(e) => setC({ ...c, pincode: e.target.value })} />
        <Field label="Phone" aria-label="Contact phone" value={c.phone} onChange={(e) => setC({ ...c, phone: e.target.value })} />
        {supplier && <Select label="Default TDS section" aria-label="Contact TDS section" value={c.defaultTdsSection} onChange={(e) => setC({ ...c, defaultTdsSection: e.target.value })}><option value="">No TDS</option>{tds.map((t) => <option key={t.code} value={t.code}>{t.code}</option>)}</Select>}
        {supplier && <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" checked={c.rcmDefault} onChange={(e) => setC({ ...c, rcmDefault: e.target.checked })} />Reverse charge by default</label>}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3"><Button disabled={busy} onClick={save}>Save contact</Button><Button variant="ghost" onClick={onClose}>Cancel</Button></div>
      <div className="mt-2"><ErrorMsg msg={error} /></div>
    </div>
  );
}
