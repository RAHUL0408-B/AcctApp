// The firm's people: who has access to what, invitations by email, changing roles and removing access.
// Only the firm owner can change anything; owners and accountants can see the list.
import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, ParseIntPipe, Post, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { getPool, tx } from '../db/db';
import { writeAudit } from '../audit/audit';
import { AuthGuard, Ip, UserId, parse } from '../common/guard';
import { queueMail } from '../firm/mailer';
import { firmRole } from './acl';
import { firmPlan } from '../ops/launch.controller';
import { linkFor, newToken, ROLE_TEXT } from './invitations';

const APP_NAME = process.env.APP_NAME ?? 'AcctApp';
const ROLES = ['owner', 'accountant', 'staff', 'client', 'sales', 'employee'] as const;
/** These roles always belong to one client organisation; the others can cover the whole firm. */
const ORG_ONLY = new Set(['client', 'sales', 'employee']);
const INVITE_DAYS = 7;

async function requireFirmOwner(uid: number, firmId: number) {
  const role = await firmRole(uid, firmId);
  if (!role) throw new NotFoundException('Firm not found');
  if (role !== 'owner') throw new ForbiddenException('Only the firm owner can manage people');
}

async function checkOrg(firmId: number, role: string, orgId: number | undefined) {
  if (ORG_ONLY.has(role) && !orgId) throw new BadRequestException(`Choose which client this ${role} person works on`);
  if (orgId && !(await getPool().query('SELECT 1 FROM organizations WHERE id=$1 AND firm_id=$2', [orgId, firmId])).rowCount) throw new NotFoundException('Organization not found in this firm');
}

@Controller('firms/:firmId')
@UseGuards(AuthGuard)
export class TeamController {
  @Get('team')
  async team(@UserId() uid: number, @Param('firmId', ParseIntPipe) firmId: number) {
    const role = await firmRole(uid, firmId);
    if (!role) throw new NotFoundException('Firm not found');
    if (role !== 'owner' && role !== 'accountant') throw new ForbiddenException('Only owners and accountants can see the team');
    const pool = getPool();
    const members = (await pool.query(
      `SELECT m.id, m.user_id, u.full_name, u.email, u.email_verified_at, u.totp_enabled, m.role, m.org_id, o.name AS org_name
         FROM memberships m JOIN users u ON u.id=m.user_id LEFT JOIN organizations o ON o.id=m.org_id
        WHERE m.firm_id=$1 ORDER BY u.full_name, o.name NULLS FIRST`, [firmId])).rows;
    const invitations = (await pool.query(
      `SELECT i.id, i.email, i.role, i.org_id, o.name AS org_name, i.expires_at, i.created_at, u.full_name AS invited_by
         FROM invitations i JOIN users u ON u.id=i.invited_by LEFT JOIN organizations o ON o.id=i.org_id
        WHERE i.firm_id=$1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL ORDER BY i.created_at DESC`, [firmId])).rows;
    const { plan, usage } = await firmPlan(firmId);
    return {
      canEdit: role === 'owner', you: Number(uid), roles: ROLE_TEXT,
      plan: { name: plan.name, maxMembers: plan.maxMembers, people: usage.members },
      members: members.map((m) => ({ id: Number(m.id), userId: Number(m.user_id), name: m.full_name, email: m.email, emailVerified: !!m.email_verified_at, twoFactor: m.totp_enabled, role: m.role, orgId: m.org_id ? Number(m.org_id) : null, orgName: m.org_name })),
      invitations: invitations.map((i) => ({ id: Number(i.id), email: i.email, role: i.role, orgId: i.org_id ? Number(i.org_id) : null, orgName: i.org_name, expiresAt: new Date(i.expires_at).toISOString(), expired: new Date(i.expires_at) < new Date(), invitedBy: i.invited_by })),
    };
  }

  /** Invite someone by email. The link is also returned, so it can be shared another way when email is not set up. */
  @Post('invitations')
  async invite(@UserId() uid: number, @Param('firmId', ParseIntPipe) firmId: number, @Body() body: unknown, @Ip() ip: string) {
    await requireFirmOwner(uid, firmId);
    const b = parse(z.object({ email: z.string().email().toLowerCase(), role: z.enum(ROLES), orgId: z.number().int().positive().optional() }), body);
    await checkOrg(firmId, b.role, b.orgId);
    const pool = getPool();
    const existing = (await pool.query('SELECT u.id FROM users u WHERE u.email=$1', [b.email])).rows[0];
    if (existing && (await pool.query('SELECT 1 FROM memberships WHERE user_id=$1 AND firm_id=$2 AND org_id IS NOT DISTINCT FROM $3', [existing.id, firmId, b.orgId ?? null])).rowCount)
      throw new ConflictException('This person already has that access');
    const inFirm = existing && (await pool.query('SELECT 1 FROM memberships WHERE user_id=$1 AND firm_id=$2', [existing.id, firmId])).rowCount;
    const { plan, usage } = await firmPlan(firmId);
    if (!inFirm && usage.members >= plan.maxMembers) throw new ForbiddenException(`Your ${plan.name} plan allows ${plan.maxMembers} people. Upgrade to invite more.`);
    const t = newToken();
    const r = await tx(async (c) => {
      // A newer invitation replaces an older one for the same person and access.
      await c.query('UPDATE invitations SET revoked_at=now() WHERE firm_id=$1 AND lower(email)=$2 AND org_id IS NOT DISTINCT FROM $3 AND accepted_at IS NULL AND revoked_at IS NULL', [firmId, b.email, b.orgId ?? null]);
      const row = (await c.query(`INSERT INTO invitations(firm_id,org_id,email,role,token_hash,invited_by,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(days => $7)) RETURNING id`, [firmId, b.orgId ?? null, b.email, b.role, t.hash, uid, INVITE_DAYS])).rows[0];
      await writeAudit(c, { orgId: b.orgId ?? null, userId: uid, action: 'invite', entity: 'invitation', entityId: row.id, after: { email: b.email, role: b.role, orgId: b.orgId ?? null }, ip });
      return row;
    });
    const link = linkFor('invite', t.raw);
    await this.mail(firmId, uid, b.email, b.role, b.orgId, link);
    return { id: Number(r.id), link, expiresInDays: INVITE_DAYS };
  }

  private async mail(firmId: number, uid: number, email: string, role: string, orgId: number | undefined | null, link: string) {
    const pool = getPool();
    const firm = (await pool.query('SELECT name FROM firms WHERE id=$1', [firmId])).rows[0].name;
    const who = (await pool.query('SELECT full_name FROM users WHERE id=$1', [uid])).rows[0].full_name;
    const org = orgId ? (await pool.query('SELECT name FROM organizations WHERE id=$1', [orgId])).rows[0]?.name : null;
    await queueMail({ to: email, subject: `${who} invited you to ${firm} on ${APP_NAME}`,
      body: `Hello,\n\n${who} has invited you to ${org ? `the books of ${org} at ${firm}` : firm} on ${APP_NAME}, as ${ROLE_TEXT[role]}.\n\nOpen this link within ${INVITE_DAYS} days to accept:\n${link}\n\nIf you were not expecting this, ignore this email.` });
  }

  /** Send a fresh link (the old one stops working). */
  @Post('invitations/:id/resend')
  async resend(@UserId() uid: number, @Param('firmId', ParseIntPipe) firmId: number, @Param('id', ParseIntPipe) id: number, @Ip() ip: string) {
    await requireFirmOwner(uid, firmId);
    const t = newToken();
    const inv = (await getPool().query(`UPDATE invitations SET token_hash=$3, expires_at=now() + make_interval(days => $4)
       WHERE id=$1 AND firm_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING email, role, org_id`, [id, firmId, t.hash, INVITE_DAYS])).rows[0];
    if (!inv) throw new NotFoundException('Invitation not found');
    const link = linkFor('invite', t.raw);
    await this.mail(firmId, uid, inv.email, inv.role, inv.org_id ? Number(inv.org_id) : null, link);
    await tx((c) => writeAudit(c, { userId: uid, action: 'resend_invitation', entity: 'invitation', entityId: id, ip }));
    return { ok: true, link };
  }

  @Delete('invitations/:id')
  async revoke(@UserId() uid: number, @Param('firmId', ParseIntPipe) firmId: number, @Param('id', ParseIntPipe) id: number, @Ip() ip: string) {
    await requireFirmOwner(uid, firmId);
    if (!(await getPool().query('UPDATE invitations SET revoked_at=now() WHERE id=$1 AND firm_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL', [id, firmId])).rowCount) throw new NotFoundException('Invitation not found');
    await tx((c) => writeAudit(c, { userId: uid, action: 'revoke_invitation', entity: 'invitation', entityId: id, ip }));
    return { ok: true };
  }

  /** The firm must always keep at least one owner with access to the whole firm. */
  private async lastOwner(firmId: number, membershipId: number) {
    const owners = (await getPool().query("SELECT id FROM memberships WHERE firm_id=$1 AND role='owner' AND org_id IS NULL", [firmId])).rows.map((r) => Number(r.id));
    return owners.length === 1 && owners[0] === membershipId;
  }

  @Put('members/:id')
  async changeRole(@UserId() uid: number, @Param('firmId', ParseIntPipe) firmId: number, @Param('id', ParseIntPipe) id: number, @Body() body: unknown, @Ip() ip: string) {
    await requireFirmOwner(uid, firmId);
    const b = parse(z.object({ role: z.enum(ROLES), orgId: z.number().int().positive().nullable().optional() }), body);
    const m = (await getPool().query('SELECT role, org_id FROM memberships WHERE id=$1 AND firm_id=$2', [id, firmId])).rows[0];
    if (!m) throw new NotFoundException('Person not found');
    const orgId = b.orgId === undefined ? (m.org_id ? Number(m.org_id) : undefined) : b.orgId ?? undefined;
    await checkOrg(firmId, b.role, orgId);
    if (m.role === 'owner' && !m.org_id && (b.role !== 'owner' || orgId) && (await this.lastOwner(firmId, id))) throw new BadRequestException('The firm needs at least one owner. Make someone else an owner first.');
    await tx(async (c) => {
      await c.query('UPDATE memberships SET role=$2, org_id=$3 WHERE id=$1', [id, b.role, orgId ?? null]);
      await writeAudit(c, { orgId: orgId ?? null, userId: uid, action: 'change_role', entity: 'membership', entityId: id, before: { role: m.role, orgId: m.org_id }, after: { role: b.role, orgId: orgId ?? null }, ip });
    });
    return { ok: true };
  }

  @Delete('members/:id')
  async remove(@UserId() uid: number, @Param('firmId', ParseIntPipe) firmId: number, @Param('id', ParseIntPipe) id: number, @Ip() ip: string) {
    await requireFirmOwner(uid, firmId);
    const m = (await getPool().query('SELECT user_id, role, org_id FROM memberships WHERE id=$1 AND firm_id=$2', [id, firmId])).rows[0];
    if (!m) throw new NotFoundException('Person not found');
    if (m.role === 'owner' && !m.org_id && (await this.lastOwner(firmId, id))) throw new BadRequestException('The firm needs at least one owner. Make someone else an owner first.');
    await tx(async (c) => {
      await c.query('DELETE FROM memberships WHERE id=$1', [id]);
      await writeAudit(c, { orgId: m.org_id ?? null, userId: uid, action: 'remove_member', entity: 'membership', entityId: id, before: { userId: m.user_id, role: m.role, orgId: m.org_id }, ip });
    });
    return { ok: true };
  }
}
