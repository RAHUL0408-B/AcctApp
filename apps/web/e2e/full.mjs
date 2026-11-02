// Full browser test: the top-bar layout and every major feature, driven like a real user in Chrome.
// Needs API (:3000) and web (:5173) running and Google Chrome installed.  Run: node e2e/full.mjs
import { chromium } from 'playwright-core';
import assert from 'assert';

const URL = process.env.WEB_URL ?? 'http://127.0.0.1:5173';
const email = `full${Date.now()}@example.com`, password = 'Passphrase-1234';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 1400, height: 1000 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('dialog', (d) => { errors.push('unexpected dialog: ' + d.message()); d.dismiss(); });
const step = (s) => console.log('✓', s);
// Top-bar menus: open each dropdown in turn until the wanted item is visible, then click it.
const nav = async (name) => {
  const bar = page.getByRole('navigation', { name: 'Client sections' });
  const item = bar.getByRole('button', { name, exact: true });
  if (!(await item.isVisible())) {
    const groups = bar.locator('button[aria-haspopup]');
    for (let i = 0; i < await groups.count() && !(await item.isVisible()); i++) await groups.nth(i).click();
  }
  await item.click();
};
const account = async (name) => {
  const bar = page.getByRole('navigation', { name: 'Account' });
  if (name !== 'Clients') await bar.getByRole('button', { name: 'Account menu' }).click();
  await bar.getByRole('button', { name, exact: true }).click();
};
const btn = (name) => page.getByRole('button', { name, exact: true });
const heading = (name) => page.getByRole('heading', { name, exact: true, level: 1 }).waitFor();
const now = new Date();
const dd = (n) => String(n).padStart(2, '0');
const ddmmyyyy = `${dd(now.getDate())}/${dd(now.getMonth() + 1)}/${now.getFullYear()}`;
const fyYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1; // current April-March year

await page.goto(URL);
await page.getByRole('button', { name: 'Create an account' }).click();
await page.getByLabel('Your name').fill('Full Test');
await page.getByLabel('Firm name').fill('Full Test Associates');
await page.getByLabel('Email').fill(email);
await page.getByLabel('Password').fill(password);
await btn('Create firm account').click();
await page.getByRole('alert').getByText(/Terms/).waitFor();
await page.getByLabel('Accept terms').check();
await btn('Create firm account').click();
await page.getByTestId('onboarding').waitFor();
step('registration requires consent; onboarding shown');

await page.getByLabel('Business name').fill('Mehta Consulting');
await page.getByLabel('GSTIN (optional)').fill('27AAPFU0939F1ZV');
await btn('Add client').click();
await page.getByRole('listitem').getByText('Mehta Consulting').waitFor();
await btn('Open books').click();
await heading('Dashboard');
await page.getByRole('navigation', { name: 'Client sections' }).waitFor();
for (const g of ['Dashboard', 'Sales', 'Purchases', 'Accounting', 'Reports', 'Compliance', 'Setup']) await page.getByRole('navigation', { name: 'Client sections' }).getByText(g, { exact: true }).waitFor();
step('client opened; sidebar shows Sales, Purchases, Accounting, Reporting, Compliance, Setup');

// ---- contacts and products
await nav('Customers');
await heading('Customers');
await btn('New customer').click();
await page.getByLabel('Name', { exact: true }).fill('Acme Retail');
await page.getByLabel('State').selectOption({ label: '27 Maharashtra' });
await page.getByLabel('Email', { exact: true }).fill('accounts@acme.example');
await btn('Add contact').click();
await page.getByRole('cell', { name: 'Acme Retail' }).waitFor();
await nav('Suppliers');
await btn('New supplier').click();
await page.getByLabel('Name', { exact: true }).fill('Pro Advisors');
await page.getByLabel('PAN', { exact: true }).fill('AAAFP1234Q'); // with a PAN, 194J is 10%; without one, 206AA would make it 20%
await btn('Add contact').click();
await page.getByRole('cell', { name: 'Pro Advisors' }).waitFor();
await nav('Products and services');
await btn('New item').click();
await page.getByLabel('Code', { exact: true }).fill('CONS-01');
await page.getByLabel('Name', { exact: true }).fill('Consulting');
await page.getByLabel('HSN / SAC').fill('9983');
await page.getByLabel('Sale price (₹)').fill('500');
await btn('Save item').click();
await page.getByRole('cell', { name: 'CONS-01' }).waitFor();
step('customer, supplier and product added');

// ---- quote -> invoice
await nav('Quotes');
await btn('New quote').click();
await page.getByLabel('Contact').selectOption({ label: 'Acme Retail' });
await page.getByLabel('Add from catalogue').selectOption({ label: 'CONS-01 · Consulting' });
await btn('Create').click();
await page.getByText('Created QU-0001: total ₹590.00').waitFor();
await btn('Accepted').click();
await page.getByText('accepted', { exact: true }).waitFor();
await btn('Convert to invoice').click();
await page.getByText(/QU-0001 converted to INV\/\d\d-\d\d\/0001/).waitFor();
step('quote QU-0001 (Rs 500 + 18% = Rs 590) accepted and converted to an invoice');

// ---- invoice, payment, email
await nav('Invoices');
await heading('Invoices');
await btn('New invoice').click();
await page.getByLabel('Contact').selectOption({ label: 'Acme Retail' });
await page.getByLabel('Description 1').fill('Consulting hours');
await page.getByLabel('HSN 1').fill('9983');
await page.getByLabel('Qty 1').fill('2');
await page.getByLabel('Rate 1').fill('500');
await btn('Create').click();
await page.getByText(/Created INV\/\d\d-\d\d\/0002: total ₹1,180.00/).waitFor();
const row2 = page.getByRole('row', { name: /INV\/\d\d-\d\d\/0002/ });
await row2.getByRole('button', { name: 'Email' }).click();
await page.getByText(/queued to accounts@acme.example/).waitFor();
await row2.getByRole('button', { name: 'Pay' }).click();
await page.getByLabel('Payment account').selectOption({ label: '1010 Bank Account' });
await btn('Record payment').click();
await page.getByText('Payment recorded.').waitFor();
step('invoice Rs 1,180 (2 x 500 + 18% GST) created, emailed and paid');

await nav('Customers');
await page.getByRole('row', { name: /Acme Retail/ }).getByRole('button', { name: 'Statement' }).click();
await page.getByTestId('statement-closing').waitFor();
assert.equal(await page.getByTestId('statement-closing').innerText(), '590.00');
step('customer statement: 590 + 1,180 - 1,180 payment = 590 owed');

// ---- bill with TDS
if (process.env.SHOT_DIR) { await nav('Invoices'); await page.getByRole('cell', { name: /INV\/\d\d-\d\d\/0002/ }).first().waitFor(); await page.screenshot({ path: process.env.SHOT_DIR + '/invoices.png' }); }
await nav('Bills');
await btn('New bill').click();
await page.getByLabel('Contact').selectOption({ label: 'Pro Advisors' });
await page.getByLabel('TDS section').selectOption({ label: '194J · Professional / technical fees' });
await page.getByLabel('Description 1').fill('Audit fee');
await page.getByLabel('Rate 1').fill('60000');
await page.getByLabel('Account 1').selectOption({ label: '5530 Professional Fees' });
await btn('Create').click();
await page.getByText(/Created BILL\/\d\d-\d\d\/0001: total ₹60,000.00, TDS ₹6,000.00, net payable ₹54,000.00/).waitFor();
step('bill from unregistered supplier: no GST; 194J TDS Rs 6,000 deducted; Rs 54,000 payable');

// ---- bank: rule, import, match, accept rule suggestion
await nav('Bank accounts');
await heading('Bank accounts');
await page.getByLabel('Bank name').fill('HDFC Current');
await page.getByLabel('Bank ledger account').selectOption({ label: '1010 Bank Account' });
await btn('Add').click();
await page.getByRole('heading', { name: 'Reconcile' }).waitFor();
await page.getByLabel('Rule name').fill('Bank charges');
await page.getByLabel('Narration contains').fill('Bank charges');
await page.getByLabel('Rule direction').selectOption('out');
await page.getByLabel('Rule account').selectOption({ label: '5560 Bank Charges' });
await btn('Add rule').click();
await page.getByText(/contains "Bank charges"/).waitFor();
await page.getByLabel('Statement file').setInputFiles({ name: 'stmt.csv', mimeType: 'text/csv', buffer: Buffer.from(`Date,Narration,Debit,Credit\n${ddmmyyyy},NEFT Acme Retail,,1180\n${ddmmyyyy},Bank charges,15.50,\n`) });
await page.getByText('Imported 2 lines (0 duplicates skipped).').waitFor();
await page.getByText('Rule suggests Bank Charges').waitFor();
await page.getByRole('button', { name: /^Match #/ }).first().click();
await page.getByText('Matched.').waitFor();
await page.getByRole('button', { name: /Accept 1 rule suggestion/ }).click();
await page.getByText('1 line(s) booked by rules and reconciled.').waitFor();
assert.equal(await page.getByTestId('unreconciled').innerText(), '0');
step('statement imported; payment matched; bank rule booked the charge; nothing left to reconcile');

// ---- fixed assets
await nav('Fixed assets');
await btn('New asset').click();
await page.getByLabel('Name', { exact: true }).fill('Laptop');
await page.getByLabel('Purchase date').fill(`${fyYear}-04-10`);
await page.getByLabel('Cost (₹)').fill('12000');
await page.getByLabel('Rate per year (%)').fill('20');
await btn('Save asset').click();
await page.getByRole('cell', { name: 'Laptop' }).waitFor();
await page.getByLabel('Post depreciation up to').fill(`${fyYear}-06-30`);
await btn('Run').click();
await page.getByText('Posted 3 entries, ₹600.00 in total.').waitFor();
step('fixed asset Rs 12,000 at 20% straight line: 3 months = Rs 600 depreciation posted');

// ---- repeating invoice
await nav('Repeating invoices');
await btn('New repeating invoice').click();
await page.getByLabel('Contact').selectOption({ label: 'Acme Retail' });
await page.getByLabel('Description 1').fill('Monthly retainer');
await page.getByLabel('Rate 1').fill('2000');
await btn('Save schedule').click();
await page.getByRole('cell', { name: 'monthly' }).waitFor();
step('repeating invoice scheduled');

// ---- dashboard
await nav('Dashboard');
await page.getByTestId('ytd-profit').waitFor();
assert.match(await page.getByTestId('ytd-profit').innerText(), /59,115\.50/);
assert.match(await page.getByTestId('receivables').innerText(), /590\.00/);
await page.getByRole('img', { name: 'Monthly chart' }).first().waitFor();
step('dashboard: profit -59,115.50, 590 owed to you, charts drawn');
if (process.env.SHOT_DIR) await page.screenshot({ path: process.env.SHOT_DIR + '/dashboard.png' });

// ---- reports
await nav('Reports');
await btn('Profit & loss').click();
await page.getByTestId('net-profit').waitFor();
assert.equal(await page.getByTestId('net-profit').innerText(), '-59,115.50');
step('P&L: 1,500 income - 60,000 fees - 15.50 charges - 600 depreciation = -59,115.50');
const [dl] = await Promise.all([page.waitForEvent('download'), btn('Export PDF').click()]);
assert.equal(dl.suggestedFilename(), 'pnl.pdf');
const [dlx] = await Promise.all([page.waitForEvent('download'), btn('Export Excel').click()]);
assert.equal(dlx.suggestedFilename(), 'pnl.xlsx');
await btn('Cash flow').click();
await page.getByTestId('cf-closing').waitFor();
assert.equal(await page.getByTestId('cf-closing').innerText(), '1,164.50');
await btn('Trial balance').click();
await page.getByTestId('tb-debit').waitFor();
assert.equal(await page.getByTestId('tb-debit').innerText(), await page.getByTestId('tb-credit').innerText());
await btn('GSTR-3B').click();
await page.getByText('3.1(a) Outward taxable').waitFor();
await btn('Balance sheet').click();
await page.getByText('✓ Assets = Liabilities + Equity').waitFor();
step('exports to PDF/Excel; cash flow closes at 1,164.50; trial balance, GSTR-3B and balance sheet agree');

// ---- compliance, import
await nav('Tasks and deadlines');
await btn('Add GST/TDS due dates').click();
await page.getByText(/Added \d+ GST\/TDS due dates/).waitFor();
await nav('Documents');
await page.getByLabel('Upload file').setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('Form 16 to follow') });
await page.getByText('Uploaded note.txt').waitFor();
await nav('Import data');
await btn('Check (dry run)').click();
await page.getByText('Looks good: 1 record(s) ready to import.').waitFor();
await nav('Organisation settings');
await page.getByLabel('Business name').fill('Mehta Consulting LLP');
await btn('Save').click();
await page.getByText(/Saved. State code is now 27/).waitFor();
step('deadlines generated, file uploaded, import dry run passed, settings saved');

// ---- URL routing: refresh and back button keep the page
await nav('Reports');
await heading('Reports');
await page.reload();
await heading('Reports');
await page.goBack();
await heading('Organisation settings');
step('refresh keeps the current page; browser back goes to the previous one');

// ---- account pages
await account('Billing');
await page.getByTestId('current-plan').waitFor();
assert.equal(await page.getByTestId('current-plan').innerText(), 'Practice');
await page.locator('section', { has: page.getByRole('heading', { name: 'Starter' }) }).getByRole('button').click();
await page.getByText(/Switched to Starter\. Invoice SUB-/).waitFor();
await account('Privacy');
const [mine] = await Promise.all([page.waitForEvent('download'), btn('Download my data').click()]);
assert.equal(mine.suggestedFilename(), 'my-data.json');
await account('Help');
await page.getByText('Getting started').waitFor();
step('billing plan change with GST invoice; personal data export; help page');

await page.screenshot({ path: process.env.SHOT ?? 'e2e-full.png', fullPage: true });
await nav('Dashboard').catch(() => {});
await browser.close();
const real = errors.filter((e) => !/40[0-9]/.test(e));
assert.equal(real.length, 0, 'console errors: ' + real.join(' | '));
console.log('ALL FULL BROWSER CHECKS PASSED');
