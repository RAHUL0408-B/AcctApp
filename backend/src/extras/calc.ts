// Pure rules for depreciation, repeating schedules and bank rules.
import { percentOf } from '../money';

export interface Asset { cost: number; residual: number; method: 'slm' | 'wdv'; rateBp: number; purchaseDate: string; accumulated: number; }

/**
 * Depreciation for one month. Straight line: (cost - residual) x annual rate / 12.
 * Written-down value: opening book value x annual rate / 12. Never goes below the residual value.
 * Note: Income Tax Act block-wise depreciation and half-year rules for assets used under 180 days are NOT modelled.
 */
export function monthlyDepreciation(a: Asset): number {
  const bookValue = a.cost - a.accumulated;
  const room = bookValue - a.residual;
  if (room <= 0) return 0;
  const raw = a.method === 'slm' ? Math.round(percentOf(a.cost - a.residual, a.rateBp) / 12) : Math.round(percentOf(bookValue, a.rateBp) / 12);
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
