// Browser test for the Phase 6 features: export invoice in USD, stock-tracked purchases, approvals, expense claims,
// tracking categories, budgets, new reports, year-end screen and the practice overview.
// Needs the app running (API and web). Run: node e2e/more.mjs   (WEB_URL and STEP_TIMEOUT work as in full.mjs)
import { chromium } from 'playwright-core';

const URL = process.env.WEB_URL ?? 'http://127.0.0.1:5173';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
page.setDefaultTimeout(Number(process.env.STEP_TIMEOUT ?? 30000));
const errors = [];
page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && errors.push(m.text()));
page.on('dialog', (d) => { errors.push('unexpected dialog: ' + d.message()); d.dismiss(); });
const step = (s) => console.log('✓', s);
const btn = (name) => page.getByRole('button', { name, exact: true });
const heading = (name) => page.getByRole('heading', { name, exact: true, level: 1 }).waitFor();
const nav = async (name) => {
  const bar = page.getByRole('navigation', { name: 'Client sections' });
  const item = bar.getByRole('button', { name, exact: true });
  if (!(await item.isVisible())) {
    const groups = bar.locator('button[aria-haspopup]');
    for (let i = 0; i < await groups.count() && !(await item.isVisible()); i++) await groups.nth(i).click();
  }
  await item.click();
};
const ok = (re) => page.getByText(re).first().waitFor();

await page.goto(URL);
await btn('Create an account').click();
await page.getByLabel('Your name').fill('Global Owner');
await page.getByLabel('Firm name').fill('Global CA');
await page.getByLabel('Email').fill(`more${Date.now()}@example.com`);
await page.getByLabel('Password').fill('Passphrase-1234');
await page.getByLabel('Accept terms').check();
await btn('Create firm account').click();
await page.getByLabel('Business name').fill('Global Exports');
await page.getByLabel('GSTIN (optional)').fill('27AAPFU0939F1ZV');
await btn('Add client').click();
await btn('Open books').click();
await heading('Dashboard');

// ---- settings: LUT
await nav('Organisation settings');
await page.getByLabel('LUT number (for exports without GST)').fill('AD2704260012345');
await btn('Save').click();
await ok(/Saved\. State code is now 27/);
step('LUT number saved in organisation settings');

// ---- contacts
await nav('Customers');
await btn('New customer').click();
await page.getByLabel('Name', { exact: true }).fill('Acme Inc');
await page.getByLabel('Country').fill('US');
await btn('Add contact').click();
await page.getByRole('cell', { name: 'Acme Inc' }).waitFor();
await btn('New customer').click();
await page.getByLabel('Name', { exact: true }).fill('Local Co');
await page.getByLabel('State').selectOption({ label: '27 Maharashtra' });
await btn('Add contact').click();
await page.getByRole('cell', { name: 'Local Co' }).waitFor();
await nav('Suppliers');
await btn('New supplier').click();
await page.getByLabel('Name', { exact: true }).fill('Widget Maker');
await page.getByLabel('State').selectOption({ label: '27 Maharashtra' });
await btn('Add contact').click();
await page.getByRole('cell', { name: 'Widget Maker' }).waitFor();

// ---- export invoice in USD
await nav('Invoices');
await btn('New invoice').click();
await page.locator('datalist option').first().waitFor({ state: 'attached' });
await page.getByLabel('Contact', { exact: true }).fill('Acme Inc');
await page.getByLabel('Supply type').selectOption({ label: 'Export under LUT (no GST)' });
await page.getByLabel('Currency').fill('USD');
await page.getByLabel('Exchange rate').fill('83.25');
await page.getByLabel('Description 1').fill('Software services');
await page.getByLabel('Rate 1').fill('1000');
await btn('Create').click();
await ok(/Created INV\/\d\d-\d\d\/0001: total ₹83,250\.00 \(USD 1,000\.00\)/);
await page.getByText('USD 1,000.00').first().waitFor();
step('export invoice: USD 1,000 at Rs 83.25 = Rs 83,250, no GST');

// ---- stock-tracked item and purchase
await nav('Products and services');
await btn('New item').click();
await page.getByLabel('Code', { exact: true }).fill('WID');
await page.getByLabel('Name', { exact: true }).fill('Widget');
await page.getByLabel('Item kind').selectOption('goods');
await page.getByLabel('Track stock').check();
await page.getByLabel('Purchase price (₹)').fill('100');
await btn('Save item').click();
await page.getByRole('cell', { name: 'WID', exact: true }).waitFor();
await nav('Bills');
await btn('New bill').click();
await page.locator('datalist option').first().waitFor({ state: 'attached' });
await page.getByLabel('Contact', { exact: true }).fill('Widget Maker');
await page.getByLabel('Add from catalogue').selectOption({ label: 'WID · Widget' });
await page.getByText('stock', { exact: true }).first().waitFor();
await page.getByLabel('Qty 1').fill('10');
await btn('Create').click();
await ok(/Created BILL\/\d\d-\d\d\/0001/);
await nav('Inventory');
await heading('Inventory');
await page.getByTestId('stock-value').getByText('₹1,000.00').waitFor();
await page.getByText('Yes', { exact: true }).waitFor();
await btn('History').click();
await page.getByTestId('stock-moves').getByText('purchase').waitFor();
step('10 widgets bought at Rs 100: stock Rs 1,000, agrees with the Inventory account');

// ---- approval
await nav('Invoices');
await btn('New invoice').click();
await page.locator('datalist option').first().waitFor({ state: 'attached' });
await page.getByLabel('Contact', { exact: true }).fill('Local Co');
await page.getByLabel('Description 1').fill('Consulting');
await page.getByLabel('Rate 1').fill('200');
await btn('Submit for approval').click();
await ok(/Sent for approval \(total ₹236\.00\)/);
await nav('Awaiting approval');
await heading('Awaiting approval');
await btn('Approve').click();
await ok(/Approved and posted as INV\/\d\d-\d\d\/0002/);
step('invoice submitted for approval, approved and posted');

// ---- expense claim
await nav('Expense claims');
await page.getByLabel('What was it for?').fill('Client visit');
await page.getByLabel('Claim description 1').fill('Taxi');
await page.getByLabel('Claim account 1').selectOption({ label: '5540 Travel and Conveyance' });
await page.getByLabel('Claim amount 1').fill('450');
await btn('Submit claim').click();
await ok(/Claim for ₹450\.00 submitted/);
await btn('Approve').click();
await ok(/Approved: the expenses are booked/);
await page.getByLabel('Repay from').selectOption({ label: '1010 Bank Account' });
await btn('Repay').click();
await ok('Repaid.');
await page.getByText('paid', { exact: true }).waitFor();
step('expense claim of Rs 450 submitted, approved and repaid');

// ---- tracking and budgets
await nav('Cost centres');
await page.getByLabel('Group name (for example Branch)').fill('Branch');
await page.getByLabel('Cost centres, separated by commas').fill('Mumbai, Pune');
await btn('Add group').click();
await page.getByText('Pune', { exact: true }).waitFor();
await nav('Budgets');
await page.getByLabel('Name', { exact: true }).fill('Plan');
await btn('Create budget').click();
await page.getByLabel('Budget account').selectOption({ label: '4000 Service Revenue' });
await page.getByLabel('Amount per month (₹)').fill('1000');
await btn('Set for all 12 months').click();
await ok('Saved for every month of the year.');
await page.getByRole('cell', { name: '4000 Service Revenue' }).waitFor();
step('tracking category Branch (Mumbai, Pune) and a Rs 1,000/month revenue budget');

// ---- reports
await nav('All reports');
await btn('P&L by month').click();
await page.getByTestId('grid-net').waitFor();
await btn('Budget vs actual').click();
await page.getByTestId('bva').getByText('4000 Service Revenue').waitFor();
await btn('GSTR-3B').click();
await page.getByText('3.1(b) Zero-rated (exports, SEZ)').waitFor();
await page.getByRole('cell', { name: '83,250.00' }).first().waitFor();
step('P&L by month, budget vs actual and GSTR-3B with the zero-rated export');

// ---- year-end and practice overview
await nav('Year-end close');
await heading('Year-end close');
await page.getByTestId('year-profit').waitFor();
await page.getByRole('button', { name: 'Account menu' }).click();
await page.getByRole('navigation', { name: 'Account' }).getByRole('button', { name: 'Practice', exact: true }).click();
await heading('Practice overview');
await page.getByTestId('practice-table').getByText('Global Exports').waitFor();
await page.getByTestId('practice-clients').getByText('1', { exact: true }).waitFor();
step('year-end screen and practice overview');

await page.screenshot({ path: process.env.SHOT ?? 'e2e-more.png', fullPage: true });
await browser.close();
if (errors.length) { console.error('Console errors:', errors); process.exit(1); }
console.log('ALL NEW-FEATURE BROWSER CHECKS PASSED');
