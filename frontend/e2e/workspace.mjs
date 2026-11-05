// Browser test for the Phase 7 screens: login page, organisation menu, Xero-style menus, "+" menu and Alt shortcuts,
// search, notifications, setup guide, sales overview and settings, spend / transfer money, short-term cash flow,
// business snapshot, TDS report, favourite reports, projects and last login.
// Needs the app running (API and web). Run: node e2e/workspace.mjs   (WEB_URL and STEP_TIMEOUT work as in full.mjs)
import { chromium } from 'playwright-core';

const URL = process.env.WEB_URL ?? 'http://127.0.0.1:5173';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
page.setDefaultTimeout(Number(process.env.STEP_TIMEOUT ?? 30000));
const errors = [];
page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && errors.push(m.text()));
page.on('dialog', (d) => { errors.push('unexpected dialog: ' + d.message()); d.dismiss(); });
const step = (s) => console.log('✓', s);
const btn = (name) => page.getByRole('button', { name, exact: true });
const heading = (name) => page.getByRole('heading', { name, exact: true, level: 1 }).waitFor();
const bar = () => page.getByRole('navigation', { name: 'Client sections' });
const top = (name) => page.locator('header').getByRole('button', { name, exact: true });
const menu = async (group, item) => { await bar().getByRole('button', { name: group, exact: true }).click(); await top(item).click(); };
const ok = (re) => page.getByText(re).first().waitFor();
const email = `ws${Date.now()}@example.com`, password = 'Passphrase-1234';
const today = new Date().toISOString().slice(0, 10);

// ---- login page
await page.goto(URL);
await page.getByRole('heading', { name: 'Log in', level: 1 }).waitFor();
await page.getByRole('heading', { name: 'A FinTaxVers product' }).waitFor();
for (const s of ['GST', 'Income Tax', 'Tax Audit', 'ROC & Company Registration']) await page.getByRole('listitem').getByText(s, { exact: true }).waitFor();
await page.getByText('Nagpur & Pan-India').first().waitFor();
step('login page shows the product introduction and FinTaxVers services');

await btn('Create an account').click();
await page.getByLabel('Your name').fill('Asha Rao');
await page.getByLabel('Firm name').fill('Rao & Co');
await page.getByLabel('Email').fill(email);
await page.getByLabel('Password').fill(password);
await page.getByLabel('Accept terms').check();
await btn('Create firm account').click();
await page.getByLabel('Business name').fill('Rao Design Studio');
await page.getByLabel('Chart of accounts').selectOption('services');
await page.getByLabel('GSTIN (optional)').fill('27AAPFU0939F1ZV');
await btn('Add client').click();
await btn('Open books').click();
await heading('Dashboard');

// ---- menus and setup guide
for (const g of ['Home', 'Sales', 'Purchases', 'Reporting', 'Accounting', 'Tax', 'Contacts', 'Projects']) await bar().getByRole('button', { name: g, exact: true }).waitFor();
await bar().getByRole('button', { name: 'Sales', exact: true }).click();
for (const i of ['Sales overview', 'Invoices', 'Quotes', 'Products and services', 'Customers', 'Sales settings']) await top(i).waitFor();
await page.keyboard.press('Escape');
await page.getByTestId('guide-progress').getByText('1 of 6 completed').waitFor();
step('Xero-style menus; setup guide at 1 of 6');

// ---- organisation menu
await page.getByRole('button', { name: 'Organisation menu' }).click();
for (const i of ['Settings', 'Subscription and billing', '+ Add new organisation', 'Practice overview']) await top(i).waitFor();
await page.keyboard.press('Escape');
step('organisation menu: settings, billing, switch, add, practice overview');

// ---- sales settings, customer via "+" menu, invoice via Alt+I
await menu('Sales', 'Sales settings');
await heading('Sales settings');
await page.getByLabel('Invoice due days').fill('15');
await page.getByLabel('Invoice terms').fill('Pay by NEFT to HDFC Bank');
await btn('Save').click();
await ok('Saved. New documents will use these defaults.');
await page.getByRole('button', { name: 'Create new' }).click();
for (const i of ['Invoice', 'Bill', 'Contact', 'Spend money', 'Transfer money']) await top(i).waitFor();
await top('Contact').click();
await heading('All contacts');
await page.getByLabel('Contact type').selectOption('customer');
await page.getByLabel('Name', { exact: true }).fill('Bright Homes');
await page.getByLabel('State').selectOption({ label: '27 Maharashtra' });
await btn('Add contact').click();
await page.getByRole('cell', { name: 'Bright Homes' }).waitFor();
await page.keyboard.press('Alt+I');
await heading('Invoices');
await page.getByLabel('Contact', { exact: true }).fill('Bright Homes');
await page.getByLabel('Description 1').fill('Interior design');
await page.getByLabel('Rate 1').fill('10000');
await btn('Create').click();
await ok(/Created INV\/\d\d-\d\d\/0001: total ₹11,800\.00/);
const due = new Date(Date.now() + 15 * 86400000).toISOString().slice(0, 10);
await page.getByRole('cell', { name: due }).waitFor();
step('sales settings: 15-day terms applied; "+" menu opened a new contact; Alt+I opened a new invoice');

// ---- sales overview
await menu('Sales', 'Sales overview');
await heading('Sales overview');
await page.getByTestId('awaiting-payment').getByText('₹11,800.00').waitFor();
step('sales overview: Rs 11,800 awaiting payment');

// ---- bank, spend and transfer money
await menu('Accounting', 'Bank accounts');
await page.getByLabel('Bank name').fill('HDFC');
await page.getByLabel('Bank ledger account').selectOption({ label: '1010 Bank Account' });
await btn('Add').click();
await page.getByRole('heading', { name: 'Reconcile' }).waitFor();
await menu('Accounting', 'Chart of accounts');
await page.getByLabel('Code').fill('1020');
await page.getByLabel('Name').fill('ICICI Bank');
await page.locator('select').filter({ hasText: 'liability' }).selectOption('asset');
await page.getByLabel('Group').fill('Cash and Bank');
await btn('Add').click();
await page.getByText('1020 · ICICI Bank').waitFor();
await menu('Accounting', 'Bank accounts');
await page.getByLabel('Bank name').fill('ICICI');
await page.getByLabel('Bank ledger account').selectOption({ label: '1020 ICICI Bank' });
await btn('Add').click();
await page.getByRole('option', { name: 'ICICI' }).waitFor({ state: 'attached' });
await menu('Accounting', 'Receive money');
await heading('Receive money');
await page.getByLabel('Payee').fill('Owner');
await page.getByLabel('Money account 1').selectOption({ label: "3000 Owner's Capital" });
await page.getByLabel('Money amount 1').fill('50000');
await btn('Save receipt').click();
await ok(/Received ₹50,000\.00 into HDFC/);
await page.keyboard.press('Alt+S');
await heading('Spend money');
await page.getByLabel('Payee').fill('Landlord');
await page.getByLabel('Money account 1').selectOption({ label: '5500 Rent' });
await page.getByLabel('Money description 1').fill('Office rent');
await page.getByLabel('Money amount 1').fill('12000');
await btn('Save spend').click();
await ok(/Spent ₹12,000\.00 from HDFC/);
await btn('Transfer money').click();
await heading('Transfer money');
await page.getByLabel('To bank account').selectOption({ label: 'ICICI' });
await page.getByLabel('Transfer amount').fill('8000');
await btn('Transfer').click();
await ok(/Transferred ₹8000/);
step('receive Rs 50,000, spend Rs 12,000 on rent, transfer Rs 8,000 to ICICI');

// ---- reports: short-term cash flow, snapshot, favourites
await menu('Reporting', 'Short-term cash flow');
await heading('Reports');
await page.getByTestId('stcf-projected').getByText('₹49,800.00').waitFor(); // 38,000 cash + 11,800 due in 15 days
await btn('☆ Add to favourites').click();
await btn('★ Favourite').waitFor();
await bar().getByRole('button', { name: 'Reporting', exact: true }).click();
await page.getByText('Favourite reports ★').waitFor();
await page.keyboard.press('Escape');
await menu('Reporting', 'Business snapshot');
await page.getByTestId('scorecard').getByText('Current ratio').waitFor();
step('short-term cash flow projects Rs 49,800; starred report in the menu; business snapshot scorecard');

// ---- TDS
await menu('Contacts', 'Suppliers');
await btn('New supplier').click();
await page.getByLabel('Name', { exact: true }).fill('CA Sharma');
await page.getByLabel('PAN').fill('ABCPS1234K');
await page.getByLabel('State').selectOption({ label: '27 Maharashtra' });
await btn('Add contact').click();
await page.getByRole('cell', { name: 'CA Sharma' }).waitFor();
await page.keyboard.press('Alt+B');
await heading('Bills');
await page.getByLabel('Contact', { exact: true }).fill('CA Sharma');
await page.getByLabel('TDS section').selectOption('194J');
await page.getByLabel('Description 1').fill('Audit fees');
await page.getByLabel('Rate 1').fill('60000');
await page.getByLabel('GST 1').selectOption({ index: 0 });
await btn('Create').click();
await ok(/TDS ₹6,000\.00/);
await menu('Tax', 'TDS deducted');
await page.getByTestId('tds-total').getByText('6,000.00').waitFor();
step('TDS deducted report: Rs 6,000 under 194J');

// ---- notifications and search
await page.getByRole('button', { name: 'Search' }).click();
await page.getByLabel('Search this organisation').fill('bright');
await page.getByText(/INV\/\d\d-\d\d\/0001 · Bright Homes/).click();
await heading('Invoices');
await page.getByRole('button', { name: 'Notifications' }).click();
await page.getByText(/bill\(s\) due in the next 7 days|You are all caught up/).first().waitFor();
await page.keyboard.press('Escape');
step('search found the invoice; notifications open');

// ---- projects
await bar().getByRole('button', { name: 'Projects', exact: true }).click();
await heading('Projects');
await btn('New project').click();
await page.getByLabel('Project name').fill('Kitchen redesign');
await page.getByLabel('Project customer').selectOption({ label: 'Bright Homes' });
await page.getByLabel('Estimate (₹)').fill('20000');
await btn('Create project').click();
await page.getByLabel('Hours').fill('1.5');
await page.getByLabel('Time description').fill('Site visit');
await page.getByLabel('Hourly rate').fill('1000');
await btn('Add time').click();
await ok('Time added.');
await page.getByLabel('Cost amount').fill('500');
await page.getByLabel('Cost description').fill('Samples');
await btn('Add cost').click();
await ok('Cost added.');
await page.getByTestId('project-unbilled').getByText('₹2,000.00').waitFor();
await btn('Create invoice').click();
await ok(/Created INV\/\d\d-\d\d\/0002: ₹2,000\.00 \+ GST = ₹2,360\.00/);
step('project: 1.5 h at Rs 1,000 + Rs 500 cost invoiced as Rs 2,000 + GST');

// ---- last login
await page.getByRole('button', { name: 'Account menu' }).click();
await btn('Log out').click();
await page.getByLabel('Email').fill(email);
await page.getByLabel('Password').fill(password);
await btn('Log in').click();
await page.getByRole('button', { name: 'Account menu' }).click();
await btn('Log out').click();
await page.getByLabel('Email').fill(email);
await page.getByLabel('Password').fill(password);
await btn('Log in').click();
await btn('Open books').first().click();
await page.getByTestId('last-login').getByText(/Last login: (just now|\d+ minutes? ago)/).waitFor();
step('home shows the last login');

await page.screenshot({ path: process.env.SHOT ?? 'e2e-workspace.png', fullPage: true });
await browser.close();
if (errors.length) { console.error('Console errors:', errors); process.exit(1); }
console.log(`ALL WORKSPACE BROWSER CHECKS PASSED (${today})`);
