// Renders a report table, or an invoice, as PDF or Excel in one of the chosen templates.
import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import { formatPaise } from '../money';
import type { Table } from './exporter';
import { DEFAULT_OPTIONS, ExportOptions, Look, lookOf, onColour, tint } from './styles';

const PAPER_XLSX = { A4: 9, A3: 8, LETTER: 1 } as const;

/** Drops the columns the person chose to leave out. */
export function withoutHidden(t: Table, hide: number[]): Table {
  if (!hide.length || hide.length >= t.columns.length) return t;
  const keep = t.columns.map((_, i) => i).filter((i) => !hide.includes(i));
  return { ...t, columns: keep.map((i) => t.columns[i]), rows: t.rows.map((r) => keep.map((i) => r[i])) };
}

/** Shortens text with an ellipsis so it fits one line of the given width (pdfkit would otherwise wrap it onto the next row). Measure with the font already set. */
function fit(doc: PDFKit.PDFDocument, text: string, width: number): string {
  if (doc.widthOfString(text) <= width) return text;
  let t = text;
  while (t.length > 1 && doc.widthOfString(`${t}…`) > width) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

const cellText = (t: Table, v: string | number, i: number) => (t.columns[i].type === 'money' ? (typeof v === 'number' ? formatPaise(v) : '') : String(v ?? ''));

/** Writes "text" with the bottom margin switched off, so footers never push a new page. */
function atBottom(doc: PDFKit.PDFDocument, fn: () => void) {
  const m = doc.page.margins.bottom; doc.page.margins.bottom = 0; fn(); doc.page.margins.bottom = m;
}

function footers(doc: PDFKit.PDFDocument, look: Look, o: ExportOptions, left: string) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    atBottom(doc, () => {
      const y = doc.page.height - 32, w = doc.page.width - 80;
      if (look.head !== 'minimal') doc.moveTo(40, y - 6).lineTo(40 + w, y - 6).strokeColor(tint(look.accent, 0.55)).lineWidth(0.6).stroke();
      doc.font(look.font).fontSize(7.5).fillColor('#777777').text(fit(doc, left, w - 90), 40, y, { width: w - 90, lineBreak: false });
      if (o.pageNumbers) doc.text(`Page ${i - range.start + 1} of ${range.count}`, 40 + w - 90, y, { width: 90, align: 'right', lineBreak: false });
    });
  }
}

const footerText = (o: ExportOptions) => `${o.footer ? `${o.footer}  ·  ` : ''}Generated ${new Date().toISOString().slice(0, 10)}. Amounts in INR.`;

export const renderPdf = (table: Table, orgName: string, o: ExportOptions = DEFAULT_OPTIONS) => renderPdfMulti([table], orgName, o);

/** One or several reports in a single PDF. Each starts on its own page and page numbers run through the whole file. */
export function renderPdfMulti(tables: Table[], orgName: string, o: ExportOptions = DEFAULT_OPTIONS): Promise<Buffer> {
  const single = tables.length === 1;
  // Hiding columns and renaming only make sense for one report; position numbers differ between reports.
  const prepared = tables.map((x) => (single ? withoutHidden(x, o.hide) : x));
  const look = lookOf(o);
  const landscapeOf = (t: Table) => (o.orientation === 'auto' ? t.columns.length > 5 : o.orientation === 'landscape');
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: o.paper, margin: 40, layout: landscapeOf(prepared[0]) ? 'landscape' : 'portrait', bufferPages: true,
      info: { Title: single ? (o.title ?? prepared[0].title) : `${orgName}: ${prepared.length} reports`, Author: orgName } });
    const chunks: Buffer[] = [];
    doc.on('data', (d) => chunks.push(d)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    const drawReport = (t: Table) => {
    const title = single ? (o.title ?? t.title) : t.title;
    const W = doc.page.width - 80, pageH = doc.page.height;

    // ----- heading
    const heading = () => {
      const sub = [t.subtitle, o.note].filter(Boolean);
      if (look.head === 'band') {
        doc.rect(0, 0, doc.page.width, 78).fill(look.accent);
        const ink = onColour(look.accent);
        doc.fillColor(ink).font(look.bold).fontSize(17).text(fit(doc, orgName, W), 40, 20, { width: W, lineBreak: false });
        doc.font(look.font).fontSize(11).text(fit(doc, title, W), 40, 44, { width: W, lineBreak: false });
        if (t.subtitle) doc.fontSize(8.5).text(fit(doc, t.subtitle, W), 40, 60, { width: W, lineBreak: false });
        doc.y = 92;
        if (o.note) doc.font(look.italic).fontSize(9).fillColor('#555555').text(o.note, 40, doc.y, { width: W }).moveDown(0.4);
      } else if (look.head === 'centered') {
        doc.fillColor(look.accent).font(look.bold).fontSize(19).text(orgName, 40, 40, { width: W, align: 'center' });
        doc.fillColor('#222222').font(look.italic).fontSize(13).text(title, { width: W, align: 'center' });
        doc.font(look.font).fontSize(9).fillColor('#666666'); sub.forEach((s) => doc.text(s as string, { width: W, align: 'center' }));
        const y = doc.y + 6; doc.moveTo(40, y).lineTo(40 + W, y).strokeColor(look.accent).lineWidth(1.2).stroke().moveTo(40, y + 3).lineTo(40 + W, y + 3).lineWidth(0.4).stroke();
        doc.y = y + 14;
      } else if (look.head === 'minimal') {
        doc.fillColor('#888888').font(look.font).fontSize(8.5).text(orgName.toUpperCase(), 40, 40, { width: W, characterSpacing: 1 });
        doc.fillColor('#111111').font(look.bold).fontSize(20).text(title, 40, doc.y + 4, { width: W });
        doc.fillColor('#777777').font(look.font).fontSize(9); sub.forEach((s) => doc.text(s as string, { width: W }));
        doc.y += 10;
      } else {
        doc.fillColor(look.accent === '#111111' ? '#000000' : look.accent).font(look.bold).fontSize(16).text(orgName, 40, 40, { width: W });
        doc.fillColor('#222222').fontSize(12).text(title, { width: W });
        doc.font(look.font).fontSize(9).fillColor('#555555'); sub.forEach((s) => doc.text(s as string, { width: W }));
        if (look.grid) { const y = doc.y + 4; doc.moveTo(40, y).lineTo(40 + W, y).strokeColor(look.accent).lineWidth(2).stroke(); doc.y = y + 8; } else doc.moveDown(0.6);
      }
      doc.fillColor('#000000');
    };
    heading();

    // ----- table
    const fs = o.fontSize, rowH = fs + 7;
    const moneyW = Math.min(88, Math.max(60, W / Math.max(t.columns.length, 1) - 6));
    // Text columns share the leftover width in proportion to how much text they hold, so long names are not cut while short codes stay narrow.
    const weight = t.columns.map((c, i) => (c.type === 'money' ? 0 : Math.min(40, Math.max(6, c.header.length, ...t.rows.slice(0, 200).map((r) => String(r[i] ?? '').length)))));
    const weightSum = weight.reduce((x, y) => x + y, 0) || 1;
    const textSpace = W - moneyW * t.columns.filter((c) => c.type === 'money').length;
    const w = t.columns.map((c, i) => (c.type === 'money' ? moneyW : (textSpace * weight[i]) / weightSum));
    const cells = (texts: string[], y: number, o2: { bold?: boolean; ink?: string; fill?: string }) => {
      if (o2.fill) doc.rect(40, y - 2, W, rowH).fill(o2.fill);
      let x = 40;
      texts.forEach((s, i) => {
        if (look.grid) doc.rect(x, y - 2, w[i], rowH).strokeColor('#c9ced8').lineWidth(0.4).stroke();
        doc.fillColor(o2.ink ?? '#111111').font(o2.bold ? look.bold : look.font).fontSize(fs)
          .text(fit(doc, s, w[i] - 6), x + 3, y + 1, { width: w[i] - 6, align: t.columns[i].type === 'money' ? 'right' : 'left', lineBreak: false });
        x += w[i];
      });
    };
    const headerRow = () => {
      const y = doc.y;
      const solid = look.headFill === 'solid', tinted = look.headFill === 'tint';
      cells(t.columns.map((c) => c.header), y, { bold: true, fill: solid ? look.accent : tinted ? tint(look.accent, 0.86) : undefined, ink: solid ? onColour(look.accent) : tinted ? look.accent : '#111111' });
      if (!solid && !tinted) doc.moveTo(40, y + rowH - 1).lineTo(40 + W, y + rowH - 1).strokeColor(look.accent).lineWidth(look.head === 'minimal' ? 0.6 : 1).stroke();
      doc.y = y + rowH + 2;
    };
    headerRow();
    t.rows.forEach((r, ri) => {
      if (doc.y > pageH - 64) { doc.addPage(); doc.y = 40; headerRow(); }
      const y = doc.y, bold = !!t.boldRows?.includes(ri);
      const fill = bold ? tint(look.accent, look.accent === '#111111' ? 0.92 : 0.9) : look.zebra && ri % 2 === 1 ? tint(look.accent, 0.95) : undefined;
      cells(r.map((v, i) => cellText(t, v, i)), y, { bold, fill });
      if (look.rowLines && !look.grid) doc.moveTo(40, y + rowH - 1).lineTo(40 + W, y + rowH - 1).strokeColor('#e2e4ea').lineWidth(0.4).stroke();
      doc.y = y + rowH;
    });
    if (!t.rows.length) doc.font(look.italic).fontSize(fs).fillColor('#777777').text('Nothing to show for these dates.', 40, doc.y + 8);

    };
    prepared.forEach((t, k) => { if (k > 0) doc.addPage({ size: o.paper, margin: 40, layout: landscapeOf(t) ? 'landscape' : 'portrait' }); drawReport(t); });

    footers(doc, look, o, footerText(o));
    doc.end();
  });
}

export const renderXlsx = (table: Table, orgName: string, o: ExportOptions = DEFAULT_OPTIONS) => renderXlsxMulti([table], orgName, o);

/** One or several reports as one workbook, one sheet each. */
export async function renderXlsxMulti(tables: Table[], orgName: string, o: ExportOptions = DEFAULT_OPTIONS): Promise<Buffer> {
  const single = tables.length === 1;
  const wb = new ExcelJS.Workbook();
  wb.creator = orgName; wb.title = single ? (o.title ?? tables[0].title) : `${orgName}: ${tables.length} reports`; wb.created = new Date();
  const used = new Set<string>();
  for (const table of tables) {
    const base = (single ? (o.title ?? table.title) : table.title).slice(0, 28).replace(/[\\/?*[\]:]/g, ' ').trim() || 'Report';
    let name = base, k = 2;
    while (used.has(name.toLowerCase())) name = `${base.slice(0, 26)} ${k++}`;
    used.add(name.toLowerCase());
    addSheet(wb, name, single ? withoutHidden(table, o.hide) : table, orgName, o, single);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function addSheet(wb: ExcelJS.Workbook, sheetName: string, t: Table, orgName: string, o: ExportOptions, single: boolean) {
  const look = lookOf(o);
  const title = single ? (o.title ?? t.title) : t.title;
  const ws = wb.addWorksheet(sheetName, { views: [{ showGridLines: false }] });
  const n = t.columns.length, argb = (hex: string) => `FF${hex.slice(1).toUpperCase()}`;
  const fontName = look.font === 'Times-Roman' ? 'Times New Roman' : 'Calibri';
  const accent = look.accent, solid = look.headFill === 'solid', tinted = look.headFill === 'tint';
  const side = { style: 'thin' as const, color: { argb: 'FFC9CED8' } };

  // ----- centred heading block: organisation, report, period, note
  const centred = (text: string, font: Partial<ExcelJS.Font>, height: number) => {
    const row = ws.addRow([text]);
    if (n > 1) ws.mergeCells(row.number, 1, row.number, n);
    const c = row.getCell(1); c.font = { name: fontName, ...font }; c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; row.height = height;
    return row;
  };
  centred(orgName, { bold: true, size: 16, color: { argb: argb(accent) } }, 26);
  centred(title, { bold: true, size: 13 }, 22);
  if (t.subtitle) centred(t.subtitle, { italic: true, size: 10, color: { argb: 'FF666666' } }, 18);
  if (o.note) centred(o.note, { size: 10, color: { argb: 'FF666666' } }, 18);
  ws.addRow([]);

  // ----- table header
  const head = ws.addRow(t.columns.map((c) => c.header));
  head.height = 24;
  head.eachCell((c, i) => {
    c.font = { name: fontName, bold: true, size: 11, color: { argb: solid ? argb(onColour(accent)) : tinted ? argb(accent) : 'FF111111' } };
    c.alignment = { horizontal: t.columns[i - 1].type === 'money' ? 'right' : 'left', vertical: 'middle', wrapText: true, indent: 1 };
    if (solid) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(accent) } };
    else if (tinted) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(tint(accent, 0.86)) } };
    c.border = solid || look.grid ? { top: side, bottom: side, left: side, right: side } : { bottom: { style: look.head === 'minimal' ? 'thin' : 'medium', color: { argb: argb(accent) } } };
  });
  const headerRowNo = head.number;

  // ----- body
  t.rows.forEach((r, ri) => {
    // Rupees go in as numbers so they can be summed and formatted; the database keeps integer paise.
    const row = ws.addRow(r.map((v, i) => (t.columns[i].type === 'money' ? (typeof v === 'number' ? v / 100 : null) : v)));
    const bold = !!t.boldRows?.includes(ri);
    row.eachCell({ includeEmpty: true }, (c, i) => {
      if (i > n) return;
      const money = t.columns[i - 1].type === 'money';
      c.font = { name: fontName, size: 10, bold };
      c.alignment = { horizontal: money ? 'right' : 'left', vertical: 'middle', indent: money ? 0 : 1 };
      if (money) c.numFmt = '#,##0.00;[Red]-#,##0.00';
      if (bold) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(tint(accent, accent === '#111111' ? 0.92 : 0.88)) } };
      else if (look.zebra && ri % 2 === 1) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(tint(accent, 0.95)) } };
      c.border = look.grid ? { top: side, bottom: side, left: side, right: side } : look.rowLines ? { bottom: { style: 'hair', color: { argb: 'FFB8BCC6' } } } : {};
    });
  });

  // ----- footer line
  ws.addRow([]);
  centred(`${o.footer ? `${o.footer}  ·  ` : ''}Generated ${new Date().toISOString().slice(0, 10)}. Amounts in INR.`, { italic: true, size: 8, color: { argb: 'FF888888' } }, 16);

  // ----- widths from the content, frozen header, filter, print layout
  t.columns.forEach((c, i) => {
    const longest = Math.max(c.header.length, ...t.rows.slice(0, 300).map((r) => cellText(t, r[i], i).length));
    ws.getColumn(i + 1).width = Math.min(c.type === 'money' ? 18 : 48, Math.max(c.type === 'money' ? 14 : 12, longest + 4));
  });
  ws.views = [{ state: 'frozen', ySplit: headerRowNo, showGridLines: false }];
  if (t.rows.length) ws.autoFilter = { from: { row: headerRowNo, column: 1 }, to: { row: headerRowNo, column: n } };
  const landscape = o.orientation === 'auto' ? n > 5 : o.orientation === 'landscape';
  ws.pageSetup = { paperSize: PAPER_XLSX[o.paper] as unknown as ExcelJS.PaperSize, orientation: landscape ? 'landscape' : 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: `${headerRowNo}:${headerRowNo}`,
    margins: { left: 0.5, right: 0.5, top: 0.6, bottom: 0.7, header: 0.3, footer: 0.3 }, horizontalCentered: true };
  ws.headerFooter.oddFooter = `&L&8${(o.footer ?? '').replace(/&/g, '&&')}&R&8${o.pageNumbers ? 'Page &P of &N' : ''}`;
}

export interface InvoiceView {
  orgName: string; orgGstin: string | null; type: string; number: string; issueDate: string; dueDate: string | null; contact: string; contactGstin: string | null;
  placeOfSupply: string | null; lines: { description: string; hsnSac: string | null; qtyMilli: number; rate: number; taxable: number; gstRateBp: number }[];
  subtotal: number; cgst: number; sgst: number; igst: number; total: number; tdsAmount: number; notes: string | null;
}

export const renderInvoicePdf = (v: InvoiceView, o: ExportOptions = DEFAULT_OPTIONS) => renderInvoicesPdf([v], o);

/** One or several invoices or bills in a single PDF, each starting on a new page. */
export function renderInvoicesPdf(views: InvoiceView[], o: ExportOptions = DEFAULT_OPTIONS): Promise<Buffer> {
  const look = lookOf(o);
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: o.paper, margin: 40, bufferPages: true, info: { Title: views.length === 1 ? views[0].number : `${views.length} documents`, Author: views[0].orgName } });
    const chunks: Buffer[] = [];
    doc.on('data', (d) => chunks.push(d)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    const drawInvoice = (v: InvoiceView) => {
    const W = doc.page.width - 80, pageH = doc.page.height, fs = Math.min(o.fontSize, 10.5);
    const label = (views.length === 1 ? o.title : undefined) ?? ({ invoice: 'TAX INVOICE', bill: 'PURCHASE BILL', credit_note: 'CREDIT NOTE', debit_note: 'DEBIT NOTE' }[v.type] ?? v.type.toUpperCase());
    const ink = onColour(look.accent), soft = tint(look.accent, 0.9);

    // ----- heading
    if (look.head === 'band' || (look.head === 'plain' && look.grid)) {
      doc.rect(0, 0, doc.page.width, 86).fill(look.accent);
      doc.fillColor(ink).font(look.bold).fontSize(17).text(fit(doc, v.orgName, W * 0.6), 40, 22, { width: W * 0.6, lineBreak: false });
      doc.font(look.font).fontSize(9).text(v.orgGstin ? `GSTIN: ${v.orgGstin}` : 'GSTIN: not registered', 40, 46);
      doc.font(look.bold).fontSize(18).text(label, 40, 28, { width: W, align: 'right', lineBreak: false });
      doc.font(look.font).fontSize(10).text(`No. ${v.number}`, 40, 52, { width: W, align: 'right', lineBreak: false });
      doc.y = 106;
    } else if (look.head === 'centered') {
      doc.fillColor(look.accent).font(look.bold).fontSize(20).text(v.orgName, 40, 40, { width: W, align: 'center' });
      doc.fillColor('#555555').font(look.font).fontSize(9.5).text(v.orgGstin ? `GSTIN: ${v.orgGstin}` : 'GSTIN: not registered', { width: W, align: 'center' });
      doc.moveDown(0.5);
      doc.fillColor('#222222').font(look.bold).fontSize(14).text(label, { width: W, align: 'center' }).moveDown(0.2);
      const y = doc.y + 2; doc.moveTo(40, y).lineTo(40 + W, y).strokeColor(look.accent).lineWidth(1.2).stroke().moveTo(40, y + 3).lineTo(40 + W, y + 3).lineWidth(0.4).stroke();
      doc.y = y + 16;
    } else if (look.head === 'minimal') {
      doc.fillColor('#111111').font(look.bold).fontSize(22).text(label.charAt(0) + label.slice(1).toLowerCase(), 40, 40, { width: W });
      doc.fillColor('#777777').font(look.font).fontSize(9).text(`${v.orgName}${v.orgGstin ? `  ·  GSTIN ${v.orgGstin}` : ''}`, 40, doc.y + 2, { width: W });
      doc.y += 14;
    } else {
      doc.fillColor('#000000').font(look.bold).fontSize(18).text(label, 40, 40, { width: W, align: 'right' });
      doc.font(look.bold).fontSize(13).text(v.orgName, 40, 40, { width: W * 0.6 });
      doc.font(look.font).fontSize(9).text(v.orgGstin ? `GSTIN: ${v.orgGstin}` : 'GSTIN: not registered');
      doc.moveDown();
    }

    // ----- details
    const top = doc.y;
    doc.fillColor('#111111').font(look.font).fontSize(fs);
    const meta: [string, string][] = [['Number', v.number], ['Date', v.issueDate], ...(v.dueDate ? [['Due', v.dueDate] as [string, string]] : []), ['Place of supply', v.placeOfSupply ?? '-']];
    const billBox = look.grid || look.head === 'band';
    if (billBox) doc.roundedRect(40, top, W / 2 - 10, 62, 4).fillAndStroke(soft, tint(look.accent, 0.6)).fillColor('#111111');
    doc.font(look.bold).fontSize(fs - 1).fillColor(look.accent).text(v.type === 'bill' || v.type === 'debit_note' ? 'SUPPLIER' : 'BILL TO', 50, top + 8, { width: W / 2 - 30 });
    doc.font(look.bold).fontSize(fs + 1.5).fillColor('#111111').text(v.contact, 50, doc.y + 1, { width: W / 2 - 30 });
    doc.font(look.font).fontSize(fs).fillColor('#444444').text(v.contactGstin ? `GSTIN: ${v.contactGstin}` : 'Unregistered', 50, doc.y, { width: W / 2 - 30 });
    let my = top + 8;
    meta.forEach(([k, val]) => { doc.font(look.font).fontSize(fs).fillColor('#666666').text(k, 40 + W / 2 + 20, my, { width: 90, lineBreak: false }); doc.font(look.bold).fillColor('#111111').text(fit(doc, val, W / 2 - 112), 40 + W / 2 + 112, my, { width: W / 2 - 112, lineBreak: false }); my += fs + 5; });
    doc.y = Math.max(doc.y, my, top + 62) + 16;

    // ----- lines table
    const cols = [{ h: 'Description', w: W - 285, a: 'left' }, { h: 'HSN/SAC', w: 60, a: 'left' }, { h: 'Qty', w: 40, a: 'right' }, { h: 'Rate', w: 70, a: 'right' }, { h: 'GST %', w: 40, a: 'right' }, { h: 'Amount', w: 75, a: 'right' }] as const;
    const rowH = fs + 8;
    const row = (cells: string[], y: number, bold: boolean, fill?: string, colour = '#111111') => {
      if (fill) doc.rect(40, y - 3, W, rowH).fill(fill);
      let x = 40; doc.fillColor(colour).font(bold ? look.bold : look.font).fontSize(fs);
      cells.forEach((s, i) => { if (look.grid) doc.rect(x, y - 3, cols[i].w, rowH).strokeColor('#c9ced8').lineWidth(0.4).stroke(); doc.fillColor(colour).text(fit(doc, s, cols[i].w - 6), x + 3, y + 1, { width: cols[i].w - 6, align: cols[i].a, lineBreak: false }); x += cols[i].w; });
    };
    const header = () => {
      const y = doc.y, solid = look.headFill === 'solid', tinted = look.headFill === 'tint';
      row(cols.map((c) => c.h), y, true, solid ? look.accent : tinted ? tint(look.accent, 0.86) : undefined, solid ? ink : tinted ? look.accent : '#111111');
      if (!solid && !tinted) doc.moveTo(40, y + rowH - 3).lineTo(40 + W, y + rowH - 3).strokeColor(look.accent).lineWidth(look.head === 'minimal' ? 0.6 : 1).stroke();
      doc.y = y + rowH;
    };
    header();
    v.lines.forEach((l, i) => {
      if (doc.y > pageH - 150) { doc.addPage(); doc.y = 40; header(); }
      const y = doc.y;
      row([l.description, l.hsnSac ?? '', String(l.qtyMilli / 1000), formatPaise(l.rate), String(l.gstRateBp / 100), formatPaise(l.taxable)], y, false, look.zebra && i % 2 === 1 ? tint(look.accent, 0.95) : undefined);
      if (look.rowLines && !look.grid) doc.moveTo(40, y + rowH - 3).lineTo(40 + W, y + rowH - 3).strokeColor('#e2e4ea').lineWidth(0.4).stroke();
      doc.y = y + rowH;
    });

    // ----- totals, right aligned
    if (doc.y > pageH - 150) { doc.addPage(); doc.y = 40; }
    doc.y += 10;
    const bx = 40 + W - 230;
    const tot = (k: string, val: number, strong = false) => {
      const y = doc.y;
      if (strong) doc.rect(bx, y - 3, 230, fs + 9).fill(look.headFill === 'none' && look.head !== 'band' ? '#eeeeee' : look.accent);
      const colour = strong ? (look.headFill === 'none' && look.head !== 'band' ? '#111111' : ink) : '#111111';
      doc.fillColor(colour).font(strong ? look.bold : look.font).fontSize(strong ? fs + 1 : fs).text(k, bx + 8, y + 1, { width: 110, lineBreak: false }).text(formatPaise(val), bx + 110, y + 1, { width: 112, align: 'right', lineBreak: false });
      doc.y = y + fs + 9;
    };
    tot('Subtotal', v.subtotal); if (v.cgst) tot('CGST', v.cgst); if (v.sgst) tot('SGST', v.sgst); if (v.igst) tot('IGST', v.igst);
    tot('Total (INR)', v.total, true);
    if (v.tdsAmount) { tot('Less TDS', -v.tdsAmount); tot('Net payable', v.total - v.tdsAmount, true); }
    if (v.notes) doc.moveDown().fillColor('#444444').font(look.italic).fontSize(fs - 0.5).text(`Notes: ${v.notes}`, 40, doc.y + 6, { width: W });
    if (o.note) doc.moveDown(0.6).fillColor('#444444').font(look.font).fontSize(fs - 0.5).text(o.note, 40, doc.y, { width: W });

    };
    views.forEach((v, k) => { if (k > 0) doc.addPage(); drawInvoice(v); });

    const v0 = views[0];
    footers(doc, look, o, `${o.footer ? `${o.footer}  ·  ` : ''}${v0.orgName}${v0.orgGstin ? `  ·  GSTIN ${v0.orgGstin}` : ''}`);
    doc.end();
  });
}
