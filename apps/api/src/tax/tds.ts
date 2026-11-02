// TDS maths. Section rates/thresholds are read from the tds_sections table and passed in.
import { percentOf } from '../money';

export interface TdsSection {
  code: string; rateIndividualBp: number; rateOtherBp: number; singleThreshold: number; annualThreshold: number;
}

export interface TdsInput {
  section: TdsSection;
  deducteeIsIndividual: boolean;
  hasPan: boolean;
  /** Amount of this bill on which TDS applies (value excluding GST when GST is shown separately). */
  amount: number;
  /** Total of earlier bills to this party in the same financial year. */
  priorTotal: number;
  /** Part of priorTotal on which TDS was already deducted. */
  priorDeductedBase: number;
}

export const NO_PAN_RATE_BP = 2000; // section 206AA: 20% when PAN is missing (or the section rate if higher)

/**
 * Returns {base, rateBp, tds}. TDS is due once the single-payment threshold OR the yearly threshold is crossed.
 * When the yearly threshold is first crossed, tax is deducted on the whole amount so far, not just this bill.
 */
export function computeTds(i: TdsInput) {
  const s = i.section;
  const cumulative = i.priorTotal + i.amount;
  const singleHit = s.singleThreshold > 0 && i.amount >= s.singleThreshold;
  const annualHit = s.annualThreshold > 0 ? cumulative > s.annualThreshold : s.singleThreshold === 0;
  if (!singleHit && !annualHit) return { base: 0, rateBp: 0, tds: 0 };
  const base = Math.max(0, cumulative - i.priorDeductedBase);
  const taxBase = singleHit && !annualHit ? i.amount : base;
  const sectionRate = i.deducteeIsIndividual ? s.rateIndividualBp : s.rateOtherBp;
  const rateBp = i.hasPan ? sectionRate : Math.max(sectionRate, NO_PAN_RATE_BP);
  return { base: taxBase, rateBp, tds: percentOf(taxBase, rateBp) };
}
