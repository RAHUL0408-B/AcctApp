// Narration templates for repeating invoices, bills and journals: "Being milk supply bill posted for {month}" becomes
// "Being milk supply bill posted for Nov-26" on the November run.
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The placeholders a narration can use, with an example for 15 Nov 2026. */
export const PLACEHOLDERS: [string, string][] = [
  ['{month}', 'Nov-26'], ['{month_long}', 'November 2026'], ['{date}', '15-11-2026'], ['{year}', '2026'], ['{fy}', '2026-27'], ['{quarter}', 'Q3 2026-27'],
  ['{period}', '01-11-2026 to 30-11-2026'],
];

const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** Fill the placeholders for a run dated `on` (YYYY-MM-DD) of a schedule repeating at `frequency`. Unknown braces are left as typed. */
export function fillNarration(template: string, on: string, frequency = 'monthly'): string {
  if (!template || !template.includes('{')) return template;
  const y = Number(on.slice(0, 4)), m = Number(on.slice(5, 7)) - 1;
  const fyStart = m >= 3 ? y : y - 1, fy = `${fyStart}-${String((fyStart + 1) % 100).padStart(2, '0')}`;
  const q = Math.floor(((m + 9) % 12) / 3) + 1;
  // The period the run covers: its month (or quarter / year), from the first to the last day.
  let from = `${y}-${String(m + 1).padStart(2, '0')}-01`, to = `${y}-${String(m + 1).padStart(2, '0')}-${lastDay(y, m)}`;
  if (frequency === 'quarterly') { const qs = m - ((m + 9) % 3); const qy = y; from = `${qy}-${String(qs + 1).padStart(2, '0')}-01`; const qe = qs + 2; to = `${qy}-${String(qe + 1).padStart(2, '0')}-${lastDay(qy, qe)}`; }
  if (frequency === 'yearly') { from = `${fyStart}-04-01`; to = `${fyStart + 1}-03-31`; }
  if (frequency === 'weekly') { from = on; const e = new Date(Date.parse(on) + 6 * 86400000).toISOString().slice(0, 10); to = e; }
  const values: Record<string, string> = {
    '{month}': `${MON[m]}-${String(y % 100).padStart(2, '0')}`, '{month_long}': `${MONTH[m]} ${y}`, '{date}': ddmmyyyy(on), '{year}': String(y), '{fy}': fy,
    '{quarter}': `Q${q} ${fy}`, '{period}': `${ddmmyyyy(from)} to ${ddmmyyyy(to)}`,
  };
  return template.replace(/\{[a-z_]+\}/g, (k) => values[k] ?? k);
}
