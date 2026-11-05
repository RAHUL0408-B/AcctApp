// Pure rules for depreciation, repeating schedules and bank rules.
import { percentOf } from '../money';

export interface Asset {
  cost: number; residual: number; method: 'slm' | 'wdv' | 'slm_life'; rateBp: number; purchaseDate: string; accumulated: number;
  /** Used by the 'slm_life' method: the asset is written down evenly over this many months. */
  usefulLifeMonths?: number | null;
  /** 'months' (default): every month is 1/12 of a year. 'actual_days': each period gets its real number of days / days in the year. */
  dayBasis?: 'months' | 'actual_days';
  /** End of the period being charged. Only needed with 'actual_days'. */
  periodEnd?: string;
}

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

/** Share of a year that a period covers. The purchase month only counts from the purchase date when days are used. */
export function yearFraction(a: Pick<Asset, 'purchaseDate' | 'dayBasis' | 'periodEnd'>): number {
  if (a.dayBasis !== 'actual_days' || !a.periodEnd) return 1 / 12;
  const [y, m] = a.periodEnd.split('-').map(Number);
  const monthStart = new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0, 10);
  const from = a.purchaseDate > monthStart ? a.purchaseDate : monthStart;
  const days = daysBetween(from, a.periodEnd) + 1;
  return Math.max(days, 0) / (isLeap(y) ? 366 : 365);
}

/**
 * Depreciation for one period (a month). Straight line: (cost - residual) x annual rate. Written-down value: opening book value x annual rate.
 * Useful life: (cost - residual) spread evenly over the life in months. The annual figure is then scaled to the period
 * (1/12, or actual days / days in the year). Never goes below the residual value.
 * Note: the Income Tax Act half-rate rule for assets used under 180 days is NOT modelled.
 */
export function monthlyDepreciation(a: Asset): number {
  const bookValue = a.cost - a.accumulated;
  const room = bookValue - a.residual;
  if (room <= 0) return 0;
  const f = yearFraction(a);
  let annual: number;
  if (a.method === 'slm_life') {
    if (!a.usefulLifeMonths) return 0;
    annual = ((a.cost - a.residual) * 12) / a.usefulLifeMonths;
  } else annual = a.method === 'slm' ? percentOf(a.cost - a.residual, a.rateBp) : percentOf(bookValue, a.rateBp);
  const raw = a.dayBasis === 'actual_days' && a.periodEnd ? Math.round(annual * f) : Math.round(annual / 12);
  return Math.min(Math.max(raw, 0), room);
}

/** Month-end dates (YYYY-MM-DD) from the purchase month through `to`, inclusive. */
export function monthEnds(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number);
  for (;;) {
    const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    if (end > to) break;
    out.push(end);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

export type Frequency = 'weekly' | 'monthly' | 'quarterly' | 'yearly';

/** Next run date. Month steps keep the original day where possible (31 Jan -> 28/29 Feb -> 31 Mar when `anchorDay` is passed). */
export function nextDate(date: string, freq: Frequency, anchorDay?: number): string {
  const [y, m, d] = date.split('-').map(Number);
  if (freq === 'weekly') return new Date(Date.UTC(y, m - 1, d + 7)).toISOString().slice(0, 10);
  const step = freq === 'monthly' ? 1 : freq === 'quarterly' ? 3 : 12;
  const idx = y * 12 + (m - 1) + step;
  const ny = Math.floor(idx / 12), nm = idx % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return new Date(Date.UTC(ny, nm, Math.min(anchorDay ?? d, last))).toISOString().slice(0, 10);
}

export interface BankRule { matchText: string; direction: 'in' | 'out' | 'any'; accountId: number; }

/** First rule whose text appears in the narration (case-insensitive) and whose direction fits the amount sign. */
export function matchRule(rules: BankRule[], description: string, amount: number): BankRule | null {
  const d = description.toLowerCase();
  return rules.find((r) => d.includes(r.matchText.toLowerCase()) && (r.direction === 'any' || (r.direction === 'in' ? amount > 0 : amount < 0))) ?? null;
}
