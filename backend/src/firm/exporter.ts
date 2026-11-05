// Turns report data into a plain table, then renders that table as PDF or Excel.
import { PoolClient } from 'pg';
import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import { formatPaise } from '../money';
import { accountBalances, aged, balanceSheet, gstr1, gstr3b, ledgerStatement, profitAndLoss } from '../accounting/reports';

export interface Col { header: string; type: 'text' | 'money' }
export interface Table { title: string; subtitle: string; columns: Col[]; rows: (string | number)[][]; boldRows?: number[];
  /** For document reports: the document behind each row (null for total rows), so the screen can archive or delete them. */
  rowIds?: (number | null)[]; }

export const REPORTS = ['trial-balance', 'pnl', 'balance-sheet', 'aged-receivables', 'aged-payables', 'ledger', 'all-ledgers', 'gstr3b', 'gstr1-b2b', 'fixed-assets', 'invoice-wise', 'bill-wise', 'purchase-register'] as const;
export type ReportName = (typeof REPORTS)[number];
export interface ReportParams { from: string; to: string; asOf: string; accountId?: number; }

const T = (s: string): Col => ({ header: s, type: 'text' });
const M = (s: string): Col => ({ header: s, type: 'money' });

export async function buildTable(c: PoolClient, name: ReportName, p: ReportParams): Promise<Table> {
  switch (name) {
    case 'trial-balance': {
      const rows = (await accountBalances(c, { to: p.asOf })).filter((a) => a.debit || a.credit);
      const dr = (a: { debit: number; credit: number }) => Math.max(a.debit - a.credit, 0), cr = (a: { debit: number; credit: number }) => Math.max(a.credit - a.debit, 0);
      const td = rows.reduce((s, a) => s + dr(a), 0), tc = rows.reduce((s, a) => s + cr(a), 0);
      return { title: 'Trial Balance', subtitle: `As at ${p.asOf}`, columns: [T('Code'), T('Account'), M('Debit'), M('Credit')],
        rows: [...rows.map((a) => [a.code, a.name, dr(a), cr(a)]), ['', 'Total', td, tc]], boldRows: [rows.length] };
    }
    case 'pnl': {
      const r = await profitAndLoss(c, p.from, p.to);
      const rows: (string | number)[][] = [['INCOME', ''], ...r.income.items.map((i) => [`${i.code} ${i.name}`, i.amount]), ['Total income', r.income.total],
        ['EXPENSES', ''], ...r.expenses.items.map((i) => [`${i.code} ${i.name}`, i.amount]), ['Total expenses', r.expenses.total], ['NET PROFIT / (LOSS)', r.netProfit]];
      return { title: 'Profit and Loss', subtitle: `${p.from} to ${p.to}`, columns: [T('Account'), M('Amount')], rows,
        boldRows: rows.map((x, i) => (/^(INCOME|EXPENSES|Total|NET)/.test(String(x[0])) ? i : -1)).filter((i) => i >= 0) };
    }
    case 'balance-sheet': {
      const b = await balanceSheet(c, p.asOf);
      const sec = (name: string, items: { code: string; name: string; amount: number }[], total: number): (string | number)[][] =>
        [[name.toUpperCase(), ''], ...items.map((i) => [`${i.code} ${i.name}`, i.amount]), [`Total ${name.toLowerCase()}`, total]];
      const rows = [...sec('Assets', b.assets.items, b.assets.total), ...sec('Liabilities', b.liabilities.items, b.liabilities.total),
        ...sec('Equity', [...b.equity.items, { code: '', name: 'Profit to date', amount: b.equity.profitToDate }], b.equity.total)];
      return { title: 'Balance Sheet', subtitle: `As at ${p.asOf}${b.balanced ? '' : ' (OUT OF BALANCE)'}`, columns: [T('Account'), M('Amount')], rows,
        boldRows: rows.map((x, i) => (/^([A-Z ]+|Total .*)$/.test(String(x[0])) ? i : -1)).filter((i) => i >= 0) };
    }
    case 'aged-receivables':
    case 'aged-payables': {
      const a = await aged(c, name === 'aged-receivables' ? 'receivables' : 'payables', p.asOf);
      const row = (x: any, label: string) => [label, x.notDue, x.days1to30, x.days31to60, x.days61to90, x.over90, x.total];
      return { title: name === 'aged-receivables' ? 'Aged Receivables' : 'Aged Payables', subtitle: `As at ${p.asOf}`,
        columns: [T('Contact'), M('Not due'), M('1-30'), M('31-60'), M('61-90'), M('90+'), M('Total')],
        rows: [...a.contacts.map((x) => row(x, x.contact)), row(a.totals, 'Total')], boldRows: [a.contacts.length] };
    }
    case 'ledger': {
      if (!p.accountId) throw new Error('accountId is required for the ledger report');
      const l = await ledgerStatement(c, p.accountId, p.from, p.to);
      if (!l) throw new Error('Account not found');
      return { title: `Ledger: ${l.account.code} ${l.account.name}`, subtitle: `${p.from} to ${p.to}`, columns: [T('Date'), T('Narration'), M('Debit'), M('Credit'), M('Balance')],
        rows: [['', 'Opening balance', 0, 0, l.openingBalance], ...l.lines.map((x) => [x.date, x.narration, x.debit, x.credit, x.balance])] };
    }
    case 'all-ledgers': {
      // Every account that has a balance or movement, one after another: header row, opening balance, lines, closing balance.
      const accs = await accountBalances(c, { to: p.to });
      const rows: (string | number)[][] = [], bold: number[] = [];
      for (const a of accs) {
        const l = await ledgerStatement(c, a.id, p.from, p.to);
        if (!l || (!l.lines.length && !l.openingBalance)) continue;
        bold.push(rows.length); rows.push(['', `${l.account.code} ${l.account.name}`, '', 0, 0, '']);
        rows.push(['', 'Opening balance', '', 0, 0, l.openingBalance]);
        for (const x of l.lines) rows.push([x.date, x.narration, x.reference ?? '', x.debit, x.credit, x.balance]);
        bold.push(rows.length); rows.push(['', 'Closing balance', '', l.lines.reduce((s, x) => s + x.debit, 0), l.lines.reduce((s, x) => s + x.credit, 0), l.closingBalance]);
      }
      return { title: 'All ledgers', subtitle: `${p.from} to ${p.to}`, columns: [T('Date'), T('Narration'), T('Reference'), M('Debit'), M('Credit'), M('Balance')], rows, boldRows: bold };
    }
    case 'fixed-assets': {
      const r = (await c.query(
        `SELECT a.code, a.name, COALESCE(a.asset_group,'') AS grp, a.purchase_date::text AS pd, a.cost, a.status, a.method, a.rate_bp,
                COALESCE((SELECT SUM(amount) FROM asset_depreciation d WHERE d.asset_id=a.id AND d.period_end <= $1::date),0) AS accum
           FROM fixed_assets a ORDER BY a.code`, [p.asOf])).rows;
      const rows = r.map((x) => [x.code, x.name, x.grp, x.pd, `${x.method === 'wdv' ? 'WDV' : 'SLM'} ${x.rate_bp / 100}%`, Number(x.cost), Number(x.accum), Number(x.cost) - Number(x.accum), x.status]);
      const tot = (i: number) => rows.reduce((s, x) => s + (x[i] as number), 0);
      return { title: 'Fixed asset register', subtitle: `As at ${p.asOf}`, columns: [T('Code'), T('Asset'), T('Group'), T('Bought'), T('Depreciation'), M('Cost'), M('Accumulated'), M('Book value'), T('Status')],
        rows: [...rows, ['', 'Total', '', '', '', tot(5), tot(6), tot(7), '']], boldRows: [rows.length] };
    }
    case 'invoice-wise':
    case 'bill-wise': {
      const sales = name === 'invoice-wise', types = sales ? ['invoice', 'credit_note'] : ['bill', 'debit_note'];
      const r = (await c.query(
        `SELECT d.id, d.number, d.doc_type, d.issue_date::text AS d, d.due_date::text AS due, ct.name, d.total, d.net_payable, d.status,
                COALESCE((SELECT SUM(amount) FROM payments x WHERE x.doc_id=d.id),0) AS paid
           FROM documents d JOIN contacts ct ON ct.id=d.contact_id
          WHERE d.doc_type = ANY($1) AND NOT d.is_archived AND d.issue_date BETWEEN $2 AND $3 ORDER BY d.issue_date, d.id`, [types, p.from, p.to])).rows;
      const rows = r.map((x) => {
        const live = x.status === 'posted', paid = Number(x.paid), pay = Number(x.net_payable);
        return [x.number, x.name, x.d, x.due ?? '', Number(x.total), live && (x.doc_type === 'invoice' || x.doc_type === 'bill') ? paid : 0, live && (x.doc_type === 'invoice' || x.doc_type === 'bill') ? pay - paid : 0, x.status];
      });
      const tot = (i: number) => rows.filter((x) => x[7] === 'posted').reduce((s, x) => s + (x[i] as number), 0);
      return { title: sales ? 'Invoice-wise report' : 'Bill-wise report', subtitle: `${p.from} to ${p.to}. Totals count posted documents only.`,
        columns: [T('Number'), T('Contact'), T('Date'), T('Due'), M('Total'), M(sales ? 'Received' : 'Paid'), M('Outstanding'), T('Status')], rows: [...rows, ['', 'Total', '', '', tot(4), tot(5), tot(6), '']], boldRows: [rows.length], rowIds: [...r.map((x) => Number(x.id)), null] };
    }
    case 'purchase-register': {
      const r = (await c.query(
        `SELECT d.id, d.number, d.supplier_ref, d.issue_date::text AS d, ct.name, ct.gstin, d.subtotal, d.cgst, d.sgst, d.igst, d.tds_amount, d.total, d.status, d.doc_type
           FROM documents d JOIN contacts ct ON ct.id=d.contact_id
          WHERE d.doc_type IN ('bill','debit_note') AND d.status='posted' AND NOT d.is_archived AND d.issue_date BETWEEN $1 AND $2 ORDER BY d.issue_date, d.id`, [p.from, p.to])).rows;
      const sign = (x: any) => (x.doc_type === 'debit_note' ? -1 : 1);
      const rows = r.map((x) => [x.number, x.supplier_ref ?? '', x.d, x.name, x.gstin ?? 'Unregistered', sign(x) * Number(x.subtotal), sign(x) * Number(x.cgst), sign(x) * Number(x.sgst), sign(x) * Number(x.igst), sign(x) * Number(x.total)]);
      const tot = (i: number) => rows.reduce((s, x) => s + (x[i] as number), 0);
      return { title: 'Purchase register', subtitle: `${p.from} to ${p.to}. Posted bills less debit notes, fetched from your documents.`,
        columns: [T('Bill'), T('Supplier bill no.'), T('Date'), T('Supplier'), T('GSTIN'), M('Taxable'), M('CGST'), M('SGST'), M('IGST'), M('Total')],
        rows: [...rows, ['', '', '', 'Total', '', tot(5), tot(6), tot(7), tot(8), tot(9)]], boldRows: [rows.length], rowIds: [...r.map((x) => Number(x.id)), null] };
    }
    case 'gstr3b': {
      const g = await gstr3b(c, p.from, p.to);
      const o = g.section31a_outwardTaxable;
      return { title: 'GSTR-3B Summary (working paper)', subtitle: `${p.from} to ${p.to}`, columns: [T('Item'), M('Taxable'), M('IGST'), M('CGST'), M('SGST')],
        rows: [['3.1(a) Outward taxable supplies', o.taxable, o.igst, o.cgst, o.sgst], ['3.1(c) Nil rated / exempt', g.section31c_nilRatedExempt.taxable, 0, 0, 0],
          ['4. ITC available', 0, g.section4_itcAvailable.igst, g.section4_itcAvailable.cgst, g.section4_itcAvailable.sgst],
          ['Net tax payable (negative = carry forward)', 0, g.netTaxPayable.igst, g.netTaxPayable.cgst, g.netTaxPayable.sgst]], boldRows: [3] };
    }
    case 'gstr1-b2b': {
      const g = await gstr1(c, p.from, p.to);
      return { title: 'GSTR-1 B2B Invoices', subtitle: `${p.from} to ${p.to}`, columns: [T('Invoice'), T('Date'), T('GSTIN'), T('POS'), M('Taxable'), M('IGST'), M('CGST'), M('SGST')],
        rows: g.b2b.map((x) => [x.number, x.date, x.gstin ?? '', x.placeOfSupply ?? '', x.taxable, x.igst, x.cgst, x.sgst]) };
    }
  }
}

export function renderPdf(t: Table, orgName: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, layout: t.columns.length > 5 ? 'landscape' : 'portrait' });
    const chunks: Buffer[] = [];
    doc.on('data', (d) => chunks.push(d)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    doc.fontSize(15).font('Helvetica-Bold').text(orgName).fontSize(12).text(t.title).font('Helvetica').fontSize(9).fillColor('#555').text(t.subtitle).fillColor('#000').moveDown();
    const width = doc.page.width - 80;
    const moneyW = 80, textCols = t.columns.filter((c) => c.type === 'text').length;
    const textW = (width - moneyW * t.columns.filter((c) => c.type === 'money').length) / Math.max(textCols, 1);
    const w = t.columns.map((c) => (c.type === 'money' ? moneyW : textW));
    const drawRow = (cells: string[], bold: boolean, header = false) => {
      if (doc.y > doc.page.height - 60) doc.addPage();
      let x = 40; const y = doc.y;
      doc.font(bold || header ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5);
      cells.forEach((s, i) => { doc.text(s, x + 2, y, { width: w[i] - 4, align: t.columns[i].type === 'money' ? 'right' : 'left', lineBreak: false, ellipsis: true }); x += w[i]; });
      doc.y = y + 14;
      doc.moveTo(40, doc.y - 2).lineTo(40 + width, doc.y - 2).strokeColor(header ? '#000' : '#ddd').lineWidth(0.5).stroke();
    };
    drawRow(t.columns.map((c) => c.header), true, true);
    t.rows.forEach((r, ri) => drawRow(r.map((v, i) => (t.columns[i].type === 'money' ? (typeof v === 'number' ? formatPaise(v) : '') : String(v))), !!t.boldRows?.includes(ri)));
    doc.fontSize(7).fillColor('#888').text(`Generated ${new Date().toISOString().slice(0, 10)}. Amounts in INR.`, 40, doc.page.height - 30, { lineBreak: false });
    doc.end();
  });
}

export async function renderXlsx(t: Table, orgName: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(t.title.slice(0, 30).replace(/[\\/?*[\]:]/g, ' '));
  ws.addRow([orgName]).font = { bold: true, size: 14 };
  ws.addRow([t.title]).font = { bold: true };
  ws.addRow([t.subtitle]);
  ws.addRow([]);
  ws.addRow(t.columns.map((c) => c.header)).font = { bold: true };
  t.rows.forEach((r, ri) => {
    // Excel stores rupees as a number for sums/formatting; the source of truth stays integer paise in the database.
    const row = ws.addRow(r.map((v, i) => (t.columns[i].type === 'money' && typeof v === 'number' ? v / 100 : v)));
    if (t.boldRows?.includes(ri)) row.font = { bold: true };
  });
  t.columns.forEach((c, i) => { const col = ws.getColumn(i + 1); col.width = c.type === 'money' ? 16 : 30; if (c.type === 'money') col.numFmt = '#,##0.00'; });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export interface InvoiceView {
  orgName: string; orgGstin: string | null; type: string; number: string; issueDate: string; dueDate: string | null; contact: string; contactGstin: string | null;
  placeOfSupply: string | null; lines: { description: string; hsnSac: string | null; qtyMilli: number; rate: number; taxable: number; gstRateBp: number }[];
  subtotal: number; cgst: number; sgst: number; igst: number; total: number; tdsAmount: number; notes: string | null;
}

export function renderInvoicePdf(v: InvoiceView): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks: Buffer[] = [];
    doc.on('data', (d) => chunks.push(d)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    const label = { invoice: 'TAX INVOICE', bill: 'PURCHASE BILL', credit_note: 'CREDIT NOTE', debit_note: 'DEBIT NOTE' }[v.type] ?? v.type.toUpperCase();
    doc.font('Helvetica-Bold').fontSize(18).text(label, { align: 'right' }).fontSize(13).text(v.orgName, 40, 40);
    doc.font('Helvetica').fontSize(9).text(v.orgGstin ? `GSTIN: ${v.orgGstin}` : 'GSTIN: not registered').moveDown();
    doc.text(`Number: ${v.number}`).text(`Date: ${v.issueDate}${v.dueDate ? `    Due: ${v.dueDate}` : ''}`).text(`Place of supply: ${v.placeOfSupply ?? '-'}`).moveDown();
    doc.font('Helvetica-Bold').text('Bill to').font('Helvetica').text(v.contact).text(v.contactGstin ? `GSTIN: ${v.contactGstin}` : '').moveDown();
    const cols = [{ h: 'Description', w: 190, a: 'left' }, { h: 'HSN/SAC', w: 55, a: 'left' }, { h: 'Qty', w: 40, a: 'right' }, { h: 'Rate', w: 70, a: 'right' }, { h: 'GST %', w: 40, a: 'right' }, { h: 'Amount', w: 80, a: 'right' }] as const;
    const row = (cells: string[], bold = false) => { let x = 40; const y = doc.y; doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5);
      cells.forEach((s, i) => { doc.text(s, x, y, { width: cols[i].w - 4, align: cols[i].a, lineBreak: false, ellipsis: true }); x += cols[i].w; }); doc.y = y + 15; };
    row(cols.map((c) => c.h), true);
    doc.moveTo(40, doc.y - 3).lineTo(515, doc.y - 3).stroke();
    v.lines.forEach((l) => row([l.description, l.hsnSac ?? '', String(l.qtyMilli / 1000), formatPaise(l.rate), String(l.gstRateBp / 100), formatPaise(l.taxable)]));
    doc.moveDown();
    const tot = (k: string, val: number, bold = false) => { doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).text(`${k}: ${formatPaise(val)}`, { align: 'right' }); };
    tot('Subtotal', v.subtotal); if (v.cgst) tot('CGST', v.cgst); if (v.sgst) tot('SGST', v.sgst); if (v.igst) tot('IGST', v.igst);
    tot('Total (INR)', v.total, true); if (v.tdsAmount) { tot('Less TDS', -v.tdsAmount); tot('Net payable', v.total - v.tdsAmount, true); }
    if (v.notes) doc.moveDown().font('Helvetica').fontSize(8).text(`Notes: ${v.notes}`, 40);
    doc.end();
  });
}
