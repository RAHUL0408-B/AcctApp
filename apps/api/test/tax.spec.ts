import { computeGst, isValidGstin, lineAmount, totals } from '../src/tax/gst';
import { computeTds } from '../src/tax/tds';
import { parseCsv, parseDate, parseStatement } from '../src/common/csv';

describe('GSTIN', () => {
  it('accepts a correct GSTIN and rejects a wrong check character or format', () => {
    expect(isValidGstin('27AAPFU0939F1ZV')).toBe(true);
    expect(isValidGstin('27AAPFU0939F1ZX')).toBe(false); // wrong checksum
    expect(isValidGstin('27aapfu0939f1zv')).toBe(true);  // case-insensitive
    expect(isValidGstin('BADGSTIN')).toBe(false);
  });
});

describe('GST calculation', () => {
  const line = { description: 'Widget', qtyMilli: 2000, rate: 50000, gstRateBp: 1800, accountId: 1 }; // 2 x Rs 500 = Rs 1,000

  it('line amount: 2.5 units at Rs 199.99 = Rs 499.975 -> 49998 paise (rounded)', () => {
    expect(lineAmount(2500, 19999)).toBe(50000 - 2); // 49997.5 -> 49998
  });
  it('intra-state: Rs 1,000 @18% -> CGST 90 + SGST 90, total 1,180', () => {
    const t = totals(computeGst([line], '27', '27'));
    expect(t).toEqual({ subtotal: 100000, cgst: 9000, sgst: 9000, igst: 0, total: 118000 });
  });
  it('inter-state: Rs 1,000 @18% -> IGST 180, total 1,180', () => {
    const t = totals(computeGst([line], '27', '29'));
    expect(t).toEqual({ subtotal: 100000, cgst: 0, sgst: 0, igst: 18000, total: 118000 });
  });
  it('0.25% slab intra-state keeps CGST = SGST (Rs 100 -> 12.5 paise each rounds to 13)', () => {
    const [l] = computeGst([{ ...line, qtyMilli: 1000, rate: 10000, gstRateBp: 25 }], '27', '27');
    expect(l.cgst).toBe(l.sgst);
    expect(l.cgst).toBe(13);
  });
  it('unregistered supplier charges no tax; 0% rate charges none', () => {
    expect(totals(computeGst([line], '27', '27', false)).total).toBe(100000);
    expect(totals(computeGst([{ ...line, gstRateBp: 0 }], '27', '29')).igst).toBe(0);
  });
  it('mixed slabs add up line by line', () => {
    const t = totals(computeGst([line, { ...line, gstRateBp: 500, rate: 20000 }], '27', '29')); // 1000@18 + 400@5
    expect(t.igst).toBe(18000 + 2000);
    expect(t.total).toBe(100000 + 40000 + 20000);
  });
});

describe('TDS calculation', () => {
  const s194J = { code: '194J', rateIndividualBp: 1000, rateOtherBp: 1000, singleThreshold: 0, annualThreshold: 5000000 };
  const s194C = { code: '194C', rateIndividualBp: 100, rateOtherBp: 200, singleThreshold: 3000000, annualThreshold: 10000000 };
  const base = { deducteeIsIndividual: false, hasPan: true, priorTotal: 0, priorDeductedBase: 0 };

  it('194J below annual threshold (Rs 40,000 < 50,000): no TDS', () => {
    expect(computeTds({ ...base, section: s194J, amount: 4000000 }).tds).toBe(0);
  });
  it('194J above threshold: Rs 60,000 @10% = Rs 6,000', () => {
    expect(computeTds({ ...base, section: s194J, amount: 6000000 })).toEqual({ base: 6000000, rateBp: 1000, tds: 600000 });
  });
  it('194J crossing the yearly limit deducts on the whole amount so far: 40,000 earlier + 20,000 now -> 6,000', () => {
    const r = computeTds({ ...base, section: s194J, amount: 2000000, priorTotal: 4000000 });
    expect(r.base).toBe(6000000);
    expect(r.tds).toBe(600000);
  });
  it('after crossing, later bills are taxed in full: Rs 10,000 more -> Rs 1,000', () => {
    const r = computeTds({ ...base, section: s194J, amount: 1000000, priorTotal: 6000000, priorDeductedBase: 6000000 });
    expect(r.tds).toBe(100000);
  });
  it('194C: individual contractor 1%, company 2%; single payment over Rs 30,000 triggers TDS', () => {
    expect(computeTds({ ...base, section: s194C, amount: 5000000, deducteeIsIndividual: true }).tds).toBe(50000);
    expect(computeTds({ ...base, section: s194C, amount: 5000000 }).tds).toBe(100000);
    expect(computeTds({ ...base, section: s194C, amount: 2000000 }).tds).toBe(0); // under both limits
  });
  it('missing PAN: 20% (206AA) if higher than the section rate', () => {
    expect(computeTds({ ...base, section: s194J, amount: 6000000, hasPan: false }).tds).toBe(1200000);
  });
});

describe('CSV and bank statements', () => {
  it('parses quoted fields with commas', () => {
    expect(parseCsv('a,b\n"x, y",2\r\n')).toEqual([['a', 'b'], ['x, y', '2']]);
  });
  it('parses common Indian date formats and rejects impossible dates', () => {
    expect(parseDate('05/04/2025')).toBe('2025-04-05');
    expect(parseDate('5-Apr-25')).toBe('2025-04-05');
    expect(() => parseDate('31/02/2025')).toThrow();
  });
  it('maps debit/credit columns and keeps identical same-day rows distinct', () => {
    const rows = parseStatement('Date,Narration,Chq No,Withdrawal Amt,Deposit Amt\n01/04/2025,UPI-Shop,1,"1,200.50",\n01/04/2025,UPI-Shop,1,"1,200.50",\n02/04/2025,NEFT-Client,,,5000');
    expect(rows.map((r) => r.amount)).toEqual([-120050, -120050, 500000]);
    expect(new Set(rows.map((r) => r.hash)).size).toBe(3);
  });
  it('maps a single signed amount column and errors on unknown layouts', () => {
    expect(parseStatement('Date,Description,Amount\n2025-04-01,Fee,-10.5')[0].amount).toBe(-1050);
    expect(() => parseStatement('foo,bar\n1,2')).toThrow(/columns/);
    expect(() => parseStatement('Date,Description,Amount\nxx,Fee,1')).toThrow(/Row 2/);
  });
});
