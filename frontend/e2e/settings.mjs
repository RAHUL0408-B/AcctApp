// Browser test for the settings: the Settings hub, organisation details and logo, financial settings and lock dates,
// invoice numbering, payment services (bank and UPI QR), email templates, reminders, currencies, tax rates, history,
// and where the Back button shows.
// Needs API (:3000) and web (:5173) running and Google Chrome.  Run: node e2e/settings.mjs
import { chromium } from 'playwright-core';
import assert from 'assert';

const URL = process.env.WEB_URL ?? 'http://127.0.0.1:5173';
const email = `set${Date.now()}@example.com`, password = 'Passphrase-1234';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(Number(process.env.STEP_TIMEOUT ?? 30000));
const errors = [];
page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && errors.push(m.text()));
const step = (s) => console.log('✓', s);
const btn = (name) => page.locator('main').getByRole('button', { name, exact: true });
const heading = (name) => page.getByRole('heading', { name, exact: true, level: 1 }).waitFor();
const bar = () => page.getByRole('navigation', { name: 'Client sections' });
const menu = async (group, item) => {
  const box = bar().getByRole('group', { name: group, exact: true });
  if ((await box.count()) === 0) return bar().getByRole('button', { name: item, exact: true }).click();
  const head = box.getByRole('button', { name: group, exact: true });
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
  await box.getByRole('button', { name: item, exact: true }).click();
};
const ok = (re) => page.getByText(re).first().waitFor();
const back = () => page.getByRole('button', { name: 'Go back' });
const tile = async (name) => { await page.getByRole('button', { name: new RegExp(`^${name}`) }).first().click(); };
const hub = async () => { await menu('Settings', 'Settings'); await heading('Settings'); };
/** Wait until an input shows the value (forms fill in once their data arrives). */
const valueIs = async (loc, v) => { for (let i = 0; i < 100; i++) { if ((await loc.inputValue()) === v) return; await page.waitForTimeout(100); } assert.strictEqual(await loc.inputValue(), v); };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');

await page.goto(URL);
await page.getByRole('button', { name: 'Create an account', exact: true }).click();
await page.getByLabel('Your name').fill('Settings CA');
await page.getByLabel('Firm name').fill('Settings Associates');
await page.getByLabel('Email').fill(email);
await page.getByLabel('Password').fill(password);
await page.getByLabel('Accept terms').check();
await page.getByRole('button', { name: 'Create firm account', exact: true }).click();
assert.strictEqual(await back().count(), 0, 'no Back button on the client list');
await page.getByLabel('Business name').fill('Shree Traders');
await page.getByLabel('GSTIN (optional)').fill('27AAPFU0939F1ZV');
await page.getByRole('button', { name: 'Add client', exact: true }).click();
await page.getByRole('button', { name: 'Open books', exact: true }).click();
await heading('Dashboard');
const orgId = Number(page.url().match(/#\/o\/(\d+)\//)[1]);
const token = await page.evaluate(() => sessionStorage.getItem('token'));

// ---- Back button only where there is somewhere to go back to
assert.strictEqual(await back().count(), 0, 'no Back button on the dashboard');
await menu('Sales', 'Invoices');
await heading('Invoices');
await back().click();
await heading('Dashboard');
assert.strictEqual(await back().count(), 0);
step('Back button: hidden on the client list and the dashboard, shown on other screens, and returns to the previous one');

// ---- the hub
await hub();
for (const g of ['General', 'Sales and purchases', 'Accounting']) await page.getByRole('region', { name: g }).waitFor();
for (const t of ['Organisation details', 'Users', 'Financial settings', 'Invoice settings', 'Payment services', 'Email settings', 'Invoice reminders', 'Chart of accounts', 'Tax rates', 'Currencies', 'Cost centres', 'Conversion balances', 'History and notes', 'Export templates'])
  await page.getByRole('button', { name: new RegExp(`^${t}`) }).first().waitFor();
await page.getByLabel('Search settings').fill('upi');
await page.getByRole('button', { name: /^Payment services/ }).waitFor();
assert.strictEqual(await page.getByRole('button', { name: /^Tax rates/ }).count(), 0, 'search narrows the list');
await page.getByLabel('Search settings').fill('');
step('Settings hub lists every setting in three groups, with search');

// ---- organisation details and logo
await tile('Organisation details');
await heading('Organisation settings');
await page.getByRole('button', { name: /^Edit (settings|organisation details)$/ }).click();
await page.getByLabel('Legal name (if different)').fill('Shree Traders Private Limited');
await page.getByLabel('Business type').selectOption('private_limited');
await page.getByLabel('TAN').fill('mums12345b');
await page.getByLabel('Address line 1').fill('12 MG Road');
await page.getByLabel('City').fill('Pune');
await page.getByLabel('PIN code').fill('411001');
await page.getByLabel('Phone').fill('+91 20 1234 5678');
await btn('Save details').click();
await ok('Organisation details saved. They are printed on your invoices.');
await page.getByLabel('PIN code').fill('0110');
await btn('Save details').click();
await page.getByRole('alert').getByText(/PIN code must be 6 digits/).waitFor();
await page.getByLabel('PIN code').fill('411001');
await page.getByLabel('Logo file').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG });
await ok('Logo saved. It now appears on your invoices.');
await page.getByRole('img', { name: 'Organisation logo' }).waitFor();
await back().click();
await heading('Settings');
step('organisation details saved (wrong PIN refused), logo uploaded; Back returns to Settings');

// ---- financial settings: lock dates
await tile('Financial settings');
await heading('Financial settings');
await valueIs(page.getByLabel('Financial year'), 'April to March');
await page.getByRole('button', { name: /^Edit (settings|organisation details)$/ }).click();
await page.getByLabel('Staff lock date').fill('2026-03-31');
await page.getByLabel('Password to confirm').fill(password);
await btn('Save lock dates').click();
await ok('Lock dates saved. Staff: up to 2026-03-31.');
await page.getByLabel('Password to confirm').fill(password);
await btn('Remove lock dates').click();
await ok('Lock dates removed. All periods are open again.');
step('financial year shown as April to March; staff lock date set and removed');

// ---- invoice settings: prefixes and next number
await hub();
await tile('Invoice settings');
await heading('Invoice settings');
await page.getByRole('button', { name: /^Edit (settings|organisation details)$/ }).click();
await page.getByLabel('Invoices prefix').fill('si');
await btn('Save prefixes').click();
await ok(/Prefixes saved/);
await page.getByTestId('next-invoice').getByText(/^SI\/\d\d-\d\d\/0001$/).waitFor();
await page.getByLabel('Invoices next number').fill('100');
await page.getByRole('row', { name: /Invoices/ }).getByRole('button', { name: 'Set' }).click();
await ok('Invoices will continue from 100.');
await page.getByTestId('next-invoice').getByText(/^SI\/\d\d-\d\d\/0100$/).waitFor();
step('invoice prefix changed to SI and numbering continues from 100');

// ---- payment services
await hub();
await tile('Payment services');
await page.getByRole('button', { name: /^Edit (settings|organisation details)$/ }).click();
await page.getByLabel('Account name').fill('Shree Traders');
await page.getByLabel('Bank name').fill('HDFC Bank');
await page.getByLabel('Account number').fill('50100012345678');
await page.getByLabel('IFSC').fill('hdfc0001234');
await page.getByLabel('UPI ID').fill('shree@okhdfcbank');
await page.getByLabel('Print these payment details on sales invoices').check();
await page.getByLabel(/Add a UPI QR code/).check();
await btn('Save').click();
await ok('Saved. Sales invoices now show how to pay, with a UPI QR code for the amount due.');
step('bank details and UPI ID saved, printed on invoices with a QR code');

// ---- email settings
await hub();
await tile('Email settings');
await page.getByRole('button', { name: /^Edit (settings|organisation details)$/ }).click();
await page.getByLabel('Sender name').fill('Shree Accounts');
await page.getByLabel('Replies go to').fill('accounts@shree.in');
await page.getByLabel('Invoice email subject').fill('Your invoice {number} from {org}');
await btn('Preview invoice email').click();
await page.getByTestId('email-preview').getByText('Subject: Your invoice INV/26-27/0014 from Shree Traders').waitFor();
await btn('Save').click();
await ok('Email settings saved.');
step('email sender, reply-to and template saved; preview fills in the words');

// ---- reminders
await hub();
await tile('Invoice reminders');
await page.getByRole('button', { name: /^Edit (settings|organisation details)$/ }).click();
await page.getByLabel('Send reminders automatically every day').check();
await page.getByLabel('Days between reminders').fill('5');
await btn('Save').click();
await ok('Saved. Reminders go out automatically, at most once every 5 day(s) per invoice.');
await btn('Send reminders now').click();
await ok('No overdue invoice needs a reminder right now.');
step('automatic reminders turned on every 5 days; send now works');

// ---- currencies, and the rate filled in on a new invoice
await hub();
await tile('Currencies');
await page.getByRole('button', { name: /^Edit (settings|organisation details)$/ }).click();
await page.getByLabel('Currency code').fill('usd');
await page.getByLabel('Default rate').fill('83.5');
await btn('Add or update').click();
await ok('USD saved at ₹83.5.');
await page.getByTestId('currency-rows').getByRole('cell', { name: 'USD', exact: true }).waitFor();
await menu('Sales', 'Invoices');
await btn('New invoice').click();
await page.getByLabel('Currency').selectOption('USD');
await valueIs(page.getByLabel('Exchange rate'), '83.5');
await back().click();
step('USD added at Rs 83.50; a new invoice in USD starts from that rate');

// ---- tax rates and history
await hub();
await tile('Tax rates');
await page.getByTestId('gst-rates').getByRole('cell', { name: 'CGST 9% + SGST 9%', exact: true }).waitFor();
await page.getByTestId('tds-rates').getByRole('cell', { name: '194C', exact: true }).waitFor();
await hub();
await tile('History and notes');
await page.getByTestId('history-rows').getByText('Changed settings').first().waitFor();
await page.getByTestId('history-rows').getByText('Saved a currency').first().waitFor();
step('tax rates list GST and TDS; history shows each change and who made it');

// ---- an invoice carries the new number, logo and QR
const api = async (path, body) => (await fetch(`${URL}/api/orgs/${orgId}${path}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined }));
const cust = await (await api('/contacts', { kind: 'customer', name: 'Kapoor Stores', stateCode: '27' })).json();
const inv = await (await api('/documents', { docType: 'invoice', contactId: cust.id, issueDate: new Date().toISOString().slice(0, 10), lines: [{ description: 'Steel', quantity: 1, rate: 100000, gstRateBp: 1800 }] })).json();
assert.match(inv.number, /^SI\/\d\d-\d\d\/0100$/);
const pdf = Buffer.from(await (await api(`/documents/${inv.id}/pdf`)).arrayBuffer());
assert((pdf.toString('latin1').match(/\/Subtype\s*\/Image/g) ?? []).length >= 2, 'logo and QR code in the invoice PDF');
step(`invoice ${inv.number} printed with the logo and a UPI QR code`);

assert.deepStrictEqual(errors, [], 'no console errors: ' + errors.join(' | '));
console.log('ALL SETTINGS BROWSER CHECKS PASSED');
await browser.close();
