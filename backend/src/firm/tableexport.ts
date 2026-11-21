// Any table shown on screen (a list, a statement, a report) as Excel, PDF, CSV or XML, in the organisation's report template.
import { z } from 'zod';
import type { Table } from './exporter';

export const FORMATS = ['xlsx', 'pdf', 'csv', 'xml'] as const;
export type Format = (typeof FORMATS)[number];

export const MIME: Record<Format, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
  csv: 'text/csv; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
};

/** A table sent from the screen. Money is in paise (integers), like everywhere else. */
export const tableSchema = z.object({
  title: z.string().trim().min(1).max(200),
  subtitle: z.string().max(400).default(''),
  columns: z.array(z.object({ header: z.string().max(120), type: z.enum(['text', 'money']).default('text') })).min(1).max(60),
  rows: z.array(z.array(z.union([z.string().max(2000), z.number().finite(), z.null()]))).max(50_000),
  boldRows: z.array(z.number().int().min(0)).max(50_000).optional(),
  format: z.enum(FORMATS),
});

/** Every row as long as the header, with empty cells for missing values. */
export function tidy(t: z.infer<typeof tableSchema>): Table {
  const n = t.columns.length;
  return {
    title: t.title, subtitle: t.subtitle, boldRows: t.boldRows,
    columns: t.columns.map((c) => ({ header: c.header, type: c.type })),
    rows: t.rows.map((r) => Array.from({ length: n }, (_, i) => {
      const v = r[i];
      if (t.columns[i].type === 'money') return typeof v === 'number' ? Math.round(v) : '';
      return v == null ? '' : v;
    })),
  };
}

const rupees = (v: string | number) => (typeof v === 'number' ? (v / 100).toFixed(2) : '');
const plain = (t: Table, v: string | number, i: number) => (t.columns[i].type === 'money' ? rupees(v) : String(v ?? ''));

/** CSV with a byte-order mark so Excel opens Indian text (₹, names) correctly. Money as plain rupees with two decimals. */
export function renderCsv(t: Table): Buffer {
  const cell = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [t.columns.map((c) => cell(c.header)).join(','), ...t.rows.map((r) => r.map((v, i) => cell(plain(t, v, i))).join(','))];
  return Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8');
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
  // Characters XML 1.0 does not allow at all.
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
/** A column heading as an XML element name: "Due date" -> Due_date, "1-30" -> _1-30. */
export function tagOf(header: string, i: number): string {
  let s = header.normalize('NFKD').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '');
  if (!s) s = `Column${i + 1}`;
  if (!/^[A-Za-z_]/.test(s) || /^xml/i.test(s)) s = `_${s}`;
  return s;
}

/** XML: one <Row> per line, one element per column, amounts in rupees. */
export function renderXml(t: Table, orgName: string): Buffer {
  const tags = t.columns.map((c, i) => tagOf(c.header, i));
  const seen = new Map<string, number>();
  const unique = tags.map((x) => { const k = seen.get(x) ?? 0; seen.set(x, k + 1); return k ? `${x}_${k + 1}` : x; });
  const rows = t.rows.map((r, ri) => `  <Row${t.boldRows?.includes(ri) ? ' total="true"' : ''}>\n${r.map((v, i) =>
    `    <${unique[i]}${t.columns[i].type === 'money' ? ' currency="INR"' : ''}>${esc(plain(t, v, i))}</${unique[i]}>`).join('\n')}\n  </Row>`);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<Report organisation="${esc(orgName)}" title="${esc(t.title)}" subtitle="${esc(t.subtitle ?? '')}" generated="${new Date().toISOString()}">\n${rows.join('\n')}\n</Report>\n`;
  return Buffer.from(xml, 'utf8');
}

/** A safe file name from a title. */
export const fileNameOf = (title: string) => title.replace(/[^\w -]+/g, '').trim().replace(/\s+/g, '-').slice(0, 80) || 'export';
