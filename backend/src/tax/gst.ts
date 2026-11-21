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

export interface TaxLineInput { description: string; hsnSac?: string; /** GST unit quantity code, e.g. NOS, KGS. */ unit?: string; qtyMilli: number; rate: number; gstRateBp: number; accountId: number; itemId?: number | null; trackingOptionId?: number | null;
  /** Compensation cess, in basis points of the taxable value (for example 1200 = 12%). */ cessRateBp?: number;
  /** Section 17(5): the GST on this purchase line can never be claimed as input credit, so it is part of the cost. */ itcBlocked?: boolean; }
export interface TaxLine extends TaxLineInput { taxable: number; cgst: number; sgst: number; igst: number; cess: number; }

/** Line amount = quantity (in 1/1000 units) x rate (paise per unit), rounded to the nearest paisa. */
export const lineAmount = (qtyMilli: number, rate: number) => Math.round((qtyMilli * rate) / 1000);

/**
 * Compute GST per line. Same state => CGST + SGST (each half the rate). Different state => IGST.
 * `registered` false (supplier not GST-registered) => no tax. `forceIgst` => IGST even within a state (exports, SEZ).
 */
export function computeGst(lines: TaxLineInput[], supplierState: string | null, placeOfSupply: string | null, registered = true, forceIgst = false): TaxLine[] {
  const intra = !forceIgst && !!supplierState && supplierState === placeOfSupply;
  return lines.map((l) => {
    const taxable = lineAmount(l.qtyMilli, l.rate);
    // Cess is charged on the taxable value whether the supply is within the state or not, and only by a registered supplier.
    const cess = registered && l.cessRateBp ? percentOf(taxable, l.cessRateBp) : 0;
    if (!registered || l.gstRateBp === 0) return { ...l, taxable, cgst: 0, sgst: 0, igst: 0, cess };
    if (intra) {
      const half = percentOf(taxable, l.gstRateBp / 2);
      return { ...l, taxable, cgst: half, sgst: half, igst: 0, cess };
    }
    return { ...l, taxable, cgst: 0, sgst: 0, igst: percentOf(taxable, l.gstRateBp), cess };
  });
}

export function totals(lines: TaxLine[]) {
  const sum = (k: 'taxable' | 'cgst' | 'sgst' | 'igst' | 'cess') => lines.reduce((s, l) => s + (l[k] ?? 0), 0);
  const subtotal = sum('taxable'), cgst = sum('cgst'), sgst = sum('sgst'), igst = sum('igst'), cess = sum('cess');
  return { subtotal, cgst, sgst, igst, cess, total: subtotal + cgst + sgst + igst + cess };
}

/** GST unit quantity codes (UQC) accepted on invoices and in GSTR-1. */
export const UQC = ['BAG', 'BAL', 'BDL', 'BKL', 'BOU', 'BOX', 'BTL', 'BUN', 'CAN', 'CBM', 'CCM', 'CMS', 'CTN', 'DOZ', 'DRM', 'GGK', 'GMS', 'GRS', 'GYD', 'KGS', 'KLR', 'KME', 'LTR', 'MLS', 'MLT', 'MTR', 'MTS', 'NOS', 'OTH', 'PAC', 'PCS', 'PRS', 'QTL', 'ROL', 'SET', 'SQF', 'SQM', 'SQY', 'TBS', 'TGM', 'THD', 'TON', 'TUB', 'UGS', 'UNT', 'YDS'] as const;

export type SupplyType = 'regular' | 'export_lut' | 'export_igst' | 'sez_lut' | 'sez_igst' | 'reverse_charge' | 'unregistered';

/**
 * How a supply type changes the GST on a document.
 * - Exports and SEZ supplies are inter-state: IGST, or no tax at all when made under a Letter of Undertaking (zero-rated).
 * - Reverse charge: the supplier charges no GST; the buyer works it out and pays it to the government (and usually claims it back).
 * - Composition dealers charge no GST on sales and cannot claim input credit.
 */
export function supplyRules(supply: SupplyType, isSales: boolean, composition: boolean) {
  if (supply === 'reverse_charge' && isSales) throw new Error('Reverse charge applies to purchases only');
  if (supply === 'unregistered' && isSales) throw new Error('"Supply from an unregistered dealer" applies to purchases only');
  const purchaseKinds: SupplyType[] = ['regular', 'reverse_charge', 'unregistered'];
  if (!purchaseKinds.includes(supply) && !isSales) throw new Error('Export and SEZ supply types apply to sales only');
  if (composition && isSales && supply !== 'regular') throw new Error('A composition dealer cannot make exports or SEZ supplies');
  return {
    // A dealer who is not registered under GST cannot charge it, so there is nothing to claim either.
    chargeTax: !(isSales && composition) && !supply.endsWith('_lut') && supply !== 'reverse_charge' && supply !== 'unregistered',
    forceIgst: supply !== 'regular' && supply !== 'reverse_charge' && supply !== 'unregistered',
    reverseCharge: supply === 'reverse_charge',
    needsLut: supply.endsWith('_lut'),
    claimInputCredit: !composition,
  };
}

/** Convert an amount in a foreign currency's minor units (cents) to paise at a rate of rupees per unit. */
export const toRupees = (minor: number, fxRate: number) => Math.round(minor * fxRate);
