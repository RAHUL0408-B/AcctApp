import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, ParseIntPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { getPool, tx, withOrg } from '../db/db';
import { writeAudit } from '../audit/audit';
import { AuthGuard, Ip, UserId, parse } from '../common/guard';
import { COA_TEMPLATES, templateFor } from '../coa/templates';
import { DEFAULT_GROUPS, FSLIS, Fsli, defaultSubGroup, fsliByKey, fsliOf, nextCode } from '../coa/structure';
import { PoolClient } from 'pg';
import { financialYearOf } from '../ledger/ledger';
import { isValidGstin } from '../tax/gst';
import { firmPlan } from '../ops/launch.controller';
import { firmRole, requireOrg, requireAnyOrg } from './acl';

const createOrg = z.object({
  firmId: z.number().int().positive(),
  name: z.string().min(1).max(200),
  gstin: z.string().refine(isValidGstin, 'Invalid GSTIN (format or check digit is wrong)').optional(),
  pan: z.string().regex(/^[A-Z]{5}\d{4}[A-Z]$/, 'Invalid PAN format').optional(),
  template: z.enum(['trading', 'services', 'manufacturing']).default('services'),
});
const FSLI_KEYS = ['equity', 'ncl', 'cl', 'nca', 'ca', 'di', 'ii', 'de', 'ie'] as const;
/** A new ledger: the statement line (FSLI) decides the type; the number is suggested when left out. */
const addAccount = z.object({
  code: z.string().trim().min(1).max(20).optional(), name: z.string().trim().min(1).max(160),
  type: z.enum(['asset', 'liability', 'equity', 'income', 'expense']).optional(), fsli: z.enum(FSLI_KEYS).optional(),
  group: z.string().trim().min(1).max(100), subGroup: z.string().trim().max(100).optional(), itcBlocked: z.boolean().optional(),
}).refine((b) => b.type || b.fsli, 'Choose the financial statement line item');
const editAccount = z.object({
  name: z.string().trim().min(1).max(160), fsli: z.enum(FSLI_KEYS), group: z.string().trim().min(1).max(100), subGroup: z.string().trim().max(100).nullable().optional(),
  code: z.string().trim().min(1).max(20).optional(),
});
/** Accounts the software posts to by number (GST, TDS, debtors, creditors, stock, reserves...): never deleted. */
const SYSTEM_CODES = new Set(['1000', '1010', '1100', '1200', '1300', '1310', '1320', '1330', '1340', '1400', '1600', '1690', '2000', '2100', '2110', '2120', '2130', '2140', '2150', '2160',
  '2200', '2310', '3100', '4000', '4300', '4400', '5000', '5050', '5580', '5590']);
const addMember = z.object({
  firmId: z.number().int().positive(), email: z.string().trim().toLowerCase().email(),
  role: z.enum(['owner', 'accountant', 'staff', 'client', 'sales', 'employee']), orgId: z.number().int().positive().optional(),
});


/** The next free ledger number for a statement line, group and sub-group: its number range, after the last number used in it. */
async function suggestCode(c: PoolClient, f: Fsli, group?: string, subGroup?: string) {
      const own = (await c.query('SELECT name,parent,code_from,code_to FROM account_groups WHERE fsli=$1', [f.key])).rows;
  const def = DEFAULT_GROUPS.find((g) => g.fsli === f.key && g.name.toLowerCase() === (group ?? '').toLowerCase());
  const ownG = own.find((o) => !o.parent && o.name.toLowerCase() === (group ?? '').toLowerCase());
  const defSub = def?.sub?.find((s) => s.name.toLowerCase() === (subGroup ?? '').toLowerCase());
  const ownSub = own.find((o) => o.parent && o.parent.toLowerCase() === (group ?? '').toLowerCase() && o.name.toLowerCase() === (subGroup ?? '').toLowerCase());
  const range = (defSub && { from: defSub.from, to: defSub.to }) ?? (ownSub?.code_from != null ? { from: ownSub.code_from, to: ownSub.code_to } : null)
    ?? (def && { from: def.from, to: def.to }) ?? (ownG?.code_from != null ? { from: ownG.code_from, to: ownG.code_to } : null) ?? { from: f.from, to: f.to };
  const codes = (await c.query('SELECT code FROM accounts')).rows.map((r) => r.code as string);
  // Within a group, follow the numbers already used by its ledgers (the last one plus 10).
  const groupCodes = group ? (await c.query('SELECT code FROM accounts WHERE lower(group_name)=lower($1) AND ($2::text IS NULL OR lower(COALESCE(sub_group, \'\'))=lower($2))', [group, subGroup || null])).rows.map((r) => r.code as string) : [];
  const inRange = groupCodes.filter((x) => { const n = Number.parseInt(x, 10); return n >= range.from && n <= range.to; });
  let code = nextCode(inRange.length ? inRange : codes, range.from, range.to);
  if (code && codes.includes(code)) code = nextCode(codes, range.from, range.to);
  return { code, from: range.from, to: range.to };
}

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
        await c.query('INSERT INTO accounts(org_id,code,name,type,group_name,fsli,sub_group) VALUES ($1,$2,$3,$4,$5,$6,$7)', [orgId, a.code, a.name, a.type, a.group, fsliOf(a.type, a.code), defaultSubGroup(a.code)]);
      }
      const fy = financialYearOf(new Date().toISOString().slice(0, 10));
      await c.query('INSERT INTO financial_years(org_id,label,starts_on,ends_on) VALUES ($1,$2,$3,$4)', [orgId, fy.label, fy.start, fy.end]);
      await writeAudit(c, { orgId, userId: uid, action: 'create', entity: 'organization', entityId: orgId, after: b, ip });
      return { id: orgId };
    });
  }

  @Get('orgs/:orgId/accounts')
  async accounts(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number) {
    const role = await requireAnyOrg(uid, orgId, ['read', 'sales', 'expenses']);
    // Sales people choose income accounts on invoices; employees choose expense accounts on claims. Neither sees the rest.
    const only = role === 'sales' ? 'income' : role === 'employee' ? 'expense' : null;
    return withOrg(orgId, async (c) =>
      (await c.query('SELECT id,code,name,type,group_name AS "group",sub_group AS "subGroup",fsli,is_active AS "isActive",itc_blocked AS "itcBlocked" FROM accounts WHERE ($1::text IS NULL OR type=$1) ORDER BY code', [only])).rows
        .map((r) => ({ ...r, id: Number(r.id), fsli: r.fsli ?? fsliOf(r.type, r.code), system: SYSTEM_CODES.has(r.code) })));
  }

  /** The classification to choose from: statement lines, their groups (default, the firm's own, and any in use) with sub-groups and number ranges. */
  @Get('orgs/:orgId/account-structure')
  async structure(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number) {
    await requireOrg(uid, orgId, 'read');
    return withOrg(orgId, async (c) => {
      const own = (await c.query('SELECT id,fsli,name,parent,code_from,code_to FROM account_groups ORDER BY id')).rows;
      const used = (await c.query('SELECT DISTINCT type,code,group_name,sub_group,fsli FROM accounts')).rows;
      return FSLIS.map((f) => {
        const groups: { name: string; from: number | null; to: number | null; custom: boolean; sub: { name: string; from: number | null; to: number | null; custom: boolean }[] }[] =
          DEFAULT_GROUPS.filter((g) => g.fsli === f.key).map((g) => ({ name: g.name, from: g.from, to: g.to, custom: false, sub: (g.sub ?? []).map((s) => ({ ...s, custom: false })) }));
        const find = (name: string) => groups.find((g) => g.name.toLowerCase() === name.toLowerCase());
        for (const o of own.filter((x) => x.fsli === f.key && !x.parent)) if (!find(o.name)) groups.push({ name: o.name, from: o.code_from, to: o.code_to, custom: true, sub: [] });
        // Groups that accounts already use (for example from the original chart) are offered too.
        for (const u of used.filter((x) => (x.fsli ?? fsliOf(x.type, x.code)) === f.key)) if (!find(u.group_name)) groups.push({ name: u.group_name, from: null, to: null, custom: false, sub: [] });
        for (const o of own.filter((x) => x.fsli === f.key && x.parent)) {
          const g = find(o.parent); if (g && !g.sub.some((s) => s.name.toLowerCase() === o.name.toLowerCase())) g.sub.push({ name: o.name, from: o.code_from, to: o.code_to, custom: true });
        }
        for (const u of used.filter((x) => x.sub_group && (x.fsli ?? fsliOf(x.type, x.code)) === f.key)) {
          const g = find(u.group_name); if (g && !g.sub.some((s) => s.name.toLowerCase() === u.sub_group.toLowerCase())) g.sub.push({ name: u.sub_group, from: null, to: null, custom: false });
        }
        return { ...f, groups };
      });
    });
  }

  /** Add a group under a statement line, or a sub-group under a group. */
  @Post('orgs/:orgId/account-groups')
  async addGroup(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'manage');
    const b = parse(z.object({ fsli: z.enum(FSLI_KEYS), name: z.string().trim().min(1).max(100), parent: z.string().trim().min(1).max(100).optional(),
      codeFrom: z.number().int().min(1).max(999999).optional(), codeTo: z.number().int().min(1).max(999999).optional() }), body);
    if ((b.codeFrom == null) !== (b.codeTo == null)) throw new BadRequestException('Give both ends of the number range, or neither');
    if (b.codeFrom != null && b.codeTo! < b.codeFrom) throw new BadRequestException('The range ends before it starts');
    const defaults = DEFAULT_GROUPS.filter((g) => g.fsli === b.fsli);
    if (!b.parent && defaults.some((g) => g.name.toLowerCase() === b.name.toLowerCase())) throw new ConflictException(`${b.name} already exists`);
    return withOrg(orgId, async (c) => {
      try {
        const r = (await c.query('INSERT INTO account_groups(org_id,fsli,name,parent,code_from,code_to) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
          [orgId, b.fsli, b.name, b.parent ?? null, b.codeFrom ?? null, b.codeTo ?? null])).rows[0];
        await writeAudit(c, { orgId, userId: uid, action: 'create', entity: 'account_group', entityId: r.id, after: b, ip });
        return { id: Number(r.id) };
      } catch (e: any) { if (e.code === '23505') throw new ConflictException(`${b.name} already exists`); throw e; }
    });
  }

  /** The next free ledger number for a statement line, group and sub-group (from its number range). */
  @Get('orgs/:orgId/accounts-next-code')
  async nextAccountCode(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Query('fsli') fsli: string, @Query('group') group?: string, @Query('subGroup') subGroup?: string) {
    await requireOrg(uid, orgId, 'read');
    const f = fsliByKey(fsli ?? '');
    if (!f) throw new BadRequestException('Unknown financial statement line item');
    return withOrg(orgId, (c) => suggestCode(c, f, group, subGroup));
  }

  /** Rename a ledger or move it to another group; the statement line must keep the same type once it has entries. */
  @Put('orgs/:orgId/accounts/:id')
  async editAccount(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'manage');
    const b = parse(editAccount, body);
    const f = fsliByKey(b.fsli)!;
    return withOrg(orgId, async (c) => {
      const a = (await c.query('SELECT code,name,type,group_name,sub_group,fsli FROM accounts WHERE id=$1', [id])).rows[0];
      if (!a) throw new NotFoundException('Account not found');
      if (f.type !== a.type) {
        if (SYSTEM_CODES.has(a.code) || (await c.query('SELECT 1 FROM journal_lines WHERE account_id=$1 LIMIT 1', [id])).rowCount)
          throw new BadRequestException(`${a.name} is ${a.type === 'asset' || a.type === 'income' ? 'an' : 'a'} ${a.type} account with entries: it can only move to another ${a.type} statement line`);
      }
      if (b.code && b.code !== a.code) {
        if (SYSTEM_CODES.has(a.code)) throw new BadRequestException(`${a.code} is used by the software and keeps its number`);
        if ((await c.query('SELECT 1 FROM accounts WHERE code=$1', [b.code])).rowCount) throw new ConflictException(`Account code ${b.code} already exists`);
      }
      await c.query('UPDATE accounts SET name=$2, type=$3, fsli=$4, group_name=$5, sub_group=$6, code=$7 WHERE id=$1', [id, b.name, f.type, b.fsli, b.group, b.subGroup || null, b.code ?? a.code]);
      await writeAudit(c, { orgId, userId: uid, action: 'update', entity: 'account', entityId: id, before: a, after: b, ip });
      return { ok: true };
    });
  }

  /** Archive (hide from new entries) or restore a ledger. Its entries and reports are unchanged. */
  @Post('orgs/:orgId/accounts/:id/archive')
  async archiveAccount(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'manage');
    const b = parse(z.object({ archived: z.boolean().default(true) }), body ?? {});
    return withOrg(orgId, async (c) => {
      const a = (await c.query('SELECT code,name FROM accounts WHERE id=$1', [id])).rows[0];
      if (!a) throw new NotFoundException('Account not found');
      if (b.archived && SYSTEM_CODES.has(a.code)) throw new BadRequestException(`${a.code} ${a.name} is used by the software (GST, TDS, debtors, creditors...) and cannot be archived`);
      if (b.archived && (await c.query('SELECT 1 FROM bank_accounts WHERE account_id=$1', [id])).rowCount) throw new BadRequestException(`${a.name} is a bank account in Bank accounts`);
      await c.query('UPDATE accounts SET is_active=$2 WHERE id=$1', [id, !b.archived]);
      await writeAudit(c, { orgId, userId: uid, action: b.archived ? 'archive' : 'unarchive', entity: 'account', entityId: id, ip });
      return { ok: true };
    });
  }

  /** Delete a ledger that was never used. One with entries (or used by products, contacts or assets) can only be archived. */
  @Delete('orgs/:orgId/accounts/:id')
  async deleteAccount(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'manage');
    return withOrg(orgId, async (c) => {
      const a = (await c.query('SELECT code,name FROM accounts WHERE id=$1', [id])).rows[0];
      if (!a) throw new NotFoundException('Account not found');
      if (SYSTEM_CODES.has(a.code)) throw new BadRequestException(`${a.code} ${a.name} is used by the software and cannot be deleted`);
      if ((await c.query('SELECT 1 FROM journal_lines WHERE account_id=$1 LIMIT 1', [id])).rowCount) throw new ConflictException(`${a.name} has entries, so it cannot be deleted. Archive it instead.`);
      await c.query('SAVEPOINT del');
      try { await c.query('DELETE FROM accounts WHERE id=$1', [id]); }
      catch (e: any) {
        if (e.code !== '23503') throw e;
        await c.query('ROLLBACK TO SAVEPOINT del');
        throw new ConflictException(`${a.name} is used by a product, contact, asset, budget or rule, so it cannot be deleted. Archive it instead.`);
      }
      await writeAudit(c, { orgId, userId: uid, action: 'delete', entity: 'account', entityId: id, before: a, ip });
      return { ok: true };
    });
  }

  @Post('orgs/:orgId/accounts')
  async addAccount(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'manage');
    const b = parse(addAccount, body);
    const f = b.fsli ? fsliByKey(b.fsli)! : null;
    const type = f?.type ?? b.type!;
    if (b.type && f && b.type !== f.type) throw new BadRequestException(`${f.name} holds ${f.type} accounts, not ${b.type}`);
    if (b.itcBlocked && type !== 'expense' && type !== 'asset') throw new BadRequestException('Only expense and asset accounts can have blocked input credit');
    return withOrg(orgId, async (c) => {
      let code = b.code;
      if (!code) {
        code = f ? (await suggestCode(c, f, b.group, b.subGroup)).code ?? undefined : nextCode((await c.query('SELECT code FROM accounts')).rows.map((r) => r.code), 1, 999999) ?? undefined;
        if (!code) throw new BadRequestException('No free number in this range: type one');
      }
      const dup = await c.query('SELECT 1 FROM accounts WHERE code=$1', [code]);
      if (dup.rowCount) throw new BadRequestException(`Account code ${code} already exists`);
      const r = (await c.query('INSERT INTO accounts(org_id,code,name,type,group_name,fsli,sub_group,itc_blocked) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
        [orgId, code, b.name, type, b.group, b.fsli ?? fsliOf(type, code), b.subGroup || null, !!b.itcBlocked])).rows[0];
      await writeAudit(c, { orgId, userId: uid, action: 'create', entity: 'account', entityId: r.id, after: { ...b, code }, ip });
      return { id: Number(r.id), code };
    });
  }

  /** Mark an expense or asset account as "blocked credit" (section 17(5)): GST on bills coded to it is added to the cost instead of being claimed. */
  @Put('orgs/:orgId/accounts/:id/itc-blocked')
  async setBlocked(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'manage');
    const b = parse(z.object({ blocked: z.boolean() }), body);
    return withOrg(orgId, async (c) => {
      const a = (await c.query('SELECT type, name FROM accounts WHERE id=$1', [id])).rows[0];
      if (!a) throw new NotFoundException('Account not found');
      if (b.blocked && a.type !== 'expense' && a.type !== 'asset') throw new BadRequestException('Only expense and asset accounts are bought on bills');
      await c.query('UPDATE accounts SET itc_blocked=$2 WHERE id=$1', [id, b.blocked]);
      await writeAudit(c, { orgId, userId: uid, action: 'itc_blocked', entity: 'account', entityId: id, after: b, ip });
      return { ok: true };
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
    if (['client', 'sales', 'employee'].includes(b.role) && !b.orgId) throw new BadRequestException(`${b.role} users must be tied to one organization`);
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
