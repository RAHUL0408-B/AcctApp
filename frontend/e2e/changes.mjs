// Browser test for the contact tools, document editing, journal rules, report tables, fixed-asset groups and
// expense-claim resubmission, plus the top bar (columns, hover switch, breadcrumb, small-screen menu).
// Needs API (:3000) and web (:5173) running and Google Chrome installed.  Run: node e2e/changes.mjs
import { chromium } from 'playwright-core';
import assert from 'assert';

const URL = process.env.WEB_URL ?? 'http://127.0.0.1:5173';
const email = `chg${Date.now()}@example.com`, password = 'Passphrase-1234';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(Number(process.env.STEP_TIMEOUT ?? 30000));
const errors = [];
page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && errors.push(m.text()));
let dialogs = [];
page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); }); // confirmations (delete, unlink) are accepted and recorded
const step = (s) => console.log('✓', s);
const btn = (name) => page.getByRole('button', { name, exact: true });
const heading = (name) => page.getByRole('heading', { name, exact: true, level: 1 }).waitFor();
const bar = () => page.getByRole('navigation', { name: 'Client sections' });
const top = (name) => page.locator('header').getByRole('button', { name, exact: true });
const menu = async (group, item) => { await bar().getByRole('button', { name: group, exact: true }).click(); await top(item).click(); };
const ok = (re) => page.getByText(re).first().waitFor();
const contactsLoaded = () => page.locator('datalist option').first().waitFor({ state: 'attached' });
const today = new Date().toISOString().slice(0, 10);

// ---- set up a firm and a client
await page.goto(URL);
await page.getByRole('button', { name: 'Create an account' }).click();
await page.getByLabel('Your name').fill('Chg Test');
await page.getByLabel('Firm name').fill('Chg Associates');
await page.getByLabel('Email').fill(email);
await page.getByLabel('Password').fill(password);
await page.getByLabel('Accept terms').check();
await btn('Create firm account').click();
await page.getByLabel('Business name').fill('Nair Traders');
await page.getByLabel('GSTIN (optional)').fill('27AAPFU0939F1ZV');
await btn('Add client').click();
await btn('Open books').click();
await heading('Dashboard');

// ---- top bar: columns, hover switch, breadcrumb
await bar().getByRole('button', { name: 'Accounting', exact: true }).click();
for (const h of ['Banking', 'Ledger', 'Records and setup']) await page.locator('header').getByText(h, { exact: true }).waitFor();
const a = await top('Bank accounts').boundingBox(), b = await top('Chart of accounts').boundingBox(), c = await top('Documents').boundingBox();
assert(a.x < b.x && b.x < c.x, 'Accounting menu is laid out in three columns');
await bar().getByRole('button', { name: 'Sales', exact: true }).hover();
await top('Quotes').waitFor();
assert(!(await top('Chart of accounts').isVisible()), 'hovering another section switches the open menu');
await page.keyboard.press('Escape');
await menu('Purchases', 'Bills');
await heading('Bills');
await page.getByRole('navigation', { name: 'Breadcrumb' }).getByText('Purchases', { exact: true }).waitFor();
await page.getByRole('navigation', { name: 'Breadcrumb' }).getByText('Bills', { exact: true }).waitFor();
step('top bar: Accounting in three columns, hover switches menus, breadcrumb reads Purchases > Bills');

await page.setViewportSize({ width: 900, height: 800 });
await page.getByRole('button', { name: 'Account menu' }).waitFor();   // avatar is not clipped off-screen
await page.getByRole('button', { name: 'Open menu' }).click();
await page.getByRole('navigation', { name: 'Small-screen menu' }).getByRole('button', { name: 'Sales' }).click();
await page.getByRole('navigation', { name: 'Small-screen menu' }).getByRole('button', { name: 'Invoices', exact: true }).click();
await heading('Invoices');
assert(!(await page.getByRole('navigation', { name: 'Small-screen menu' }).isVisible().catch(() => false)), 'small-screen menu closes after choosing');
await page.setViewportSize({ width: 1440, height: 1000 });
step('small screen: hamburger menu opens a section and navigates');

// ---- contact with bank details and default account
await menu('Contacts', 'All contacts');
await heading('All contacts');
await btn('New contact').click();
await page.getByLabel('Contact type').selectOption('customer');
await page.getByLabel('Name', { exact: true }).fill('Kapoor Stores');
await page.getByLabel('State').selectOption({ label: '27 Maharashtra' });
await page.getByLabel('Account holder name').fill('Kapoor Stores');
await page.getByLabel('Bank name').fill('HDFC Bank');
await page.getByLabel('Account number').fill('50100123456789');
await page.getByLabel('IFSC code').fill('BAD');
await btn('Add contact').click();
await page.getByRole('alert').first().waitFor();                       // bad IFSC is refused
await page.getByLabel('IFSC code').fill('HDFC0000123');
await btn('Add contact').click();
await page.getByRole('cell', { name: 'Kapoor Stores' }).waitFor();
await page.getByText('HDFC Bank ••6789').waitFor();
step('contact saved with bank details; a malformed IFSC is rejected');

await page.getByRole('row', { name: /Kapoor Stores/ }).getByRole('button', { name: 'Edit' }).click();
await page.getByLabel('Phone').fill('9822012345');
await btn('Save changes').click();
await page.getByRole('cell', { name: 'Kapoor Stores' }).waitFor();
await page.getByRole('row', { name: /Kapoor Stores/ }).getByRole('button', { name: 'Archive' }).click();
await page.getByRole('cell', { name: 'Kapoor Stores' }).waitFor({ state: 'detached' });
await page.getByLabel('Show archived').check();
await page.getByRole('row', { name: /Kapoor Stores/ }).getByRole('button', { name: 'Restore' }).click();
await page.getByLabel('Show archived').uncheck();
await page.getByRole('cell', { name: 'Kapoor Stores' }).waitFor();
step('contact edited, archived (hidden) and restored');

// ---- invoice: custom number, totals box, edit by clicking the amount, payment, unlink, delete
await page.keyboard.press('Alt+I');
await heading('Invoices');
await contactsLoaded();
await page.getByLabel('Contact', { exact: true }).fill('Kapoor Stores');
await page.getByLabel('Document number').fill('KS/2026/001');
await page.getByLabel('Description 1').fill('Supply of goods');
await page.getByLabel('Rate 1').fill('2000');
await page.getByText('Total invoice value').waitFor();
await page.getByText('₹2,360.00').first().waitFor();                  // total shown on the form before saving
await btn('Create').click();
await ok(/Created KS\/2026\/001: total ₹2,360\.00/);
step('invoice KS/2026/001 created with a typed number; totals shown on the form: 2,000 + 18% = 2,360');

await page.getByRole('button', { name: 'Edit KS/2026/001' }).click();
await page.getByLabel('Rate 1').fill('3000');
await btn('Save changes').click();
await ok(/Updated KS\/2026\/001: total ₹3,540\.00/);
step('posted invoice edited by clicking its amount: now 3,540 under the same number');

await menu('Accounting', 'Bank accounts');
await page.getByLabel('Bank name').fill('Kotak');
await page.getByLabel('Bank ledger account').selectOption({ label: '1010 Bank Account' });
await btn('Add').click();
await page.getByRole('heading', { name: 'Reconcile' }).waitFor();
await menu('Sales', 'Invoices');
await heading('Invoices');
await page.getByRole('row', { name: /KS\/2026\/001/ }).getByRole('button', { name: 'Receive payment' }).click();
await page.getByLabel('Amount (₹)').fill('1000');
await page.getByLabel('Payment account').selectOption({ label: '1010 Bank Account' });
await btn('Record payment').click();
await ok('Payment recorded.');
await page.getByRole('button', { name: 'Edit KS/2026/001' }).click();
await page.getByText('₹1,000.00').first().waitFor();                  // the payment is listed for unlinking
await page.getByRole('button', { name: 'Unlink', exact: true }).click();
await ok('Payment unlinked.');
step('Receive payment recorded Rs 1,000, then unlinked so the invoice is outstanding again');

await page.getByLabel('Select KS/2026/001', { exact: true }).check();
await btn('Delete selected').click();
await ok(/1 deleted/);
assert(dialogs.some((d) => /Delete 1/.test(d) || /cancel/i.test(d)), 'delete asked for confirmation');
await page.getByLabel('Show archived').waitFor();
step('invoice deleted (cancelled with a reversing entry) after a confirmation');

// ---- manual journal rule
await menu('Accounting', 'Manual journals');
await heading('Manual journals');
await page.getByLabel('Narration', { exact: true }).fill('Insurance write-off');
await page.getByLabel('Account 1').selectOption({ index: 1 });
await page.getByLabel('Debit 1').fill('1200');
await page.getByLabel('Account 2').selectOption({ label: '1010 · Bank Account' });
await page.getByLabel('Credit 2').fill('1200');
await page.getByLabel('Repeat automatically').check();
await page.getByLabel('Rule name').fill('Insurance monthly');
await btn('Save rule').click();
await page.getByRole('cell', { name: 'Insurance monthly' }).waitFor();
step('manual journal saved as a repeating rule and listed under Journal rules');

// ---- report as a table, with all-ledgers export button on the ledger report
await menu('Reporting', 'All reports');
await heading('Reports');
await page.getByRole('button', { name: 'All ledgers', exact: true }).click();
await btn('Run').click();
await page.getByTestId('table-report').waitFor();
await page.getByRole('button', { name: 'Invoice-wise', exact: true }).click();
await btn('Run').click();
await page.getByTestId('table-report').waitFor();
await page.getByRole('button', { name: 'Purchase register', exact: true }).click();
await btn('Run').click();
await page.getByTestId('table-report').waitFor();
await page.getByRole('button', { name: 'Fixed asset register', exact: true }).click();
await btn('Run').click();
await page.getByTestId('table-report').waitFor();
step('All ledgers, Invoice-wise, Purchase register and Fixed asset register reports render as tables');

// ---- fixed assets: group fills the Income Tax rate, edit, dispose with gain/loss preview
await menu('Accounting', 'Fixed assets');
await heading('Fixed assets');
await btn('New asset').click();
await page.getByLabel('Name', { exact: true }).fill('Office AC');
await page.getByLabel('Asset group').selectOption({ label: 'Plant and machinery' }).catch(async () => { await page.getByLabel('Asset group').selectOption({ index: 1 }); });
await page.getByLabel('Purchase date').fill(`${new Date().getFullYear()}-04-10`);
await page.getByLabel('Cost (₹)').fill('60000');
await btn('Save asset').click();
await page.getByRole('cell', { name: 'FA-0001' }).waitFor();
await page.getByRole('row', { name: /Office AC/ }).getByRole('button', { name: 'Edit' }).click();
await page.getByLabel('Name', { exact: true }).fill('Office AC 1.5 ton');
await btn('Save changes').click();
await page.getByRole('cell', { name: 'Office AC 1.5 ton' }).waitFor();
await page.getByRole('row', { name: /Office AC/ }).getByRole('button', { name: 'Dispose' }).click();
await page.getByLabel('Sale proceeds').fill('20000');
await page.getByLabel('Proceeds account').selectOption({ label: '1010 Bank Account' });
await btn('Calculate gain / loss').click();
await page.getByTestId('disposal-preview').waitFor();
await btn('Post disposal entry').click();
await ok(/disposed\. (Profit|Loss) on sale/);
step('asset auto-coded FA-0001, grouped, edited, then disposed with the gain or loss posted');

// ---- bank: statement line matched to an open invoice by amount, then unlinked
await page.keyboard.press('Alt+I');
await heading('Invoices');
await contactsLoaded();
await page.getByLabel('Contact', { exact: true }).fill('Kapoor Stores');
await page.getByLabel('Description 1').fill('Second supply');
await page.getByLabel('Rate 1').fill('1000');
await btn('Create').click();
await ok(/Created .*total ₹1,180\.00/);
await menu('Accounting', 'Bank accounts');
await page.getByRole('heading', { name: 'Reconcile' }).waitFor();
const dd2 = (n) => String(n).padStart(2, '0'), now2 = new Date();
await page.getByLabel('Statement file').setInputFiles({ name: 'k.csv', mimeType: 'text/csv', buffer: Buffer.from(`Date,Narration,Debit,Credit\n${dd2(now2.getDate())}/${dd2(now2.getMonth() + 1)}/${now2.getFullYear()},NEFT Kapoor,,1180\n`) });
await page.getByText('Imported 1 lines (0 duplicates skipped).').waitFor();
await page.getByRole('button', { name: /^Match invoice .* Kapoor Stores · ₹1,180\.00/ }).click();
await ok(/Matched to .*fully paid/);
await page.getByRole('button', { name: 'unlink' }).click();
await ok(/Unlinked\. .* is outstanding again/);
await page.getByRole('button', { name: /^Match invoice / }).waitFor();
step('bank line matched to the invoice with the same amount, then unlinked so the invoice is outstanding again');

// ---- cost centres on an invoice and on a journal
await menu('Accounting', 'Cost centres');
await heading('Cost centres');
await page.getByLabel('Group name (for example Branch)').fill('Department');
await page.getByLabel('Cost centres, separated by commas').fill('Sales, Admin');
await btn('Add group').click();
await page.getByText('Admin', { exact: true }).waitFor();
await page.keyboard.press('Alt+I');
await heading('Invoices');
await contactsLoaded();
await page.getByLabel('Contact', { exact: true }).fill('Kapoor Stores');
await page.getByLabel('Description 1').fill('Branch work');
await page.getByLabel('Rate 1').fill('500');
await btn('+ Add line').click().catch(() => page.getByText('+ Add line').click());
await page.getByLabel('Description 2').fill('More branch work');
await page.getByLabel('Rate 2').fill('500');
await page.getByLabel('Cost centre for all lines').selectOption({ label: 'Department: Sales' });
assert.strictEqual(await page.getByLabel('Cost centre 1').inputValue(), await page.getByLabel('Cost centre 2').inputValue(), 'one choice applied to every line');
await page.getByLabel('Cost centre 2').selectOption({ label: 'Department: Admin' });   // a single line can still differ
assert.strictEqual(await page.getByLabel('Cost centre for all lines').inputValue(), 'mixed');
await btn('Create').click();
await ok(/Created .*total ₹1,180\.00/);
await menu('Accounting', 'Manual journals');
await heading('Manual journals');
await page.getByLabel('Narration', { exact: true }).fill('Admin cost');
await page.getByLabel('Account 1').selectOption({ index: 1 });
await page.getByLabel('Debit 1').fill('700');
await page.getByLabel('Account 2').selectOption({ label: '1010 · Bank Account' });
await page.getByLabel('Credit 2').fill('700');
await page.getByLabel('Cost centre for all lines').selectOption({ label: 'Department: Admin' });
assert.strictEqual(await page.getByLabel('Cost centre 2').inputValue(), await page.getByLabel('Cost centre 1').inputValue());
await btn('Post entry').click();
await ok('Entry posted.');
step('cost centre chosen once for a whole invoice and journal, and changed on a single line');

// ---- exports: one template for everything, set by the owner under Export templates
const fs = await import('fs');
const grabbed = async (click) => { const [dl] = await Promise.all([page.waitForEvent('download'), click()]); const buf = fs.readFileSync(await dl.path()); return { name: dl.suggestedFilename(), head: buf.subarray(0, 4).toString('latin1'), size: buf.length }; };
await menu('Reporting', 'All reports');
await heading('Reports');
await page.getByRole('button', { name: 'Trial balance', exact: true }).click();
assert.strictEqual(await page.getByRole('button', { name: 'Customize export…' }).count(), 0, 'the per-export customise option is gone');
let f = await grabbed(() => btn('Export PDF').click());
assert.strictEqual(f.head, '%PDF'); assert.strictEqual(f.name, 'trial-balance.pdf');
step('reports export straight away; the per-export customise option is gone');

await btn('Export several reports…').click();
await page.getByLabel('Profit & loss', { exact: true }).check();
await page.getByLabel('Balance sheet', { exact: true }).check();
await page.getByText('3 chosen').waitFor();
f = await grabbed(() => page.getByRole('button', { name: 'Download PDF' }).last().click());
assert.strictEqual(f.head, '%PDF'); assert.strictEqual(f.name, 'reports.pdf');
f = await grabbed(() => page.getByRole('button', { name: 'Download Excel' }).last().click());
assert.strictEqual(f.head.slice(0, 2), 'PK'); assert.strictEqual(f.name, 'reports.xlsx');
await page.getByRole('button', { name: 'Clear', exact: true }).click();
assert(await page.getByRole('button', { name: 'Download PDF' }).last().isDisabled(), 'nothing chosen disables the download');
step('three reports combined into one PDF and one Excel workbook');

await menu('Sales', 'Invoices');
await heading('Invoices');
await page.getByLabel('Select all', { exact: true }).check();
f = await grabbed(() => btn('Download as one PDF').click());
assert.strictEqual(f.head, '%PDF'); assert.strictEqual(f.name, 'documents.pdf');
assert.strictEqual(await page.getByRole('button', { name: 'PDF style…' }).count(), 0);
step('all selected invoices downloaded as one PDF');

// the owner designs a template and uses it everywhere
await menu('Accounting', 'Export templates');
await heading('Export templates');
await page.getByText('Ready-made templates').waitFor();
for (const n of ['Classic', 'Modern', 'Minimal', 'Corporate', 'Elegant']) await page.getByRole('button', { name: `Customise ${n}` }).waitFor();
await btn('New template').click();
await page.getByLabel('Template name').fill('Brand red');
await page.getByRole('button', { name: 'Start from Modern' }).click();
await page.getByLabel('Main colour', { exact: true }).fill('#b91c1c');
await page.getByRole('radio', { name: 'Typeface Typewriter' }).click();
await page.getByRole('radio', { name: 'Heading Coloured band' }).click();
await page.getByRole('radio', { name: 'Table heading Solid colour' }).click();
await page.getByLabel('Table heading uses the main colour').uncheck();
await page.getByLabel('Table heading colour').fill('#7f1d1d');
await page.getByLabel('Striped rows').check();
await page.getByLabel('Footer text').fill('Brand footer');
await page.getByLabel('Invoice heading').fill('COMMERCIAL INVOICE');
await btn('Preview report').click();
await page.getByTitle('Template preview').waitFor();
await btn('Preview invoice').click();
await page.getByText('Preview: sample invoice').waitFor();
await btn('Save template').click();
await ok(/Template "Brand red" saved/);
await page.getByRole('button', { name: 'Edit Brand red' }).waitFor();
await page.getByLabel('Template for reports').selectOption({ label: 'Brand red (yours)' });
await page.getByLabel('Template for invoices and bills').selectOption({ label: 'Corporate' });
await btn('Save choice').click();
await ok(/Reports now use Brand red; invoices and bills use Corporate/);
const tok = await page.evaluate(() => sessionStorage.getItem('token'));
const orgId = Number(page.url().match(/#\/o\/(\d+)\//)[1]);
const api = async (path, body, token = tok) => (await fetch(`${URL}/api${path}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined })).json();
const saved = await api(`/orgs/${orgId}/export-settings`);
assert(saved.defaults.report.startsWith('custom:') && saved.defaults.document === 'corporate', 'the choices are saved on the server');
assert.strictEqual(saved.templates[0].config.font, 'mono');
step('owner designed "Brand red" (colours, typeface, heading, table style, footer), previewed it as PDF, and chose it for reports and Corporate for invoices');

await menu('Reporting', 'All reports');
await page.getByRole('button', { name: 'Trial balance', exact: true }).click();
f = await grabbed(() => btn('Export Excel').click());
assert.strictEqual(f.head.slice(0, 2), 'PK');
step('reports now download in the chosen template with no options to pick');

// a staff member sees the choices but cannot change them
const staffEmail = `staff${Date.now()}@example.com`;
const reg = await (await fetch(`${URL}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: staffEmail, password, fullName: 'Staff Person', firmName: 'Staff Own Firm', acceptTerms: true }) })).json();
assert(reg.token, 'staff user registered');
const me = await api('/auth/me');
await api('/members', { firmId: me.memberships[0].firmId, email: staffEmail, role: 'staff' });
const staffPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await staffPage.goto(URL);
await staffPage.getByLabel('Email').fill(staffEmail);
await staffPage.getByLabel('Password').fill(password);
await staffPage.getByRole('button', { name: 'Log in' }).click();
await staffPage.getByRole('navigation', { name: 'Account' }).waitFor();
await staffPage.evaluate((p) => { location.hash = p; }, `/o/${orgId}/export-templates`);
await staffPage.getByRole('heading', { name: 'Export templates', level: 1 }).waitFor();
await staffPage.getByText('Only the owner can change export templates').waitFor();
assert.strictEqual(await staffPage.getByRole('button', { name: 'New template' }).count(), 0, 'staff cannot design templates');
assert.strictEqual(await staffPage.getByRole('button', { name: 'Save choice' }).count(), 0, 'staff cannot change the choice');
assert(await staffPage.getByLabel('Template for reports').isDisabled(), 'the choice is read-only for staff');
await staffPage.getByRole('navigation', { name: 'Client sections' }).getByRole('button', { name: 'Accounting', exact: true }).click();
await staffPage.locator('header').getByRole('button', { name: 'Chart of accounts', exact: true }).waitFor();
assert.strictEqual(await staffPage.locator('header').getByRole('button', { name: 'Export templates', exact: true }).count(), 0, 'the menu hides Export templates from staff');
await staffPage.close();
step('a staff login sees the choices read-only and the menu hides Export templates');

// ---- expense claim: rejected claim is corrected and resubmitted
await menu('Purchases', 'Expense claims');
await page.getByLabel('What was it for?').fill('Courier');
await page.getByLabel('Claim description 1').fill('Courier charges');
await page.getByLabel('Claim account 1').selectOption({ index: 1 });
await page.getByLabel('Claim amount 1').fill('300');
await btn('Submit claim').click();
await ok(/Claim for ₹300\.00 submitted/);
await page.getByLabel('Reason, if you reject').fill('Attach the receipt');
await page.getByRole('row', { name: /Courier/ }).getByRole('button', { name: 'Reject' }).click();
await page.getByText('declined', { exact: true }).waitFor();
await page.getByRole('button', { name: 'Edit and resubmit' }).click();
await page.getByLabel('Claim amount 1').fill('320');
await btn('Resubmit claim').click();
await ok(/corrected and sent again/);
step('rejected expense claim edited and resubmitted');

assert.deepStrictEqual(errors, [], 'no console errors: ' + errors.join(' | '));
console.log('ALL CHANGE BROWSER CHECKS PASSED');
await browser.close();
