// End-to-end tests against a real (embedded) PostgreSQL: auth, 2FA, tenancy isolation, ledger rules, audit.
import request from 'supertest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { INestApplication } from '@nestjs/common';
import { startDevDb } from './devdb';
import { closePool, getPool, tx } from '../src/db/db';
import { migrate } from '../src/db/migrate';
import { totpAt } from '../src/security/totp';

let app: INestApplication, stop: () => Promise<void>, dir: string;
let http: () => ReturnType<typeof request>;

const pw = 'S3cure-passphrase!';
async function register(email: string, firmName = 'Firm ' + email) {
  const r = await http().post('/api/auth/register').send({ email, password: pw, fullName: 'T ' + email, firmName, acceptTerms: true }).expect(201);
  return { token: r.body.token as string, firmId: r.body.firmId as number, userId: r.body.userId as number };
}
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
async function newOrg(t: string, firmId: number, name: string) {
  return (await http().post('/api/orgs').set(auth(t)).send({ firmId, name, template: 'trading' }).expect(201)).body.id as number;
}
async function acct(t: string, orgId: number, code: string) {
  const a = (await http().get(`/api/orgs/${orgId}/accounts`).set(auth(t)).expect(200)).body;
  return a.find((x: any) => x.code === code).id as number;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'acctapp-pg-'));
  const db = await startDevDb(dir, 54329);
  stop = db.stop;
  process.env.DATABASE_URL = db.url;
  await migrate(getPool());
  const { createApp } = await import('../src/main');
  app = await createApp();
  await app.init();
  http = () => request(app.getHttpServer());
});

afterAll(async () => {
  await app?.close();
  await closePool();
  await stop?.();
  rmSync(dir, { recursive: true, force: true });
});

describe('auth + 2FA', () => {
  it('registers, logs in, rejects bad passwords and weak passwords', async () => {
    await register('a@x.com');
    await http().post('/api/auth/register').send({ email: 'a@x.com', password: pw, fullName: 'x', firmName: 'f', acceptTerms: true }).expect(409);
    await http().post('/api/auth/register').send({ email: 'weak@x.com', password: 'short', fullName: 'x', firmName: 'f', acceptTerms: true }).expect(400);
    await http().post('/api/auth/login').send({ email: 'a@x.com', password: 'nope-nope-nope' }).expect(401);
    const ok = await http().post('/api/auth/login').send({ email: 'a@x.com', password: pw }).expect(200);
    await http().get('/api/auth/me').set(auth(ok.body.token)).expect(200);
    await http().get('/api/auth/me').expect(401);
  });

  it('enables 2FA, then login needs a code; recovery code works once', async () => {
    const u = await register('b@x.com');
    const setup = await http().post('/api/auth/2fa/setup').set(auth(u.token)).expect(200);
    await http().post('/api/auth/2fa/enable').set(auth(u.token)).send({ code: '000000' }).expect(401);
    const en = await http().post('/api/auth/2fa/enable').set(auth(u.token)).send({ code: totpAt(setup.body.secret, Date.now()) }).expect(200);
    expect(en.body.recoveryCodes).toHaveLength(8);

    const l = await http().post('/api/auth/login').send({ email: 'b@x.com', password: pw }).expect(200);
    expect(l.body.twoFactorRequired).toBe(true);
    expect(l.body.token).toBeUndefined();
    // a partial (2FA-stage) token must not open the API
    await http().get('/api/auth/me').set(auth(l.body.tempToken)).expect(401);
    await http().post('/api/auth/2fa/verify').send({ tempToken: l.body.tempToken, code: '111111' }).expect(401);
    const v = await http().post('/api/auth/2fa/verify').send({ tempToken: l.body.tempToken, code: totpAt(setup.body.secret, Date.now()) }).expect(200);
    await http().get('/api/auth/me').set(auth(v.body.token)).expect(200);

    const rc = en.body.recoveryCodes[0];
    await http().post('/api/auth/2fa/verify').send({ tempToken: l.body.tempToken, code: rc }).expect(200);
    await http().post('/api/auth/2fa/verify').send({ tempToken: l.body.tempToken, code: rc }).expect(401);
  });

  it('locks the account after 5 wrong passwords', async () => {
    await register('lock@x.com');
    const { RateLimiter } = await import('../src/common/ratelimit');
    void RateLimiter;
    for (let i = 0; i < 5; i++) await http().post('/api/auth/login').send({ email: 'lock@x.com', password: 'bad-bad-bad-1' }).expect(401);
    const r = await http().post('/api/auth/login').send({ email: 'lock@x.com', password: pw });
    expect(r.status).toBe(401);
    expect(r.body.message).toMatch(/locked/i);
  });
});

describe('multi-tenant ledger', () => {
  let owner: Awaited<ReturnType<typeof register>>, orgA: number, orgB: number;
  let cash: number, sales: number, rent: number;

  beforeAll(async () => {
    owner = await register('owner@firm.com', 'CA Firm');
    orgA = await newOrg(owner.token, owner.firmId, 'Client A');
    orgB = await newOrg(owner.token, owner.firmId, 'Client B');
    cash = await acct(owner.token, orgA, '1000');
    sales = await acct(owner.token, orgA, '4000');
    rent = await acct(owner.token, orgA, '5500');
  });

  it('seeds the Indian chart of accounts per organization', async () => {
    const a = (await http().get(`/api/orgs/${orgA}/accounts`).set(auth(owner.token)).expect(200)).body;
    expect(a.length).toBeGreaterThan(30);
    expect(a.find((x: any) => x.name === 'Output CGST')).toBeTruthy();
  });

  it('validates GSTIN format on org creation', async () => {
    await http().post('/api/orgs').set(auth(owner.token)).send({ firmId: owner.firmId, name: 'Bad', gstin: '123' }).expect(400);
    await http().post('/api/orgs').set(auth(owner.token)).send({ firmId: owner.firmId, name: 'Good', gstin: '27AAPFU0939F1ZV' }).expect(201);
  });

  it('posts a balanced entry and shows it in the trial balance', async () => {
    await http().post(`/api/orgs/${orgA}/journal`).set(auth(owner.token))
      .send({ date: '2025-06-10', narration: 'Cash sale', lines: [{ accountId: cash, debit: 500000 }, { accountId: sales, credit: 500000 }] }).expect(201);
    const tb = (await http().get(`/api/orgs/${orgA}/trial-balance`).set(auth(owner.token)).expect(200)).body;
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebit).toBe(500000);
    expect(tb.accounts.find((a: any) => a.code === '4000').balance).toBe(500000);
  });

  it('rejects unbalanced entries in the API', async () => {
    const r = await http().post(`/api/orgs/${orgA}/journal`).set(auth(owner.token))
      .send({ date: '2025-06-10', narration: 'bad', lines: [{ accountId: cash, debit: 100 }, { accountId: sales, credit: 90 }] }).expect(400);
    expect(r.body.message).toMatch(/unbalanced/);
  });

  it('database itself refuses unbalanced entries even if the API is bypassed', async () => {
    await expect(tx(async (c) => {
      await c.query('SET LOCAL ROLE app_user');
      await c.query("SELECT set_config('app.org_id', $1, true)", [String(orgA)]);
      const e = (await c.query("INSERT INTO journal_entries(org_id,entry_date,narration,created_by) VALUES ($1,'2025-06-11','x',$2) RETURNING id", [orgA, owner.userId])).rows[0];
      await c.query('INSERT INTO journal_lines(entry_id,org_id,account_id,debit,credit) VALUES ($1,$2,$3,100,0)', [e.id, orgA, cash]);
      await c.query('INSERT INTO journal_lines(entry_id,org_id,account_id,debit,credit) VALUES ($1,$2,$3,0,60)', [e.id, orgA, sales]);
    })).rejects.toThrow(/unbalanced/);
  });

  it('posted entries cannot be updated or deleted, even by the database owner', async () => {
    await expect(getPool().query('UPDATE journal_lines SET debit = debit + 1')).rejects.toThrow(/append-only/);
    await expect(getPool().query('DELETE FROM journal_entries')).rejects.toThrow(/append-only/);
    await expect(getPool().query('DELETE FROM audit_log')).rejects.toThrow(/append-only/);
  });

  it('reverses an entry once, with a mirror entry; the original stays', async () => {
    const id = (await http().post(`/api/orgs/${orgA}/journal`).set(auth(owner.token))
      .send({ date: '2025-06-12', narration: 'Rent', lines: [{ accountId: rent, debit: 20000 }, { accountId: cash, credit: 20000 }] }).expect(201)).body.id;
    const before = (await http().get(`/api/orgs/${orgA}/trial-balance`).set(auth(owner.token))).body;
    await http().post(`/api/orgs/${orgA}/journal/${id}/reverse`).set(auth(owner.token)).send({ date: '2025-06-13', reason: 'wrong month' }).expect(201);
    await http().post(`/api/orgs/${orgA}/journal/${id}/reverse`).set(auth(owner.token)).send({ date: '2025-06-13', reason: 'again' }).expect(409);
    const after = (await http().get(`/api/orgs/${orgA}/trial-balance`).set(auth(owner.token))).body;
    expect(before.accounts.find((a: any) => a.code === '5500').balance).toBe(20000);
    expect(after.accounts.find((a: any) => a.code === '5500')?.balance ?? 0).toBe(0);
    const list = (await http().get(`/api/orgs/${orgA}/journal`).set(auth(owner.token))).body;
    expect(list.some((e: any) => e.id === id)).toBe(true);
  });

  it('blocks postings into a locked period', async () => {
    await http().post(`/api/orgs/${orgA}/lock`).set(auth(owner.token)).send({ through: '2025-06-30' }).expect(201);
    const r = await http().post(`/api/orgs/${orgA}/journal`).set(auth(owner.token))
      .send({ date: '2025-06-20', narration: 'late', lines: [{ accountId: cash, debit: 1 }, { accountId: sales, credit: 1 }] }).expect(400);
    expect(r.body.message).toMatch(/locked/);
    await http().post(`/api/orgs/${orgA}/journal`).set(auth(owner.token))
      .send({ date: '2025-07-01', narration: 'ok', lines: [{ accountId: cash, debit: 1 }, { accountId: sales, credit: 1 }] }).expect(201);
  });

  it('isolates tenants: another firm cannot see org A, and RLS hides org A rows from org B', async () => {
    const other = await register('other@firm.com', 'Other Firm');
    await http().get(`/api/orgs/${orgA}/accounts`).set(auth(other.token)).expect(404);
    await http().post(`/api/orgs/${orgA}/journal`).set(auth(other.token)).send({ date: '2025-08-01', narration: 'x', lines: [] }).expect(404);
    // Database-level: with org B selected, org A's journal is invisible
    const n = await tx(async (c) => {
      await c.query('SET LOCAL ROLE app_user');
      await c.query("SELECT set_config('app.org_id', $1, true)", [String(orgB)]);
      return (await c.query('SELECT count(*)::int AS n FROM journal_entries')).rows[0].n;
    });
    expect(n).toBe(0);
    // Posting into org B using org A's account ids fails
    await http().post(`/api/orgs/${orgB}/journal`).set(auth(owner.token))
      .send({ date: '2025-08-01', narration: 'x', lines: [{ accountId: cash, debit: 5 }, { accountId: sales, credit: 5 }] }).expect(400);
  });

  it('enforces roles: client is read-only, staff can post but not change the chart', async () => {
    const staff = await register('staff@x.com'), client = await register('client@x.com');
    await http().post('/api/members').set(auth(owner.token)).send({ firmId: owner.firmId, email: 'staff@x.com', role: 'staff' }).expect(201);
    await http().post('/api/members').set(auth(owner.token)).send({ firmId: owner.firmId, email: 'client@x.com', role: 'client' }).expect(400);
    await http().post('/api/members').set(auth(owner.token)).send({ firmId: owner.firmId, email: 'client@x.com', role: 'client', orgId: orgA }).expect(201);

    const entry = { date: '2025-09-01', narration: 'by role', lines: [{ accountId: cash, debit: 7 }, { accountId: sales, credit: 7 }] };
    await http().post(`/api/orgs/${orgA}/journal`).set(auth(staff.token)).send(entry).expect(201);
    await http().post(`/api/orgs/${orgA}/accounts`).set(auth(staff.token)).send({ code: '9999', name: 'X', type: 'asset', group: 'G' }).expect(403);
    await http().get(`/api/orgs/${orgA}/trial-balance`).set(auth(client.token)).expect(200);
    await http().post(`/api/orgs/${orgA}/journal`).set(auth(client.token)).send(entry).expect(403);
    await http().get(`/api/orgs/${orgB}/accounts`).set(auth(client.token)).expect(404); // client sees only org A
    const orgs = (await http().get('/api/orgs').set(auth(client.token)).expect(200)).body;
    expect(orgs.map((o: any) => o.id)).toEqual([orgA]);
    await http().post('/api/members').set(auth(staff.token)).send({ firmId: owner.firmId, email: 'client@x.com', role: 'staff' }).expect(403);
  });

  it('records who did what in the audit log', async () => {
    const log = (await http().get(`/api/orgs/${orgA}/audit`).set(auth(owner.token)).expect(200)).body;
    const actions = log.map((l: any) => l.action);
    expect(actions).toEqual(expect.arrayContaining(['post', 'reverse', 'lock_period', 'create']));
    expect(log.some((l: any) => l.action === 'post' && l.user_id === String(owner.userId))).toBe(true);
  });
});
