// Login test: every sign-in API, then the login screen in a real browser, including a slow or unreachable server.
// Needs the API (:3000, started with TRUST_PROXY=1), the web app (:5173), the database and Google Chrome.  Run: node frontend/e2e/logins.mjs
// Emailed links (reset, confirm) are read from the email outbox table, so DATABASE_URL must point at the API's database.
import { chromium } from 'playwright-core';
import { createHmac } from 'crypto';
import { createRequire } from 'module';
import assert from 'assert';

const require = createRequire(import.meta.url);
const { Client } = require('pg');

const API = process.env.API_URL ?? 'http://localhost:3000/api';
const WEB = process.env.WEB_URL ?? 'http://127.0.0.1:5173';
const db = new Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/acctapp' });
await db.connect();

let n = 0;
const results = [];
const pass = (name) => { n += 1; results.push(name); console.log(`PASS ${String(n).padStart(2, '0')}  ${name}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function totp(secret, at = Date.now()) {
  let bits = 0, val = 0; const key = [];
  for (const ch of secret) { val = (val << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { key.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(Math.floor(at / 30000)));
  const h = createHmac('sha1', Buffer.from(key)).update(msg).digest(); const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}

// The API allows 10 login tries a minute for each address and email, which this script would trip by itself.
// Each call therefore comes from a different pretend address (the API must run with TRUST_PROXY=1 to read it);
// the check of that limit pins one address.
let device = 0;
async function call(path, { method, body, token, from } = {}) {
  device += 1;
  const res = await fetch(API + path, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': from ?? `10.${(device >> 16) & 255}.${(device >> 8) & 255}.${device & 255}`, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const expect = async (path, opts, status, message) => {
  const r = await call(path, opts);
  assert.strictEqual(r.status, status, `${path}: expected ${status}, got ${r.status} ${JSON.stringify(r.data)}`);
  if (message) assert.ok(String(r.data.message).includes(message), `${path}: expected "${message}", got "${r.data.message}"`);
  return r.data;
};
/** Sign-ups are limited to 10 a minute for each address; wait out the limit instead of failing. */
async function register(body) {
  for (;;) {
    const r = await call('/auth/register', { body: { acceptTerms: true, ...body } });
    if (r.status !== 429) return r;
    console.log('     (sign-up limit reached, waiting a minute)'); await sleep(61_000);
  }
}
const login = (email, password) => call('/auth/login', { body: { email, password } });
/** The newest emailed link of one kind sent to an address. */
async function mailedLink(to, screen) {
  for (let i = 0; i < 20; i++) {
    const rows = (await db.query('SELECT body FROM email_outbox WHERE to_addr=$1 ORDER BY id DESC', [to])).rows;
    for (const r of rows) { const m = new RegExp(`#/${screen}\\?token=([\\w-]+)`).exec(r.body); if (m) return m[1]; }
    await sleep(250);
  }
  throw new Error(`No ${screen} email found for ${to}`);
}

const stamp = Date.now();
const email = `login${stamp}@example.com`, pw1 = 'Passphrase-1234', pw2 = 'Another-Phrase-5678', pw3 = 'Third-Phrase-9012';

// ------------------------------------------------------------------ 1. the server answers
{
  const h = await expect('/health', {}, 200);
  assert.strictEqual(h.status, 'ok'); assert.strictEqual(h.db, 'ok');
  pass('Server and database are up');
}

// ------------------------------------------------------------------ 2. sign up
let token;
{
  const r = await register({ email, password: pw1, fullName: 'Login Tester', firmName: 'Login Test & Co' });
  assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.data)); assert.ok(r.data.token);
  token = r.data.token;
  pass('Sign up creates the account and logs in');

  const dup = await register({ email, password: pw1, fullName: 'Again', firmName: 'Again & Co' });
  assert.strictEqual(dup.status, 409, JSON.stringify(dup.data));
  pass('Signing up twice with the same email is refused');

  const weak = await register({ email: `weak${stamp}@example.com`, password: 'password1234', fullName: 'Weak', firmName: 'Weak & Co' });
  assert.strictEqual(weak.status, 400, JSON.stringify(weak.data));
  await expect('/auth/register', { body: { email: `short${stamp}@example.com`, password: 'Ab1!', fullName: 'S', firmName: 'S', acceptTerms: true } }, 400, 'at least 10');
  pass('Weak and short passwords are refused at sign up');

  await expect('/auth/register', { body: { email: `noterms${stamp}@example.com`, password: pw1, fullName: 'N', firmName: 'N' } }, 400, 'Terms');
  await expect('/auth/register', { body: { email: 'not-an-email', password: pw1, fullName: 'N', firmName: 'N', acceptTerms: true } }, 400);
  pass('Sign up needs the terms accepted and a real email address');
}

// ------------------------------------------------------------------ 3. log in
{
  const ok = await login(email, pw1);
  assert.strictEqual(ok.status, 200); assert.ok(ok.data.token);
  pass('Log in with the right email and password');

  for (const typed of [email.toUpperCase(), `  ${email}  `, ` ${email[0].toUpperCase()}${email.slice(1)}\t`]) {
    const r = await login(typed, pw1);
    assert.strictEqual(r.status, 200, `"${typed}": ${JSON.stringify(r.data)}`);
  }
  pass('Log in works with capital letters or spaces around the email');

  await expect('/auth/login', { body: { email, password: 'wrong-password' } }, 401, 'Wrong email or password');
  await expect('/auth/login', { body: { email: `nobody${stamp}@example.com`, password: pw1 } }, 401, 'Wrong email or password');
  pass('Wrong password and unknown email give the same refusal');

  await expect('/auth/login', { body: { email } }, 400);
  await expect('/auth/login', { body: { email: 'x', password: 'y' } }, 400);
  await expect('/auth/login', { body: { email, password: '' } }, 400);
  pass('Log in with a missing or malformed field is refused cleanly (no server error)');

  await login(email, pw1); // clear the failed count from the wrong password above
  for (let i = 0; i < 12; i++) { const r = await login(email, pw1); assert.strictEqual(r.status, 200, `repeat ${i}: ${JSON.stringify(r.data)}`); }
  pass('Logging in several times in a row works every time');
}

// ------------------------------------------------------------------ 4. the session
let firmId;
{
  const me = await expect('/auth/me', { token }, 200);
  assert.strictEqual(me.email, email); assert.strictEqual(me.memberships[0].role, 'owner');
  firmId = me.memberships[0].firmId;
  assert.ok(Array.isArray(await expect('/orgs', { token }, 200)));
  pass('A logged-in person gets their account, firm and client list');

  await expect('/auth/me', {}, 401, 'Missing token');
  await expect('/auth/me', { token: 'not-a-token' }, 401, 'Invalid or expired token');
  await expect('/auth/me', { token: token.slice(0, -4) + 'AAAA' }, 401, 'Invalid or expired token');
  await expect('/orgs', {}, 401);
  pass('No token, a made-up token and a tampered token are all refused');

  const many = await Promise.all(Array.from({ length: 40 }, (_, i) => call(i % 2 ? '/auth/me' : '/orgs', { token })));
  assert.deepStrictEqual([...new Set(many.map((r) => r.status))], [200]);
  pass('40 requests at the same moment all succeed (no random failures)');

  const two = await Promise.all([login(email, pw1), login(email, pw1), login(email, pw1)]);
  assert.ok(two.every((r) => r.status === 200));
  assert.strictEqual((await call('/auth/me', { token })).status, 200);
  for (const r of two) assert.strictEqual((await call('/auth/me', { token: r.data.token })).status, 200);
  pass('Being logged in on several devices at once works');
}

// ------------------------------------------------------------------ 5. limits and lock
{
  const probe = `limit${stamp}@example.com`;
  const codes = [];
  for (let i = 0; i < 11; i++) codes.push((await call('/auth/login', { body: { email: probe, password: 'x' }, from: '10.250.0.1' })).status);
  assert.deepStrictEqual(codes.slice(0, 10), Array(10).fill(401)); assert.strictEqual(codes[10], 429);
  assert.strictEqual((await login(email, pw1)).status, 200);
  pass('More than 10 tries a minute on one email is slowed down, without blocking other people');

  const locked = `lock${stamp}@example.com`;
  assert.ok((await register({ email: locked, password: pw1, fullName: 'Lock Tester', firmName: 'Lock & Co' })).data.token);
  for (let i = 0; i < 4; i++) await expect('/auth/login', { body: { email: locked, password: 'wrong' } }, 401, 'Wrong email or password');
  assert.strictEqual((await login(locked, pw1)).status, 200);
  pass('4 wrong passwords then the right one still logs in, and resets the count');

  for (let i = 0; i < 5; i++) await expect('/auth/login', { body: { email: locked, password: 'wrong' } }, 401, 'Wrong email or password');
  await expect('/auth/login', { body: { email: locked, password: pw1 } }, 401, 'temporarily locked');
  pass('5 wrong passwords lock the account, and the message says so');

  await expect('/auth/forgot-password', { body: { email: locked } }, 200);
  await expect('/auth/reset-password', { body: { token: await mailedLink(locked, 'reset'), password: pw2 } }, 200);
  assert.strictEqual((await login(locked, pw2)).status, 200);
  pass('A locked account is opened again by resetting the password');
}

// ------------------------------------------------------------------ 6. forgot and reset password
{
  const a = await expect('/auth/forgot-password', { body: { email: `nobody${stamp}@example.com` } }, 200);
  const b = await expect('/auth/forgot-password', { body: { email: ` ${email.toUpperCase()} ` } }, 200);
  assert.strictEqual(a.message, b.message);
  pass('Forgot password answers the same for a known and an unknown email');

  const link = await mailedLink(email, 'reset');
  await expect('/auth/reset-password', { body: { token: link, password: 'password1234' } }, 400);
  await expect('/auth/reset-password', { body: { token: 'x'.repeat(40), password: pw2 } }, 400, 'expired or was already used');
  await expect('/auth/reset-password', { body: { token: link, password: pw2 } }, 200);
  pass('The emailed reset link sets a new password (weak passwords and made-up links refused)');

  await expect('/auth/login', { body: { email, password: pw1 } }, 401, 'Wrong email or password');
  const r = await login(email, pw2);
  assert.strictEqual(r.status, 200);
  pass('After a reset the old password stops working and the new one works');

  await expect('/auth/me', { token }, 401, 'Your password was changed');
  await expect('/auth/reset-password', { body: { token: link, password: pw3 } }, 400, 'expired or was already used');
  token = r.data.token;
  pass('A reset logs out every other device, and the link cannot be used twice');
}

// ------------------------------------------------------------------ 7. change password
{
  await expect('/auth/change-password', { token, body: { currentPassword: 'wrong', newPassword: pw3 } }, 401, 'current password is wrong');
  await expect('/auth/me', { token }, 200);
  await expect('/auth/change-password', { token, body: { currentPassword: pw2, newPassword: pw2 } }, 400);
  await expect('/auth/change-password', { token, body: { currentPassword: pw2, newPassword: 'short' } }, 400);
  pass('Change password refuses a wrong current password, the same password and a short one (and keeps you logged in)');

  const other = (await login(email, pw2)).data.token;
  const r = await expect('/auth/change-password', { token, body: { currentPassword: pw2, newPassword: pw3 } }, 200);
  assert.ok(r.token);
  await expect('/auth/me', { token: r.token }, 200);
  await expect('/auth/me', { token: other }, 401, 'Your password was changed');
  assert.strictEqual((await login(email, pw3)).status, 200);
  await expect('/auth/login', { body: { email, password: pw2 } }, 401);
  token = (await login(email, pw3)).data.token;
  pass('Change password keeps this device logged in, logs out the others, and the new password works');
}

// ------------------------------------------------------------------ 8. confirm email
{
  assert.strictEqual((await expect('/auth/me', { token }, 200)).emailVerified, true); // a reset link proves the address
  const fresh = `verify${stamp}@example.com`;
  const t = (await register({ email: fresh, password: pw1, fullName: 'Verify Tester', firmName: 'Verify & Co' })).data.token;
  assert.strictEqual((await expect('/auth/me', { token: t }, 200)).emailVerified, false);
  const first = await mailedLink(fresh, 'verify');
  await expect('/auth/resend-verification', { token: t, body: {} }, 200);
  let second = first;
  for (let i = 0; i < 20 && second === first; i++) { await sleep(250); second = await mailedLink(fresh, 'verify'); }
  assert.notStrictEqual(second, first);
  await expect('/auth/verify-email', { body: { token: first } }, 400);
  await expect('/auth/verify-email', { body: { token: second } }, 200);
  assert.strictEqual((await expect('/auth/me', { token: t }, 200)).emailVerified, true);
  await expect('/auth/verify-email', { body: { token: second } }, 400);
  pass('The emailed link confirms the address; a re-sent link replaces the old one and works once');
}

// ------------------------------------------------------------------ 9. two-step login
{
  const setup = await expect('/auth/2fa/setup', { token, body: {} }, 200);
  await expect('/auth/2fa/enable', { token, body: { code: '000000' === totp(setup.secret) ? '111111' : '000000' } }, 401, 'Wrong code');
  const on = await expect('/auth/2fa/enable', { token, body: { code: totp(setup.secret) } }, 200);
  assert.strictEqual(on.recoveryCodes.length, 8);
  await expect('/auth/2fa/setup', { token, body: {} }, 409);
  pass('Two-step login is switched on with an authenticator code (a wrong code is refused)');

  const step1 = await login(email, pw3);
  assert.strictEqual(step1.status, 200); assert.strictEqual(step1.data.twoFactorRequired, true); assert.ok(!step1.data.token);
  await expect('/auth/me', { token: step1.data.tempToken }, 401);
  pass('With two-step on, the password alone does not log in');

  const wrong = totp(setup.secret) === '000000' ? '111111' : '000000';
  await expect('/auth/2fa/verify', { body: { tempToken: step1.data.tempToken, code: wrong } }, 401, 'Wrong code');
  await expect('/auth/2fa/verify', { body: { tempToken: 'junk', code: totp(setup.secret) } }, 401, 'Login step expired');
  const done = await expect('/auth/2fa/verify', { body: { tempToken: step1.data.tempToken, code: totp(setup.secret) } }, 200);
  assert.strictEqual((await expect('/auth/me', { token: done.token }, 200)).twoFactorEnabled, true);
  pass('The authenticator code completes the login (wrong code and expired step refused)');

  const again = (await login(email, pw3)).data.tempToken;
  const rec = await expect('/auth/2fa/verify', { body: { tempToken: again, code: on.recoveryCodes[0] } }, 200);
  assert.ok(rec.token);
  const third = (await login(email, pw3)).data.tempToken;
  await expect('/auth/2fa/verify', { body: { tempToken: third, code: on.recoveryCodes[0] } }, 401, 'Wrong code');
  await expect('/auth/2fa/verify', { body: { tempToken: third, code: on.recoveryCodes[1] } }, 200);
  pass('A recovery code logs in once and cannot be used again');
  token = done.token;
}

// ------------------------------------------------------------------ 10. every access level can log in
const people = {};
{
  const org = await expect('/orgs', { token, body: { firmId, name: 'Login Test Client', template: 'services' } }, 201);
  const orgId = org.id;
  for (const role of ['accountant', 'staff', 'client', 'sales', 'employee']) {
    const who = `${role}${stamp}@example.com`;
    const inv = await call(`/firms/${firmId}/invitations`, { token, body: { email: `  ${who.toUpperCase()} `, role, ...(['client', 'sales', 'employee'].includes(role) ? { orgId } : {}) } });
    assert.ok(inv.status === 200 || inv.status === 201, `${role}: ${JSON.stringify(inv.data)}`);
    const t = /token=([\w-]+)/.exec(inv.data.link)[1];
    const info = await expect(`/auth/invitations/${t}`, {}, 200);
    assert.strictEqual(info.email, who); assert.strictEqual(info.role, role); assert.strictEqual(info.hasAccount, false);
    const joined = await register({ email: who, password: pw1, fullName: `${role} person`, inviteToken: t });
    assert.ok(joined.data.token, `${role}: ${JSON.stringify(joined.data)}`);
    const r = await login(who, pw1);
    assert.strictEqual(r.status, 200, `${role}: ${JSON.stringify(r.data)}`);
    const me = await expect('/auth/me', { token: r.data.token }, 200);
    assert.strictEqual(me.memberships.length, 1); assert.strictEqual(me.memberships[0].role, role);
    assert.strictEqual(me.emailVerified, true);
    const orgs = await expect('/orgs', { token: r.data.token }, 200);
    assert.ok(orgs.some((o) => o.id === orgId), `${role} cannot see the client`);
    await expect(`/auth/invitations/${t}`, {}, 404);
    people[role] = { email: who, token: r.data.token };
    pass(`Invited ${role}: joins from the emailed link, logs in and sees the client`);
  }
  await expect('/auth/invitations/' + 'z'.repeat(43), {}, 404);

  const outsider = (await login(`lock${stamp}@example.com`, pw2)).data.token;
  const theirs = await expect('/orgs', { token: outsider }, 200);
  assert.ok(!theirs.some((o) => o.id === orgId));
  const peek = await call(`/orgs/${orgId}/accounts`, { token: outsider });
  assert.ok(peek.status === 403 || peek.status === 404, `outsider got ${peek.status}`);
  pass('A person from another firm cannot see this firm\'s client');

  const team = await expect(`/firms/${firmId}/team`, { token }, 200);
  const staff = team.members.find((m) => m.email === people.staff.email);
  const gone = await call(`/firms/${firmId}/members/${staff.id}`, { token, method: 'DELETE' });
  assert.ok(gone.status === 200 || gone.status === 204, JSON.stringify(gone.data));
  assert.strictEqual((await login(people.staff.email, pw1)).status, 200);
  const after = await expect('/orgs', { token: people.staff.token }, 200);
  assert.ok(!after.some((o) => o.id === orgId));
  pass('A person whose access is removed can still log in but no longer sees the client');
}

// ------------------------------------------------------------------ 11. the login screen in a browser
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.setDefaultTimeout(Number(process.env.STEP_TIMEOUT ?? 30000));
  const user = people.accountant;
  const home = () => page.getByText('Login Test & Co — clients').waitFor();
  const loginForm = () => page.getByRole('button', { name: 'Log in', exact: true }).waitFor();
  const hasToken = () => page.evaluate(() => !!sessionStorage.getItem('token'));

  await page.goto(WEB);
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill('wrong-password');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await page.getByText('Wrong email or password').waitFor();
  assert.strictEqual(await hasToken(), false);
  pass('Browser: a wrong password shows "Wrong email or password"');

  await page.getByLabel('Email').fill(`${user.email.toUpperCase()} `);
  await page.getByLabel('Password').fill(pw1);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await home();
  pass('Browser: log in works, also with capitals and a space after the email');

  await page.reload(); await home();
  assert.strictEqual(await hasToken(), true);
  pass('Browser: refreshing the page keeps you logged in');

  // The server answers "starting up" (as free hosting does after a quiet spell), then recovers.
  let fail = 2;
  await page.route('**/api/auth/me', (route) => (fail-- > 0 ? route.fulfill({ status: 503, body: 'starting' }) : route.continue()));
  await page.reload(); await home();
  assert.strictEqual(await hasToken(), true);
  await page.unroute('**/api/auth/me');
  pass('Browser: a server that is still starting up does not log you out');

  // The server stays down for longer than the built-in retries: before the fix this silently logged the person out.
  let down = true;
  await page.route('**/api/auth/me', (route) => (down ? route.fulfill({ status: 503, body: 'starting' }) : route.continue()));
  await page.route('**/api/health', (route) => (down ? route.fulfill({ status: 503, body: 'starting' }) : route.continue()));
  await page.reload();
  await page.getByText('The server is starting up').waitFor({ timeout: 90_000 });
  assert.strictEqual(await hasToken(), true);
  down = false;
  await home();
  assert.strictEqual(await hasToken(), true);
  await page.unroute('**/api/auth/me'); await page.unroute('**/api/health');
  pass('Browser: a server that is down for a while shows "starting up", then opens the app without a new login');

  let drop = 2;
  await page.route('**/api/auth/me', (route) => (drop-- > 0 ? route.abort('connectionfailed') : route.continue()));
  await page.reload(); await home();
  assert.strictEqual(await hasToken(), true);
  await page.unroute('**/api/auth/me');
  pass('Browser: a dropped connection while opening the page does not log you out');

  // The login runs out (8 hours) while the app is open.
  await page.evaluate(() => sessionStorage.setItem('token', sessionStorage.getItem('token').slice(0, -4) + 'AAAA'));
  await page.getByRole('button', { name: 'Open books' }).first().click();
  await loginForm();
  await page.getByText('You were logged out because the session ended. Log in again.').waitFor();
  assert.strictEqual(await hasToken(), false);
  pass('Browser: when the session ends you are taken to the login page and told why');

  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(pw1);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await home();
  pass('Browser: logging in again after the session ended works');

  await page.evaluate(() => sessionStorage.setItem('token', 'junk'));
  await page.reload(); await loginForm();
  pass('Browser: a damaged saved login goes to the login page, not a blank or broken screen');

  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(pw1);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await home();
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('button', { name: 'Log out' }).click();
  await loginForm();
  assert.strictEqual(await hasToken(), false);
  await page.reload(); await loginForm();
  pass('Browser: log out returns to the login page and stays logged out after a refresh');

  // Two-step login in the browser, as the owner.
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(pw3);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  const secret = (await db.query('SELECT totp_secret FROM users WHERE email=$1', [email])).rows[0].totp_secret;
  await page.getByLabel('Code').fill(totp(secret));
  await page.getByRole('button', { name: 'Verify' }).click();
  await home();
  pass('Browser: two-step login with the authenticator code');
} finally { await browser.close(); await db.end(); }

console.log(`\nAll ${n} login checks passed.`);
