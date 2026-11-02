// Phase 4: consent, plans/billing limits, DPDP export & erasure, health/metrics, encrypted backup + restore test.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { auth, boot, pw } from './helpers';
import { getPool } from '../src/db/db';
import { createBackup, decrypt, encrypt, restoreInto } from '../src/ops/backup';
import { verifyBackup } from '../src/ops/backup';
import { effectivePlan, priceWithGst, Plan } from '../src/ops/billing';
import { weakPassword } from '../src/security/password';
import { checkProductionConfig } from '../src/main';

process.env.WORKER = 'off';
process.env.LOG_REQUESTS = 'off';
process.env.BACKUP_KEY = 'unit-test-backup-passphrase';
process.env.METRICS_TOKEN = 'metrics-secret';

const plans: Plan[] = [
  { code: 'free', name: 'Free', pricePaiseMonthly: 0, maxOrgs: 1, maxMembers: 2 },
  { code: 'practice', name: 'Practice', pricePaiseMonthly: 299900, maxOrgs: 25, maxMembers: 15 },
];

describe('billing rules (pure)', () => {
  const sub = (o: object) => ({ planCode: 'practice', status: 'active', trialEnds: null, currentPeriodEnd: null, ...o }) as any;
  it('active and in-trial subscriptions get their plan; lapsed ones fall back to Free', () => {
    expect(effectivePlan(sub({}), plans, '2025-06-01').code).toBe('practice');
    expect(effectivePlan(sub({ status: 'trialing', trialEnds: '2025-06-10' }), plans, '2025-06-10').code).toBe('practice');
    expect(effectivePlan(sub({ status: 'trialing', trialEnds: '2025-06-10' }), plans, '2025-06-11').code).toBe('free');
    expect(effectivePlan(sub({ status: 'past_due' }), plans, '2025-06-01').code).toBe('free');
    expect(effectivePlan(sub({ status: 'cancelled', currentPeriodEnd: '2025-06-30' }), plans, '2025-06-15').code).toBe('practice');
    expect(effectivePlan(sub({ status: 'cancelled', currentPeriodEnd: '2025-06-30' }), plans, '2025-07-01').code).toBe('free');
    expect(effectivePlan(null, plans, '2025-06-01').code).toBe('free');
  });
  it('adds 18% GST: Rs 2,999 -> Rs 539.82 GST -> Rs 3,538.82', () => {
    expect(priceWithGst(299900)).toEqual({ amount: 299900, gst: 53982, total: 353882 });
  });
});

describe('password strength and production config', () => {
  it('rejects common, email-based and low-variety passwords', () => {
    expect(weakPassword('Password12345', 'a@b.com')).toMatch(/common/);
    expect(weakPassword('rahulbramhankar1', 'rahulbramhankar@x.com')).toMatch(/email/);
    expect(weakPassword('aaaaaaaaaaaa', 'a@b.com')).toMatch(/variety/);
    expect(weakPassword('onlylowercaseletters', 'a@b.com')).toMatch(/two kinds/);
    expect(weakPassword('S3cure-passphrase!', 'a@b.com')).toBeNull();
  });
  it('production refuses to start without secrets', () => {
    const old = { ...process.env };
    process.env.NODE_ENV = 'production';
    delete process.env.JWT_SECRET;
    expect(() => checkProductionConfig()).toThrow(/JWT_SECRET/);
    Object.assign(process.env, { DATABASE_URL: 'x', JWT_SECRET: 'short', BACKUP_KEY: 'k', WEB_ORIGIN: 'https://a.b' });
    expect(() => checkProductionConfig()).toThrow(/32 characters/);
    process.env.JWT_SECRET = 'x'.repeat(32);
    expect(() => checkProductionConfig()).not.toThrow();
    process.env.NODE_ENV = old.NODE_ENV; if (old.JWT_SECRET === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = old.JWT_SECRET;
    process.env.DATABASE_URL = old.DATABASE_URL;
  });
});

describe('backup encryption (pure)', () => {
  it('round-trips, hides content, and detects tampering or a wrong key', () => {
    const blob = encrypt(Buffer.from('{"secret":"Sharma Traders ledger"}'));
    expect(blob.toString('latin1')).not.toContain('Sharma');
    expect(decrypt(blob).toString()).toContain('Sharma Traders');
    const bad = Buffer.from(blob); bad[bad.length - 1] ^= 1;
    expect(() => decrypt(bad)).toThrow(/corrupted|wrong key/);
    const k = process.env.BACKUP_KEY; process.env.BACKUP_KEY = 'another-key';
    expect(() => decrypt(blob)).toThrow(/corrupted|wrong key/);
    process.env.BACKUP_KEY = k;
    expect(() => decrypt(Buffer.from('hello world'))).toThrow(/Not an AcctApp backup/);
  });
});

describe('launch features against the database', () => {
  let ctx: Awaited<ReturnType<typeof boot>>;
  const tmp = mkdtempSync(join(tmpdir(), 'acctapp-bk-'));
  let owner: Awaited<ReturnType<typeof ctx.register>>;
  let org: number;

  beforeAll(async () => {
    ctx = await boot(54332);
    owner = await ctx.register('founder@ca.com', 'Founders CA');
    org = await ctx.newOrg(owner.token, owner.firmId, 'Backup Test Pvt Ltd', { gstin: '27AAPFU0939F1ZV' });
  });
  afterAll(async () => { await ctx?.stop(); rmSync(tmp, { recursive: true, force: true }); });

  it('registration requires consent and a decent password, and records consent + a 14-day trial', async () => {
    const body = { email: 'new@x.com', password: pw, fullName: 'N', firmName: 'F' };
    await ctx.http().post('/api/auth/register').send(body).expect(400);
    await ctx.http().post('/api/auth/register').send({ ...body, acceptTerms: false }).expect(400);
    await ctx.http().post('/api/auth/register').send({ ...body, password: 'Password12345', acceptTerms: true }).expect(400);
    const c = (await ctx.http().get('/api/me/consents').set(auth(owner.token)).expect(200)).body;
    expect(c.map((x: any) => x.purpose).sort()).toEqual(['privacy', 'terms']);
    const b = (await ctx.http().get(`/api/firms/${owner.firmId}/billing`).set(auth(owner.token)).expect(200)).body;
    expect(b.subscription).toMatchObject({ planCode: 'practice', status: 'trialing' });
    expect(b.effectivePlan.code).toBe('practice');
  });

  it('marketing consent can be given and withdrawn; history is kept', async () => {
    await ctx.http().post('/api/me/consents').set(auth(owner.token)).send({ purpose: 'marketing', granted: true }).expect(201);
    await ctx.http().post('/api/me/consents').set(auth(owner.token)).send({ purpose: 'marketing', granted: false }).expect(201);
    await ctx.http().post('/api/me/consents').set(auth(owner.token)).send({ purpose: 'terms', granted: false }).expect(400); // required consents are not optional
    const now = (await ctx.http().get('/api/me/consents').set(auth(owner.token))).body.find((x: any) => x.purpose === 'marketing');
    expect(now.granted).toBe(false);
    const hist = (await ctx.http().get('/api/me/export').set(auth(owner.token))).body.consents.filter((x: any) => x.purpose === 'marketing');
    expect(hist.map((x: any) => x.granted)).toEqual([true, false]);
    await expect(getPool().query('DELETE FROM consents')).rejects.toThrow(/append-only/);
  });

  it('plans are listed publicly with GST; lapsed trial enforces the Free client limit; buying a plan lifts it', async () => {
    const list = (await ctx.http().get('/api/plans').expect(200)).body;
    expect(list.find((p: any) => p.code === 'starter')).toMatchObject({ amount: 99900, gst: 17982, total: 117882 });
    await getPool().query("UPDATE subscriptions SET trial_ends = CURRENT_DATE - 1 WHERE firm_id=$1", [owner.firmId]);
    const r = await ctx.http().post('/api/orgs').set(auth(owner.token)).send({ firmId: owner.firmId, name: 'Second client' }).expect(403);
    expect(r.body.message).toMatch(/Upgrade/);
    const s = (await ctx.http().post(`/api/firms/${owner.firmId}/billing/subscribe`).set(auth(owner.token)).send({ planCode: 'starter' }).expect(201)).body;
    expect(s).toMatchObject({ plan: 'starter', total: 117882 });
    await ctx.http().post('/api/orgs').set(auth(owner.token)).send({ firmId: owner.firmId, name: 'Second client' }).expect(201);
    const b = (await ctx.http().get(`/api/firms/${owner.firmId}/billing`).set(auth(owner.token))).body;
    expect(b.invoices[0]).toMatchObject({ plan_code: 'starter', amount: 99900, gst: 17982, total: 117882, status: 'paid' });
    await ctx.http().post(`/api/firms/${owner.firmId}/billing/subscribe`).set(auth(owner.token)).send({ planCode: 'free' }).expect(400); // 2 clients > Free limit of 1
    await ctx.http().post(`/api/firms/${owner.firmId}/billing/subscribe`).set(auth(owner.token)).send({ planCode: 'nope' }).expect(400);
  });

  it('only the firm owner sees billing', async () => {
    const stranger = await ctx.register('stranger@x.com');
    await ctx.http().get(`/api/firms/${owner.firmId}/billing`).set(auth(stranger.token)).expect(403);
    await ctx.http().post(`/api/firms/${owner.firmId}/billing/subscribe`).set(auth(stranger.token)).send({ planCode: 'firm' }).expect(403);
  });

  it('health is public; metrics need the token; security headers and request id are set', async () => {
    const h = await ctx.http().get('/api/health').expect(200);
    expect(h.body).toMatchObject({ status: 'ok', db: 'ok' });
    expect(h.headers['x-request-id']).toBeTruthy();
    expect(h.headers['x-content-type-options']).toBe('nosniff');
    expect(h.headers['content-security-policy']).toContain("default-src 'none'");
    expect(h.headers['x-powered-by']).toBeUndefined();
    await ctx.http().get('/api/metrics').expect(401);
    const m = await ctx.http().get('/api/metrics').set('Authorization', 'Bearer metrics-secret').expect(200);
    expect(m.body.requests).toBeGreaterThan(0);
  });

  it('malformed JSON and oversize bodies get clean errors, not stack traces', async () => {
    const r = await ctx.http().post('/api/auth/login').set('Content-Type', 'application/json').send('{bad json').expect(400);
    expect(JSON.stringify(r.body)).not.toMatch(/node_modules|\.[jt]s:\d+/);
  });

  it('encrypted backup -> restore test: a scratch database gets identical ledger content', async () => {
    const accId = (await ctx.accounts(owner.token, org));
    await ctx.http().post(`/api/orgs/${org}/journal`).set(auth(owner.token)).send({ date: '2025-06-10', narration: 'Capital introduced', lines: [{ accountId: accId('1010'), debit: 12345678 }, { accountId: accId('3000'), credit: 12345678 }] }).expect(201);
    const b = await createBackup(getPool(), tmp);
    const raw = readFileSync(join(tmp, b.filename));
    expect(raw.toString('latin1')).not.toContain('Backup Test Pvt Ltd');
    const result = await verifyBackup(getPool(), join(tmp, b.filename), process.env.DATABASE_URL!);
    expect(result).toMatchObject({ ok: true, balanced: true, ledgerMatches: true });
    expect(result.restored.journal_lines).toBe(2);
    // a damaged file must not restore
    const damaged = Buffer.from(raw); damaged[100] ^= 255; writeFileSync(join(tmp, 'damaged.bak.enc'), damaged);
    await expect(verifyBackup(getPool(), join(tmp, 'damaged.bak.enc'), process.env.DATABASE_URL!)).rejects.toThrow(/corrupted/);
    // scratch databases are cleaned up
    const left = (await getPool().query("SELECT datname FROM pg_database WHERE datname LIKE 'restore_test_%'")).rows;
    expect(left).toEqual([]);
    void restoreInto;
  });

  it('DPDP export lists personal data; erasure is blocked for a sole owner, then anonymises while the books stay', async () => {
    const exp = (await ctx.http().get('/api/me/export').set(auth(owner.token)).expect(200)).body;
    expect(exp.user.email).toBe('founder@ca.com');
    expect(exp.memberships.length).toBeGreaterThan(0);
    expect(exp.activity.some((a: any) => a.action === 'post')).toBe(true);

    const co = await ctx.register('coowner@ca.com', 'Other');
    await ctx.http().post('/api/me/delete').set(auth(owner.token)).send({ password: pw, confirm: 'DELETE' }).expect(409);
    await ctx.http().post('/api/members').set(auth(owner.token)).send({ firmId: owner.firmId, email: 'coowner@ca.com', role: 'owner' }).expect(201);
    await ctx.http().post('/api/me/delete').set(auth(owner.token)).send({ password: 'wrong-wrong-1', confirm: 'DELETE' }).expect(401);
    await ctx.http().post('/api/me/delete').set(auth(owner.token)).send({ password: pw }).expect(400); // must type DELETE
    const del = await ctx.http().post('/api/me/delete').set(auth(owner.token)).send({ password: pw, confirm: 'DELETE' }).expect(200);
    expect(del.body.deleted).toBe(true);

    await ctx.http().post('/api/auth/login').send({ email: 'founder@ca.com', password: pw }).expect(401);
    const u = (await getPool().query('SELECT email, full_name, password_hash FROM users WHERE id=$1', [owner.userId])).rows[0];
    expect(u.email).toMatch(/^deleted-\d+@deleted\.invalid$/);
    expect(u.full_name).toBe('Deleted user');
    // the books remain readable by the remaining owner
    const tb = (await ctx.http().get(`/api/orgs/${org}/trial-balance`).set(auth(co.token)).expect(200)).body;
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebit).toBe(12345678);
    const journal = (await getPool().query('SELECT count(*)::int AS n FROM journal_entries WHERE org_id=$1', [org])).rows[0].n;
    expect(journal).toBe(1);
  });
});
