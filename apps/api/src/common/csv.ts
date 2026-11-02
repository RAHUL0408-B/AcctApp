// Small CSV reader (quoted fields, commas/newlines inside quotes) and bank-statement mapper.
import { createHash } from 'crypto';
import { rupeesToPaise } from '../money';

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell.trim()); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell.trim()); cell = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell.trim());
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}

/** Accepts DD/MM/YYYY, DD-MM-YYYY, YYYY-MM-DD, DD-Mon-YYYY. Returns ISO YYYY-MM-DD. */
export function parseDate(s: string): string {
  const t = s.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) return check(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(t);
  if (m) return check(+m[3], +m[2], +m[1]);
  m = /^(\d{1,2})[ -]([A-Za-z]{3})[a-z]*[ -](\d{2,4})$/.exec(t);
  if (m) {
    const mon = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[2].toLowerCase()) + 1;
    return check(+m[3] < 100 ? 2000 + +m[3] : +m[3], mon, +m[1]);
  }
  throw new Error(`Unrecognised date "${s}"`);
}
function check(y: number, mo: number, d: number) {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (mo < 1 || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) throw new Error(`Invalid date ${d}/${mo}/${y}`);
  return dt.toISOString().slice(0, 10);
}

export interface StatementRow { date: string; description: string; amount: number; reference: string | null; hash: string; }

/**
 * Map a bank statement CSV to rows. Needs a header with a date column and either
 * separate debit/withdrawal + credit/deposit columns, or one signed amount column.
 * amount > 0 means money in, < 0 money out.
 */
export function parseStatement(text: string): StatementRow[] {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('The file has no data rows');
  const head = rows[0].map((h) => h.toLowerCase());
  const find = (...names: string[]) => head.findIndex((h) => names.some((n) => h.includes(n)));
  const iDate = find('date'), iDesc = find('narration', 'description', 'particulars', 'details'), iRef = find('ref', 'chq', 'cheque', 'utr');
  const iDr = find('debit', 'withdrawal'), iCr = find('credit', 'deposit'), iAmt = find('amount');
  if (iDate < 0 || iDesc < 0 || (iAmt < 0 && (iDr < 0 || iCr < 0))) {
    throw new Error('Could not find columns: need Date, Description/Narration and either Debit+Credit or Amount');
  }
  const seen = new Map<string, number>();
  return rows.slice(1).map((r, n) => {
    try {
      const money = (s?: string) => (s && s.trim() !== '' ? rupeesToPaise(s) : 0);
      const amount = iAmt >= 0 && (iDr < 0 || iCr < 0) ? money(r[iAmt]) : money(r[iCr]) - Math.abs(money(r[iDr]));
      const date = parseDate(r[iDate]);
      const description = r[iDesc] ?? '';
      const base = `${date}|${description}|${amount}|${iRef >= 0 ? r[iRef] : ''}`;
      const k = (seen.get(base) ?? 0) + 1; seen.set(base, k); // identical rows on the same day stay distinct
      return { date, description, amount, reference: iRef >= 0 && r[iRef] ? r[iRef] : null, hash: createHash('sha256').update(base + '#' + k).digest('hex') };
    } catch (e) {
      throw new Error(`Row ${n + 2}: ${(e as Error).message}`);
    }
  });
}
