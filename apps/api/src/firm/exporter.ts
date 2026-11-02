// Turns report data into a plain table, then renders that table as PDF or Excel.
import { PoolClient } from 'pg';
import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import { formatPaise } from '../money';
import { accountBalances, aged, balanceSheet, gstr1, gstr3b, ledgerStatement, profitAndLoss } from '../accounting/reports';

export interface Col { header: string; type: 'text' | 'money' }
export interface Table { title: string; subtitle: string; columns: Col[]; rows: (string | number)[][]; boldRows?: number[]; }

export const REPORTS = ['trial-balance', 'pnl', 'balance-sheet', 'aged-receivables', 'aged-payables', 'ledger', 'gstr3b', 'gstr1-b2b'] as const;
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
