// Turn compliance_rules rows into concrete due dates. Rules live in the database so a CA can change them.
export interface Rule { code: string; title: string; frequency: 'monthly' | 'quarterly'; dueDay: number; dueMonthOffset: number; appliesWhen: string; }
export interface Deadline { ruleCode: string; title: string; period: string; dueDate: string; }

const iso = (y: number, m: number, d: number) => {
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-12; day 0 of next month = last day of this one
  return new Date(Date.UTC(y, m - 1, Math.min(d, last))).toISOString().slice(0, 10);
};
const monthName = (m: number) => ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1];

/** Deadlines with a due date between `from` and `to` (inclusive, ISO dates). */
export function deadlinesBetween(rules: Rule[], from: string, to: string, hasGstin: boolean): Deadline[] {
  const out: Deadline[] = [];
  const [fy, fm] = from.split('-').map(Number);
  // Walk period-end months starting a few months before `from`, since the due date falls after the period ends.
  for (let i = -4; i <= 15; i++) {
    const idx = fy * 12 + (fm - 1) + i;
    const y = Math.floor(idx / 12), m = (idx % 12) + 1; // period-end month
    for (const r of rules) {
      if (r.appliesWhen === 'gstin' && !hasGstin) continue;
      if (r.frequency === 'quarterly' && ![3, 6, 9, 12].includes(m)) continue;
      let offset = r.dueMonthOffset;
      if (r.code === 'TDS_RETURN' && m === 3) offset = 2; // Q4 TDS return is due 31 May, not 30 April
      const dueIdx = y * 12 + (m - 1) + offset;
      const dueDate = iso(Math.floor(dueIdx / 12), (dueIdx % 12) + 1, r.dueDay);
      if (dueDate < from || dueDate > to) continue;
      const period = r.frequency === 'quarterly' ? `${y}-Q${Math.ceil(m / 3)}` : `${y}-${String(m).padStart(2, '0')}`;
      out.push({ ruleCode: r.code, title: `${r.title} - ${r.frequency === 'quarterly' ? `quarter ending ${monthName(m)} ${y}` : `${monthName(m)} ${y}`}`, period, dueDate });
    }
  }
  return out.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.ruleCode.localeCompare(b.ruleCode));
}
