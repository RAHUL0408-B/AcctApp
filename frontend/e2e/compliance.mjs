// Browser test for the compliance checks: MSME details on a supplier, the duplicate supplier-bill warning, GSTR-2B upload
// and matching, MSME 43B(h), the 180-day ITC rule, exports and alerts.
// Needs API (:3000) and web (:5173) running and Google Chrome.  Run: node e2e/compliance.mjs
import { chromium } from 'playwright-core';
import assert from 'assert';

const URL = process.env.WEB_URL ?? 'http://127.0.0.1:5173';
const email = `comp${Date.now()}@example.com`, password = 'Passphrase-1234';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
page.setDefaultTimeout(Number(process.env.STEP_TIMEOUT ?? 30000));
const errors = [];
page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && errors.push(m.text()));
let answer = 'accept', dialogs = [];
page.on('dialog', (d) => { dialogs.push(d.message()); answer === 'accept' ? d.accept() : d.dismiss(); });
const step = (s) => console.log('✓', s);
const btn = (name) => page.getByRole('button', { name, exact: true });
const heading = (name) => page.getByRole('heading', { name, exact: true, level: 1 }).waitFor();
const bar = () => page.getByRole('navigation', { name: 'Client sections' });
const top = (name) => page.locator('header').getByRole('button', { name, exact: true });
const menu = async (group, entry) => { await bar().getByRole('button', { name: group, exact: true }).click(); await top(entry).click(); };
const ok = (re) => page.getByText(re).first().waitFor();
const CH = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const gstin = (f) => { let s = 0; for (let i = 0; i < 14; i++) { const v = CH.indexOf(f[i]) * (i % 2 ? 2 : 1); s += Math.floor(v / 36) + (v % 36); } return f + CH[(36 - (s % 36)) % 36]; };
const day = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
const today = day(0), month = today.slice(0, 7);

await page.goto(URL);
await btn('Create an account').click();
await page.getByLabel('Your name').fill('Compliance CA');
await page.getByLabel('Firm name').fill('Compliance Associates');
await page.getByLabel('Email').fill(email);
await page.getByLabel('Password').fill(password);
await page.getByLabel('Accept terms').check();
await btn('Create firm account').click();
await page.getByLabel('Business name').fill('Pune Fabricators');
await page.getByLabel('GSTIN (optional)').fill('27AAPFU0939F1ZV');
await btn('Add client').click();
await btn('Open books').click();
await heading('Dashboard');
const orgId = Number(page.url().match(/#\/o\/(\d+)\//)[1]);
const token = await page.evaluate(() => sessionStorage.getItem('token'));
const api = async (path, body) => { const r = await fetch(`${URL}/api/orgs/${orgId}${path}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined }); return r.json(); };

// ---- an MSME supplier, entered on screen
await menu('Contacts', 'Suppliers');
await btn('New supplier').click();
await page.getByLabel('Name', { exact: true }).fill('Tiny Tools');
await page.getByLabel('GSTIN').fill(gstin('27AAACT9876T1Z'));
await page.getByLabel('MSME type').selectOption('micro');
await page.getByLabel('Udyam number').fill('udyam-mh-26-0012345');
await page.getByLabel('Agreed payment days').fill('30');
await page.getByText('pay this supplier within 30 days of each bill').waitFor();
await page.getByLabel('Agreed payment days').fill('60');
await page.getByText('pay this supplier within 45 days of each bill').waitFor();   // never more than 45
await page.getByLabel('Agreed payment days').fill('');
await btn('Add contact').click();
await page.getByRole('cell', { name: 'Tiny Tools' }).waitFor();
step('supplier saved as a micro enterprise with its Udyam number; the 43B(h) limit is explained (15 days, agreed days capped at 45)');

// ---- data for the checks (through the API, to keep the test short)
const contacts = await api('/contacts');
const tiny = contacts.find((c) => c.name === 'Tiny Tools').id;
const filer = (await api('/contacts', { kind: 'supplier', name: 'Good Filer', gstin: gstin('29AAACG1234G1Z') })).id;
const lazy = (await api('/contacts', { kind: 'supplier', name: 'Lazy Filer', gstin: gstin('24AAACL1234L1Z') })).id;
await api('/contacts', { kind: 'supplier', name: 'Status Unknown', stateCode: '27' });
const line = (rate) => [{ description: 'Material', quantity: 1, rate, gstRateBp: 1800 }];
await api('/documents', { docType: 'bill', contactId: tiny, issueDate: day(25), supplierRef: 'TT/101', lines: line(100000) });   // overdue (15 days)
await api('/documents', { docType: 'bill', contactId: tiny, issueDate: day(2), supplierRef: 'TT/102', lines: line(50000) });     // 13 days left
await api('/documents', { docType: 'bill', contactId: filer, issueDate: `${month}-01`, supplierRef: 'GF/0042', lines: line(200000) });
await api('/documents', { docType: 'bill', contactId: lazy, issueDate: `${month}-01`, supplierRef: 'LF-7', lines: line(100000) });
const old = await api('/documents', { docType: 'bill', contactId: filer, issueDate: day(200), supplierRef: 'GF/0001', lines: line(100000) });
assert(old.id, 'old bill created');

// ---- duplicate supplier bill
await menu('Purchases', 'Bills');
await btn('New bill').click();
await page.locator('datalist option').first().waitFor({ state: 'attached' });
await page.getByLabel('Contact', { exact: true }).fill('Good Filer');
await page.getByLabel('Supplier bill no.').fill('gf-42');
await page.getByLabel('Description 1').fill('Steel');
await page.getByLabel('Rate 1').fill('2000');
answer = 'dismiss'; dialogs = [];
await btn('Create').click();
await page.getByRole('alert').getByText(/Possible duplicate: bill .* already has supplier bill no\. GF\/0042/).waitFor();
assert(dialogs.some((d) => /claims its GST credit twice/.test(d) && /Post this bill anyway\?/.test(d)), 'asked before posting a duplicate');
await page.getByLabel('Supplier bill no.').fill('GF/0043');
answer = 'accept';
await btn('Create').click();
await ok(/Created BILL\/\d\d-\d\d\/\d+/);
step('the same supplier bill number (written gf-42 against GF/0042) was stopped with a warning; a new number posted normally');

// ---- GSTR-2B: upload the portal file and match
await menu('Tax', 'GSTR-2B match');
await heading('Compliance checks');
const twoB = { data: { rtnprd: `${month.slice(5)}${month.slice(0, 4)}`, docdata: { b2b: [
  { ctin: gstin('29AAACG1234G1Z'), trdnm: 'Good Filer', inv: [{ inum: 'GF-42', dt: `01-${month.slice(5)}-${month.slice(0, 4)}`, items: [{ txval: 2000, igst: 360 }] }, { inum: 'GF/0043', dt: `02-${month.slice(5)}-${month.slice(0, 4)}`, items: [{ txval: 2000, igst: 300 }] }] },
  { ctin: gstin('33AAACX1234X1Z'), trdnm: 'Someone Else', inv: [{ inum: 'X-9', dt: `03-${month.slice(5)}-${month.slice(0, 4)}`, items: [{ txval: 1000, igst: 180 }] }] }] } } };
await page.getByLabel('GSTR-2B file').setInputFiles({ name: 'GSTR2B.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(twoB)) });
await btn('Upload and match').click();
await ok(new RegExp(`Read 3 invoice\\(s\\) for ${month}`));
const summary = page.getByTestId('twob-summary');
await summary.getByText('Matched').waitFor();
const tiles = await summary.innerText();
assert.match(tiles, /Matched\s+1/); assert.match(tiles, /Tax differs\s+1/); assert.match(tiles, /Only in GSTR-2B\s+1/); assert.match(tiles, /Only in your books\s+2/);                                  // Lazy Filer, and Tiny Tools' bill from this month
assert.match(tiles, /Credit at risk\s+₹330\.00/);                                   // Rs 180 + Rs 90 never reported, Rs 60 under-reported
await page.getByText('Suppliers to chase (3)').waitFor();
await page.getByRole('button', { name: 'Copy reminder for Lazy Filer' }).click();
await ok('Message for Lazy Filer copied.');
await page.getByRole('button', { name: /^Only in your books \(2\)/ }).click();
assert.strictEqual(await page.getByTestId('twob-rows').locator('tbody tr').count(), 2);
await page.getByTestId('twob-rows').getByText('Lazy Filer').waitFor();
const [csv] = await Promise.all([page.waitForEvent('download'), btn('Download CSV').click()]);
assert.match(csv.suggestedFilename(), new RegExp(`gstr2b-match-${month}\\.csv`));
step('GSTR-2B uploaded: 1 matched (GF-42 = GF/0042), 1 tax difference, 1 portal-only, 2 not reported; Rs 330 credit at risk; reminder copied; CSV saved');

// ---- MSME 43B(h)
await page.getByRole('tab', { name: 'MSME payments (43B(h))' }).click();
await page.getByTestId('msme-summary').waitFor();
const ms = await page.getByTestId('msme-summary').innerText();
assert.match(ms, /Overdue: pay now\s+₹1,180\.00/);
assert.match(ms, /Expense not allowed, FY [0-9-]+\s+₹1,000\.00/);                    // the GST is not part of the expense
await page.getByTestId('msme-rows').getByText('Overdue: pay now').waitFor();
await page.getByTestId('msme-rows').getByText('Not yet due').waitFor();
await page.getByTestId('msme-missing').getByText(/Status Unknown/).waitFor();
const [x1] = await Promise.all([page.waitForEvent('download'), btn('Export Excel').click()]);
assert.match(x1.suggestedFilename(), /msme-43bh-\d{4}\.xlsx/);
step('MSME 43B(h): Rs 1,180 overdue to pay now, Rs 1,000 expense not allowed (GST excluded), a bill not yet due, suppliers without MSME status named; exported');

// ---- 180-day rule
await page.getByRole('tab', { name: 'ITC 180-day rule' }).click();
await page.getByTestId('itc-summary').waitFor();
assert.match(await page.getByTestId('itc-summary').innerText(), /Credit to reverse now\s+₹180\.00/);
await page.getByTestId('itc-rows').getByText('GF/0001').waitFor();
const [x2] = await Promise.all([page.waitForEvent('download'), btn('Export PDF').click()]);
assert.match(x2.suggestedFilename(), /itc-180-days-.*\.pdf/);
step('180-day rule: the bill unpaid for 200 days shows Rs 180 of credit to reverse; exported');

// ---- alerts in the bell lead to the checks
await page.getByRole('button', { name: 'Notifications' }).click();
await page.locator('header').getByText(/MSME bill\(s\) past the 43B\(h\) limit/).waitFor();
await page.locator('header').getByText(/unpaid for over 180 days/).click();
await page.getByRole('tab', { name: 'ITC 180-day rule', selected: true }).waitFor();
step('notifications warn about MSME bills and credit to reverse, and open the right check');

assert.deepStrictEqual(errors, [], 'no console errors: ' + errors.join(' | '));
console.log('ALL COMPLIANCE BROWSER CHECKS PASSED');
await browser.close();
