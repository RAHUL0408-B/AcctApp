// Export templates: how every PDF and Excel file looks. A template is a full set of settings (colours, typeface,
// heading layout, table style, page options). Five built-in templates are ready-made starting points; an owner can
// design their own and choose which one all reports and which one all invoices use.

export const TEMPLATES = ['classic', 'modern', 'minimal', 'corporate', 'elegant'] as const;
export type TemplateName = (typeof TEMPLATES)[number];
export const PAPERS = ['A4', 'A3', 'LETTER'] as const;
export const FONTS = ['sans', 'serif', 'mono'] as const;
export const HEADINGS = ['plain', 'band', 'centered', 'minimal'] as const;
export const TABLE_HEADERS = ['solid', 'tint', 'none'] as const;

/** Everything that decides how a file looks. This is what an owner designs and saves. */
export interface TemplateConfig {
  /** Main colour: headings, rules, totals. */
  accent: string;
  /** Fill of the table's heading row. Leave out to use the main colour. */
  headColour?: string;
  /** Colour of the text in tables and details. */
  textColour: string;
  font: (typeof FONTS)[number];
  /** Body text size in points. */
  fontSize: number;
  /** How the top of the page is laid out: plain, a coloured band, centred, or minimal. */
  heading: (typeof HEADINGS)[number];
  /** Table heading row: a solid block, a light tint, or just a line. */
  tableHeader: (typeof TABLE_HEADERS)[number];
  zebra: boolean;
  /** A border around every cell. */
  grid: boolean;
  /** A thin line under every row. */
  rowLines: boolean;
  orientation: 'auto' | 'portrait' | 'landscape';
  paper: (typeof PAPERS)[number];
  pageNumbers: boolean;
  /** Printed at the bottom of every page. */
  footer?: string;
  /** Replaces the heading of an invoice, for example "INVOICE" instead of "TAX INVOICE". */
  invoiceLabel?: string;
}

/** A template plus what is chosen for one particular export. Only the first part is saved in settings. */
export interface ExportOptions extends TemplateConfig {
  /** Replaces the report's own title (for example "Sales by customer, FY 2026-27"). */
  title?: string;
  /** A line printed under the heading. */
  note?: string;
  /** Zero-based positions of columns to leave out. */
  hide: number[];
}

const COMMON = { textColour: '#111111', fontSize: 9, orientation: 'auto', paper: 'A4', pageNumbers: true } as const;

export const PRESETS: Record<TemplateName, TemplateConfig> = {
  classic: { ...COMMON, accent: '#111111', font: 'sans', heading: 'plain', tableHeader: 'none', zebra: false, grid: false, rowLines: true },
  modern: { ...COMMON, accent: '#4f46e5', font: 'sans', heading: 'band', tableHeader: 'solid', zebra: true, grid: false, rowLines: false },
  minimal: { ...COMMON, accent: '#374151', font: 'sans', heading: 'minimal', tableHeader: 'none', zebra: false, grid: false, rowLines: false },
  corporate: { ...COMMON, accent: '#1e3a8a', font: 'sans', heading: 'plain', tableHeader: 'solid', zebra: false, grid: true, rowLines: true },
  elegant: { ...COMMON, accent: '#0f766e', font: 'serif', heading: 'centered', tableHeader: 'tint', zebra: false, grid: false, rowLines: true },
};

export const DEFAULT_CONFIG: TemplateConfig = PRESETS.classic;
export const DEFAULT_OPTIONS: ExportOptions = { ...DEFAULT_CONFIG, hide: [] };

export const TEMPLATE_INFO: { name: TemplateName; label: string; blurb: string; accent: string; config: TemplateConfig }[] = [
  { name: 'classic', label: 'Classic', blurb: 'Black and white with ruled lines. Prints well anywhere.', accent: PRESETS.classic.accent, config: PRESETS.classic },
  { name: 'modern', label: 'Modern', blurb: 'Coloured heading band and striped rows.', accent: PRESETS.modern.accent, config: PRESETS.modern },
  { name: 'minimal', label: 'Minimal', blurb: 'Light and airy, with plenty of white space.', accent: PRESETS.minimal.accent, config: PRESETS.minimal },
  { name: 'corporate', label: 'Corporate', blurb: 'Navy header and a full bordered grid, like an audit pack.', accent: PRESETS.corporate.accent, config: PRESETS.corporate },
  { name: 'elegant', label: 'Elegant', blurb: 'Serif type, centred heading and a soft tinted header row.', accent: PRESETS.elegant.accent, config: PRESETS.elegant },
];

const clean = (s: unknown, max: number) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : '');
const hex = (v: unknown): string | undefined => { const h = clean(v, 7).replace(/^#/, ''); return /^[0-9a-fA-F]{6}$/.test(h) ? `#${h.toLowerCase()}` : undefined; };
const pick = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined => (allowed as readonly string[]).includes(v as string) ? (v as T) : undefined;
const bool = (v: unknown): boolean | undefined => (v === true || v === '1' || v === 'true' ? true : v === false || v === '0' || v === 'false' ? false : undefined);

/** Takes anything (a saved object, a request body) and returns a complete, valid template. Bad or missing values fall back to `base`. */
export function sanitizeConfig(raw: unknown, base: TemplateConfig = DEFAULT_CONFIG): TemplateConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const fs = Number(r.fontSize);
  const out: TemplateConfig = {
    accent: hex(r.accent) ?? base.accent,
    textColour: hex(r.textColour) ?? base.textColour,
    font: pick(r.font, FONTS) ?? base.font,
    fontSize: Number.isFinite(fs) && fs >= 7 && fs <= 12 ? Math.round(fs * 2) / 2 : base.fontSize,
    heading: pick(r.heading, HEADINGS) ?? base.heading,
    tableHeader: pick(r.tableHeader, TABLE_HEADERS) ?? base.tableHeader,
    zebra: bool(r.zebra) ?? base.zebra,
    grid: bool(r.grid) ?? base.grid,
    rowLines: bool(r.rowLines) ?? base.rowLines,
    orientation: pick(r.orientation, ['auto', 'portrait', 'landscape'] as const) ?? base.orientation,
    paper: pick(clean(r.paper, 10).toUpperCase(), PAPERS) ?? base.paper,
    pageNumbers: bool(r.pageNumbers) ?? base.pageNumbers,
  };
  const head = hex(r.headColour) ?? (r.headColour === undefined ? base.headColour : undefined);
  if (head) out.headColour = head;
  const footer = r.footer === undefined ? base.footer : clean(r.footer, 150);
  if (footer) out.footer = footer;
  const label = r.invoiceLabel === undefined ? base.invoiceLabel : clean(r.invoiceLabel, 30);
  if (label) out.invoiceLabel = label;
  return out;
}

/**
 * The options for one export: the organisation's chosen template, then anything asked for in this request.
 * A request can name a built-in template or change single settings; the saved template is the default.
 */
export function optionsFor(base: TemplateConfig, q: Record<string, unknown> | undefined): ExportOptions {
  const o: ExportOptions = { ...base, hide: [] };
  if (!q) return o;
  const preset = pick(q.template, TEMPLATES);
  const merged = sanitizeConfig(q, preset ? PRESETS[preset] : base);
  Object.assign(o, merged);
  const title = clean(q.title, 80), note = clean(q.note, 200);
  if (title) o.title = title; if (note) o.note = note;
  if (typeof q.hide === 'string' && q.hide) o.hide = [...new Set(q.hide.split(',').map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < 60))];
  return o;
}

/** For callers that have no saved template (for example a request with only query settings). */
export const parseOptions = (q: Record<string, unknown> | undefined): ExportOptions => optionsFor(DEFAULT_CONFIG, q);

export interface Look {
  font: string; bold: string; italic: string; excelFont: string;
  accent: string;
  /** Fill of the table heading row. */
  headColour: string;
  text: string;
  head: TemplateConfig['heading'];
  headFill: TemplateConfig['tableHeader'];
  zebra: boolean; grid: boolean; rowLines: boolean;
}

const FACES = {
  sans: { font: 'Helvetica', bold: 'Helvetica-Bold', italic: 'Helvetica-Oblique', excelFont: 'Calibri' },
  serif: { font: 'Times-Roman', bold: 'Times-Bold', italic: 'Times-Italic', excelFont: 'Times New Roman' },
  mono: { font: 'Courier', bold: 'Courier-Bold', italic: 'Courier-Oblique', excelFont: 'Courier New' },
} as const;

export const lookOf = (o: TemplateConfig): Look => ({
  ...FACES[o.font], accent: o.accent, headColour: o.headColour ?? o.accent, text: o.textColour,
  head: o.heading, headFill: o.tableHeader, zebra: o.zebra, grid: o.grid, rowLines: o.rowLines,
});

/** Blend a hex colour towards white; pct 0 = the colour, 1 = white. */
export function tint(hexColour: string, pct: number): string {
  const n = parseInt(hexColour.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v + (255 - v) * pct));
  return `#${ch.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
/** Black or white, whichever reads better on the given colour. */
export const onColour = (hexColour: string) => { const n = parseInt(hexColour.slice(1), 16); return ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114 > 160 ? '#111111' : '#ffffff'; };
