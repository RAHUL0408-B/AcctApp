// Pure helpers for the insights reports. Money is integer paise.

const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);

export interface CashItem { date: string; direction: 'in' | 'out'; amount: number; overdue: boolean }

/**
 * Short-term cash flow. Week 1 starts today. Items due inside the window land in their week; overdue items are shown
 * separately and are not assumed to be paid, so `projected` is cautious and `projectedIncludingOverdue` is hopeful.
 */
export function cashWeeks(opening: number, today: string, days: number, items: CashItem[]) {
  const last = addDays(today, days - 1);
  const weeks: { start: string; end: string; cashIn: number; cashOut: number; net: number; closing: number }[] = [];
  for (let s = 0; s < days; s += 7) weeks.push({ start: addDays(today, s), end: addDays(today, Math.min(s + 6, days - 1)), cashIn: 0, cashOut: 0, net: 0, closing: 0 });
  const overdue = { cashIn: 0, cashOut: 0 };
  for (const i of items) {
    if (i.overdue) { overdue[i.direction === 'in' ? 'cashIn' : 'cashOut'] += i.amount; continue; }
    if (i.date > last) continue;
    const w = weeks[Math.floor((Date.parse(i.date) - Date.parse(today)) / (7 * 86400000))];
    if (i.direction === 'in') w.cashIn += i.amount; else w.cashOut += i.amount;
  }
  let bal = opening;
  for (const w of weeks) { w.net = w.cashIn - w.cashOut; bal += w.net; w.closing = bal; }
  return { opening, overdue, weeks, projected: bal, projectedIncludingOverdue: bal + overdue.cashIn - overdue.cashOut };
}

/** TDS deducted in a month is deposited by the 7th of the next month; March deductions by 30 April. */
export function depositBy(month: string) {
  const [y, m] = month.split('-').map(Number);
  if (m === 3) return `${y}-04-30`;
  return m === 12 ? `${y + 1}-01-07` : `${y}-${String(m + 1).padStart(2, '0')}-07`;
}

/** Quarter of the April-March financial year: Q1 = April to June. */
export function fyQuarter(date: string) {
  const m = Number(date.slice(5, 7));
  return `Q${m >= 4 ? Math.floor((m - 4) / 3) + 1 : 4}`;
}

/** good / watch / concern against two thresholds; `lowerIsBetter` flips the direction (e.g. days to get paid). */
export function grade(v: number | null, good: number, watch: number, lowerIsBetter = false): 'good' | 'watch' | 'concern' | 'n/a' {
  if (v == null) return 'n/a';
  if (lowerIsBetter) return v <= good ? 'good' : v <= watch ? 'watch' : 'concern';
  return v >= good ? 'good' : v >= watch ? 'watch' : 'concern';
}

export const round1 = (v: number) => Math.round(v * 10) / 10;

/** Value of time worked: minutes x hourly rate / 60, to the nearest paisa. */
export const timeValue = (minutes: number, ratePerHour: number) => Math.round((minutes * ratePerHour) / 60);
