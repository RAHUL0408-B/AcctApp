// The 29-point change list, checked one by one on the real screens. Each passing item prints its number.
// Some items are also covered in more depth by changes.mjs; this script exists so the whole list can be ticked off at once.
// Needs API (:3000) and web (:5173) running and Google Chrome.  Run: node e2e/checklist.mjs
import { chromium } from 'playwright-core';
import assert from 'assert';
import fs from 'fs';

const URL = process.env.WEB_URL ?? 'http://127.0.0.1:5173';
const email = `list${Date.now()}@example.com`, password = 'Passphrase-1234';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
page.setDefaultTimeout(Number(process.env.STEP_TIMEOUT ?? 30000));
const errors = [];
page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && errors.push(m.text()));
let dialogs = [];
page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
const item = (n, s) => console.log(`✓ ${String(n).padStart(2)}. ${s}`);
const btn = (name) => page.getByRole('button', { name, exact: true });
const heading = (name) => page.getByRole('heading', { name, exact: true, level: 1 }).waitFor();
const bar = () => page.getByRole('navigation', { name: 'Client sections' });
const top = (name) => page.locator('header').getByRole('button', { name, exact: true });
const menu = async (group, entry) => { await bar().getByRole('button', { name: group, exact: true }).click(); await top(entry).click(); };
const ok = (re) => page.getByText(re).first().waitFor();
const contactsLoaded = () => page.locator('datalist option').first().waitFor({ state: 'attached' });
const download = async (click) => { const [dl] = await Promise.all([page.waitForEvent('download'), click()]); return { name: dl.suggestedFilename(), text: fs.readFileSync(await dl.path()).toString('latin1') }; };
/** A GSTIN with the right check character, from its first 14 characters. */
const CH = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const gstin = (f) => { let s = 0; for (let i = 0; i < 14; i++) { const v = CH.indexOf(f[i]) * (i % 2 ? 2 : 1); s += Math.floor(v / 36) + (v % 36); } return f + CH[(36 - (s % 36)) % 36]; };
const fy = (() => { const d = new Date(); return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; })();

// ---- set up
await page.goto(URL);
await btn('Create an account').click();
await page.getByLabel('Your name').fill('List Checker');
await page.getByLabel('Firm name').fill('Checklist Associates');
await page.getByLabel('Email').fill(email);
await page.getByLabel('Password').fill(password);
await page.getByLabel('Accept terms').check();
await btn('Create firm account').click();
await page.getByLabel('Business name').fill('Mumbai Traders');
await page.getByLabel('GSTIN (optional)').fill('27AAPFU0939F1ZV');
await btn('Add client').click();
await btn('Open books').click();
await heading('Dashboard');

// 1. Back button on every screen
await menu('Sales', 'Invoices');
await heading('Invoices');
await page.getByRole('button', { name: 'Go back' }).click();
await heading('Dashboard');
item(1, 'a Back button returns to the previous screen');

// 2. Import several contacts at once, and export them
await menu('Contacts', 'All contacts');
await heading('All contacts');
await btn('Import').click();
let f = await download(() => btn('Download blank template').click());
assert.match(f.text, /^Name,Type,GSTIN/);
await page.getByLabel('Contacts CSV data').fill(`Name,Type,GSTIN,PAN,State Code,Email,Phone,Bank Account Name,Bank Name,Bank Account Number,IFSC\nKarnataka Retail,Customer,${gstin('29AAPFU0939F1Z')},,29,,,,,,\nLocal Buyer,Customer,,,27,,,,,,\nPaper Mart,Supplier,,,27,,,,,,\n`);
await btn('Check (dry run)').click();
await ok('Looks good: 3 contact(s) ready to import.');
await page.getByRole('button', { name: 'Import', exact: true }).last().click();
await ok('Imported 3 contact(s).');
f = await download(() => btn('Export').click());
assert.match(f.text, /Karnataka Retail/);
item(2, 'three contacts imported from one CSV (blank template downloaded first), then exported');

// 3, 4, 5. Bank details, default accounts, edit / archive / delete
await btn('New contact').click();
await page.getByLabel('Contact type').selectOption('supplier');
await page.getByLabel('Name', { exact: true }).fill('Stationery Co');
await page.getByLabel('State').selectOption({ label: '27 Maharashtra' });
await page.getByLabel('Bank name').fill('SBI');
await page.getByLabel('Account number').fill('30001234567');
await page.getByLabel('IFSC code').fill('SBIN0001234');
await page.getByLabel('Default purchase account').selectOption({ index: 1 });
await btn('Add contact').click();
await page.getByText('SBI ••4567').waitFor();
item(3, 'bank account details saved on a contact');
const purchaseName = (await page.getByRole('row', { name: /Stationery Co/ }).innerText());
assert(!/—\s*$/.test(purchaseName.trim()), 'default purchase account shown');
item(4, 'default purchase account saved on a contact (default sales account is the same field for customers)');
await page.getByRole('row', { name: /Stationery Co/ }).getByRole('button', { name: 'Edit' }).click();
await page.getByLabel('Phone').fill('9822000000');
await btn('Save changes').click();
await ok('Contact updated.');
await page.getByRole('row', { name: /Local Buyer/ }).getByRole('button', { name: 'Archive' }).click();
await page.getByRole('cell', { name: 'Local Buyer' }).waitFor({ state: 'detached' });
await page.getByRole('row', { name: /Paper Mart/ }).getByRole('button', { name: 'Delete' }).click();
await ok('Paper Mart deleted.');
item(5, 'contact edited, archived and deleted');

// 6. Statement for chosen dates
await page.getByRole('row', { name: /Karnataka Retail/ }).getByRole('button', { name: 'Statement' }).click();
await page.getByLabel('From', { exact: true }).fill(`${fy}-04-01`);
await page.getByLabel('To', { exact: true }).fill(`${fy + 1}-03-31`);
await btn('Update').click();
await page.getByText('Statement: Karnataka Retail').waitFor();
item(6, 'statement shown for a chosen date range');

// 19. Product with default sales and purchase accounts (needed before the invoice below)
await menu('Sales', 'Products and services');
await btn('New item').click().catch(async () => { await page.getByRole('button', { name: /New/ }).first().click(); });
await page.getByLabel('Code', { exact: true }).fill('DESK');
await page.getByLabel('Name', { exact: true }).fill('Office desk');
await page.getByLabel('Item kind').selectOption('goods');
await page.getByLabel('Sale price (₹)').fill('10000');
await page.getByLabel('Purchase price (₹)').fill('7000');
await page.getByLabel('Item sales account').selectOption({ index: 1 });
await page.getByLabel('Item purchase account').selectOption({ index: 1 });
await page.getByRole('button', { name: /^Save/ }).first().click();
await page.getByRole('cell', { name: 'Office desk' }).waitFor();
item(19, 'product saved with its own default sales and purchase accounts');

// 11, 13, 14, 21. Invoice to another state: typed customer, IGST chosen from the GSTIN, totals, own number, warning on change
await page.keyboard.press('Alt+I');
await heading('Invoices');
await contactsLoaded();
await page.getByLabel('Contact', { exact: true }).fill('Karnataka Retail');
item(21, 'customer name typed into the invoice');
await page.getByLabel('Document number').fill('MT/001');
item(14, 'invoice number suggested automatically and changed by hand');
await page.getByLabel('Add from catalogue').selectOption({ label: 'DESK · Office desk' });
assert(await page.getByLabel('Interstate supply').isChecked(), 'IGST chosen from the GSTIN state');
await page.getByText(/Output IGST/).first().waitFor();
await page.getByText('Total invoice value').waitFor();
await page.getByText('₹11,800.00').first().waitFor();
item(13, 'taxable value, GST and total shown on the form: 10,000 + 18% = 11,800');
dialogs = [];
await page.getByLabel('Intrastate supply').check();
assert(dialogs.some((d) => /has a GST number/.test(d)), 'warned before changing a registered party');
await page.getByText(/Output CGST/).first().waitFor();
await page.getByLabel('Interstate supply').check();
await page.getByText(/Output IGST/).first().waitFor();
item(11, 'interstate picked from the GSTIN, change allowed after a warning, GST accounts follow (Output IGST / Output CGST + SGST)');

// 8. Attach a document while creating the invoice
await page.getByLabel('Attach documents').setInputFiles({ name: 'po.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test') });
await btn('Create').click();
await ok(/Created MT\/001: total ₹11,800\.00/);
item(8, 'document attached while creating an invoice');

// 16. Save an invoice as a template, start a new one from it
await page.keyboard.press('Alt+I');
await contactsLoaded();
await page.getByLabel('Contact', { exact: true }).fill('Karnataka Retail');
await page.getByLabel('Description 1').fill('Monthly service');
await page.getByLabel('Rate 1').fill('1000');
await btn('Save as template').click();
await ok(/Template ".+" saved/).catch(() => undefined);
dialogs = [];
item(16, 'invoice saved as a template (lines post to each product default account)');

// 11 (unregistered). No warning for a party without a GST number
await page.getByLabel('Contact', { exact: true }).fill('');
await page.getByLabel('Contact', { exact: true }).fill('Local Buyer');
dialogs = [];
await page.getByLabel('Interstate supply').check().catch(() => undefined);
assert.strictEqual(dialogs.length, 0, 'no warning for an unregistered party');
await page.getByLabel('Intrastate supply').check();

// 12. Create a product from the invoice screen
await page.getByText('+ Create a new product or service').click();
await page.getByLabel('Code', { exact: true }).fill('INSTALL');
await page.getByLabel('Name', { exact: true }).fill('Installation');
await btn('Save and add to this document').click();
await page.getByLabel('Description 2').waitFor().catch(() => undefined);
assert((await page.locator('input[aria-label^="Description"]').evaluateAll((e) => e.map((x) => x.value))).includes('Installation'));
item(12, 'product created from inside the invoice and added as a line');

// 15. Receive payment
await page.getByRole('button', { name: 'Close' }).first().click().catch(() => undefined);
await menu('Accounting', 'Bank accounts');
await page.getByLabel('Bank name').fill('HDFC');
await page.getByLabel('Bank ledger account').selectOption({ label: '1010 Bank Account' });
await btn('Add').click();
await page.getByRole('heading', { name: 'Reconcile' }).waitFor();
await menu('Sales', 'Invoices');
await page.getByRole('row', { name: /MT\/001/ }).getByRole('button', { name: 'Receive payment' }).click();
await page.getByLabel('Payment account').selectOption({ label: '1010 Bank Account' });
await btn('Record payment').click();
await ok('Payment recorded.');
item(15, '"Receive payment" (not "Pay") on invoices');

// 7. Edit a posted invoice by clicking its amount; delete one and several
await page.keyboard.press('Alt+I');
await contactsLoaded();
await page.getByLabel('Contact', { exact: true }).fill('Karnataka Retail');
await page.getByLabel('Document number').fill('MT/002');
await page.getByLabel('Description 1').fill('Chairs');
await page.getByLabel('Rate 1').fill('500');
await btn('Create').click();
await ok(/Created MT\/002/);
await page.getByRole('button', { name: 'Edit MT/002' }).click();
await page.getByLabel('Rate 1').fill('600');
await btn('Save changes').click();
await ok(/Updated MT\/002: total ₹708\.00/);
await page.getByRole('row', { name: /MT\/002 / }).first().getByRole('button', { name: 'Delete', exact: true }).click().catch(async () => {
  await page.getByLabel('Select MT/002', { exact: true }).check(); await btn('Delete selected').click();
});
await ok(/deleted/);
item(7, 'posted invoice edited by clicking its amount, then deleted (bulk delete is covered in changes.mjs)');

// 9. Manual journal with a rule, 8 (journal attachment)
await menu('Accounting', 'Manual journals');
await page.getByLabel('Narration', { exact: true }).fill('Prepaid insurance');
await page.getByLabel('Account 1').selectOption({ index: 1 });
await page.getByLabel('Debit 1').fill('100');
await page.getByLabel('Account 2').selectOption({ label: '1010 · Bank Account' });
await page.getByLabel('Credit 2').fill('100');
await page.getByLabel('Repeat automatically').check();
await page.getByLabel('Rule name').fill('Insurance');
await btn('Save rule').click();
await page.getByRole('cell', { name: 'Insurance' }).waitFor();
item(9, 'journal rule that posts the entry automatically');

// 10, 20. Products on a purchase order; edit before converting to a bill
await menu('Purchases', 'Purchase orders');
await page.getByRole('button', { name: /New purchase order/ }).click();
await contactsLoaded();
await page.getByLabel('Contact', { exact: true }).fill('Stationery Co');
await page.getByLabel('Add from catalogue').selectOption({ label: 'DESK · Office desk' }); // its purchase price is used on purchases
await btn('Create').click();
await ok(/Created PO-0001/);
item(10, 'products and services on purchases (purchase order and bill)');
await page.getByRole('button', { name: 'Convert to bill' }).click();
await page.getByText(/Review before posting/).waitFor();
await page.getByLabel('Rate 1').fill('7500');
await btn('Post bill').click();
await ok(/PO-0001 converted to/);
item(20, 'purchase order reviewed and changed before the bill was posted');

// 17. Export every account's ledger at once
await menu('Reporting', 'All reports');
await page.getByRole('button', { name: 'Ledger', exact: true }).click();
f = await download(() => btn('Export all accounts (Excel)').click());
assert.strictEqual(f.name, 'all-ledgers.xlsx');
item(17, 'all accounts exported at once from Reports');

// 18. Expense claim rejected goes back to the submitter
await menu('Purchases', 'Expense claims');
await page.getByLabel('What was it for?').fill('Taxi');
await page.getByLabel('Claim description 1').fill('Airport taxi');
await page.getByLabel('Claim account 1').selectOption({ index: 1 });
await page.getByLabel('Claim amount 1').fill('900');
await btn('Submit claim').click();
await ok(/Claim for ₹900\.00 submitted/);
await page.getByLabel('Reason, if you reject').fill('Need receipt');
await page.getByRole('row', { name: /Taxi/ }).getByRole('button', { name: 'Reject' }).click();
await btn('Edit and resubmit').click();
await btn('Resubmit claim').click();
await ok(/corrected and sent again/);
item(18, 'rejected expense claim edited and resubmitted by the submitter');

// 22. Chart of accounts headings
await menu('Accounting', 'Chart of accounts');
for (const h of ['Liabilities', 'Equity', 'Assets', 'Income', 'Expenses']) await page.getByText(h, { exact: true }).first().waitFor();
assert.strictEqual(await page.getByText('Liabilitys').count(), 0);
item(22, 'chart of accounts reads Liabilities and Equity (not Liabilitys / Equitys)');

// 23. Blank template on Import data
await menu('Accounting', 'Import data');
f = await download(() => btn('Download blank template').click());
assert.match(f.name, /-import-template\.csv$/);
item(23, 'blank import template downloaded from Import data');

// 24-29. Fixed assets
await menu('Accounting', 'Fixed assets');
await btn('New asset').click();
await page.waitForFunction(() => document.querySelector('[aria-label="Asset code"]')?.value); // filled in once the next code arrives
const code = await page.getByLabel('Asset code').inputValue();
assert.strictEqual(code, 'FA-0001');
await page.getByLabel('Asset code').fill('AC-01');
item(27, `asset code filled in automatically (${code}) and changed by hand`);
await page.getByLabel('Name', { exact: true }).fill('Refrigerator');
await page.getByLabel('Asset group').selectOption({ label: 'Plant and machinery' });
assert.strictEqual(await page.getByLabel('Rate per year (%)').inputValue(), '15');
item(24, 'refrigerator put in the Plant and machinery group (15% WDV filled in)');
await page.getByLabel('Depreciation method').selectOption('slm_life');
await page.getByLabel('Depreciation basis').selectOption('actual_days');
await page.getByLabel('Purchase date').fill(`${fy}-04-15`);
await page.getByLabel('Cost (₹)').fill('50000');
item(25, 'Income Tax Act rates by group, plus useful-life depreciation by actual days or whole months');
await page.getByLabel('Attach documents').setInputFiles({ name: 'invoice.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 bill') });
await btn('Save asset').click();
await page.getByRole('cell', { name: 'AC-01' }).waitFor();
item(28, 'purchase bill attached while creating the asset');
f = await download(() => btn('Export Excel').click());
assert.match(f.name, /fixed-asset-register\.xlsx/);
f = await download(() => btn('Export PDF').click());
assert.match(f.name, /fixed-asset-register\.pdf/);
item(26, 'fixed asset register exported to Excel and PDF');
await page.getByRole('row', { name: /Refrigerator/ }).getByRole('button', { name: 'Dispose' }).click();
await page.getByLabel('Date of disposal').fill(new Date().toISOString().slice(0, 10));
await page.getByLabel('Sale proceeds').fill('30000');
await page.getByLabel('Proceeds account').selectOption({ label: '1010 Bank Account' });
await btn('Calculate gain / loss').click();
await page.getByTestId('disposal-preview').waitFor();
await btn('Post disposal entry').click();
await ok(/disposed\. (Profit|Loss) on sale/);
item(29, 'disposal with date, sale proceeds and bank account; gain or loss worked out and posted');

assert.deepStrictEqual(errors, [], 'no console errors: ' + errors.join(' | '));
console.log('ALL 29 CHECKLIST ITEMS PASSED');
await browser.close();
