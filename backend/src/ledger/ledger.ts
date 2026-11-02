// Pure double-entry rules. The database re-checks the same rules with triggers as a safety net.
export interface LineInput { accountId: number; debit?: number; credit?: number; memo?: string; trackingOptionId?: number | null; }
export interface Line { accountId: number; debit: number; credit: number; memo?: string; trackingOptionId?: number | null; }

export class LedgerError extends Error {}

/** Check lines are valid and balanced; return them normalised. Throws LedgerError if not. */
export function validateLines(input: LineInput[]): Line[] {
  if (input.length < 2) throw new LedgerError('An entry needs at least two lines');
  let debits = 0, credits = 0;
  const lines = input.map((l, i) => {
    const debit = l.debit ?? 0, credit = l.credit ?? 0;
    if (!Number.isSafeInteger(debit) || !Number.isSafeInteger(credit)) throw new LedgerError(`Line ${i + 1}: amounts must be whole paise`);
    if (debit < 0 || credit < 0) throw new LedgerError(`Line ${i + 1}: amounts cannot be negative`);
    if ((debit === 0) === (credit === 0)) throw new LedgerError(`Line ${i + 1}: use exactly one of debit or credit`);
    debits += debit; credits += credit;
    return { accountId: l.accountId, debit, credit, memo: l.memo, trackingOptionId: l.trackingOptionId ?? null };
  });
  if (debits !== credits) throw new LedgerError(`Entry is unbalanced: debits ${debits} paise, credits ${credits} paise`);
  return lines;
}

/** A reversal swaps debit and credit on every line. */
export function reverseLines(lines: Line[]): Line[] {
  return lines.map((l) => ({ accountId: l.accountId, debit: l.credit, credit: l.debit, memo: l.memo, trackingOptionId: l.trackingOptionId ?? null }));
}

/** Net balance in the account's natural direction: assets/expenses are debit-positive, others credit-positive. */
export function naturalBalance(type: string, debit: number, credit: number): number {
  return type === 'asset' || type === 'expense' ? debit - credit : credit - debit;
}

/** Indian financial year (April-March) containing a date, e.g. 2025-06-10 -> {label:'FY 2025-26'}. */
export function financialYearOf(date: string, startMonth = 4) {
  const [y, m] = date.split('-').map(Number);
  const startYear = m >= startMonth ? y : y - 1;
  const pad = (n: number) => String(n).padStart(2, '0');
  const start = `${startYear}-${pad(startMonth)}-01`;
  const endDate = new Date(Date.UTC(startYear + 1, startMonth - 1, 0));
  const end = endDate.toISOString().slice(0, 10);
  const label = startMonth === 1 ? `FY ${startYear}` : `FY ${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
  return { label, start, end };
}
