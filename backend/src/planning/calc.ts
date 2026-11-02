// Pure helpers for management reports.
import { naturalBalance } from '../ledger/ledger';

/** Month labels ('YYYY-MM') from the month of `from` to the month of `to`, inclusive. */
export function months(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  const end = to.slice(0, 7);
  for (;;) {
    const label = `${y}-${String(m).padStart(2, '0')}`;
    if (label > end) break;
    out.push(label);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

/**
 * Turn grouped rows (account x column with debit/credit sums) into a P&L grid: income and expense sections,
 * one amount per column, row totals, and net profit per column.
 */
export function plRows(rows: { id: unknown; code: string; name: string; type: string; col: string; d: unknown; cr: unknown }[], columns: string[]) {
  const byAccount = new Map<number, { code: string; name: string; type: string; amounts: number[]; total: number }>();
  for (const r of rows) {
    const id = Number(r.id), i = columns.indexOf(r.col);
    if (i < 0) continue;
    const a = byAccount.get(id) ?? { code: r.code, name: r.name, type: r.type, amounts: columns.map(() => 0), total: 0 };
    const v = naturalBalance(r.type, Number(r.d), Number(r.cr));
    a.amounts[i] += v; a.total += v;
    byAccount.set(id, a);
  }
  const section = (type: string) => {
    const items = [...byAccount.values()].filter((a) => a.type === type && a.amounts.some((x) => x)).sort((a, b) => a.code.localeCompare(b.code))
      .map(({ code, name, amounts, total }) => ({ code, name, amounts, total }));
    const totals = columns.map((_, i) => items.reduce((s, a) => s + a.amounts[i], 0));
    return { items, totals, total: totals.reduce((s, x) => s + x, 0) };
  };
  const income = section('income'), expenses = section('expense');
  const netProfit = columns.map((_, i) => income.totals[i] - expenses.totals[i]);
  return { income, expenses, netProfit, netProfitTotal: income.total - expenses.total };
}
