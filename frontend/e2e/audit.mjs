// Site audit: opens every screen for a client with data and for a brand-new empty client, on a desktop and a phone
// screen, and fails on any server error, script error, broken text (undefined, NaN, Invalid Date) or a page wider
// than a phone screen.  Needs the API (:3000, TRUST_PROXY=1) and the web app (:5173).  Run: node frontend/e2e/audit.mjs
import { chromium } from 'playwright-core';
import assert from 'assert';

const API = process.env.API_URL ?? 'http://localhost:3000/api';
const WEB = process.env.WEB_URL ?? 'http://127.0.0.1:5173';
const SHOTS = process.env.AUDIT_SHOTS; // a folder: save a picture of every screen there
const stamp = Date.now(), email = `audit${stamp}@example.com`, password = 'Passphrase-1234';

let hop = 0;
async function call(path, { method, body, token } = {}) {
  hop += 1;
  const res = await fetch(API + path, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.9.${(hop >> 8) & 255}.${hop & 255}`, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  assert.ok(res.ok, `${method ?? 'call'} ${path}: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

// ------------------------------------------------------------------ a client with data, and an empty one
const { token } = await call('/auth/register', { body: { email, password, fullName: 'Audit Owner', firmName: 'Audit & Co', acceptTerms: true } });
const firmId = (await call('/auth/me', { token })).memberships[0].firmId;
const full = await call('/orgs', { token, body: { firmId, name: 'Audit Traders', template: 'trading', gstin: '27AAPFU0939F1ZV' } });
const empty = await call('/orgs', { token, body: { firmId, name: 'Audit Empty Client', template: 'services' } });
const O = `/orgs/${full.id}`;
const accounts = await call(`${O}/accounts`, { token });
const acct = (code) => { const a = accounts.find((x) => x.code === code); assert.ok(a, `account ${code}`); return a.id; };
const byType = (t) => accounts.find((x) => x.type === t && !/gst|tds|cess/i.test(x.name)).id;
const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const customer = await call(`${O}/contacts`, { token, body: { kind: 'customer', name: 'Audit Customer Pvt Ltd', gstin: '29AAGCB7383J1Z4', email: 'customer@example.com' } });
const supplier = await call(`${O}/contacts`, { token, body: { kind: 'supplier', name: 'Audit Supplier LLP', gstin: '27AAACR5055K1Z7', pan: 'AAACR5055K' } });
const line = (accountId, rupees) => ({ description: 'Audit line', accountId, quantity: 1, rate: rupees * 100, gstRateBp: 1800, hsnSac: '9983' });
await call(`${O}/documents`, { token, body: { docType: 'invoice', contactId: customer.id, issueDate: daysAgo(40), dueDate: daysAgo(10), lines: [line(byType('income'), 50000)] } });
await call(`${O}/documents`, { token, body: { docType: 'invoice', contactId: customer.id, issueDate: today, dueDate: today, lines: [line(byType('income'), 12000)] } });
await call(`${O}/documents`, { token, body: { docType: 'bill', contactId: supplier.id, issueDate: daysAgo(200), dueDate: daysAgo(170), supplierRef: 'SUP/001', lines: [line(byType('expense'), 20000)] } });
void acct;

// ------------------------------------------------------------------ every screen
const reports = ['tb', 'pnl', 'pnlm', 'pnlt', 'bs', 'ledger', 'cf', 'stcf', 'snap', 'bva', 'ar', 'ap', 'gstr1', 'gstr3b', 'tds'];
const orgPages = [
  'dashboard', 'sales-overview', 'invoices', 'invoices/new', 'quotes', 'recurring', 'items', 'customers', 'sales-settings',
  'purchases-overview', 'bills', 'bills/new', 'recurring-bills', 'batch-payments', 'purchase-orders', 'expenses', 'approvals', 'suppliers', 'purchases-settings',
  'reports', ...reports.map((r) => `reports/${r}`),
  'bank', 'bank-rules', 'money/spend', 'money/receive', 'money/transfer', 'coa', 'journal', 'assets', 'inventory', 'budgets', 'tracking',
  'files', 'year-end', 'import', 'schedules', 'export-templates', 'settings',
  'compliance/2b', 'compliance/msme', 'compliance/itc180', 'tasks', 'contacts', 'projects', 'settings-hub',
  'setup/financial', 'setup/invoice', 'setup/payment', 'setup/email', 'setup/reminders', 'setup/currencies', 'setup/tax-rates', 'setup/history',
];
const firmPages = ['/clients', '/practice', '/team', '/security', '/billing', '/privacy', '/help'];
const routes = [
  ...firmPages.map((p) => ({ name: p, hash: p })),
  ...orgPages.map((p) => ({ name: `data: ${p}`, hash: `/o/${full.id}/${p}` })),
  ...orgPages.map((p) => ({ name: `empty: ${p}`, hash: `/o/${empty.id}/${p}` })),
];

const BROKEN = /\bundefined\b|\bNaN\b|Invalid Date|\[object Object\]|\bnull\b/;
const problems = [];
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const [label, viewport] of [['desktop', { width: 1366, height: 800 }], ['phone', { width: 390, height: 780 }]]) {
    if (process.env.AUDIT_ONLY && process.env.AUDIT_ONLY !== label) continue;
    const ctx = await browser.newContext({ viewport });
    await ctx.addInitScript((t) => sessionStorage.setItem('token', t), token);
    const page = await ctx.newPage();
    let where = '';
    const note = (what) => problems.push(`[${label}] ${where}: ${what}`);
    page.on('pageerror', (e) => note(`script error: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) note(`console: ${m.text().slice(0, 200)}`); });
    page.on('response', (r) => { if (r.status() >= 400 && r.url().includes('/api/')) note(`${r.status()} ${r.request().method()} ${r.url().replace(/^.*\/api/, '')}`); });
    page.on('requestfailed', (r) => { if (r.url().includes('/api/') && r.failure()?.errorText !== 'net::ERR_ABORTED') note(`request failed: ${r.url().replace(/^.*\/api/, '')}`); });
    // "Settled" = no API call in flight for 400 ms (the dev server keeps a socket open, so the browser never reports idle).
    let inFlight = 0, lastMove = Date.now();
    const isApi = (q) => q.url().includes('/api/');
    page.on('request', (q) => { if (isApi(q)) { inFlight += 1; lastMove = Date.now(); } });
    for (const ev of ['requestfinished', 'requestfailed']) page.on(ev, (q) => { if (isApi(q)) { inFlight -= 1; lastMove = Date.now(); } });
    const settled = async () => { const until = Date.now() + 15000; await page.waitForTimeout(150); while (Date.now() < until && (inFlight > 0 || Date.now() - lastMove < 400)) await page.waitForTimeout(100); };
    await page.goto(WEB);
    for (const r of routes) {
      where = r.name;
      await page.evaluate((h) => { location.hash = h; }, r.hash);
      await settled();
      const main = page.locator('main').first();
      const text = (await main.count()) ? await main.innerText() : await page.locator('body').innerText();
      if (text.trim().length < 20) note('the screen is blank');
      const bad = BROKEN.exec(text);
      if (bad) note(`shows "${bad[0]}": …${text.slice(Math.max(0, bad.index - 60), bad.index + 40).replace(/\s+/g, ' ')}…`);
      for (const a of await page.getByRole('alert').allInnerTexts()) if (a.trim()) note(`error shown: ${a.trim().slice(0, 160)}`);
      if (/Loading…\s*$/.test(text.trim())) note('still says Loading…');
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (wide > 2) note(`page is ${wide}px wider than the screen`);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/${label}-${r.name.replace(/[^\w]+/g, '_')}.png` });
    }
    await ctx.close();
    console.log(`✓ ${label}: opened ${routes.length} screens`);
  }
} finally { await browser.close(); }

if (problems.length) { console.log(`\n${problems.length} problem(s):`); for (const p of [...new Set(problems)]) console.log(' -', p); process.exit(1); }
console.log(`\nSITE AUDIT PASSED: ${routes.length} screens on a desktop and a phone, no errors.`);
