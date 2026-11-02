import { BadRequestException, Body, Controller, ForbiddenException, Get, NotFoundException, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { getPool, tx, withOrg } from '../db/db';
import { writeAudit } from '../audit/audit';
import { AuthGuard, Ip, UserId, parse } from '../common/guard';
import { COA_TEMPLATES, templateFor } from '../coa/templates';
import { financialYearOf } from '../ledger/ledger';
import { isValidGstin } from '../tax/gst';
import { firmPlan } from '../ops/launch.controller';
import { firmRole, requireOrg } from './acl';

const createOrg = z.object({
  firmId: z.number().int().positive(),
  name: z.string().min(1).max(200),
  gstin: z.string().refine(isValidGstin, 'Invalid GSTIN (format or check digit is wrong)').optional(),
  pan: z.string().regex(/^[A-Z]{5}\d{4}[A-Z]$/, 'Invalid PAN format').optional(),
  template: z.enum(['trading', 'services', 'manufacturing']).default('services'),
});
const addAccount = z.object({
  code: z.string().min(1).max(20), name: z.string().min(1).max(160),
  type: z.enum(['asset', 'liability', 'equity', 'income', 'expense']), group: z.string().min(1).max(100),
});
const addMember = z.object({
  firmId: z.number().int().positive(), email: z.string().email().toLowerCase(),
  role: z.enum(['owner', 'accountant', 'staff', 'client']), orgId: z.number().int().positive().optional(),
});

@Controller()
@UseGuards(AuthGuard)
export class OrgController {
  @Get('templates')
  templates() {
    return Object.fromEntries(Object.entries(COA_TEMPLATES).map(([k, v]) => [k, v.length]));
  }

  /** All organizations the user can open: whole firm for firm-level members, single org for client users. */
  @Get('orgs')
  async list(@UserId() uid: number) {
    const { rows } = await getPool().query(
      `SELECT DISTINCT o.id, o.name, o.gstin, o.firm_id FROM organizations o JOIN memberships m ON m.firm_id=o.firm_id
        WHERE m.user_id=$1 AND (m.org_id IS NULL OR m.org_id=o.id) ORDER BY o.name`, [uid]);
    return rows.map((r) => ({ id: Number(r.id), name: r.name, gstin: r.gstin, firmId: Number(r.firm_id) }));
  }

  @Post('orgs')
  async create(@UserId() uid: number, @Body() body: unknown, @Ip() ip: string) {
    const b = parse(createOrg, body);
    const role = await firmRole(uid, b.firmId);
    if (role !== 'owner' && role !== 'accountant') throw new ForbiddenException('Only firm owners and accountants can add clients');
    const { plan, usage } = await firmPlan(b.firmId);
    if (usage.orgs >= plan.maxOrgs) throw new ForbiddenException(`Your ${plan.name} plan allows ${plan.maxOrgs} client(s). Upgrade your plan to add more.`);
    const stateCode = b.gstin?.slice(0, 2) ?? null;
    return tx(async (c) => {
      const org = (await c.query('INSERT INTO organizations(firm_id,name,gstin,pan,state_code) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [b.firmId, b.name, b.gstin ?? null, b.pan ?? null, stateCode])).rows[0];
      const orgId = Number(org.id);
      await c.query('SET LOCAL ROLE app_user');
      await c.query("SELECT set_config('app.org_id', $1, true)", [String(orgId)]);
      for (const a of templateFor(b.template)) {
        await c.query('INSERT INTO accounts(org_id,code,name,type,group_name) VALUES ($1,$2,$3,$4,$5)', [orgId, a.code, a.name, a.type, a.group]);
      }
      const fy = financialYearOf(new Date().toISOString().slice(0, 10));
      await c.query('INSERT INTO financial_years(org_id,label,starts_on,ends_on) VALUES ($1,$2,$3,$4)', [orgId, fy.label, fy.start, fy.end]);
      await writeAudit(c, { orgId, userId: uid, action: 'create', entity: 'organization', entityId: orgId, after: b, ip });
      return { id: orgId };
    });
  }

  @Get('orgs/:orgId/accounts')
  async accounts(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number) {
    await requireOrg(uid, orgId, 'read');
    return withOrg(orgId, async (c) =>
      (await c.query('SELECT id,code,name,type,group_name AS "group",is_active AS "isActive" FROM accounts ORDER BY code')).rows
        .map((r) => ({ ...r, id: Number(r.id) })));
  }

  @Post('orgs/:orgId/accounts')
  async addAccount(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'manage');
    const b = parse(addAccount, body);
    return withOrg(orgId, async (c) => {
      const dup = await c.query('SELECT 1 FROM accounts WHERE code=$1', [b.code]);
      if (dup.rowCount) throw new BadRequestException(`Account code ${b.code} already exists`);
      const r = (await c.query('INSERT INTO accounts(org_id,code,name,type,group_name) VALUES ($1,$2,$3,$4,$5) RETURNING id', [orgId, b.code, b.name, b.type, b.group])).rows[0];
      await writeAudit(c, { orgId, userId: uid, action: 'create', entity: 'account', entityId: r.id, after: b, ip });
      return { id: Number(r.id) };
    });
  }

  /** Lock the books up to and including a date; later postings on or before it are rejected. */
  @Post('orgs/:orgId/lock')
  async lock(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'manage');
    const b = parse(z.object({ through: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }), body);
    return withOrg(orgId, async (c) => {
      const fy = financialYearOf(b.through);
      await c.query(
        `INSERT INTO financial_years(org_id,label,starts_on,ends_on,locked_through) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (org_id,starts_on) DO UPDATE SET locked_through=EXCLUDED.locked_through`, [orgId, fy.label, fy.start, fy.end, b.through]);
      await writeAudit(c, { orgId, userId: uid, action: 'lock_period', entity: 'financial_year', after: b, ip });
      return { lockedThrough: b.through };
    });
  }

  /** Give an already-registered user access to the firm (or to one client org). */
  @Post('members')
  async addMember(@UserId() uid: number, @Body() body: unknown, @Ip() ip: string) {
    const b = parse(addMember, body);
    if ((await firmRole(uid, b.firmId)) !== 'owner') throw new ForbiddenException('Only the firm owner can manage members');
    if (b.role === 'client' && !b.orgId) throw new BadRequestException('Client users must be tied to one organization');
    if (b.orgId) {
      const o = await getPool().query('SELECT 1 FROM organizations WHERE id=$1 AND firm_id=$2', [b.orgId, b.firmId]);
      if (!o.rowCount) throw new NotFoundException('Organization not found in this firm');
    }
    const { plan, usage } = await firmPlan(b.firmId);
    if (usage.members >= plan.maxMembers) throw new ForbiddenException(`Your ${plan.name} plan allows ${plan.maxMembers} team members. Upgrade to add more.`);
    return tx(async (c) => {
      const u = (await c.query('SELECT id FROM users WHERE email=$1', [b.email])).rows[0];
      if (!u) throw new NotFoundException('That person must register first');
      await c.query('INSERT INTO memberships(user_id,firm_id,org_id,role) VALUES ($1,$2,$3,$4)', [u.id, b.firmId, b.orgId ?? null, b.role]);
      await writeAudit(c, { orgId: b.orgId ?? null, userId: uid, action: "add_member", entity: 'membership', after: b, ip });
      return { ok: true };
    });
  }
}
