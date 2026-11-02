// GST maths. Rates come from the gst_rates config table; nothing here hardcodes a rate.
import { percentOf } from '../money';

const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const FORMAT = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** Valid GSTIN = right format + valid state code prefix shape + correct check character (mod-36 checksum). */
export function isValidGstin(gstin: string): boolean {
  const g = gstin.toUpperCase();
  if (!FORMAT.test(g)) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = CHARS.indexOf(g[i]) * (i % 2 ? 2 : 1);
    sum += Math.floor(v / 36) + (v % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36] === g[14];
}

export const stateOfGstin = (gstin: string) => gstin.slice(0, 2);

export interface TaxLineInput { description: string; hsnSac?: string; qtyMilli: number; rate: number; gstRateBp: number; accountId: number; }
export interface TaxLine extends TaxLineInput { taxable: number; cgst: number; sgst: number; igst: number; }

/** Line amount = quantity (in 1/1000 units) x rate (paise per unit), rounded to the nearest paisa. */
export const lineAmount = (qtyMilli: number, rate: number) => Math.round((qtyMilli * rate) / 1000);

/**
 * Compute GST per line. Same state => CGST + SGST (each half the rate). Different state => IGST.
 * `registered` false (supplier not GST-registered) => no tax.
 */
export function computeGst(lines: TaxLineInput[], supplierState: string | null, placeOfSupply: string | null, registered = true): TaxLine[] {
  const intra = !!supplierState && supplierState === placeOfSupply;
  return lines.map((l) => {
    const taxable = lineAmount(l.qtyMilli, l.rate);
    if (!registered || l.gstRateBp === 0) return { ...l, taxable, cgst: 0, sgst: 0, igst: 0 };
    if (intra) {
      const half = percentOf(taxable, l.gstRateBp / 2);
      return { ...l, taxable, cgst: half, sgst: half, igst: 0 };
    }
    return { ...l, taxable, cgst: 0, sgst: 0, igst: percentOf(taxable, l.gstRateBp) };
  });
}

export function totals(lines: TaxLine[]) {
  const sum = (k: 'taxable' | 'cgst' | 'sgst' | 'igst') => lines.reduce((s, l) => s + l[k], 0);
  const subtotal = sum('taxable'), cgst = sum('cgst'), sgst = sum('sgst'), igst = sum('igst');
  return { subtotal, cgst, sgst, igst, total: subtotal + cgst + sgst + igst };
}
