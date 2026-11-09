// Browser test for accounts and team: forgot password and reset from the emailed link, email confirmation, changing the
// password, inviting people by email (new and existing logins), the People page, and the Sales and Employee views.
// Needs API (:3000) and web (:5173) running, Google Chrome, and the dev database (it reads the email outbox to follow links).
// Run: node e2e/team.mjs
import { chromium } from 'playwright-core';
import assert from 'assert';
import pg from 'pg';

const URL = process.env.WEB_URL ?? 'http://127.0.0.1:5173';
const DB = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/acctapp';
const stamp = Date.now();
const owner = `owner${stamp}@example.com`, seller = `seller${stamp}@example.com`, worker = `worker${stamp}@example.com`;
const password = 'Passphrase-1234', newPassword = 'Brand-new-pass-5678';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = () => browser.newPage({ viewport: { width: 1440, height: 1000 } });
const page = await ctx();
page.setDefaultTimeout(Number(process.env.STEP_TIMEOUT ?? 30000));
const errors = [];
for (const p of [page]) p.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && errors.push(m.text()));
const step = (s) => console.log('✓', s);
const btn = (p, name) => p.getByRole('button', { name, exact: true });
const heading = (p, name) => p.getByRole('heading', { name, exact: true, level: 1 }).waitFor();
const bar = (p) => p.getByRole('navigation', { name: 'Client sections' });
const top = (p, name) => p.locator('header').getByRole('button', { name, exact: true });

/** The newest email to this address, read straight from the outbox: [subject, token]. */
const db = new pg.Client({ connectionString: DB }); await db.connect();
const mail = async (to) => {
  for (let i = 0; i < 20; i++) {
    const r = (await db.query('SELECT subject, body FROM email_outbox WHERE to_addr=$1 ORDER BY id DESC LIMIT 1', [to])).rows[0];
    if (r) return { subject: r.subject, token: /token=([0-9a-f]{64})/.exec(r.body)?.[1] };
    await new Promise((r2) => setTimeout(r2, 250));
  }
  throw new Error('no email for ' + to);
};
const api = async (path, body, token, method) => {
  const res = await fetch(`${URL}/api${path}`, { method: method ?? (body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const login = async (p, email, pw) => {
  await p.getByLabel('Email').fill(email); await p.getByLabel('Password').fill(pw); await btn(p, 'Log in').click();
};

// ---- the owner signs up and sets up a client
await page.goto(URL);
await btn(page, 'Create an account').click();
await page.getByLabel('Your name').fill('Owen Owner');
await page.getByLabel('Firm name').fill('Team Test Firm');
await page.getByLabel('Email').fill(owner);
await page.getByLabel('Password').fill(password);
await page.getByLabel('Accept terms').check();
await btn(page, 'Create firm account').click();
await page.getByLabel('Business name').fill('Nair Traders');
await page.getByLabel('GSTIN (optional)').fill('27AAPFU0939F1ZV');
await btn(page, 'Add client').click();
await btn(page, 'Open books').click();
await heading(page, 'Dashboard');
const orgId = Number(page.url().match(/#\/o\/(\d+)\//)[1]);
let token = await page.evaluate(() => sessionStorage.getItem('token'));
await api(`/orgs/${orgId}/contacts`, { kind: 'customer', name: 'Kapoor Stores', stateCode: '27' }, token);
await api(`/orgs/${orgId}/contacts`, { kind: 'supplier', name: 'Secret Supplier', stateCode: '27', bankAccountNo: '99887766' }, token);

// ---- email confirmation
await page.getByText('Please confirm your email address').waitFor();
const verify = await mail(owner);
assert.match(verify.subject, /Confirm your email/);
const link = await ctx();
await link.goto(`${URL}/#/verify?token=${verify.token}`);
await link.getByText('Thank you. Your email address is confirmed.').waitFor().catch(() => undefined); // shown after logging in if signed out
await link.close();
await page.reload();
await page.getByRole('navigation', { name: 'Account' }).waitFor();
await page.waitForFunction(() => !document.body.innerText.includes('Please confirm your email address'));
step('sign-up emailed a confirmation link; opening it removed the "confirm your email" bar');

// ---- change the password while logged in (other sessions end)
const other = (await api('/auth/login', { email: owner, password })).body.token;
await page.getByRole('button', { name: 'Account menu' }).click();
await top(page, 'Security').click();
await page.getByLabel('Current password').fill(password);
await page.getByLabel('New password', { exact: true }).fill(newPassword);
await page.getByLabel('New password again').fill(newPassword);
await btn(page, 'Change password').click();
await page.getByText('Password changed. Every other device has been signed out.').waitFor();
assert.strictEqual((await api('/auth/me', undefined, other)).status, 401, 'the other session was signed out');
token = await page.evaluate(() => sessionStorage.getItem('token'));
assert.strictEqual((await api('/auth/me', undefined, token)).status, 200, 'this session keeps working');
step('password changed from Security: other devices signed out, this one carries on');

// ---- forgot password, then reset from the emailed link
const lost = await ctx();
await lost.goto(URL);
await btn(lost, 'Forgot your password?').click();
await lost.getByLabel('Email').fill(owner);
await btn(lost, 'Send reset link').click();
await lost.getByText(/If that address has an account/).waitFor();
const reset = await mail(owner);
assert.match(reset.subject, /Reset your/);
await lost.goto(`${URL}/#/reset?token=${reset.token}`);
await lost.reload();
await heading(lost, 'Choose a new password');
await lost.getByLabel('New password', { exact: true }).fill('Reset-by-email-9012');
await lost.getByLabel('New password again').fill('Reset-by-email-0000');
await btn(lost, 'Change password').click();
await lost.getByRole('alert').getByText('The two passwords are different').waitFor();
await lost.getByLabel('New password again').fill('Reset-by-email-9012');
await btn(lost, 'Change password').click();
await lost.getByText('Your password has been changed. Log in with the new one.').waitFor();
assert.strictEqual((await api('/auth/me', undefined, token)).status, 401, 'the reset ended the old session');
await login(lost, owner, 'Reset-by-email-9012');
await lost.getByRole('navigation', { name: 'Account' }).waitFor();
await lost.close();
// the same link cannot be used twice
assert.strictEqual((await api('/auth/reset-password', { token: reset.token, password: 'Another-pass-1111' })).status, 400);
step('forgot password: link emailed, new password set, old session ended, the link works only once');

// ---- the owner logs back in on the main page and opens People and access
await page.evaluate(() => sessionStorage.clear());
await page.goto(`${URL}/#/clients`);
await page.reload();
await login(page, owner, 'Reset-by-email-9012');
await page.getByRole('navigation', { name: 'Account' }).waitFor();
token = await page.evaluate(() => sessionStorage.getItem('token'));
await page.getByRole('button', { name: 'Account menu' }).click();
await top(page, 'People and access').click();
await heading(page, 'People and access');
await page.getByText('1 of ').waitFor();

// invite a sales person (new login) for the client
await page.getByLabel('Invite email').fill(seller);
await page.getByLabel('Invite role').selectOption({ label: 'Sales (raise invoices and quotes, add customers)' });
await page.getByLabel('Invite client').selectOption({ label: 'Nair Traders' });
await btn(page, 'Send invitation').click();
await page.getByText(`Invitation sent to ${seller}`).waitFor();
const inviteLink = await page.getByTestId('invite-link').innerText();
assert.match(inviteLink, /#\/invite\?token=[0-9a-f]{64}$/);
await page.getByText(seller).first().waitFor();
step('owner invited a sales person; the invitation is listed and its link is shown');

// ---- the sales person opens the link, creates a login and sees a narrow app
const salesPage = await ctx();
await salesPage.goto(inviteLink.replace(/^https?:\/\/[^/]+/, URL));
await salesPage.reload();
await heading(salesPage, 'Join your team');
await salesPage.getByText(/invited to Nair Traders at Team Test Firm as Sales/).waitFor();
assert.strictEqual(await salesPage.getByLabel('Email').inputValue(), seller);
assert.strictEqual(await salesPage.getByLabel('Firm name').count(), 0, 'no firm name is asked for');
await salesPage.getByLabel('Your name').fill('Sam Seller');
await salesPage.getByLabel('Password').fill(password);
await salesPage.getByLabel('Accept terms').check();
await btn(salesPage, 'Create my login').click();
await salesPage.getByRole('navigation', { name: 'Account' }).waitFor();
assert.strictEqual(await salesPage.getByText('Please confirm your email address').count(), 0, 'an invited address counts as confirmed');
await salesPage.getByText('Nair Traders').first().click();
await salesPage.getByRole('button', { name: 'Open books' }).click().catch(() => undefined);
await salesPage.waitForURL(/#\/o\/\d+\//);
await heading(salesPage, 'Sales');
for (const gone of ['Accounting', 'Reporting', 'Tax', 'Projects', 'Purchases', 'Home']) assert.strictEqual(await bar(salesPage).getByRole('button', { name: gone, exact: true }).count(), 0, `${gone} is hidden from a sales person`);
await bar(salesPage).getByRole('button', { name: 'Sales', exact: true }).click();
for (const i of ['Invoices', 'Quotes', 'Products and services', 'Customers']) await top(salesPage, i).waitFor();
assert.strictEqual(await top(salesPage, 'Sales settings').count(), 0);
await salesPage.keyboard.press('Escape');
assert.strictEqual(await salesPage.getByRole('button', { name: 'Search' }).count(), 0, 'no search for sales people');
await salesPage.getByRole('button', { name: 'New invoice' }).click();
await heading(salesPage, 'Invoices');
await salesPage.locator('datalist option').first().waitFor({ state: 'attached' });
const names = await salesPage.locator('datalist option').evaluateAll((o) => o.map((x) => x.value));
assert.deepStrictEqual(names, ['Kapoor Stores'], 'only customers are offered');
await salesPage.getByLabel('Contact', { exact: true }).fill('Kapoor Stores');
await salesPage.getByLabel('Description 1').fill('Brand design');
await salesPage.getByLabel('Rate 1').fill('2000');
await btn(salesPage, 'Create').click();
await salesPage.getByText(/Created INV\/\d\d-\d\d\/0001: total ₹2,360\.00/).first().waitFor();
for (const hidden of ['Receive payment', 'Delete', 'Email']) assert.strictEqual(await salesPage.getByRole('button', { name: hidden, exact: true }).count(), 0, `${hidden} is hidden`);
// the rest of the books is closed, even by address
await salesPage.evaluate((p) => { location.hash = p; }, `/o/${orgId}/reports`);
await heading(salesPage, 'Sales');
const salesToken = await salesPage.evaluate(() => sessionStorage.getItem('token'));
assert.strictEqual((await api(`/orgs/${orgId}/trial-balance`, undefined, salesToken)).status, 403);
assert.strictEqual((await api(`/orgs/${orgId}/contacts`, undefined, salesToken)).body.some((c) => c.name === 'Secret Supplier'), false);
step('the sales person joined without a firm, sees only Sales, raised an invoice for a customer, and the books stay closed');

// ---- an existing login is invited as an employee and accepts by logging in
await api('/auth/register', { email: worker, password, fullName: 'Wendy Worker', firmName: 'Wendy Own Firm', acceptTerms: true });
await page.getByLabel('Invite email').fill(worker);
await page.getByLabel('Invite role').selectOption({ label: 'Employee (submit expense claims)' });
await page.getByLabel('Invite client').selectOption({ label: 'Nair Traders' });
await btn(page, 'Send invitation').click();
await page.getByText(`Invitation sent to ${worker}`).waitFor();
const empLink = (await page.getByTestId('invite-link').innerText()).replace(/^https?:\/\/[^/]+/, URL);
const empPage = await ctx();
await empPage.goto(empLink);
await empPage.reload();
await heading(empPage, 'Log in to accept');
await empPage.getByLabel('Password').fill(password);
await btn(empPage, 'Log in and accept').click();
await empPage.getByRole('navigation', { name: 'Account' }).waitFor();
await empPage.goto(`${URL}/#/o/${orgId}/dashboard`);
await heading(empPage, 'Expense claims');
for (const gone of ['Sales', 'Accounting', 'Reporting']) assert.strictEqual(await bar(empPage).getByRole('button', { name: gone, exact: true }).count(), 0);
await empPage.getByRole('button', { name: 'Open my expense claims' }).click();
await empPage.getByLabel('What was it for?').fill('Client lunch');
await empPage.getByLabel('Claim description 1').fill('Lunch');
await empPage.getByLabel('Claim account 1').selectOption({ index: 1 });
await empPage.getByLabel('Claim amount 1').fill('850');
await btn(empPage, 'Submit claim').click();
await empPage.getByText(/Claim for ₹850\.00 submitted/).waitFor();
step('an existing login accepted an employee invitation by logging in and submitted an expense claim');

// ---- the owner manages people
await page.reload();
await page.getByRole('button', { name: 'Account menu' }).click();
await top(page, 'People and access').click();
await heading(page, 'People and access');
await page.getByLabel('Role for Sam Seller at Nair Traders').selectOption('client');
await page.getByText('Sam Seller is now Client for Nair Traders.').waitFor();
await page.getByLabel('Role for Wendy Worker at Nair Traders').waitFor();
await page.once('dialog', (d) => d.accept());
await btn(page, 'Remove Wendy Worker at Nair Traders').click();
await page.getByText('Removed Wendy Worker.').waitFor();
await empPage.reload();
await empPage.getByText('That client was not found, or you do not have access.').waitFor();
// the only owner cannot be demoted or removed
await page.getByLabel('Role for Owen Owner').selectOption('staff');
await page.getByRole('alert').getByText(/at least one owner/).waitFor();
step('owner changed a role and removed a person (access ended at once); the last owner cannot be demoted');

// an invitation can be cancelled
await page.getByLabel('Invite email').fill(`never${stamp}@example.com`);
await btn(page, 'Send invitation').click();
await page.getByText(`never${stamp}@example.com`).first().waitFor();
await btn(page, `Cancel invitation to never${stamp}@example.com`).click();
await page.getByText(`Invitation to never${stamp}@example.com cancelled.`).waitFor();
step('an invitation was cancelled');

await db.end();
assert.deepStrictEqual(errors, [], 'no console errors: ' + errors.join(' | '));
console.log('ALL TEAM BROWSER CHECKS PASSED');
await browser.close();
