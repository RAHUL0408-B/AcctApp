// How accounts are classified: Financial Statement Line Item (FSLI) -> Group -> Sub-group -> Ledger, with a number
// range for each group so the next ledger number can be suggested. Default groups follow Schedule III; firms add their own.
import type { AccountType } from './templates';

export interface Fsli { key: string; name: string; type: AccountType; from: number; to: number; side: 'bs' | 'pl' }
/** The statement lines, in the order the Balance Sheet and Profit and Loss show them. */
export const FSLIS: Fsli[] = [
  { key: 'equity', name: 'Capital and Reserves & Surplus', type: 'equity', from: 3000, to: 3999, side: 'bs' },
  { key: 'ncl', name: 'Non-Current Liabilities', type: 'liability', from: 2400, to: 2999, side: 'bs' },
  { key: 'cl', name: 'Current Liabilities', type: 'liability', from: 2000, to: 2399, side: 'bs' },
  { key: 'nca', name: 'Non-Current Assets', type: 'asset', from: 1600, to: 1999, side: 'bs' },
  { key: 'ca', name: 'Current Assets', type: 'asset', from: 1000, to: 1599, side: 'bs' },
  { key: 'di', name: 'Direct Incomes', type: 'income', from: 4000, to: 4099, side: 'pl' },
  { key: 'ii', name: 'Indirect Incomes', type: 'income', from: 4100, to: 4999, side: 'pl' },
  { key: 'de', name: 'Direct Expenses', type: 'expense', from: 5000, to: 5399, side: 'pl' },
  { key: 'ie', name: 'Indirect Expenses', type: 'expense', from: 5400, to: 6999, side: 'pl' },
];
export const fsliByKey = (k: string) => FSLIS.find((f) => f.key === k);

export interface GroupDef { fsli: string; name: string; from: number; to: number; sub?: { name: string; from: number; to: number }[] }
export const DEFAULT_GROUPS: GroupDef[] = [
  { fsli: 'equity', name: 'Share Capital / Owners\' Capital', from: 3000, to: 3099 },
  { fsli: 'equity', name: 'Reserves and Surplus', from: 3100, to: 3999 },
  { fsli: 'ncl', name: 'Long-term Borrowings', from: 2400, to: 2499, sub: [{ name: 'Secured Loans', from: 2400, to: 2409 }, { name: 'Unsecured Loans', from: 2410, to: 2499 }] },
  { fsli: 'ncl', name: 'Deferred Tax Liabilities (Net)', from: 2500, to: 2599 },
  { fsli: 'ncl', name: 'Long-term Provisions', from: 2600, to: 2999 },
  { fsli: 'cl', name: 'Trade Payables', from: 2000, to: 2099 },
  { fsli: 'cl', name: 'Duties & Taxes', from: 2100, to: 2299, sub: [{ name: 'Output Tax Liability', from: 2100, to: 2199 }, { name: 'TDS Payable', from: 2200, to: 2209 }, { name: 'Other Statutory Dues', from: 2210, to: 2299 }] },
  { fsli: 'cl', name: 'Other Current Liabilities', from: 2300, to: 2349 },
  { fsli: 'cl', name: 'Short-term Borrowings', from: 2350, to: 2379 },
  { fsli: 'cl', name: 'Short-term Provisions', from: 2380, to: 2399 },
  { fsli: 'nca', name: 'Property, Plant and Equipment', from: 1600, to: 1699 },
  { fsli: 'nca', name: 'Intangible Assets', from: 1700, to: 1799 },
  { fsli: 'nca', name: 'Non-current Investments', from: 1800, to: 1899 },
  { fsli: 'nca', name: 'Long-term Loans and Advances', from: 1900, to: 1999 },
  { fsli: 'ca', name: 'Cash and Bank Balances', from: 1000, to: 1099 },
  { fsli: 'ca', name: 'Trade Receivables', from: 1100, to: 1199 },
  { fsli: 'ca', name: 'Inventories', from: 1200, to: 1299 },
  { fsli: 'ca', name: 'Duties & Taxes (Input)', from: 1300, to: 1399, sub: [{ name: 'Input Tax Credit', from: 1300, to: 1349 }, { name: 'TDS and TCS Receivable', from: 1400, to: 1409 }] },
  { fsli: 'ca', name: 'Short-term Loans and Advances', from: 1410, to: 1599 },
  { fsli: 'di', name: 'Revenue from Operations', from: 4000, to: 4099 },
  { fsli: 'ii', name: 'Other Income', from: 4100, to: 4999 },
  { fsli: 'de', name: 'Purchases and Cost of Goods Sold', from: 5000, to: 5299 },
  { fsli: 'de', name: 'Direct Expenses', from: 5300, to: 5399 },
  { fsli: 'ie', name: 'Employee Benefit Expenses', from: 5400, to: 5499 },
  { fsli: 'ie', name: 'Administrative and Other Expenses', from: 5500, to: 5559 },
  { fsli: 'ie', name: 'Finance Costs', from: 5560, to: 5579 },
  { fsli: 'ie', name: 'Depreciation and Amortisation', from: 5580, to: 5599 },
  { fsli: 'ie', name: 'Selling and Distribution Expenses', from: 5600, to: 5799 },
  { fsli: 'ie', name: 'Other Indirect Expenses', from: 5800, to: 6999 },
];

/** The statement line an account belongs to when none was chosen: from its type and number. */
export function fsliOf(type: string, code: string): string {
  const n = Number.parseInt(code, 10);
  const byRange = Number.isFinite(n) ? FSLIS.find((f) => f.type === type && n >= f.from && n <= f.to) : undefined;
  if (byRange) return byRange.key;
  return ({ asset: 'ca', liability: 'cl', equity: 'equity', income: 'ii', expense: 'ie' } as Record<string, string>)[type] ?? 'ie';
}

/**
 * Next free ledger number in a range: 10 after the highest number used in it (5350 -> 5360), or the first free number
 * if that runs past the end. null when the range is full.
 */
export function nextCode(used: string[], from: number, to: number, step = 10): string | null {
  const inRange = used.map((c) => Number.parseInt(c, 10)).filter((n) => Number.isFinite(n) && n >= from && n <= to);
  const taken = new Set(inRange);
  if (!inRange.length) return String(from);
  const max = Math.max(...inRange);
  const after = Math.ceil((max + 1) / step) * step;
  if (after <= to && !taken.has(after)) return String(after);
  for (let n = from; n <= to; n++) if (!taken.has(n)) return String(n);
  return null;
}

/** The sub-group a standard account belongs to (GST and TDS accounts), or null. */
export function defaultSubGroup(code: string): string | null {
  if (['2100', '2110', '2120', '2130', '2140', '2150', '2160'].includes(code)) return 'Output Tax Liability';
  if (['1300', '1310', '1320', '1330', '1340'].includes(code)) return 'Input Tax Credit';
  if (code === '2200') return 'TDS Payable';
  if (code === '1400') return 'TDS and TCS Receivable';
  return null;
}
