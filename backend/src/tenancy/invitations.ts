// One-time links sent by email (password reset, email check, invitations). Only a SHA-256 hash of each token is stored,
// so a database leak does not hand out working links.
import { createHash, randomBytes } from 'crypto';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { firmPlan } from '../ops/launch.controller';

export const APP_URL = () => (process.env.APP_URL ?? 'http://localhost:5173').replace(/\/$/, '');
export const hashToken = (raw: string) => createHash('sha256').update(raw).digest('hex');
export const newToken = () => { const raw = randomBytes(32).toString('hex'); return { raw, hash: hashToken(raw) }; };
/** Links use the app's # routes, so they open the right screen in the single-page app. */
export const linkFor = (screen: 'reset' | 'verify' | 'invite', raw: string) => `${APP_URL()}/#/${screen}?token=${raw}`;

export const ROLE_TEXT: Record<string, string> = {
  owner: 'Owner (everything, including users and billing)',
  accountant: 'Accountant (manage the books)',
  staff: 'Staff (enter invoices, bills and payments)',
  client: 'Client (view their own books)',
  sales: 'Sales (raise invoices and quotes, add customers)',
  employee: 'Employee (submit expense claims)',
};

export interface Invitation { id: number; firm_id: number; org_id: number | null; email: string; role: string; firm_name: string; org_name: string | null; expires_at: Date }

/** A usable invitation for this token, or null when unknown, used, revoked or expired. */
export async function findInvitation(c: PoolClient, raw: string): Promise<Invitation | null> {
  const r = (await c.query(
    `SELECT i.*, f.name AS firm_name, o.name AS org_name FROM invitations i JOIN firms f ON f.id = i.firm_id LEFT JOIN organizations o ON o.id = i.org_id
      WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()`, [hashToken(raw)])).rows[0];
  return r ? { ...r, id: Number(r.id), firm_id: Number(r.firm_id), org_id: r.org_id ? Number(r.org_id) : null } : null;
}

/** Give the user the invited access and mark the invitation used. The email must match the invitation. */
export async function acceptInvitation(c: PoolClient, inv: Invitation, userId: number, email: string) {
  if (inv.email.toLowerCase() !== email.toLowerCase()) throw new ForbiddenException(`This invitation was sent to ${inv.email}. Log in with that address to accept it.`);
  const dup = await c.query('SELECT 1 FROM memberships WHERE user_id=$1 AND firm_id=$2 AND org_id IS NOT DISTINCT FROM $3', [userId, inv.firm_id, inv.org_id]);
  if (dup.rowCount) throw new ConflictException('You already have access to this organisation');
  // The plan counts people, so someone already in the firm (for another client) does not use a new place.
  const inFirm = (await c.query('SELECT 1 FROM memberships WHERE user_id=$1 AND firm_id=$2', [userId, inv.firm_id])).rowCount;
  const { plan, usage } = await firmPlan(inv.firm_id);
  if (!inFirm && usage.members >= plan.maxMembers) throw new ForbiddenException(`This firm's ${plan.name} plan is full (${plan.maxMembers} people). Ask the owner to upgrade.`);
  await c.query('INSERT INTO memberships(user_id,firm_id,org_id,role) VALUES ($1,$2,$3,$4)', [userId, inv.firm_id, inv.org_id, inv.role]);
  await c.query('UPDATE invitations SET accepted_at=now() WHERE id=$1', [inv.id]);
  // Following the emailed link proves the address belongs to them.
  await c.query('UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id=$1', [userId]);
}
