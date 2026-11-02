// Money is always an integer number of paise (1 rupee = 100 paise). Never use floats.

/** Parse a rupee string like "1,234.50" into paise (123450). Throws on bad input. */
export function rupeesToPaise(input: string): number {
  const s = input.replace(/,/g, '').trim();
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new Error(`Invalid amount: "${input}"`);
  const paise = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0') || '0');
  if (!Number.isSafeInteger(paise)) throw new Error('Amount too large');
  return m[1] ? -paise : paise;
}

/** Format paise as Indian-grouped rupees, e.g. 12345678 -> "1,23,456.78". */
export function formatPaise(paise: number): string {
  const neg = paise < 0;
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100).toString();
  const frac = (abs % 100).toString().padStart(2, '0');
  const last3 = rupees.slice(-3);
  const rest = rupees.slice(0, -3);
  const grouped = rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3 : last3;
  return `${neg ? '-' : ''}${grouped}.${frac}`;
}

/** Multiply paise by a percentage given in basis points (1% = 100 bp), rounding half up. */
export function percentOf(paise: number, basisPoints: number): number {
  return Math.round((paise * basisPoints) / 10000);
}

/** Split an amount into parts by weights so the parts always add up exactly (largest remainder). */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) throw new Error('Weights must sum to a positive number');
  const raw = weights.map((w) => (total * w) / sum);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, f: r - Math.floor(r) })).sort((a, b) => b.f - a.f);
  for (let k = 0; left > 0; k++, left--) out[order[k % order.length].i]++;
  return out;
}
