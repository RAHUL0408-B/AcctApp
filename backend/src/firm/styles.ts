// Visual templates and customisation options shared by every PDF and Excel export (reports and invoices).

export const TEMPLATES = ['classic', 'modern', 'minimal', 'corporate', 'elegant'] as const;
export type TemplateName = (typeof TEMPLATES)[number];
export const PAPERS = ['A4', 'A3', 'LETTER'] as const;

/** What the person chose on the "Customize export" panel. Every field is optional on the wire; parseOptions fills the rest. */
export interface ExportOptions {
  template: TemplateName;
  orientation: 'auto' | 'portrait' | 'landscape';
  paper: (typeof PAPERS)[number];
  /** Replaces the report's own title (for example "Sales by customer, FY 2026-27"). */
  title?: string;
  /** A line printed under the heading, for example "Prepared for the board meeting". */
  note?: string;
  /** Printed at the bottom of every page. */
  footer?: string;
  /** Hex colour such as #4f46e5. Replaces the template's own accent colour. */
  accent?: string;
  pageNumbers: boolean;
  /** Body text size in points. */
  fontSize: number;
  /** Zero-based positions of columns to leave out. */
  hide: number[];
}

export const DEFAULT_OPTIONS: ExportOptions = { template: 'classic', orientation: 'auto', paper: 'A4', pageNumbers: true, fontSize: 9, hide: [] };

const clean = (s: unknown, max: number) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : '');

/** Reads options from a query string (or a saved object). Unknown or invalid values fall back to the defaults. */
export function parseOptions(q: Record<string, unknown> | undefined): ExportOptions {
  const o: ExportOptions = { ...DEFAULT_OPTIONS, hide: [] };
  if (!q) return o;
  if ((TEMPLATES as readonly string[]).includes(q.template as string)) o.template = q.template as TemplateName;
  if (['auto', 'portrait', 'landscape'].includes(q.orientation as string)) o.orientation = q.orientation as ExportOptions['orientation'];
  const paper = clean(q.paper, 10).toUpperCase();
  if ((PAPERS as readonly string[]).includes(paper)) o.paper = paper as ExportOptions['paper'];
  const title = clean(q.title, 80), note = clean(q.note, 200), footer = clean(q.footer, 150);
  if (title) o.title = title; if (note) o.note = note; if (footer) o.footer = footer;
  const accent = clean(q.accent, 7).replace(/^#/, '');
  if (/^[0-9a-fA-F]{6}$/.test(accent)) o.accent = `#${accent.toLowerCase()}`;
  if (q.pageNumbers === '0' || q.pageNumbers === 'false' || q.pageNumbers === false) o.pageNumbers = false;
  const fs = Number(q.fontSize); if (Number.isFinite(fs) && fs >= 7 && fs <= 12) o.fontSize = Math.round(fs * 2) / 2;
  if (typeof q.hide === 'string' && q.hide) o.hide = [...new Set(q.hide.split(',').map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < 60))];
  return o;
}

export interface Look {
  font: string; bold: string; italic: string;
  accent: string;
  /** How the heading is laid out. */
  head: 'plain' | 'band' | 'centered' | 'minimal';
  /** Table header row: coloured block, tinted block, or just a line under it. */
  headFill: 'solid' | 'tint' | 'none';
  zebra: boolean;
  /** Draw a border around every cell. */
  grid: boolean;
  /** Draw a thin line under every row. */
  rowLines: boolean;
}

const LOOKS: Record<TemplateName, Look> = {
  classic: { font: 'Helvetica', bold: 'Helvetica-Bold', italic: 'Helvetica-Oblique', accent: '#111111', head: 'plain', headFill: 'none', zebra: false, grid: false, rowLines: true },
  modern: { font: 'Helvetica', bold: 'Helvetica-Bold', italic: 'Helvetica-Oblique', accent: '#4f46e5', head: 'band', headFill: 'solid', zebra: true, grid: false, rowLines: false },
  minimal: { font: 'Helvetica', bold: 'Helvetica-Bold', italic: 'Helvetica-Oblique', accent: '#374151', head: 'minimal', headFill: 'none', zebra: false, grid: false, rowLines: false },
  corporate: { font: 'Helvetica', bold: 'Helvetica-Bold', italic: 'Helvetica-Oblique', accent: '#1e3a8a', head: 'plain', headFill: 'solid', zebra: false, grid: true, rowLines: true },
  elegant: { font: 'Times-Roman', bold: 'Times-Bold', italic: 'Times-Italic', accent: '#0f766e', head: 'centered', headFill: 'tint', zebra: false, grid: false, rowLines: true },
};

export const lookOf = (o: ExportOptions): Look => ({ ...LOOKS[o.template], ...(o.accent ? { accent: o.accent } : {}) });

/** Blend a hex colour towards white; pct 0 = the colour, 1 = white. */
export function tint(hex: string, pct: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v + (255 - v) * pct));
  return `#${ch.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
/** Black or white, whichever reads better on the given colour. */
export const onColour = (hex: string) => { const n = parseInt(hex.slice(1), 16); return ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114 > 160 ? '#111111' : '#ffffff'; };

export const TEMPLATE_INFO: { name: TemplateName; label: string; blurb: string; accent: string }[] = [
  { name: 'classic', label: 'Classic', blurb: 'Black and white with ruled lines. Prints well anywhere.', accent: LOOKS.classic.accent },
  { name: 'modern', label: 'Modern', blurb: 'Coloured heading band and striped rows.', accent: LOOKS.modern.accent },
  { name: 'minimal', label: 'Minimal', blurb: 'Light and airy, with plenty of white space.', accent: LOOKS.minimal.accent },
  { name: 'corporate', label: 'Corporate', blurb: 'Navy header and a full bordered grid, like an audit pack.', accent: LOOKS.corporate.accent },
  { name: 'elegant', label: 'Elegant', blurb: 'Serif type, centred heading and a soft tinted header row.', accent: LOOKS.elegant.accent },
];
