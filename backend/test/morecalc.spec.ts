// Unit tests for the pure helpers behind Phase 6: supply rules, currency conversion, average cost, report grids.
import { computeGst, supplyRules, toRupees } from '../src/tax/gst';
import { issueCost } from '../src/inventory/stock';
import { months, plRows } from '../src/planning/calc';

describe('supply rules', () => {
  it('export under LUT charges nothing; export with payment and SEZ force IGST', () => {
    expect(supplyRules('export_lut', true, false)).toMatchObject({ chargeTax: false, forceIgst: true, needsLut: true });
    expect(supplyRules('sez_igst', true, false)).toMatchObject({ chargeTax: true, forceIgst: true, needsLut: false });
    expect(supplyRules('reverse_charge', false, false)).toMatchObject({ chargeTax: false, reverseCharge: true, claimInputCredit: true });
  });
  it('rejects combinations that cannot happen', () => {
    expect(() => supplyRules('reverse_charge', true, false)).toThrow(/purchases only/);
    expect(() => supplyRules('export_lut', false, false)).toThrow(/sales only/);
    expect(() => supplyRules('export_igst', true, true)).toThrow(/composition/);
  });
  it('composition: no tax on sales, no input credit on purchases', () => {
    expect(supplyRules('regular', true, true).chargeTax).toBe(false);
    expect(supplyRules('regular', false, true)).toMatchObject({ chargeTax: true, claimInputCredit: false });
  });
  it('forceIgst turns a same-state supply into IGST: Rs 1,000 @18% = IGST 180', () => {
    const [l] = computeGst([{ description: 'x', qtyMilli: 1000, rate: 100000, gstRateBp: 1800, accountId: 1 }], '27', '27', true, true);
    expect(l).toMatchObject({ cgst: 0, sgst: 0, igst: 18000 });
  });
});

describe('currency and stock arithmetic', () => {
  it('USD 1,000.00 at Rs 83.25 = Rs 83,250.00; rounding to the nearest paisa', () => {
    expect(toRupees(100000, 83.25)).toBe(8325000);
    expect(toRupees(1, 83.255)).toBe(83);
    expect(toRupees(333, 1.5)).toBe(500); // 499.5 rounds up
  });
  it('weighted average cost: 3 out of 7 worth Rs 10 = Rs 4.29; taking the rest takes exactly what is left', () => {
    const s = { qtyMilli: 7000, value: 1000 };
    expect(issueCost(s, 3000)).toBe(429);
    expect(issueCost({ qtyMilli: 4000, value: 571 }, 4000)).toBe(571);
    expect(() => issueCost(s, 8000)).toThrow(/Not enough stock/);
  });
});

describe('report helpers', () => {
  it('months across a year end', () => {
    expect(months('2025-11-15', '2026-02-01')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(months('2026-04-01', '2026-04-30')).toEqual(['2026-04']);
  });
  it('builds a P&L grid with column totals and net profit', () => {
    const r = plRows([
      { id: 1, code: '4000', name: 'Sales', type: 'income', col: 'A', d: 0, cr: 500 },
      { id: 1, code: '4000', name: 'Sales', type: 'income', col: 'B', d: 0, cr: 300 },
      { id: 2, code: '5500', name: 'Rent', type: 'expense', col: 'B', d: 200, cr: 0 },
      { id: 3, code: '5600', name: 'Ignored', type: 'expense', col: 'Z', d: 999, cr: 0 },
    ], ['A', 'B']);
    expect(r.income.items[0]).toMatchObject({ amounts: [500, 300], total: 800 });
    expect(r.expenses.totals).toEqual([0, 200]);
    expect(r.netProfit).toEqual([500, 100]);
    expect(r.netProfitTotal).toBe(600);
  });
});
