import { PoolClient } from 'pg';

export interface AuditInput {
  orgId?: number | null;
  userId?: number | null;
  action: string;
  entity: string;
  entityId?: string | number;
  before?: unknown;
  after?: unknown;
  ip?: string;
}

/** Append one row to the audit log (inside the caller's transaction so it commits or rolls back together). */
export async function writeAudit(c: PoolClient, a: AuditInput) {
  await c.query(
    `INSERT INTO audit_log(org_id,user_id,action,entity,entity_id,before_data,after_data,ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [a.orgId ?? null, a.userId ?? null, a.action, a.entity, a.entityId?.toString() ?? null,
     a.before === undefined ? null : JSON.stringify(a.before), a.after === undefined ? null : JSON.stringify(a.after), a.ip ?? null],
  );
}
