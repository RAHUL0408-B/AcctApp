// Browser smoke test: register -> add client -> post entry -> trial balance -> reverse -> enable 2FA -> relogin with code.
// Needs the API (:3000) and web (:5173) running and Google Chrome installed.  Run: node e2e/smoke.mjs
import { chromium } from 'playwright-core';
import { createHmac } from 'crypto';
import assert from 'assert';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function totp(secret) {
  let bits = 0, val = 0; const key = [];
  for (const ch of secret) { val = (val << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { key.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = createHmac('sha1', Buffer.from(key)).update(msg).digest(); const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}

const URL = process.env.WEB_URL ?? 'http://127.0.0.1:5173';
const email = `e2e${Date.now()}@example.com`, password = 'Passphrase-1234';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
page.setDefaultTimeout(Number(process.env.STEP_TIMEOUT ?? 30000)); // raise on slow hosts, e.g. STEP_TIMEOUT=90000 for a free-tier server
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const step = (s) => console.log('✓', s);

await page.goto(URL);
await page.getByRole('button', { name: 'Create an account' }).click();
await page.getByLabel('Your name').fill('E2E User');
await page.getByLabel('Firm name').fill('E2E & Co');
await page.getByLabel('Email').fill(email);
await page.getByLabel('Password').fill(password);
await page.getByLabel('Accept terms').check();
await page.getByRole('button', { name: 'Create firm account' }).click();
await page.getByText('E2E & Co — clients').waitFor();
step('registered and landed on clients page');

await page.getByLabel('Business name').fill('Sharma Traders');
await page.getByLabel('Chart of accounts').selectOption('trading');
await page.getByLabel('GSTIN (optional)').fill('BADGSTIN');
await page.getByRole('button', { name: 'Add client' }).click();
await page.getByRole('alert').getByText(/Invalid GSTIN/).waitFor();
step('invalid GSTIN rejected');
await page.getByLabel('GSTIN (optional)').fill('27AAPFU0939F1ZV');
await page.getByRole('button', { name: 'Add client' }).click();
await page.getByRole('listitem').getByText('Sharma Traders').waitFor();
await page.getByRole('button', { name: 'Open books' }).click();
await page.getByRole('navigation', { name: 'Client sections' }).getByRole('button', { name: 'Accounting', exact: true }).click();
await page.getByRole('button', { name: 'Manual journals', exact: true }).click();
await page.getByText('New journal entry').waitFor();
step('client created, books opened');

const post = async (acc1, d, acc2, c, text) => {
  await page.getByLabel('Narration').fill(text);
  await page.getByLabel('Account 1').selectOption({ label: acc1 });
  await page.getByLabel('Debit 1').fill(d);
  await page.getByLabel('Account 2').selectOption({ label: acc2 });
  await page.getByLabel('Credit 2').fill(c);
};
await post('1000 · Cash in Hand', '5,000.50', '4000 · Sales', '5000.50', 'Cash sale');
await page.getByRole('button', { name: 'Post entry' }).click();
await page.getByText('Entry posted.').waitFor();
step('balanced entry posted');

await post('1000 · Cash in Hand', '100', '4000 · Sales', '90', 'Bad entry');
await page.getByRole('button', { name: 'Post entry' }).click();
await page.getByRole('alert').getByText(/unbalanced/).waitFor();
step('unbalanced entry rejected');

await page.getByRole('navigation', { name: 'Client sections' }).getByRole('button', { name: 'Reporting', exact: true }).click();
await page.getByRole('button', { name: 'All reports', exact: true }).click();
await page.getByRole('button', { name: 'Trial balance', exact: true }).click();
await page.getByTestId('tb-debit').waitFor();
assert.equal(await page.getByTestId('tb-debit').innerText(), '5,000.50');
assert.equal(await page.getByTestId('tb-credit').innerText(), '5,000.50');
step('trial balance shows 5,000.50 on both sides');

await page.getByRole('navigation', { name: 'Client sections' }).getByRole('button', { name: 'Accounting', exact: true }).click();
await page.getByRole('button', { name: 'Manual journals', exact: true }).click();
await page.getByRole('button', { name: 'Reverse' }).first().click();
await page.getByText('Reversal posted.').waitFor();
await page.getByRole('navigation', { name: 'Client sections' }).getByRole('button', { name: 'Reporting', exact: true }).click();
await page.getByRole('button', { name: 'All reports', exact: true }).click();
await page.getByRole('button', { name: 'Trial balance', exact: true }).click();
await page.getByText('✓').first().waitFor();
step('entry reversed; books still balanced');

await page.getByRole('button', { name: 'Account menu' }).click();
await page.getByRole('navigation', { name: 'Account' }).getByRole('button', { name: 'Security', exact: true }).click();
await page.getByRole('button', { name: 'Set up 2FA' }).click();
const secret = (await page.getByTestId('totp-secret').innerText()).trim();
await page.getByLabel('6-digit code').fill(totp(secret));
await page.getByRole('button', { name: 'Turn on 2FA' }).click();
await page.getByTestId('recovery-codes').waitFor();
step('2FA enabled, recovery codes shown');

await page.getByRole('button', { name: 'Account menu' }).click();
await page.getByRole('button', { name: 'Log out' }).click();
await page.getByLabel('Email').fill(email);
await page.getByLabel('Password').fill(password);
await page.getByRole('button', { name: 'Log in' }).click();
await page.getByLabel('Code').waitFor();
await page.getByLabel('Code').fill(totp(secret));
await page.getByRole('button', { name: 'Verify' }).click();
await page.getByText('E2E & Co — clients').waitFor();
step('login now requires 2FA code and succeeds with it');

await page.screenshot({ path: process.env.SHOT ?? 'e2e-final.png', fullPage: true });
await browser.close();
const real = errors.filter((e) => !/401|409|400/.test(e));
assert.equal(real.length, 0, 'console errors: ' + real.join(' | '));
console.log('ALL BROWSER CHECKS PASSED');
