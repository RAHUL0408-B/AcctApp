import { matchRule, monthEnds, monthlyDepreciation, nextDate, yearFraction } from '../src/extras/calc';

describe('depreciation', () => {
  const base = { cost: 12000000, residual: 1200000, rateBp: 1000, purchaseDate: '2025-04-10', accumulated: 0 }; // Rs 1,20,000 cost, Rs 12,000 residual, 10%
  it('straight line: (1,20,000 - 12,000) x 10% / 12 = Rs 900 a month', () => {
    expect(monthlyDepreciation({ ...base, method: 'slm' })).toBe(90000);
  });
  it('written down value: Rs 1,20,000 x 10% / 12 = Rs 1,000, then falls as book value falls', () => {
    expect(monthlyDepreciation({ ...base, method: 'wdv' })).toBe(100000);
    expect(monthlyDepreciation({ ...base, method: 'wdv', accumulated: 100000 })).toBe(99167); // 1,19,000 x 10%/12 = 991.67
  });
  it('useful life: cost less residual spread evenly over the life in months', () => {
    // Rs 1,08,000 to write off over 36 months = Rs 3,000 a month
    expect(monthlyDepreciation({ ...base, method: 'slm_life', rateBp: 1, usefulLifeMonths: 36 })).toBe(300000);
    expect(monthlyDepreciation({ ...base, method: 'slm_life', rateBp: 1 })).toBe(0); // no life given
  });
  it('actual days: a part first month counts only the days owned, over the days in the year', () => {
    const a = { ...base, method: 'slm' as const, dayBasis: 'actual_days' as const, purchaseDate: '2025-04-21', periodEnd: '2025-04-30' }; // 10 of 365 days
    expect(yearFraction(a)).toBeCloseTo(10 / 365, 10);
    expect(monthlyDepreciation(a)).toBe(Math.round(10800000 * 0.1 * 10 / 365));
    // a full month later in the year is its real length, not 1/12
    expect(yearFraction({ ...a, periodEnd: '2025-05-31' })).toBeCloseTo(31 / 365, 10);
    // leap year
    expect(yearFraction({ ...a, purchaseDate: '2024-01-01', periodEnd: '2024-02-29' })).toBeCloseTo(29 / 366, 10);
    // months basis is untouched by the new options
    expect(monthlyDepreciation({ ...base, method: 'slm', dayBasis: 'months' })).toBe(90000);
  });
  it('never depreciates below the residual value', () => {
    expect(monthlyDepreciation({ ...base, method: 'slm', accumulated: base.cost - base.residual - 30000 })).toBe(30000);
    expect(monthlyDepreciation({ ...base, method: 'slm', accumulated: base.cost - base.residual })).toBe(0);
  });
  it('lists month ends from the purchase month up to a date', () => {
    expect(monthEnds('2025-11-20', '2026-02-28')).toEqual(['2025-11-30', '2025-12-31', '2026-01-31', '2026-02-28']);
    expect(monthEnds('2025-11-20', '2025-11-29')).toEqual([]);
    expect(monthEnds('2024-02-01', '2024-02-29')).toEqual(['2024-02-29']); // leap year
  });
});

describe('repeating schedules', () => {
  it('weekly adds 7 days across a month end', () => expect(nextDate('2025-12-28', 'weekly')).toBe('2026-01-04'));
  it('monthly keeps the anchor day: 31 Jan -> 28 Feb -> 31 Mar', () => {
    const feb = nextDate('2025-01-31', 'monthly', 31);
    expect(feb).toBe('2025-02-28');
    expect(nextDate(feb, 'monthly', 31)).toBe('2025-03-31');
  });
  it('quarterly and yearly (including 29 Feb)', () => {
    expect(nextDate('2025-11-15', 'quarterly')).toBe('2026-02-15');
    expect(nextDate('2024-02-29', 'yearly')).toBe('2025-02-28');
  });
});

describe('bank rules', () => {
  const rules = [
    { matchText: 'SBI CHARGES', direction: 'out' as const, accountId: 5560 },
    { matchText: 'interest', direction: 'in' as const, accountId: 4200 },
    { matchText: 'rent', direction: 'any' as const, accountId: 5500 },
  ];
  it('matches case-insensitively and respects direction', () => {
    expect(matchRule(rules, 'sbi charges Q2', -5000)?.accountId).toBe(5560);
    expect(matchRule(rules, 'sbi charges refund', 5000)).toBeNull();
    expect(matchRule(rules, 'Savings Interest', 1200)?.accountId).toBe(4200);
    expect(matchRule(rules, 'Office RENT Nov', -2500000)?.accountId).toBe(5500);
    expect(matchRule(rules, 'Unknown', -1)).toBeNull();
  });
  it('first matching rule wins', () => {
    expect(matchRule([{ matchText: 'a', direction: 'any', accountId: 1 }, { matchText: 'a', direction: 'any', accountId: 2 }], 'abc', 1)?.accountId).toBe(1);
  });
});
