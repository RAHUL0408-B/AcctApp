// Compliance checks a CA does by hand today, worked out from the books.
//
// 1. MSME payments, section 43B(h) of the Income Tax Act (from FY 2023-24). A bill from a micro or small enterprise
//    must be paid within 15 days, or within the agreed period if there is a written agreement (at most 45 days).
//    Whatever is still unpaid after that limit is not allowed as an expense for the year; it is allowed in the year it
//    is actually paid. This is reported in clause 22 of the tax audit report (Form 3CD).
// 2. The 180-day rule for input tax credit (second proviso to section 16(2) of the CGST Act, Rule 37). If a supplier
//    is not paid within 180 days of the invoice date, the credit taken on the unpaid part must be reversed (with
//    interest) and can be taken again once paid.
// 3. GSTR-2B matching. The GST portal shows, per month, the invoices suppliers have reported. Credit can only be
//    claimed for invoices that appear there, so every bill must be matched against it.
//
// These are working papers. They do not replace the CA's judgement (for example on the date of acceptance of goods).
import { PoolClient } from 'pg';
import type { Table } from '../firm/exporter';

export const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
/** The financial year (April to March) that a date falls in. */
export const fyOfDate = (iso: string) => { const y = Number(iso.slice(0, 4)), m = Number(iso.slice(5, 7)); const s = m >= 4 ? y : y - 1; return { start: `${s}-04-01`, end: `${s + 1}-03-31`, label: `${s}-${String((s + 1) % 100).padStart(2, '0')}` }; };

/** Settled so far = payments + debit notes against the bill; the TDS deducted counts as paid (it is paid to the government). */
const BILL_SQL = `
  SELECT d.id, d.number, d.supplier_ref, d.issue_date::text AS date, d.subtotal, d.total, d.net_payable, d.tds_amount,
         d.cgst + d.sgst + d.igst AS gst, c.id AS contact_id, c.name AS supplier, c.gstin, c.msme_type, c.msme_agreed_days, c.udyam_no,
         COALESCE(n.noted, 0) AS noted
    FROM documents d JOIN contacts c ON c.id = d.contact_id
    LEFT JOIN (SELECT original_doc_id, SUM(total) noted FROM documents WHERE status='posted' AND original_doc_id IS NOT NULL GROUP BY original_doc_id) n ON n.original_doc_id = d.id
   WHERE d.doc_type='bill' AND d.status='posted' AND d.replaced_by IS NULL`;

async function paymentsFor(c: PoolClient, ids: number[], asOf: string) {
  const rows = ids.length ? (await c.query('SELECT doc_id, pay_date::text AS date, amount FROM payments WHERE doc_id = ANY($1) AND pay_date <= $2 ORDER BY pay_date, id', [ids, asOf])).rows : [];
  const by = new Map<number, { date: string; amount: number }[]>();
  for (const r of rows) { const k = Number(r.doc_id); if (!by.has(k)) by.set(k, []); by.get(k)!.push({ date: r.date, amount: Number(r.amount) }); }
  return by;
}

// ------------------------------------------------------------------ 43B(h)
export interface MsmeRow {
  id: number; number: string; supplierRef: string | null; supplier: string; contactId: number; msmeType: string; udyamNo: string | null;
  date: string; limitDays: number; payBy: string; payable: number; paidOnTime: number; paidLate: number; lastPaid: string | null; unpaid: number;
  daysLeft: number | null; status: 'paid_on_time' | 'paid_late' | 'overdue' | 'due'; expense: number; disallowed: number;
}
export interface MsmeReport {
  fy: { start: string; end: string; label: string }; asOf: string; final: boolean;
  rows: MsmeRow[];
  totals: { bills: number; payable: number; paidOnTime: number; overdue: number; dueSoon: number; disallowed: number };
  suppliersWithoutStatus: { id: number; name: string }[];
}

/** The time limit for paying a micro or small supplier: 15 days, or the agreed days but never more than 45. */
export const msmeLimitDays = (agreedDays: number | null) => (agreedDays ? Math.min(agreedDays, 45) : 15);

/**
 * One bill under 43B(h). Allowed for the year: what was paid by the due date (even if that is after 31 March), plus
 * what was paid late but still within the same year. The rest of the expense is not allowed for this year.
 * Only the expense part counts: the GST on the bill is input credit, not an expense.
 */
export function msmeBill(b: { date: string; subtotal: number; total: number; payable: number; agreedDays: number | null }, payments: { date: string; amount: number }[], fyEnd: string, asOf: string) {
  const limitDays = msmeLimitDays(b.agreedDays);
  const payBy = addDays(b.date, limitDays);
  let paidOnTime = 0, paidLate = 0, paidLateInYear = 0, lastPaid: string | null = null;
  for (const p of payments) {
    if (p.date <= payBy) paidOnTime += p.amount; else { paidLate += p.amount; if (p.date <= fyEnd) paidLateInYear += p.amount; }
    lastPaid = p.date;
  }
  const unpaid = Math.max(0, b.payable - paidOnTime - paidLate);
  const ratio = b.total ? b.subtotal / b.total : 0;
  // Nothing is lost while the due date has not passed.
  const notAllowed = asOf > payBy ? Math.max(0, b.payable - paidOnTime - paidLateInYear) : 0;
  const status: MsmeRow['status'] = unpaid === 0 ? (paidLate > 0 ? 'paid_late' : 'paid_on_time') : asOf > payBy ? 'overdue' : 'due';
  return { limitDays, payBy, paidOnTime, paidLate, lastPaid, unpaid, status, daysLeft: unpaid > 0 ? daysBetween(asOf, payBy) : null,
    expense: b.subtotal, disallowed: Math.round(notAllowed * ratio) };
}

export async function msmeReport(c: PoolClient, fyStart: string, asOf: string): Promise<MsmeReport> {
  const fy = fyOfDate(fyStart);
  const bills = (await c.query(`${BILL_SQL} AND c.msme_type IN ('micro','small') AND d.issue_date BETWEEN $1 AND $2 ORDER BY d.issue_date, d.id`, [fy.start, fy.end])).rows;
  const pays = await paymentsFor(c, bills.map((b) => Number(b.id)), asOf);
  const rows: MsmeRow[] = bills.map((b) => {
    const payable = Number(b.net_payable) - Number(b.noted);
    const r = msmeBill({ date: b.date, subtotal: Number(b.subtotal), total: Number(b.total), payable, agreedDays: b.msme_agreed_days ? Number(b.msme_agreed_days) : null }, pays.get(Number(b.id)) ?? [], fy.end, asOf);
    return { id: Number(b.id), number: b.number, supplierRef: b.supplier_ref, supplier: b.supplier, contactId: Number(b.contact_id), msmeType: b.msme_type, udyamNo: b.udyam_no, date: b.date, payable, ...r };
  });
  const sum = (f: (r: MsmeRow) => number) => rows.reduce((s, r) => s + f(r), 0);
  const missing = (await c.query("SELECT id, name FROM contacts WHERE kind IN ('supplier','both') AND msme_type IS NULL AND NOT is_archived ORDER BY name")).rows.map((r) => ({ id: Number(r.id), name: r.name }));
  return {
    fy, asOf, final: asOf > addDays(fy.end, 45), rows,
    totals: { bills: rows.length, payable: sum((r) => r.payable), paidOnTime: sum((r) => r.paidOnTime),
      overdue: sum((r) => (r.status === 'overdue' ? r.unpaid : 0)), dueSoon: sum((r) => (r.status === 'due' && (r.daysLeft ?? 99) <= 7 ? r.unpaid : 0)), disallowed: sum((r) => r.disallowed) },
    suppliersWithoutStatus: missing,
  };
}

// ------------------------------------------------------------------ 180-day rule
export interface ItcRow { id: number; number: string; supplierRef: string | null; supplier: string; gstin: string | null; date: string; day180: string; daysPast: number; total: number; unpaid: number; gst: number; reverse: number; status: 'reverse' | 'soon' }

/** Credit to reverse on an unpaid bill: the bill's GST in proportion to what is still unpaid. */
export const itcToReverse = (gst: number, total: number, unpaid: number) => (total > 0 ? Math.round((gst * Math.min(unpaid, total)) / total) : 0);

export async function itc180Report(c: PoolClient, asOf: string, soonDays = 30) {
  const bills = (await c.query(`${BILL_SQL} AND (d.cgst + d.sgst + d.igst) > 0 AND d.issue_date <= $1 ORDER BY d.issue_date, d.id`, [addDays(asOf, soonDays - 180)])).rows;
  const pays = await paymentsFor(c, bills.map((b) => Number(b.id)), asOf);
  const rows: ItcRow[] = [];
  for (const b of bills) {
    const paid = (pays.get(Number(b.id)) ?? []).reduce((s, p) => s + p.amount, 0);
    const unpaid = Number(b.net_payable) - Number(b.noted) - paid;
    if (unpaid <= 0) continue;
    const day180 = addDays(b.date, 180);
    const past = daysBetween(day180, asOf);
    rows.push({ id: Number(b.id), number: b.number, supplierRef: b.supplier_ref, supplier: b.supplier, gstin: b.gstin, date: b.date, day180, daysPast: past,
      total: Number(b.total), unpaid, gst: Number(b.gst), reverse: itcToReverse(Number(b.gst), Number(b.total), unpaid), status: past >= 0 ? 'reverse' : 'soon' });
  }
  return { asOf, rows, totals: { reverseNow: rows.filter((r) => r.status === 'reverse').reduce((s, r) => s + r.reverse, 0), soon: rows.filter((r) => r.status === 'soon').reduce((s, r) => s + r.reverse, 0) } };
}

// ------------------------------------------------------------------ GSTR-2B
export interface TwoBLine { gstin: string; supplierName: string | null; invoiceNo: string; date: string | null; taxable: number; igst: number; cgst: number; sgst: number; cess: number; itcAvailable: boolean; reverseCharge: boolean }

/** Invoice numbers are written differently in different places ("INV/0042" vs "inv-42"): compare letters and numbers only. */
// Leading zeros are dropped from each group of digits first, then the separators: so 2026/0001 and 2026-1 match.
export const invoiceKey = (s: string) => s.toUpperCase().replace(/\d+/g, (m) => m.replace(/^0+(?=\d)/, '')).replace(/[^A-Z0-9]/g, '');
const paise = (v: unknown) => { const n = Number(String(v ?? '0').replace(/,/g, '')); return Number.isFinite(n) ? Math.round(n * 100) : 0; };
/** 05-10-2026, 05/10/2026 or 2026-10-05 to 2026-10-05. */
const isoDate = (v: unknown) => { const s = String(v ?? '').trim(); let m = /^(\d{2})[-/.](\d{2})[-/.](\d{4})$/.exec(s); if (m) return `${m[3]}-${m[2]}-${m[1]}`; m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; };
const GSTIN = /^[0-9]{2}[A-Z0-9]{13}$/;

/** Read GSTR-2B as downloaded from the GST portal (JSON), or a CSV with the usual column names. Returns the period too when the file says it. */
export function parseGstr2b(text: string): { period: string | null; lines: TwoBLine[]; skipped: number } {
  const t = text.trim();
  if (t.startsWith('{')) {
    const j = JSON.parse(t);
    const root = j.data ?? j;
    const rp = String(root.rtnprd ?? root.ret_period ?? '');
    const period = /^\d{6}$/.test(rp) ? `${rp.slice(2)}-${rp.slice(0, 2)}` : null;
    const b2b = root.docdata?.b2b ?? root.b2b ?? [];
    const lines: TwoBLine[] = [];
    let skipped = 0;
    for (const sup of b2b) {
      for (const inv of sup.inv ?? []) {
        if (!sup.ctin || !inv.inum) { skipped++; continue; }
        const items = inv.items ?? inv.itms ?? [];
        const tot = (k: string) => items.reduce((s: number, i: any) => s + paise(i[k] ?? i.itm_det?.[k]), 0);
        lines.push({ gstin: String(sup.ctin).toUpperCase(), supplierName: sup.trdnm ?? null, invoiceNo: String(inv.inum), date: isoDate(inv.dt ?? inv.idt),
          taxable: tot('txval'), igst: tot('igst') || tot('iamt'), cgst: tot('cgst') || tot('camt'), sgst: tot('sgst') || tot('samt'), cess: tot('cess') || tot('csamt'),
          itcAvailable: String(inv.itcavl ?? 'Y').toUpperCase() !== 'N', reverseCharge: String(inv.rev ?? 'N').toUpperCase() === 'Y' });
      }
    }
    return { period, lines, skipped };
  }
  // CSV, for example saved from the portal's Excel download (B2B sheet).
  const rows = t.split(/\r?\n/).filter((l) => l.trim()).map(splitCsv);
  const head = rows.findIndex((r) => r.some((c) => /gstin/i.test(c)) && r.some((c) => /invoice\s*(no|number)/i.test(c)));
  if (head < 0) throw new Error('Could not find the header row: the file needs columns for the supplier GSTIN and the invoice number');
  const h = rows[head].map((c) => c.toLowerCase());
  const col = (...names: RegExp[]) => h.findIndex((c) => names.some((n) => n.test(c)));
  const ix = { gstin: col(/gstin/), name: col(/trade|legal|supplier name|name/), no: col(/invoice\s*(no|number)/), date: col(/invoice\s*date|^date/), taxable: col(/taxable/),
    igst: col(/integrated|igst/), cgst: col(/central|cgst/), sgst: col(/state|sgst|ut tax/), cess: col(/cess/), itc: col(/itc\s*avail/), rev: col(/reverse/) };
  const lines: TwoBLine[] = [];
  let skipped = 0;
  for (const r of rows.slice(head + 1)) {
    const g = (r[ix.gstin] ?? '').trim().toUpperCase(), no = (r[ix.no] ?? '').trim();
    if (!GSTIN.test(g) || !no) { skipped++; continue; }
    const v = (i: number) => (i >= 0 ? r[i] : '0');
    lines.push({ gstin: g, supplierName: ix.name >= 0 ? r[ix.name] || null : null, invoiceNo: no, date: ix.date >= 0 ? isoDate(r[ix.date]) : null,
      taxable: paise(v(ix.taxable)), igst: paise(v(ix.igst)), cgst: paise(v(ix.cgst)), sgst: paise(v(ix.sgst)), cess: paise(v(ix.cess)),
      itcAvailable: ix.itc >= 0 ? !/^n/i.test(r[ix.itc] ?? '') : true, reverseCharge: ix.rev >= 0 ? /^y/i.test(r[ix.rev] ?? '') : false });
  }
  return { period: null, lines, skipped };
}

function splitCsv(line: string): string[] {
  const out: string[] = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export type MatchStatus = 'matched' | 'mismatch' | 'only_2b' | 'only_books';
export interface MatchRow { status: MatchStatus; gstin: string; supplier: string; invoiceNo: string; date: string | null; billId: number | null; billNumber: string | null;
  books: { taxable: number; tax: number } | null; portal: { taxable: number; tax: number; itcAvailable: boolean } | null; difference: number; note: string }

/** Up to Rs 1 of difference is treated as rounding. */
export const TOLERANCE = 100;

/** Match one GSTR-2B upload against the bills. Bills dated in that month that are in no upload at all are "only in books". */
export async function reconcile2b(c: PoolClient, importId: number) {
  const imp = (await c.query('SELECT id, period, file_name, created_at FROM gstr2b_imports WHERE id=$1', [importId])).rows[0];
  if (!imp) return null;
  const portal = (await c.query('SELECT *, invoice_date::text AS invoice_day FROM gstr2b_lines WHERE import_id=$1 ORDER BY id', [importId])).rows;
  const bills = (await c.query(`${BILL_SQL} AND c.gstin IS NOT NULL ORDER BY d.issue_date, d.id`)).rows;
  const byKey = new Map<string, any>();
  for (const b of bills) if (b.supplier_ref) byKey.set(`${String(b.gstin).toUpperCase()}|${invoiceKey(b.supplier_ref)}`, b);
  const everywhere = new Set((await c.query('SELECT gstin, invoice_key FROM gstr2b_lines')).rows.map((r) => `${r.gstin}|${r.invoice_key}`));
  const rows: MatchRow[] = [];
  const seen = new Set<number>();
  for (const p of portal) {
    const key = `${p.gstin}|${p.invoice_key}`;
    const b = byKey.get(key);
    const pTax = Number(p.igst) + Number(p.cgst) + Number(p.sgst) + Number(p.cess);
    const pv = { taxable: Number(p.taxable), tax: pTax, itcAvailable: p.itc_available };
    const date: string | null = p.invoice_day ?? null; // read as text: a JS Date would move it a day back in India's time zone
    if (!b) { rows.push({ status: 'only_2b', gstin: p.gstin, supplier: p.supplier_name ?? p.gstin, invoiceNo: p.invoice_no, date, billId: null, billNumber: null, books: null, portal: pv, difference: pTax,
      note: 'The supplier reported this, but there is no bill for it. Enter the bill if it is yours, or ask the supplier to correct their return.' }); continue; }
    seen.add(Number(b.id));
    const bv = { taxable: Number(b.subtotal), tax: Number(b.gst) };
    const diff = bv.tax - pTax;
    const ok = Math.abs(diff) <= TOLERANCE && Math.abs(bv.taxable - pv.taxable) <= TOLERANCE;
    rows.push({ status: ok ? 'matched' : 'mismatch', gstin: p.gstin, supplier: b.supplier, invoiceNo: p.invoice_no, date: b.date, billId: Number(b.id), billNumber: b.number, books: bv, portal: pv, difference: diff,
      note: ok ? (pv.itcAvailable ? '' : 'Matched, but the portal says the credit is not available.') : diff > 0 ? 'The supplier reported less tax than your bill: only the lower amount can be claimed.' : 'The supplier reported more tax than your bill: check the bill.' });
  }
  const [y, m] = String(imp.period).split('-').map(Number);
  const start = `${imp.period}-01`, end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  for (const b of bills) {
    if (seen.has(Number(b.id)) || b.date < start || b.date > end || Number(b.gst) === 0) continue;
    if (b.supplier_ref && everywhere.has(`${String(b.gstin).toUpperCase()}|${invoiceKey(b.supplier_ref)}`)) continue; // matched in another month's upload
    rows.push({ status: 'only_books', gstin: String(b.gstin).toUpperCase(), supplier: b.supplier, invoiceNo: b.supplier_ref ?? '(no supplier bill number)', date: b.date, billId: Number(b.id), billNumber: b.number,
      books: { taxable: Number(b.subtotal), tax: Number(b.gst) }, portal: null, difference: Number(b.gst),
      note: b.supplier_ref ? 'Not in GSTR-2B: the supplier has not reported it yet. The credit is at risk until they do.' : 'Enter the supplier bill number on this bill so it can be matched.' });
  }
  const sum = (s: MatchStatus, f: (r: MatchRow) => number) => rows.filter((r) => r.status === s).reduce((a, r) => a + f(r), 0);
  const count = (s: MatchStatus) => rows.filter((r) => r.status === s).length;
  const chase = new Map<string, { supplier: string; gstin: string; invoices: string[]; tax: number }>();
  for (const r of rows.filter((x) => x.status === 'only_books' || (x.status === 'mismatch' && x.difference > 0))) {
    const k = r.gstin; if (!chase.has(k)) chase.set(k, { supplier: r.supplier, gstin: r.gstin, invoices: [], tax: 0 });
    const e = chase.get(k)!; e.invoices.push(r.invoiceNo); e.tax += r.difference;
  }
  return {
    import: { id: Number(imp.id), period: imp.period, fileName: imp.file_name, uploadedAt: new Date(imp.created_at).toISOString() },
    counts: { matched: count('matched'), mismatch: count('mismatch'), only_2b: count('only_2b'), only_books: count('only_books') },
    tax: { portal: rows.filter((r) => r.portal?.itcAvailable).reduce((a, r) => a + (r.portal?.tax ?? 0), 0), matched: sum('matched', (r) => r.books!.tax),
      atRisk: sum('only_books', (r) => r.difference) + rows.filter((r) => r.status === 'mismatch' && r.difference > 0).reduce((a, r) => a + r.difference, 0) },
    rows, chase: [...chase.values()].sort((a, b) => b.tax - a.tax),
  };
}

// ------------------------------------------------------------------ tables for PDF and Excel export
const T = (header: string) => ({ header, type: 'text' as const });
const M = (header: string) => ({ header, type: 'money' as const });
const STATUS: Record<string, string> = { paid_on_time: 'Paid on time', paid_late: 'Paid late', overdue: 'Overdue', due: 'Not yet due' };

export async function msmeTable(c: PoolClient, from: string, asOf: string): Promise<Table> {
  const r = await msmeReport(c, from, asOf);
  const rows: (string | number)[][] = r.rows.map((x) => [x.number, x.supplierRef ?? '', x.supplier, x.msmeType, x.date, x.payBy, x.payable, x.paidOnTime, x.paidLate, x.unpaid, STATUS[x.status], x.disallowed]);
  rows.push(['Total', '', '', '', '', '', r.totals.payable, r.totals.paidOnTime, r.rows.reduce((s, x) => s + x.paidLate, 0), r.rows.reduce((s, x) => s + x.unpaid, 0), '', r.totals.disallowed]);
  return { title: 'MSME payments: section 43B(h)', subtitle: `FY ${r.fy.label}, as at ${asOf}. ${r.final ? 'Final for the year.' : 'Amounts not allowed assume nothing more is paid in time.'} For Form 3CD clause 22; check with your CA.`,
    columns: [T('Bill'), T('Supplier bill no.'), T('Supplier'), T('MSME'), T('Bill date'), T('Pay by'), M('Payable'), M('Paid on time'), M('Paid late'), M('Unpaid'), T('Status'), M('Expense not allowed')],
    rows, boldRows: [rows.length - 1], rowIds: [...r.rows.map((x) => x.id), null] };
}

export async function itcTable(c: PoolClient, asOf: string): Promise<Table> {
  const r = await itc180Report(c, asOf);
  const rows: (string | number)[][] = r.rows.map((x) => [x.number, x.supplierRef ?? '', x.supplier, x.date, x.day180, x.status === 'reverse' ? `${x.daysPast} days past` : `in ${-x.daysPast} days`, x.unpaid, x.gst, x.reverse]);
  rows.push(['Reverse now', '', '', '', '', '', '', '', r.totals.reverseNow]);
  return { title: 'Input tax credit: 180-day rule', subtitle: `As at ${asOf}. Unpaid bills older than 180 days, and those reaching 180 days within 30 days. Interest under section 50 is not included.`,
    columns: [T('Bill'), T('Supplier bill no.'), T('Supplier'), T('Bill date'), T('Day 180'), T('When'), M('Unpaid'), M('GST on bill'), M('Credit to reverse')],
    rows, boldRows: [rows.length - 1], rowIds: [...r.rows.map((x) => x.id), null] };
}
