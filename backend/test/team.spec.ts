// Accounts and team: password reset and change (which end old sessions), email verification, invitations by email,
// managing people, and the two narrow roles (sales: invoices, quotes and customers; employee: their own expense claims).
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { auth, boot, pw } from './helpers';
import { getPool } from '../src/db/db';

const dataDir = mkdtempSync(join(tmpdir(), 'acctapp-data-'));
process.env.DATA_DIR = dataDir;
process.env.WORKER = 'off';

let ctx: Awaited<ReturnType<typeof boot>>;
let owner: { token: string; firmId: number; userId: number }, org: number, otherOrg: number;
const NEW_PW = 'Another-strong-pass-77';

/** The newest email to this address, and the token in its link. */
async function lastMail(to: string) {
  const r = (await getPool().query('SELECT subject, body FROM email_outbox WHERE to_addr=$1 ORDER BY id DESC LIMIT 1', [to])).rows[0];
  const token = /token=([0-9a-f]{64})/.exec(r?.body ?? '')?.[1];
  return { subject: r?.subject as string, body: r?.body as string, token };
}
const login = (email: string, password = pw) => ctx.http().post('/api/auth/login').send({ email, password });

beforeAll(async () => {
  ctx = await boot(54351);
  owner = await ctx.register('owner@team.com', 'Team Firm');
  org = await ctx.newOrg(owner.token, owner.firmId, 'Team Client One');
  otherOrg = await ctx.newOrg(owner.token, owner.firmId, 'Team Client Two');
});
afterAll(async () => { await ctx?.stop(); rmSync(dataDir, { recursive: true, force: true }); });

describe('email verification', () => {
  it('emails a check link on sign-up and marks the address verified when it is opened', async () => {
    expect((await ctx.http().get('/api/auth/me').set(auth(owner.token)).expect(200)).body.emailVerified).toBe(false);
    const m = await lastMail('owner@team.com');
    expect(m.subject).toMatch(/Confirm your email/);
    await ctx.http().post('/api/auth/verify-email').send({ token: m.token }).expect(200);
    expect((await ctx.http().get('/api/auth/me').set(auth(owner.token)).expect(200)).body.emailVerified).toBe(true);
    await ctx.http().post('/api/auth/verify-email').send({ token: m.token }).expect(400); // one use only
    expect((await ctx.http().post('/api/auth/resend-verification').set(auth(owner.token)).expect(200)).body.alreadyVerified).toBe(true);
  });
});

describe('password reset', () => {
  let user: { token: string };
  beforeAll(async () => { user = await ctx.register('forgetful@team.com'); });

  it('answers the same for unknown addresses, so it does not reveal who has an account', async () => {
    const known = (await ctx.http().post('/api/auth/forgot-password').send({ email: 'forgetful@team.com' }).expect(200)).body;
    const unknown = (await ctx.http().post('/api/auth/forgot-password').send({ email: 'nobody@team.com' }).expect(200)).body;
    expect(known).toEqual(unknown);
    expect((await lastMail('nobody@team.com')).subject).toBeUndefined();
  });

  it('sets a new password from the link, ends old sessions, and the link works once', async () => {
    await ctx.http().post('/api/auth/forgot-password').send({ email: 'forgetful@team.com' }).expect(200);
    const m = await lastMail('forgetful@team.com');
    expect(m.subject).toMatch(/Reset your/);
    await ctx.http().post('/api/auth/reset-password').send({ token: m.token, password: 'short' }).expect(400);
    await ctx.http().post('/api/auth/reset-password').send({ token: m.token, password: NEW_PW }).expect(200);
    await ctx.http().get('/api/auth/me').set(auth(user.token)).expect(401);              // the old session has ended
    await login('forgetful@team.com').expect(401);                                       // the old password no longer works
    const fresh = (await login('forgetful@team.com', NEW_PW).expect(200)).body.token;
    await ctx.http().get('/api/auth/me').set(auth(fresh)).expect(200);
    await ctx.http().post('/api/auth/reset-password').send({ token: m.token, password: 'Yet-another-pass-88' }).expect(400);
  });

  it('only the newest link works', async () => {
    await ctx.http().post('/api/auth/forgot-password').send({ email: 'forgetful@team.com' }).expect(200);
    const first = (await lastMail('forgetful@team.com')).token;
    await ctx.http().post('/api/auth/forgot-password').send({ email: 'forgetful@team.com' }).expect(200);
    await ctx.http().post('/api/auth/reset-password').send({ token: first, password: 'Yet-another-pass-88' }).expect(400);
  });

  it('refuses an expired link', async () => {
    await ctx.http().post('/api/auth/forgot-password').send({ email: 'forgetful@team.com' }).expect(200);
    const m = await lastMail('forgetful@team.com');
    await getPool().query("UPDATE auth_tokens SET expires_at = now() - interval '1 minute' WHERE purpose='reset' AND used_at IS NULL");
    await ctx.http().post('/api/auth/reset-password').send({ token: m.token, password: 'Yet-another-pass-88' }).expect(400);
  });
});

describe('change password', () => {
  it('needs the current password, gives this session a new token and ends the others', async () => {
    const u = await ctx.register('changer@team.com');
    const second = (await login('changer@team.com').expect(200)).body.token;
    await ctx.http().post('/api/auth/change-password').set(auth(u.token)).send({ currentPassword: 'wrong-one', newPassword: NEW_PW }).expect(401);
    const r = (await ctx.http().post('/api/auth/change-password').set(auth(u.token)).send({ currentPassword: pw, newPassword: NEW_PW }).expect(200)).body;
    await ctx.http().get('/api/auth/me').set(auth(r.token)).expect(200);
    await ctx.http().get('/api/auth/me').set(auth(second)).expect(401);
    await ctx.http().get('/api/auth/me').set(auth(u.token)).expect(401);
  });
});

describe('invitations and the team', () => {
  let salesToken: string, employeeToken: string, salesMember: number;

  it('invites a new person by email; they join by signing up through the link, without a firm of their own', async () => {
    const r = (await ctx.http().post(`/api/firms/${owner.firmId}/invitations`).set(auth(owner.token)).send({ email: 'Seller@Team.com', role: 'sales', orgId: org }).expect(201)).body;
    expect(r.link).toMatch(/#\/invite\?token=[0-9a-f]{64}$/);
    const m = await lastMail('seller@team.com');
    expect(m.subject).toMatch(/invited you to Team Firm/);
    const info = (await ctx.http().get(`/api/auth/invitations/${m.token}`).expect(200)).body;
    expect(info).toMatchObject({ email: 'seller@team.com', firmName: 'Team Firm', orgName: 'Team Client One', role: 'sales', hasAccount: false });
    await ctx.http().post('/api/auth/register').send({ email: 'other@team.com', password: pw, fullName: 'Wrong', acceptTerms: true, inviteToken: m.token }).expect(403);
    const reg = (await ctx.http().post('/api/auth/register').send({ email: 'seller@team.com', password: pw, fullName: 'Sam Seller', acceptTerms: true, inviteToken: m.token }).expect(201)).body;
    salesToken = reg.token;
    const me = (await ctx.http().get('/api/auth/me').set(auth(salesToken)).expect(200)).body;
    expect(me.emailVerified).toBe(true);
    expect(me.memberships).toEqual([{ firmId: owner.firmId, firmName: 'Team Firm', orgId: org, role: 'sales' }]);
    await ctx.http().get(`/api/auth/invitations/${m.token}`).expect(404);                 // used
  });

  it('lets someone with an account accept by logging in with the invited address', async () => {
    const emp = await ctx.register('worker@team.com');
    await ctx.http().post(`/api/firms/${owner.firmId}/invitations`).set(auth(owner.token)).send({ email: 'worker@team.com', role: 'employee', orgId: org }).expect(201);
    const m = await lastMail('worker@team.com');
    expect((await ctx.http().get(`/api/auth/invitations/${m.token}`).expect(200)).body.hasAccount).toBe(true);
    const stranger = await ctx.register('stranger@team.com');
    await ctx.http().post('/api/auth/invitations/accept').set(auth(stranger.token)).send({ token: m.token }).expect(403);
    await ctx.http().post('/api/auth/invitations/accept').set(auth(emp.token)).send({ token: m.token }).expect(200);
    employeeToken = emp.token;
    await ctx.http().post('/api/auth/invitations/accept').set(auth(emp.token)).send({ token: m.token }).expect(404);
  });

  it('checks roles: narrow roles need a client, duplicates are refused, only the owner manages people', async () => {
    await ctx.http().post(`/api/firms/${owner.firmId}/invitations`).set(auth(owner.token)).send({ email: 'x@team.com', role: 'employee' }).expect(400);
    await ctx.http().post(`/api/firms/${owner.firmId}/invitations`).set(auth(owner.token)).send({ email: 'seller@team.com', role: 'sales', orgId: org }).expect(409);
    await ctx.http().post(`/api/firms/${owner.firmId}/invitations`).set(auth(owner.token)).send({ email: 'x@team.com', role: 'staff', orgId: 999999 }).expect(404);
    // A sales person belongs to one client, not to the firm, so the firm's people pages do not exist for them.
    await ctx.http().post(`/api/firms/${owner.firmId}/invitations`).set(auth(salesToken)).send({ email: 'x@team.com', role: 'staff' }).expect(404);
    await ctx.http().get(`/api/firms/${owner.firmId}/team`).set(auth(salesToken)).expect(404);
  });

  it('lists people and pending invitations; resending replaces the link; cancelling stops it', async () => {
    const inv = (await ctx.http().post(`/api/firms/${owner.firmId}/invitations`).set(auth(owner.token)).send({ email: 'later@team.com', role: 'accountant' }).expect(201)).body;
    const first = (await lastMail('later@team.com')).token;
    await ctx.http().post(`/api/firms/${owner.firmId}/invitations/${inv.id}/resend`).set(auth(owner.token)).expect(201);
    const second = (await lastMail('later@team.com')).token;
    expect(second).not.toBe(first);
    await ctx.http().get(`/api/auth/invitations/${first}`).expect(404);
    await ctx.http().get(`/api/auth/invitations/${second}`).expect(200);
    const team = (await ctx.http().get(`/api/firms/${owner.firmId}/team`).set(auth(owner.token)).expect(200)).body;
    expect(team.canEdit).toBe(true);
    expect(team.members.map((m: any) => m.role).sort()).toEqual(['employee', 'owner', 'sales']);
    expect(team.invitations.map((i: any) => i.email)).toEqual(['later@team.com']);
    salesMember = team.members.find((m: any) => m.role === 'sales').id;
    await ctx.http().delete(`/api/firms/${owner.firmId}/invitations/${inv.id}`).set(auth(owner.token)).expect(200);
    await ctx.http().get(`/api/auth/invitations/${second}`).expect(404);
  });

  it('never leaves the firm without an owner', async () => {
    const team = (await ctx.http().get(`/api/firms/${owner.firmId}/team`).set(auth(owner.token)).expect(200)).body;
    const me = team.members.find((m: any) => m.role === 'owner').id;
    await ctx.http().put(`/api/firms/${owner.firmId}/members/${me}`).set(auth(owner.token)).send({ role: 'accountant' }).expect(400);
    await ctx.http().delete(`/api/firms/${owner.firmId}/members/${me}`).set(auth(owner.token)).expect(400);
  });

  describe('sales role', () => {
    let customer: number, supplier: number, invoiceId: number, billId: number, quoteId: number, poId: number;
    const s = (path: string) => `/api/orgs/${org}${path}`;
    beforeAll(async () => {
      customer = (await ctx.http().post(s('/contacts')).set(auth(owner.token)).send({ kind: 'customer', name: 'Buyer Co', stateCode: '27', bankAccountNo: '123456789', bankIfsc: 'HDFC0000123' }).expect(201)).body.id;
      supplier = (await ctx.http().post(s('/contacts')).set(auth(owner.token)).send({ kind: 'supplier', name: 'Vendor Co', stateCode: '27' }).expect(201)).body.id;
      const line = { description: 'Work', quantity: 1, rate: 100000, gstRateBp: 1800 };
      billId = (await ctx.http().post(s('/documents')).set(auth(owner.token)).send({ docType: 'bill', contactId: supplier, issueDate: '2026-10-01', lines: [line] }).expect(201)).body.id;
      poId = (await ctx.http().post(s('/pre-documents')).set(auth(owner.token)).send({ kind: 'purchase_order', contactId: supplier, issueDate: '2026-10-01', lines: [line] }).expect(201)).body.id;
    });

    it('sees customers only, without their bank details, and adds customers but not suppliers', async () => {
      const list = (await ctx.http().get(s('/contacts')).set(auth(salesToken)).expect(200)).body;
      expect(list.map((x: any) => x.name)).toEqual(['Buyer Co']);
      expect(list[0].bankAccountNo).toBeNull();
      await ctx.http().post(s('/contacts')).set(auth(salesToken)).send({ kind: 'supplier', name: 'Nope' }).expect(403);
      await ctx.http().post(s('/contacts')).set(auth(salesToken)).send({ kind: 'customer', name: 'New Buyer', stateCode: '27' }).expect(201);
    });

    it('raises and views invoices and quotes, but never bills, purchase orders or the rest of the books', async () => {
      const line = { description: 'Design', quantity: 1, rate: 50000, gstRateBp: 1800 };
      invoiceId = (await ctx.http().post(s('/documents')).set(auth(salesToken)).send({ docType: 'invoice', contactId: customer, issueDate: '2026-10-02', lines: [line] }).expect(201)).body.id;
      await ctx.http().post(s('/documents')).set(auth(salesToken)).send({ docType: 'bill', contactId: supplier, issueDate: '2026-10-02', lines: [line] }).expect(403);
      expect((await ctx.http().get(s('/documents')).set(auth(salesToken)).expect(200)).body.map((d: any) => d.docType)).toEqual(['invoice']);
      expect((await ctx.http().get(s('/documents?type=bill')).set(auth(salesToken)).expect(200)).body).toEqual([]);
      await ctx.http().get(s(`/documents/${invoiceId}`)).set(auth(salesToken)).expect(200);
      await ctx.http().get(s(`/documents/${billId}`)).set(auth(salesToken)).expect(404);
      await ctx.http().get(s(`/documents/${invoiceId}/pdf`)).set(auth(salesToken)).expect(200);
      await ctx.http().get(s(`/documents/${billId}/pdf`)).set(auth(salesToken)).expect(404);
      await ctx.http().get(s(`/documents-pdf?ids=${invoiceId},${billId}`)).set(auth(salesToken)).expect(404);
      quoteId = (await ctx.http().post(s('/pre-documents')).set(auth(salesToken)).send({ kind: 'quote', contactId: customer, issueDate: '2026-10-02', lines: [line] }).expect(201)).body.id;
      await ctx.http().post(s('/pre-documents')).set(auth(salesToken)).send({ kind: 'purchase_order', contactId: supplier, issueDate: '2026-10-02', lines: [line] }).expect(403);
      expect((await ctx.http().get(s('/pre-documents')).set(auth(salesToken)).expect(200)).body.map((p: any) => p.kind)).toEqual(['quote']);
      await ctx.http().get(s(`/pre-documents/${poId}`)).set(auth(salesToken)).expect(404);
      await ctx.http().post(s(`/pre-documents/${poId}/status`)).set(auth(salesToken)).send({ status: 'sent' }).expect(409);
      await ctx.http().post(s(`/pre-documents/${quoteId}/status`)).set(auth(salesToken)).send({ status: 'accepted' }).expect(201);
      // Payments, cancelling, reports, the bank and journals stay closed.
      await ctx.http().post(s(`/documents/${invoiceId}/void`)).set(auth(salesToken)).send({ date: '2026-10-03', reason: 'x' }).expect(403);
      await ctx.http().post(s(`/documents/${invoiceId}/payments`)).set(auth(salesToken)).send({ date: '2026-10-03', amount: 100, accountId: 1 }).expect(403);
      for (const p of ['/journal', '/trial-balance', '/bank-accounts', '/expense-claims', '/reports/pnl']) await ctx.http().get(s(p)).set(auth(salesToken)).expect(403);
      expect((await ctx.http().get(s('/accounts')).set(auth(salesToken)).expect(200)).body.every((a: any) => a.type === 'income')).toBe(true);
      expect((await ctx.http().get(s('/items')).set(auth(salesToken)).expect(200)).body).toEqual([]);
      await ctx.http().get(`/api/orgs/${otherOrg}/documents`).set(auth(salesToken)).expect(404); // other client of the firm
    });

    it('goes through approval like staff when the organisation requires it', async () => {
      await ctx.http().put(s('/settings')).set(auth(owner.token)).send({ name: 'Team Client One', gstScheme: 'regular', requireApproval: true }).expect(200);
      const line = { description: 'More', quantity: 1, rate: 1000, gstRateBp: 0 };
      await ctx.http().post(s('/documents')).set(auth(salesToken)).send({ docType: 'invoice', contactId: customer, issueDate: '2026-10-04', lines: [line] }).expect(403);
      await ctx.http().post(s('/drafts')).set(auth(salesToken)).send({ docType: 'invoice', contactId: customer, issueDate: '2026-10-04', lines: [line] }).expect(201);
      await ctx.http().post(s('/drafts')).set(auth(salesToken)).send({ docType: 'bill', contactId: supplier, issueDate: '2026-10-04', lines: [line] }).expect(403);
      await ctx.http().put(s('/settings')).set(auth(owner.token)).send({ name: 'Team Client One', gstScheme: 'regular', requireApproval: false }).expect(200);
    });
  });

  describe('employee role', () => {
    it('submits and sees only their own expense claims, and nothing else', async () => {
      const s = (path: string) => `/api/orgs/${org}${path}`;
      const accounts = (await ctx.http().get(s('/accounts')).set(auth(employeeToken)).expect(200)).body;
      expect(accounts.length).toBeGreaterThan(0);
      expect(accounts.every((a: any) => a.type === 'expense')).toBe(true);
      await ctx.http().post(s('/expense-claims')).set(auth(owner.token)).send({ date: '2026-10-05', title: 'Owner taxi', lines: [{ description: 'Taxi', accountId: accounts[0].id, amount: 5000 }] }).expect(201);
      await ctx.http().post(s('/expense-claims')).set(auth(employeeToken)).send({ date: '2026-10-05', title: 'My lunch', lines: [{ description: 'Lunch', accountId: accounts[0].id, amount: 30000 }] }).expect(201);
      expect((await ctx.http().get(s('/expense-claims')).set(auth(employeeToken)).expect(200)).body.map((c: any) => c.title)).toEqual(['My lunch']);
      expect((await ctx.http().get(s('/expense-claims')).set(auth(owner.token)).expect(200)).body).toHaveLength(2);
      const mine = (await ctx.http().get(s('/expense-claims')).set(auth(employeeToken)).expect(200)).body[0].id;
      await ctx.http().post(s(`/expense-claims/${mine}/approve`)).set(auth(employeeToken)).send({}).expect(403);
      for (const p of ['/contacts', '/documents', '/journal', '/trial-balance', '/items', '/pre-documents', '/settings']) await ctx.http().get(s(p)).set(auth(employeeToken)).expect(403);
    });
  });

  it('changes a role and removes access straight away', async () => {
    await ctx.http().put(`/api/firms/${owner.firmId}/members/${salesMember}`).set(auth(owner.token)).send({ role: 'client' }).expect(200);
    await ctx.http().post(`/api/orgs/${org}/documents`).set(auth(salesToken)).send({ docType: 'invoice', contactId: 1, issueDate: '2026-10-06', lines: [] }).expect(403);
    await ctx.http().get(`/api/orgs/${org}/trial-balance`).set(auth(salesToken)).expect(200);   // a client can read the books
    await ctx.http().put(`/api/firms/${owner.firmId}/members/${salesMember}`).set(auth(owner.token)).send({ role: 'staff', orgId: null }).expect(200);
    await ctx.http().get(`/api/orgs/${otherOrg}/trial-balance`).set(auth(salesToken)).expect(200); // firm-wide staff now
    await ctx.http().delete(`/api/firms/${owner.firmId}/members/${salesMember}`).set(auth(owner.token)).expect(200);
    await ctx.http().get(`/api/orgs/${org}/trial-balance`).set(auth(salesToken)).expect(404);
  });
});
