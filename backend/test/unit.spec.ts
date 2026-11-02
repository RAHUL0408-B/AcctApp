import { allocate, formatPaise, percentOf, rupeesToPaise } from '../src/money';
import { LedgerError, financialYearOf, naturalBalance, reverseLines, validateLines } from '../src/ledger/ledger';
import { COA_TEMPLATES } from '../src/coa/templates';
import { base32Decode, base32Encode, totpAt, verifyTotp } from '../src/security/totp';
import { hashPassword, verifyPassword } from '../src/security/password';
import { RateLimiter } from '../src/common/ratelimit';

describe('money', () => {
  it('parses rupees to paise without float errors', () => {
    expect(rupeesToPaise('1,234.50')).toBe(123450);
    expect(rupeesToPaise('0.07')).toBe(7);
    expect(rupeesToPaise('19.9')).toBe(1990);
    expect(rupeesToPaise('-5')).toBe(-500);
  });
  it('rejects bad input', () => {
    expect(() => rupeesToPaise('1.234')).toThrow();
    expect(() => rupeesToPaise('abc')).toThrow();
  });
  it('formats with Indian digit grouping', () => {
    expect(formatPaise(12345678)).toBe('1,23,456.78');
    expect(formatPaise(99)).toBe('0.99');
    expect(formatPaise(-10000000)).toBe('-1,00,000.00');
  });
  it('percentOf: 18% of Rs 1,000 = Rs 180; 2.5% of Rs 99.99 rounds half up', () => {
    expect(percentOf(100000, 1800)).toBe(18000);
    expect(percentOf(9999, 250)).toBe(250); // 249.975 paise -> 250
  });
  it('allocate splits exactly: Rs 100.00 in thirds = 33.34 + 33.33 + 33.33', () => {
    const parts = allocate(10000, [1, 1, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(10000);
    expect(parts.sort()).toEqual([3333, 3333, 3334]);
  });
});

describe('ledger rules', () => {
  it('accepts a balanced sale: Dr Debtors 11800, Cr Sales 10000, Cr Output GST 1800', () => {
    const lines = validateLines([{ accountId: 1, debit: 11800 }, { accountId: 2, credit: 10000 }, { accountId: 3, credit: 1800 }]);
    expect(lines).toHaveLength(3);
  });
  it('rejects unbalanced, single-line, negative, float and two-sided lines', () => {
    expect(() => validateLines([{ accountId: 1, debit: 100 }, { accountId: 2, credit: 99 }])).toThrow(LedgerError);
    expect(() => validateLines([{ accountId: 1, debit: 100 }])).toThrow(/two lines/);
    expect(() => validateLines([{ accountId: 1, debit: -100 }, { accountId: 2, credit: -100 }])).toThrow(/negative/);
    expect(() => validateLines([{ accountId: 1, debit: 10.5 }, { accountId: 2, credit: 10.5 }])).toThrow(/whole paise/);
    expect(() => validateLines([{ accountId: 1, debit: 5, credit: 5 }, { accountId: 2, credit: 0, debit: 0 }])).toThrow(/exactly one/);
  });
  it('reverse swaps sides and stays balanced', () => {
    const rev = reverseLines(validateLines([{ accountId: 1, debit: 500 }, { accountId: 2, credit: 500 }]));
    expect(rev).toEqual([{ accountId: 1, debit: 0, credit: 500, memo: undefined }, { accountId: 2, debit: 500, credit: 0, memo: undefined }]);
    expect(() => validateLines(rev)).not.toThrow();
  });
  it('natural balance by account type', () => {
    expect(naturalBalance('asset', 1000, 400)).toBe(600);
    expect(naturalBalance('income', 100, 1000)).toBe(900);
  });
  it('financial year runs April to March', () => {
    expect(financialYearOf('2025-06-10')).toEqual({ label: 'FY 2025-26', start: '2025-04-01', end: '2026-03-31' });
    expect(financialYearOf('2026-03-31').label).toBe('FY 2025-26');
    expect(financialYearOf('2026-04-01').label).toBe('FY 2026-27');
    expect(financialYearOf('2099-02-01').label).toBe('FY 2098-99');
  });
});

describe('chart of accounts templates', () => {
  it.each(Object.keys(COA_TEMPLATES))('%s has unique codes and all five account types', (name) => {
    const t = COA_TEMPLATES[name];
    expect(new Set(t.map((a) => a.code)).size).toBe(t.length);
    expect(new Set(t.map((a) => a.type))).toEqual(new Set(['asset', 'liability', 'equity', 'income', 'expense']));
  });
});

describe('security', () => {
  it('base32 round-trips', () => {
    const b = Buffer.from('12345678901234567890');
    expect(base32Encode(b)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ').equals(b)).toBe(true);
  });
  it('TOTP matches RFC 6238 test vector (time 59s -> 287082)', () => {
    expect(totpAt('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59000)).toBe('287082');
    expect(verifyTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', '287082', 59000)).toBe(true);
    expect(verifyTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', '000000', 59000)).toBe(false);
  });
  it('password hash verifies only the right password', async () => {
    const h = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
  });
  it('rate limiter blocks after max hits and recovers after the window', () => {
    const r = new RateLimiter(2, 1000);
    r.hit('k', 0); r.hit('k', 10);
    expect(() => r.hit('k', 20)).toThrow();
    expect(() => r.hit('k', 2000)).not.toThrow();
  });
});
