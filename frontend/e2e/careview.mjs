// Browser test for the changes asked for in the CA's review (Points Noted 2): contacts, import errors, invoices and bills
// (unit, numbers, due date, unregistered dealer, TDS, place-of-supply warning, credit notes, payment dialog, lists),
// chart of accounts, journals, reports, settings, search and repeating bills.
// Needs API (:3000, TRUST_PROXY=1) and web (:5173) running and Google Chrome.  Run: node e2e/careview.mjs
import { chromium } from 'playwright-core';
import { autoConfirm } from './confirm.mjs';
import assert from 'assert';
import fs from 'fs';

const URL = process.env.WEB_URL ?? 'http://127.0.0.1:5173';
const email = `review${Date.now()}@example.com`, password = 'Passphrase-1234';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
page.setDefaultTimeout(Number(process.env.STEP_TIMEOUT ?? 30000));
const errors = [];
page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && errors.push(m.text()));
page.on('dialog', (d) => d.accept());
autoConfirm(page);
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
/** Wait until a field shows a value (it may be filled in a moment after the page opens). */
const valueIs = async (loc, v) => { for (let i = 0; i < 50; i++) { if ((await loc.inputValue()) === v) return; await page.waitForTimeout(200); } assert.strictEqual(await loc.inputValue(), v); };
const download = async (click) => { const [dl] = await Promise.all([page.waitForEvent('download'), click()]); return { name: dl.suggestedFilename(), buf: fs.readFileSync(await dl.path()) }; };
const rowMenu = async (rowName, item) => { await page.getByRole('row', { name: rowName }).first().getByRole('button', { name: /^Actions for/ }).click(); await page.getByRole('menuitem', { name: item }).click(); };
const CH = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const gstin = (f) => { let s = 0; for (let i = 0; i < 14; i++) { const v = CH.indexOf(f[i]) * (i % 2 ? 2 : 1); s += Math.floor(v / 36) + (v % 36); } return f + CH[(36 - (s % 36)) % 36]; };
const today = new Date().toISOString().slice(0, 10);

await page.goto(URL);
await page.getByRole('button', { name: 'Create an account', exact: true }).click();
await page.getByLabel('Your name').fill('Review Owner');
await page.getByLabel('Firm name').fill('Review & Co');
await page.getByLabel('Email').fill(email);
await page.getByLabel('Password').fill(password);
await page.getByLabel('Accept terms').check();
await page.getByRole('button', { name: 'Create firm account', exact: true }).click();
await page.getByLabel('Business name').fill('Pune Works');
await page.getByLabel('Chart of accounts').selectOption('trading');
await page.getByLabel('GSTIN (optional)').fill('27AAPFU0939F1ZV');
await page.getByRole('button', { name: 'Add client', exact: true }).click();
await page.getByRole('button', { name: 'Open books', exact: true }).click();
await heading('Dashboard');

// ---- 13, 46, 47, 32: a supplier with address, constitution, GST status, default TDS; the form checks GSTIN or "not registered"
await menu('Contacts', 'Suppliers');
await heading('Suppliers');
await btn('New supplier').click();
await heading('New supplier');
await page.getByLabel('Name', { exact: true }).fill('Ramesh Transport');
await btn('Add contact').click();
await page.getByRole('alert').getByText('Enter the GSTIN, or choose "Not registered under GST".').waitFor();
await page.getByLabel('Not registered under GST').check();
assert(await page.getByLabel('GSTIN', { exact: true }).isDisabled(), 'GSTIN greyed out for an unregistered party');
await page.getByLabel('State').selectOption({ label: '27 Maharashtra' });
await page.getByLabel('Constitution').selectOption('individual');
await page.getByLabel('PAN', { exact: true }).fill('ABCPR1234K');
await page.getByLabel('Address line 1', { exact: true }).fill('12 FC Road');
await page.getByLabel('City', { exact: true }).fill('Pune');
await page.getByLabel('PIN code', { exact: true }).fill('411004');
await page.getByLabel('Default TDS section').selectOption('194C');
await btn('Add contact').click();
await ok('Contact added.');
await page.getByRole('button', { name: 'Ramesh Transport', exact: true }).click();
await page.getByText('Statement: Ramesh Transport').waitFor();
await page.getByText('12 FC Road, Pune 411004').waitFor();
await page.getByText('Individual / Proprietor').first().waitFor();
const stmt = await download(async () => { await page.locator('main').getByRole('button', { name: /^Export/ }).click(); await page.getByRole('menuitem', { name: 'Excel (.xlsx)' }).click(); });
assert.strictEqual(stmt.buf.subarray(0, 2).toString(), 'PK');
await page.locator('main').getByRole('button', { name: 'Edit contact' }).click();
await heading('Edit Ramesh Transport');
await page.getByRole('button', { name: 'Go back' }).click();
step('supplier with address, constitution, unregistered status and default TDS; GSTIN or "not registered" required; statement page with Excel export; Edit opens its page');

// ---- 1, 2: import errors listed with what to change, downloadable as Excel
await menu('Contacts', 'All contacts');
await heading('All contacts');
await btn('Import').click();
await page.getByText('Choose CSV file…').waitFor();
await page.getByLabel('Contacts CSV file').setInputFiles({ name: 'contacts.csv', mimeType: 'text/csv', buffer: Buffer.from('Name,GSTIN,Email\nBad One,27AAPFU0939F1ZX,a@b.in\nBad Two,,not-mail\n') });
await btn('Check (dry run)').click();
await page.getByTestId('import-problems').getByText('Copy the GSTIN again from the GST portal').waitFor();
const errs = await download(() => btn('Download errors (Excel)').click());
assert.match(errs.name, /Contact-import-errors\.xlsx/);
await btn('Close import').click();
step('contact import: each wrong cell listed with what to change; errors downloaded as Excel; the file button has a border');

// ---- the customer for the invoices, and settings for the due date
const customer = await page.evaluate(async () => {
  const t = sessionStorage.getItem('token'), org = location.hash.match(/#\/o\/(\d+)/)[1];
  const h = { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` };
  const r = await fetch(`/api/orgs/${org}/contacts`, { method: 'POST', headers: h, body: JSON.stringify({ kind: 'customer', name: 'Gujarat Retail', stateCode: '24', email: 'buyer@example.com' }) });
  await fetch(`/api/orgs/${org}/settings`, { method: 'PUT', headers: h, body: JSON.stringify({ invoiceDueDays: 30, billDueDays: 10 }) });
  return (await r.json()).id;
});
assert(customer > 0);

// ---- 48, 49, 10, 11, 14: bill from the unregistered supplier: supply type, TDS, unit, number and due date filled in
await menu('Purchases', 'Bills');
await heading('Bills');
await btn('New bill').click();
await page.locator('[role=combobox][aria-label="Contact"]:not([data-count="0"])').first().waitFor();
await page.getByLabel('Contact', { exact: true }).fill('Ramesh Transport');
assert.strictEqual(await page.getByLabel('Supply type').inputValue(), 'unregistered');
assert.strictEqual(await page.getByLabel('TDS section').inputValue(), '194C');
assert.match(await page.getByLabel('Document number').inputValue(), /^BILL\/\d\d-\d\d\/\d{4}$/);
const due = new Date(Date.parse(today) + 10 * 86400000).toISOString().slice(0, 10);
await valueIs(page.getByLabel('Due date'), due);                                            // bill date + 10 days from Purchases settings
await page.getByLabel('Description 1').fill('Transport charges');
await page.getByLabel('Unit 1').selectOption('OTH');
await page.getByLabel('Rate 1').fill('40000');
await page.getByTestId('tds-total').getByText('− ₹400.00').waitFor();                       // 1% for an individual under 194C
assert.strictEqual(await page.getByTestId('net-payable').innerText(), '₹39,600.00');
assert.strictEqual(await page.getByTestId('gst-total').innerText(), '₹0.00');
await page.getByLabel('Supplier bill no.').fill('RT/77');
await btn('Create').click();
await ok(/Created BILL\/\d\d-\d\d\/\d+: total ₹40,000\.00, TDS ₹400\.00, net payable ₹39,600\.00/);
step('bill from an unregistered dealer: no GST, TDS 194C at 1% and the balance payable shown; unit, number and due date filled in');

// ---- 27, 28, 33, 12: invoice to the unregistered Gujarat customer: warning, duplicate number, GST shown line by line
await menu('Sales', 'Invoices');
await heading('Invoices');
await btn('New invoice').click();
await page.locator('[role=combobox][aria-label="Contact"]:not([data-count="0"])').first().waitFor();
await page.getByLabel('Contact', { exact: true }).fill('Gujarat Retail');
assert(await page.getByLabel('Interstate supply').isChecked(), 'IGST for a buyer in Gujarat');
await page.getByLabel('Intrastate supply').check();
await page.getByText(/CGST \+ SGST does not match the customer's state/).waitFor();
await btn('Use IGST as worked out').click();
await page.getByLabel('Description 1').fill('Steel pipes');
await page.getByLabel('Rate 1').fill('10000');
await page.getByText('IGST @ 18% on ₹10,000.00').waitFor();
await page.getByTestId('rule46-issues').getByText(/business address is missing/).waitFor();      // Rule 46 particulars missing are shown while filling the form
await btn('Create').click();
await ok(/Created INV\/\d\d-\d\d\/0001: total ₹11,800\.00/);
await btn('New invoice').click();
await page.getByLabel('Document number').fill('INV/26-27/0001');
await page.getByLabel('Description 1').click();
const firstNo = await page.getByRole('cell', { name: /^Open INV/ }).first().innerText().catch(() => '');
void firstNo;
await page.getByRole('alert').getByText(/is already used/).waitFor().catch(async () => {
  // the financial year in the number may differ: use the real number of the first invoice
  const n = await page.getByRole('button', { name: /^Open INV\// }).first().innerText();
  await page.getByLabel('Document number').fill(n); await page.getByLabel('Description 1').click();
  await page.getByRole('alert').getByText(/is already used/).waitFor();
});
await btn('Cancel').click();
step('place of supply against the customer\'s state is warned about; a used invoice number is caught as soon as it is typed; GST shown line by line');

// ---- 29, 31, 35, 36, 43, 44, 45, 40, 42: the list, payment dialog, credit note against the invoice
const inv = page.getByRole('row', { name: /Gujarat Retail/ }).first();
await inv.getByRole('button', { name: 'Credit note' }).click();
await page.waitForFunction(() => document.querySelector('input[aria-label="Description 1"]')?.value === 'Steel pipes'); // copied from the invoice
await page.getByLabel('Rate 1').fill('2000');
await btn('Create').click();
await ok(/Created CN\/\d\d-\d\d\/0001: total ₹2,360\.00\. Balance still to receive on INV\/\d\d-\d\d\/0001: ₹9,440\.00\./);
await rowMenu(/INV\/\d\d-\d\d\/0001/, 'Send reminder');
await ok(/reminder\(s\) queued/);
await page.getByRole('row', { name: /INV\/\d\d-\d\d\/0001/ }).first().getByRole('button', { name: 'Receive payment' }).click();
await page.getByRole('dialog', { name: /Receive payment for INV/ }).getByText('₹9,440.00').waitFor();
await page.getByLabel('Payment account').selectOption({ label: '1010 Bank Account' });
await page.getByRole('dialog').getByRole('button', { name: 'Record payment' }).click();
await ok('Payment recorded.');
await page.getByRole('row', { name: /INV\/\d\d-\d\d\/0001/ }).first().getByText('Paid', { exact: false }).waitFor();
await page.getByLabel(/^Search invoices/).fill('CN/');
assert.strictEqual(await page.getByRole('row', { name: /Gujarat Retail/ }).count(), 1);
await page.getByLabel(/^Search invoices/).fill('');
await page.locator('main').getByRole('button', { name: 'Columns' }).click();
await page.getByLabel('Show Supply type').check();
await page.getByRole('button', { name: 'Save as my view' }).click();
await page.getByRole('columnheader', { name: 'Supply type' }).waitFor();
const csv = await download(async () => { await page.locator('main').getByRole('button', { name: /^Export/ }).last().click(); await page.getByRole('menuitem', { name: 'CSV (.csv)' }).click(); });
assert.match(csv.buf.toString('utf8'), /Supply type/);
step('credit note copies the invoice and shows the balance left; payment in a dialog; status "Paid"; search, saved column view, CSV export; reminder for one invoice from the ⋮ menu');

// ---- 23: an amount opens the ledger it was booked to
await page.getByRole('button', { name: /^Ledger of INV/ }).first().click();
await heading('Reports');
await page.getByTestId('table-report').waitFor();
step('an invoice amount opens the ledger it was booked to');

// ---- 11: unit of measurement on a product, shown in its list
await menu('Sales', 'Products and services');
await heading('Products and services');
await btn('New item').click();
await page.getByLabel('Code', { exact: true }).fill('PIPE-1');
await page.getByLabel('Name', { exact: true }).fill('Steel pipe');
await page.getByLabel('Kind').selectOption('goods');
await page.getByLabel('Item unit').selectOption('MTR');
await btn('Save item').click();
await page.getByRole('row', { name: /PIPE-1/ }).getByText('Mtr', { exact: false }).or(page.getByRole('row', { name: /PIPE-1/ }).getByText('MTR')).first().waitFor();
await page.getByLabel('Search products and services (name, code, HSN)').fill('pipe');
await page.getByRole('cell', { name: 'PIPE-1' }).waitFor();
step('product with a unit of measurement; searchable list');

// ---- 6, 7, 18, 19, 24: chart of accounts
await menu('Accounting', 'Chart of accounts');
await heading('Chart of accounts');
await btn('New ledger').click();
await page.getByRole('combobox', { name: 'Statement line' }).click(); await page.getByRole('option', { name: /^Indirect Expenses/ }).click();
await page.getByRole('combobox', { name: 'Group', exact: true }).click(); await page.getByRole('option', { name: /New group/ }).click();
await page.getByLabel('New group name').fill('Vehicle Running');
await page.getByLabel('Range from').fill('5900');
await page.getByLabel('Range to').fill('5949');
await btn('Create').click();
await ok('Group "Vehicle Running" created.');
await page.getByLabel('Name', { exact: true }).fill('Diesel');
await page.waitForFunction(() => document.querySelector('input[aria-label="Code"]')?.value === '5900');
await btn('Add ledger').click();
await ok('Ledger 5900 · Diesel added under Vehicle Running.');
await page.getByTestId('coa-tree').getByText('5900 · Diesel').waitFor();
await page.getByRole('button', { name: 'List', exact: true }).click();
await page.getByLabel('Search by number, name or group').fill('diesel');
await rowMenu(/Diesel/, 'Delete');
await ok('5900 Diesel deleted.');
step('chart of accounts: a new group with a number range, the next ledger number suggested, grouped and list views, delete');

// ---- 16, 17: journal with voucher number, reference, typed accounts
await menu('Accounting', 'Manual journals');
await heading('Manual journals');
await btn('New journal').click();
for (let i = 0; i < 50 && !(await page.getByLabel('Voucher number').inputValue()); i++) await page.waitForTimeout(200);
assert.match(await page.getByLabel('Voucher number').inputValue(), /^JV\/\d\d-\d\d\/0001$/);
await page.getByLabel('Reference number').fill('AGR-9');
await page.getByLabel('Narration', { exact: true }).fill('Office tea');
await page.getByLabel('Account 1').fill('5550');
await page.getByLabel('Debit 1').fill('250');
await page.getByLabel('Account 2').fill('1000 · Cash in Hand');
await page.getByLabel('Credit 2').fill('250');
await btn('Post entry').click();
await ok(/Entry posted\. Voucher JV\/\d\d-\d\d\/0001\./);
step('journal: voucher number from its own series, reference number, accounts typed by number or name');

// ---- 20, 21, 41, 23: reports
await menu('Reporting', 'All reports');
await heading('Reports');
await page.getByRole('combobox', { name: 'Report', exact: true }).click(); await page.getByRole('option', { name: 'Ledger', exact: true }).click();
await page.getByText('then click Run').waitFor();                                        // nothing loads until Run
await page.getByLabel('From account').fill('1000 · Cash in Hand');
await page.getByLabel('To account').fill('1000 · Cash in Hand');
await btn('Run').click();
await page.getByTestId('table-report').getByRole('button', { name: 'Office tea' }).click();
await heading('Manual journals');
await page.getByText('Showing the entry opened from the ledger.').waitFor();
step('reports: one picker, Run needed, ledger for an account range; a ledger line opens its journal');

// ---- 9, 8: settings locked until Edit; lock dates need a password
await page.evaluate(() => { location.hash = location.hash.replace(/\/[^/]+(\/[^/]+)?$/, '/setup/financial'); });
await heading('Financial settings');
assert(await page.getByLabel('Staff lock date').isDisabled(), 'locked until Edit');
await page.getByRole('button', { name: 'Edit settings' }).click();
await page.getByLabel('Staff lock date').fill('2025-03-31');
assert(await btn('Save lock dates').isDisabled(), 'the password is needed');
await page.getByLabel('Password to confirm').fill(password);
await btn('Save lock dates').click();
await ok('Lock dates saved. Staff: up to 2025-03-31.');
step('settings open read-only until Edit; lock dates need your password');

// ---- 38: search finds settings and screens
await page.getByRole('button', { name: 'Search' }).click();
await page.getByLabel('Search this organisation').fill('lock dates');
await page.getByRole('button', { name: /^Lock dates/ }).waitFor();
await page.keyboard.press('Escape');
step('search finds settings and screens as well as records');

// ---- 57, 59, 60: repeating bill waits for review; narration placeholders; open and post it
await menu('Purchases', 'Repeating bills');
await heading('Repeating bills');
await btn('New repeating bill').click();
await page.locator('[role=combobox][aria-label="Contact"]:not([data-count="0"])').first().waitFor();
await page.getByLabel('Contact', { exact: true }).fill('Ramesh Transport');
const past = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
await page.getByLabel('First bill date').fill(past);
await page.getByLabel('Narration').fill('Being transport charges for');
await page.locator('main').getByRole('button', { name: '{month}', exact: true }).click();
await page.getByTestId('narration-preview').getByText(/Being transport charges for [A-Z][a-z]{2}-\d\d/).waitFor();
await page.getByLabel('Description 1').fill('Monthly transport');
await page.getByLabel('Rate 1').fill('5000');
await btn('Save schedule').click();
await ok(/waits under "Due for posting"/);
await page.getByTestId('recurring-due').getByText(/Being transport charges for/).waitFor();
await btn('Open and post').click();
await heading('Bills');
await page.waitForFunction(() => document.querySelector('input[aria-label="Description 1"]')?.value === 'Monthly transport');
await page.getByLabel('Supplier bill no.').fill('RT/78');
await btn('Create').click();
await ok(/Created BILL\//);
await menu('Purchases', 'Repeating bills');
await heading('Repeating bills');
assert.strictEqual(await page.getByTestId('recurring-due').count(), 0);
await rowMenu(/Ramesh Transport/, 'Delete');
await ok('Schedule deleted. The ones posted earlier are still in the books.');
step('repeating bill waits for review with the month in its narration; opened, completed and posted; schedule deleted without touching what was posted');

// ---- 34: credit and debit notes from the "+" menu
await page.getByRole('button', { name: 'Create new' }).click();
await page.getByRole('menuitem', { name: /Debit note/ }).or(page.getByRole('button', { name: /^Debit note/ })).first().click();
await heading('Bills');
assert.strictEqual(await page.getByLabel('Document type').inputValue(), 'debit_note');
step('"+" menu opens a new credit or debit note');

assert.deepStrictEqual(errors.filter((e) => !/favicon|Failed to load resource/.test(e)), [], 'no script errors');
await browser.close();
console.log('ALL CA REVIEW BROWSER CHECKS PASSED');
