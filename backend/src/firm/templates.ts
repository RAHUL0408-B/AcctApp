// Finds the template an organisation has chosen, and holds the sample data used to preview a design.
import { PoolClient } from 'pg';
import type { InvoiceView } from './render';
import type { Table } from './exporter';
import { DEFAULT_CONFIG, PRESETS, sanitizeConfig, TEMPLATES, TemplateConfig, TemplateName } from './styles';

export type TemplateKind = 'report' | 'document';

/** A built-in name ('classic') or 'custom:<id>' for a template the owner designed. */
export async function resolveRef(c: PoolClient, ref: string): Promise<TemplateConfig | null> {
  if ((TEMPLATES as readonly string[]).includes(ref)) return PRESETS[ref as TemplateName];
  const m = /^custom:(\d+)$/.exec(ref);
  if (!m) return null;
  const row = (await c.query('SELECT config FROM export_templates WHERE id=$1', [m[1]])).rows[0];
  return row ? sanitizeConfig(row.config) : null;
}

/** The organisation's choice for reports or for invoices and bills. Call inside withOrg(). Falls back to Classic. */
export async function templateConfigFor(c: PoolClient, kind: TemplateKind): Promise<TemplateConfig> {
  const d = (await c.query('SELECT report_ref, document_ref FROM export_defaults')).rows[0];
  const ref: string = d ? (kind === 'report' ? d.report_ref : d.document_ref) : 'classic';
  return (await resolveRef(c, ref)) ?? DEFAULT_CONFIG;
}

/** A believable report, so a design can be judged before it is used on real figures. */
export const SAMPLE_TABLE: Table = {
  title: 'Profit and loss', subtitle: '01-04-2026 to 30-09-2026',
  columns: [{ header: 'Account', type: 'text' }, { header: 'Type', type: 'text' }, { header: 'Apr-Jun', type: 'money' }, { header: 'Jul-Sep', type: 'money' }, { header: 'Total', type: 'money' }],
  rows: [
    ['Service revenue', 'Income', 41250000, 47800000, 89050000], ['Product sales', 'Income', 18900000, 21450000, 40350000], ['Total income', '', 60150000, 69250000, 129400000],
    ['Salaries and wages', 'Expense', 22400000, 22400000, 44800000], ['Rent', 'Expense', 7200000, 7200000, 14400000], ['Professional fees', 'Expense', 3150000, 4020000, 7170000],
    ['Travel and conveyance', 'Expense', 1285000, 1610000, 2895000], ['Depreciation', 'Expense', 960000, 960000, 1920000], ['Total expenses', '', 34995000, 36190000, 71185000],
    ['Net profit', '', 25155000, 33060000, 58215000],
  ],
  boldRows: [2, 8, 9],
};

export const sampleInvoice = (orgName: string): InvoiceView => ({
  orgName, orgGstin: '27AAPFU0939F1ZV', type: 'invoice', number: 'INV/26-27/0014', issueDate: '2026-11-06', dueDate: '2026-11-21', contact: 'Kapoor Stores', contactGstin: '27ABCDE1234F1Z5', placeOfSupply: '27',
  lines: [
    { description: 'Interior design consultation', hsnSac: '998391', qtyMilli: 2000, rate: 500000, taxable: 1000000, gstRateBp: 1800 },
    { description: 'Site supervision, 4 visits', hsnSac: '998399', qtyMilli: 4000, rate: 150000, taxable: 600000, gstRateBp: 1800 },
    { description: 'Material sourcing', hsnSac: '998313', qtyMilli: 1000, rate: 250000, taxable: 250000, gstRateBp: 1800 },
  ],
  subtotal: 1850000, cgst: 166500, sgst: 166500, igst: 0, total: 2183000, tdsAmount: 0, notes: 'Payment by NEFT within 15 days. Thank you for your business.',
});
