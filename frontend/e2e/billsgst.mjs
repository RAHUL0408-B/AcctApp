// Browser test for repeating bills, batch payments, access per person, and the GST details: cess, blocked credit
// (section 17(5)), Rule 37 reversal and reclaim, GSTR-2B labels, GSTR-1 JSON and GSTR-3B lines.
// Needs API (:3000) and web (:5173) running and Google Chrome.  Run: node e2e/billsgst.mjs
import { chromium } from 'playwright-core';
import assert from 'assert';
import { readFileSync } from 'fs';

const URL = process.env.WEB_URL ?? 'http://127.0.0.1:5173';
const stamp = Date.now(), email = `bg${stamp}@example.com`, staffEmail = `bgstaff${stamp}@example.com`, password = 'Passphrase-1234';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
page.setDefaultTimeout(Number(process.env.STEP_TIMEOUT ?? 30000));
const errors = [];
const watch = (p) => p.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && errors.push(m.text()));
watch(page);
page.on('dialog', (d) => d.accept());
const step = (s) => console.log('✓', s);
const btn = (name, p = page) => p.locator('main').getByRole('button', { name, exact: true });
const heading = (name, p = page) => p.getByRole('heading', { name, exact: true, level: 1 }).waitFor();
const menu = async (group, item, p = page) => {
  const nav = p.getByRole('navigation', { name: 'Client sections' });
  const box = nav.getByRole('group', { name: group, exact: true });
  if ((await box.count()) === 0) return nav.getByRole('button', { name: item, exact: true }).click();
  const head = box.getByRole('button', { name: group, exact: true });
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
  await box.getByRole('button', { name: item, exact: true }).click();
};
const ok = (re, p = page) => p.getByText(re).first().waitFor();
const CH = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const gstin = (f) => { let s = 0; for (let i = 0; i < 14; i++) { const v = CH.indexOf(f[i]) * (i % 2 ? 2 : 1); s += Math.floor(v / 36) + (v % 36); } return f + CH[(36 - (s % 36)) % 36]; };
const day = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
const today = day(0), month = today.slice(0, 7);
const raw = async (path, body, token, method) => { const r = await fetch(`${URL}/api${path}`, { method: method ?? (body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };

await page.goto(URL);
await page.getByRole('button', { name: 'Create an account', exact: true }).click();
await page.getByLabel('Your name').fill('GST Owner');
await page.getByLabel('Firm name').fill('GST Associates');
await page.getByLabel('Email').fill(email);
await page.getByLabel('Password').fill(password);
await page.getByLabel('Accept terms').check();
await page.getByRole('button', { name: 'Create firm account', exact: true }).click();
await page.getByLabel('Business name').fill('Deccan Motors');
await page.getByLabel('GSTIN (optional)').fill('27AAPFU0939F1ZV');
await page.getByRole('button', { name: 'Add client', exact: true }).click();
await page.getByRole('button', { name: 'Open books', exact: true }).click();
await heading('Dashboard');
const orgId = Number(page.url().match(/#\/o\/(\d+)\//)[1]);
const token = await page.evaluate(() => sessionStorage.getItem('token'));
const api = async (path, body, method) => (await raw(`/orgs/${orgId}${path}`, body, token, method)).body;
const supplier = (await api('/contacts', { kind: 'supplier', name: 'Pune Parts', gstin: gstin('27AAACP1234P1Z') })).id;
const far = (await api('/contacts', { kind: 'supplier', name: 'Karnataka Tools', gstin: gstin('29AAACK1234K1Z') })).id;
const customer = (await api('/contacts', { kind: 'customer', name: 'Shah Auto', gstin: gstin('27AAACS1234S1Z') })).id;
const accounts = await api('/accounts');
const bankId = accounts.find((a) => a.code === '1010').id;
const line = (rate) => [{ description: 'Parts', quantity: 1, rate, gstRateBp: 1800 }];

// ---- repeating bill
await menu('Purchases', 'Repeating bills');
await heading('Repeating bills');
await btn('New repeating bill').click();
await page.locator('datalist option').first().waitFor({ state: 'attached' });
await page.getByLabel('Contact', { exact: true }).fill('Pune Parts');
await page.getByLabel('Frequency').selectOption('monthly');
await page.getByLabel('Note on each bill (optional)').fill('Workshop rent');
await page.getByLabel('Description 1').fill('Workshop rent');
await page.getByLabel('Rate 1').fill('25000');
await btn('Save schedule').click();
await ok(/Saved\. The first bill is created on/);
await page.getByRole('cell', { name: 'Pune Parts' }).waitFor();
step('repeating bill for rent saved under Purchases, Repeating bills');

// ---- batch payment of two bills
const b1 = await api('/documents', { docType: 'bill', contactId: far, issueDate: today, supplierRef: 'KT-1', lines: line(100000) });
const b2 = await api('/documents', { docType: 'bill', contactId: far, issueDate: today, supplierRef: 'KT-2', lines: line(200000) });
await menu('Purchases', 'Bills');
await heading('Bills');
await page.getByLabel(`Select ${b1.number}`).check();
await page.getByLabel(`Select ${b2.number}`).check();
await btn('Pay 2 bill(s) together').click();
await page.getByTestId('batch-panel').waitFor();
assert.strictEqual(await page.getByTestId('batch-total').innerText(), '₹3,540.00');
await page.getByLabel('Batch account').selectOption(String(bankId));
await page.getByLabel('Batch reference').fill('NEFT-9911');
await btn('Record batch payment').click();
await ok('Batch payment of ₹3,540.00 recorded for 2 bill(s), as one bank entry.');
await menu('Purchases', 'Batch payments');
await heading('Batch payments');
await page.getByTestId('batch-rows').getByText('NEFT-9911').waitFor();
await btn('Undo').click();
await ok(/Batch #\d+ undone\./);
assert.strictEqual((await api(`/documents/${b1.id}`)).outstanding, 118000, 'the bill is outstanding again');
step('two bills (Rs 3,540) paid together as one bank entry, listed under Batch payments, and undone');

// ---- cess on an invoice
await menu('Sales', 'Invoices');
await btn('New invoice').click();
await page.locator('datalist option').first().waitFor({ state: 'attached' });
await page.getByLabel('Contact', { exact: true }).fill('Shah Auto');
await page.getByLabel('Description 1').fill('Car');
await page.getByLabel('Rate 1').fill('1000');
await page.getByLabel('GST 1').selectOption('2800');
await page.getByLabel('Show cess and blocked credit').check();
await page.getByLabel('Cess 1').fill('22');
assert.strictEqual(await page.getByTestId('cess-total').innerText(), '₹220.00');
assert.strictEqual(await page.getByTestId('grand-total').innerText(), '₹1,500.00');
await btn('Create').click();
await ok(/Created INV\/\d\d-\d\d\/\d+: total ₹1,500\.00/);
step('invoice with 28% GST and 22% cess: cess Rs 220 shown and posted, total Rs 1,500');

// ---- blocked credit on a bill, and on an account
await menu('Purchases', 'Bills');
await btn('New bill').click();
await page.locator('datalist option').first().waitFor({ state: 'attached' });
await page.getByLabel('Contact', { exact: true }).fill('Pune Parts');
await page.getByLabel('Supplier bill no.').fill('PP-LUNCH');
await page.getByLabel('Description 1').fill('Team lunch');
await page.getByLabel('Rate 1').fill('1000');
await page.getByLabel('GST 1').selectOption('500');
await page.getByLabel('Show cess and blocked credit').check();
await page.getByLabel('Blocked credit 1').check();
await page.getByText('GST on lines marked "No ITC" is added to their cost and is not claimed.').waitFor();
await btn('Create').click();
await ok(/Created BILL\/\d\d-\d\d\/\d+/);
await menu('Accounting', 'Chart of accounts');
await heading('Chart of accounts');
const expense = accounts.find((a) => a.type === 'expense' && a.code !== '5000');
await page.getByLabel(`Blocked credit ${expense.code}`).click();
await page.getByText('no ITC', { exact: true }).first().waitFor();
step('bill line marked "No ITC" (section 17(5)); an expense account marked 17(5) in the chart of accounts');

// ---- Rule 37: reverse and claim again
const old = await api('/documents', { docType: 'bill', contactId: far, issueDate: day(200), supplierRef: 'KT-OLD', lines: line(100000) });
await menu('Tax', 'ITC 180-day rule');
await page.getByRole('button', { name: `Reverse credit on ${old.number}` }).click();
await ok(`₹180.00 of input credit on ${old.number} reversed.`);
await page.getByTestId('itc-reversals').getByText('₹1,180.00 still unpaid').waitFor();
await api(`/documents/${old.id}/payments`, { date: today, amount: 118000, accountId: bankId });
await page.reload();
await page.getByRole('tab', { name: 'ITC 180-day rule', selected: true }).waitFor();
await page.getByRole('button', { name: `Reclaim credit on ${old.number}` }).click();
await ok(`₹180.00 of input credit on ${old.number} claimed again.`);
step('Rule 37: Rs 180 of credit on a 200-day-old unpaid bill reversed; claimed again after payment');

// ---- GSTR-3B lines and the GSTR-1 JSON
await menu('Tax', 'GSTR-3B'); await page.locator('main').getByRole('button', { name: 'Run', exact: true }).click();
await page.getByTestId('gstr3b').getByText('4(D)(1) Ineligible ITC, section 17(5) (not claimed)').waitFor();
await page.getByTestId('gstr3b').getByText('4(B)(2) Credit reversed (Rule 37, unpaid 180 days)').waitFor();
await page.getByTestId('gstr3b').getByText('4(A)(5) Credit claimed again (Rule 37, paid)').waitFor();
await menu('Tax', 'GSTR-1'); await page.locator('main').getByRole('button', { name: 'Run', exact: true }).click();
await page.getByLabel('GSTR-1 month').fill(month);
const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download JSON for the GST portal' }).click()]);
assert.strictEqual(dl.suggestedFilename(), `GSTR1-${month}.json`);
const j = JSON.parse(readFileSync(await dl.path(), 'utf8'));
assert.strictEqual(j.gstin, '27AAPFU0939F1ZV');
assert.strictEqual(j.b2b[0].ctin, gstin('27AAACS1234S1Z'));
assert.deepStrictEqual(j.b2b[0].inv[0].itms[0].itm_det, { rt: 28, txval: 1000, iamt: 0, camt: 140, samt: 140, csamt: 220 });
step('GSTR-3B shows blocked, reversed and reclaimed credit; GSTR-1 JSON downloaded with the cess');

// ---- access per person: a bank-only staff member
const staff = await raw('/auth/register', { email: staffEmail, password, fullName: 'Bina Bank', firmName: 'Bina own firm', acceptTerms: true });
assert.strictEqual(staff.status, 201);
const firmId = (await raw('/auth/me', undefined, token)).body.memberships.find((m) => m.orgId === null).firmId;
assert.strictEqual((await raw('/members', { firmId, email: staffEmail, role: 'staff' }, token)).status, 201);
await page.getByRole('button', { name: 'Account menu' }).click();
await page.locator('header').getByRole('button', { name: 'People and access', exact: true }).click();
await heading('People and access');
await page.getByRole('button', { name: /^Limit access for Bina Bank/ }).first().click();
await page.getByTestId('access-editor').waitFor();
await btn('Bank only').click();
await btn('Save access').click();
await ok(/access is limited: No Sales, Purchases, Accounting, Reports, Tax and compliance, Projects, Settings · View only: Contacts/);
const sp = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
watch(sp);
await sp.goto(URL);
await sp.getByLabel('Email').fill(staffEmail); await sp.getByLabel('Password').fill(password);
await sp.getByRole('button', { name: 'Log in', exact: true }).click();
await sp.getByText('GST Associates — clients').waitFor();
await sp.getByRole('button', { name: 'Open books', exact: true }).click();
await heading('Dashboard', sp);
const nav = sp.getByRole('navigation', { name: 'Client sections' });
await nav.getByRole('group', { name: 'Accounting', exact: true }).waitFor();
for (const g of ['Sales', 'Purchases', 'Reporting', 'Tax', 'Projects']) assert.strictEqual(await nav.getByRole('group', { name: g, exact: true }).count() + await nav.getByRole('button', { name: g, exact: true }).count(), 0, `${g} is hidden`);
await menu('Accounting', 'Bank accounts', sp);
await heading('Bank accounts', sp);
await sp.evaluate((id) => { location.hash = `#/o/${id}/invoices`; }, orgId);
await sp.getByRole('alert').getByText("You do not have access to this part of Deccan Motors's books.").waitFor();
assert.strictEqual((await raw(`/orgs/${orgId}/documents?type=invoice`, undefined, await sp.evaluate(() => sessionStorage.getItem('token')))).status, 403, 'the API refuses too');
step('owner limited a staff member to "Bank only": they see Bank and Contacts, not Sales, Purchases, Reports or Tax');

assert.deepStrictEqual(errors, [], 'no console errors: ' + errors.join(' | '));
console.log('ALL BILLS, ACCESS AND GST BROWSER CHECKS PASSED');
await browser.close();
