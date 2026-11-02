import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { getPool } from '../db/db';

export type Role = 'owner' | 'accountant' | 'staff' | 'client';
export type Permission = 'read' | 'post' | 'manage';

// What each role may do inside an organization.
const ALLOWED: Record<Role, Permission[]> = {
  owner: ['read', 'post', 'manage'],
  accountant: ['read', 'post', 'manage'],
  staff: ['read', 'post'],
  client: ['read'],
};

/** Find the user's role on an organization: a direct membership wins, otherwise a firm-wide one. */
export async function roleOnOrg(userId: number, orgId: number): Promise<Role | null> {
  const { rows } = await getPool().query(
    `SELECT m.role FROM memberships m JOIN organizations o ON o.firm_id = m.firm_id
      WHERE m.user_id = $1 AND o.id = $2 AND (m.org_id = $2 OR m.org_id IS NULL)
      ORDER BY (m.org_id IS NULL) ASC LIMIT 1`,
    [userId, orgId],
  );
  return rows[0]?.role ?? null;
}

/** Throw unless the user holds the permission on the org. Unknown/unrelated orgs look like 404. */
export async function requireOrg(userId: number, orgId: number, perm: Permission): Promise<Role> {
  const role = await roleOnOrg(userId, orgId);
  if (!role) throw new NotFoundException('Organization not found');
  if (!ALLOWED[role].includes(perm)) throw new ForbiddenException(`Your role (${role}) cannot do this`);
  return role;
}

/** Firm-level role (for creating organizations, listing all clients). */
export async function firmRole(userId: number, firmId: number): Promise<Role | null> {
  const { rows } = await getPool().query('SELECT role FROM memberships WHERE user_id=$1 AND firm_id=$2 AND org_id IS NULL', [userId, firmId]);
  return rows[0]?.role ?? null;
}
