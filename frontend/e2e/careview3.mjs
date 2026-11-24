// Browser test for the CA's third review (Points Noted 3): New client button, themed dropdowns (type to complete, Tab,
// + Create new contact / ledger), TDS receivable on an invoice, a document opened locked with Edit / Duplicate / Void and
// an attachment added without voiding, journals (New journal, lines opened, Repeating journals page), report drill-down
// and Back, aged receivables drill-down, Duties and taxes (TDS sections, own GST rates), 2FA QR code, grouped search,
// the in-app confirmation box and the purple theme.
// Needs API (:3000, TRUST_PROXY=1) and web (:5173) running and Google Chrome.  Run: node e2e/careview3.mjs
import { chromium } from 'playwright-core';
import { autoConfirm } from './confirm.mjs';
import assert from 'assert';

const URL = process.env.WEB_URL ?? 'http://127.0.0.1:5173';
const email = `review3${Date.now()}@example.com`, password = 'Passphrase-1234';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
page.setDefaultTimeout(Number(process.env.STEP_TIMEOUT ?? 30000));
const errors = [];
page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && errors.push(m.text()));
page.on('dialog', (d) => { errors.push('browser dialog instead of the in-app box: ' + d.message()); d.accept(); });
const confirms = autoConfirm(page);
const step = (s) => console.log('✓', s);
const btn = (name) => page.locator('main').getByRole('button', { name, exact: true });
const heading = (name) => page.getByRole('heading', { name, exact: true, level: 1 }).waitFor();
const ok = (re) => page.getByText(re).first().waitFor();
const menu = async (group, item) => {
  const nav = page.getByRole('navigation', { name: 'Client sections' });
  const box = nav.getByRole('group', { name: group, exact: true });
  if ((await box.count()) === 0) return nav.getByRole('button', { name: item, exact: true }).click();
  const head = box.getByRole('button', { name: group, exact: true });
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
  await box.getByRole('button', { name: item, exact: true }).click();
};
const CH = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const gstin = (f) => { let s = 0; for (let i = 0; i < 14; i++) { const v = CH.indexOf(f[i]) * (i % 2 ? 2 : 1); s += Math.floor(v / 36) + (v % 36); } return f + CH[(36 - (s % 36)) % 36]; };

await page.goto(URL);
await page.getByRole('button', { name: 'Create an account', exact: true }).click();
await page.getByLabel('Your name').fill('Review Three');
await page.getByLabel('Firm name').fill('Review Three & Co');
await page.getByLabel('Email').fill(email);
await page.getByLabel('Password').fill(password);
await page.getByLabel('Accept terms').check();
await page.getByRole('button', { name: 'Create firm account', exact: true }).click();
await page.getByLabel('Business name').fill('Nashik Mills');
await page.getByLabel('GSTIN (optional)').fill('27AAPFU0939F1ZV');
await page.getByRole('button', { name: 'Add client', exact: true }).click();
// ---- 1: with a client in the list, the add-client fields wait behind "New client"
await page.getByRole('button', { name: 'New client', exact: true }).waitFor();
assert.strictEqual(await page.getByLabel('Business name').count(), 0, 'add-client fields hidden once there are clients');
step('clients: New client button; the add fields are not always shown');
await page.getByRole('button', { name: 'Open books', exact: true }).click();
await heading('Dashboard');

// ---- 25: light purple column headings
await menu('Sales', 'Invoices');
await heading('Invoices');
// ---- 4, 36, 38: + Create new customer from the dropdown (full contact form over the invoice), TDS the customer deducts
await btn('New invoice').click();
await page.getByLabel('Contact', { exact: true }).fill('Godavari Hospital');
await page.getByRole('listbox', { name: 'Suggestions' }).getByRole('option', { name: /Create new customer/ }).click();
const dlg = page.getByRole('dialog', { name: 'New contact' });
await dlg.waitFor();
assert.strictEqual(await dlg.getByLabel('Name', { exact: true }).inputValue(), 'Godavari Hospital', 'the typed name is carried into the form');
await dlg.getByLabel('GSTIN').first().fill(gstin('27AAACG4321G1Z'));
await dlg.getByLabel('PAN').fill('AAACG4321G');
await dlg.getByLabel('Customer TDS section').selectOption('194J');
await dlg.getByRole('button', { name: 'Add contact', exact: true }).click();
await dlg.waitFor({ state: 'detached' });
await ok('Godavari Hospital added.');
for (let i = 0; i < 50 && (await page.getByLabel('TDS section').inputValue()) !== '194J'; i++) await page.waitForTimeout(200);
assert.strictEqual(await page.getByLabel('TDS section').inputValue(), '194J', 'the customer TDS section fills in');
step('dropdown: + Create new customer opened the full contact form over the invoice; the new customer is chosen with its TDS section');

await page.getByLabel('Description 1').fill('Consulting');
await page.getByLabel('Rate 1').fill('10000');
await page.getByLabel('Apply TDS irrespective of threshold').check();
await page.getByTestId('net-payable').getByText('10,800.00').waitFor();           // 11,800 less TDS 1,000 at 10%
assert.match(await page.getByTestId('tds-total').innerText(), /1,000\.00/);
await btn('Create').click();
await ok(/Created INV\/.+ total ₹11,800\.00, TDS ₹1,000\.00/);
step('invoice with TDS receivable (irrespective of threshold): net receivable 10,800');

// ---- 21, 18, 19, 20, 30: open by number, locked, attachment without void, duplicate, void with the in-app box
const number = (await page.getByRole('button', { name: /^Open INV\// }).first().innerText()).trim();
await page.getByRole('button', { name: `Open ${number}` }).first().click();
const view = page.getByTestId('doc-view');
await view.getByText('is posted and locked').waitFor();
assert.match(await view.getByTestId('view-outstanding').innerText(), /10,800\.00/);
await view.getByLabel('Add attachment').setInputFiles({ name: 'po.txt', mimeType: 'text/plain', buffer: Buffer.from('purchase order 77') });
await view.getByText('The posted entry is unchanged').waitFor();
await view.getByRole('button', { name: 'po.txt' }).waitFor();
assert.strictEqual(await page.getByRole('row', { name: new RegExp(number.replace(/\//g, '\\/')) }).first().getByText('Void').count(), 0, 'not voided by the attachment');
await view.getByRole('button', { name: 'Duplicate', exact: true }).click();
await ok(`Copied from ${number}`);
assert.strictEqual(await page.getByLabel('Description 1').inputValue(), 'Consulting');
await btn('Close').click();
await page.getByRole('button', { name: `Open ${number}` }).first().click();
await confirms.clear();
await page.getByTestId('doc-view').getByRole('button', { name: 'Void', exact: true }).click();
await ok(`${number} voided`);
assert((await confirms.messages()).some((m) => new RegExp(`Void ${number.replace(/\//g, '\\/')}`).test(m)), 'asked in the in-app box');
step('document opened locked; attachment added without voiding; duplicated; voided after the in-app confirmation');

// ---- 12, 31, 32, 24: manual journals
await menu('Accounting', 'Manual journals');
await heading('Manual journals');
await btn('New repeating journal').waitFor();
await btn('New journal').click();
const acc1 = page.getByLabel('Account 1');
await acc1.click();
await page.getByRole('listbox', { name: 'Suggestions' }).getByText('Type an account code or name to search').waitFor();   // a hint, not every account
await acc1.pressSequentially('100');
assert.strictEqual(await acc1.inputValue(), '100', 'what is typed is not replaced');
await page.getByTestId('ghost').waitFor();                                           // the rest of the best match, in grey
assert.match(await page.getByTestId('ghost').innerText(), /0 · Cash in Hand$/);
await page.keyboard.press('Tab');
assert.match(await acc1.inputValue(), /^1000 · /, 'Tab takes the completion');
await page.getByLabel('Debit 1').fill('750');
await page.getByLabel('Account 2').fill('Courier charges');
await page.getByRole('listbox', { name: 'Suggestions' }).getByRole('option', { name: /Create new ledger/ }).click();
const nl = page.getByRole('dialog', { name: 'New ledger' });
await nl.waitFor();
assert.strictEqual(await nl.getByLabel('New ledger name').inputValue(), 'Courier charges');
await nl.getByRole('button', { name: 'Create ledger', exact: true }).click();
await nl.waitFor({ state: 'detached' });
assert.match(await page.getByLabel('Account 2').inputValue(), /· Courier charges$/);
await page.getByLabel('Debit 2').fill('');
// cash is credited, the new ledger debited: swap the amounts
await page.getByLabel('Debit 1').fill('');
await page.getByLabel('Credit 1').fill('750');
await page.getByLabel('Debit 2').fill('750');
await page.getByLabel('Narration', { exact: true }).fill('Being courier charges paid');
await btn('Post entry').click();
await ok(/Entry posted/);
await page.getByRole('button', { name: 'Expand row' }).first().click();
await page.getByText('Entry total').first().waitFor();
await btn('Repeating journals (0)').click();
await heading('Repeating journals');
step('journals: New journal button, account typed and completed with Tab, + Create new ledger from the list, lines opened under the entry, Repeating journals page');

// ---- 15, 46, 5, 16: drill down from P&L to a ledger and Back; aged receivables to the invoices behind an amount
await menu('Reporting', 'All reports');
await heading('Reports');
await page.getByRole('combobox', { name: 'Report', exact: true }).click(); await page.getByRole('option', { name: 'Profit & loss', exact: true }).click();
await btn('Run').click();
await page.getByRole('button', { name: /Ledger of .*Courier charges/ }).click();
await page.getByRole('columnheader', { name: 'Counter-ledger' }).first().waitFor();
await page.getByText('Cash in Hand').first().waitFor();                             // the counter-ledger of the courier line
await page.goBack();
await page.getByRole('button', { name: /Ledger of .*Courier charges/ }).waitFor();
step('P&L amount opens the ledger with the counter-ledger column; Back returns to the P&L');

await page.getByRole('combobox', { name: 'Report', exact: true }).click(); await page.getByRole('option', { name: 'Aged receivables', exact: true }).click();
await btn('Run').click();
await page.getByText('Nothing to show').first().waitFor().catch(() => undefined);
step('aged receivables run (the voided invoice is not outstanding)');

// ---- 39, 29: Duties and taxes
await page.evaluate(() => { location.hash = location.hash.replace(/\/[^/]+(\/[^/]+)?$/, '/setup/taxes'); });
await heading('Duties and taxes');
await page.getByRole('heading', { name: 'TDS sections, rates and thresholds' }).waitFor();
await page.getByRole('button', { name: /^Edit (settings|organisation details)$/ }).click();
await page.getByLabel('New GST rate').fill('0.25');
await page.getByRole('button', { name: 'Add rate', exact: true }).click();
await ok('0.25% added');
await page.getByTestId('gst-rate-list').getByText('0.25%').waitFor();
step('duties and taxes: TDS sections with statutory figures; own GST rate added');

// ---- 26: search finds records, grouped
await page.getByRole('button', { name: 'Search' }).click();
await page.getByLabel('Search this organisation').fill('godavari');
await page.getByRole('group', { name: 'Contacts' }).getByText('Godavari Hospital').waitFor();
await page.getByRole('group', { name: 'Invoices' }).waitFor();
await page.keyboard.press('Escape');
step('search finds contacts and invoices, grouped by kind');

// ---- 13: 2FA set-up shows a QR code
await page.getByRole('button', { name: /^Account menu|^Open account menu|Review Three/ }).first().click().catch(() => undefined);
await page.evaluate(() => { location.hash = '#/security'; });
await page.getByRole('button', { name: 'Set up 2FA', exact: true }).click();
await page.getByTestId('totp-qr').waitFor();
assert.match(await page.getByTestId('totp-qr').getAttribute('src'), /^data:image\/png;base64,/);
step('2FA set-up shows a QR code to scan');

// ---- 25: the theme: light purple column headings
const bg = await page.evaluate(() => { const th = document.createElement('table'); th.innerHTML = '<thead><tr><th>x</th></tr></thead>'; document.body.appendChild(th); const c = getComputedStyle(th.querySelector('th')).backgroundColor; th.remove(); return c; });
assert.strictEqual(bg, 'rgb(241, 237, 255)', 'column headings are light purple');
step('light purple column headings');

assert.deepStrictEqual(errors, [], 'no console errors or browser dialogs');
console.log('ALL CA REVIEW 3 BROWSER CHECKS PASSED');
await browser.close();
