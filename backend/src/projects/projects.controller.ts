// Projects: record time and costs against a customer job, compare with the estimate, and invoice what is not yet billed.
import { BadRequestException, Body, ConflictException, Controller, Get, NotFoundException, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { PoolClient } from 'pg';
import { z } from 'zod';
import { withOrg } from '../db/db';
import { writeAudit } from '../audit/audit';
import { AuthGuard, Ip, UserId, parse } from '../common/guard';
import { requireOrg } from '../tenancy/acl';
import { createDocument } from '../accounting/documents.controller';
import { timeValue } from '../insights/calc';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const today = () => new Date().toISOString().slice(0, 10);
const hm = (minutes: number) => `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`;

/** Totals for one project. Profit = amount invoiced (before GST) - all costs. */
async function summary(c: PoolClient, projectId: number) {
  const time = (await c.query('SELECT minutes, rate, invoiced_doc_id FROM project_time WHERE project_id=$1', [projectId])).rows;
  const costs = (await c.query('SELECT amount, chargeable, invoiced_doc_id FROM project_costs WHERE project_id=$1', [projectId])).rows;
  const invoiced = Number((await c.query(
    `SELECT COALESCE(SUM(subtotal),0) AS s FROM documents WHERE status='posted' AND id IN
       (SELECT invoiced_doc_id FROM project_time WHERE project_id=$1 UNION SELECT invoiced_doc_id FROM project_costs WHERE project_id=$1)`, [projectId])).rows[0].s);
  const minutes = time.reduce((s, r) => s + r.minutes, 0);
  const value = time.reduce((s, r) => s + timeValue(r.minutes, Number(r.rate)), 0);
  const costTotal = costs.reduce((s, r) => s + Number(r.amount), 0);
  const unbilledTime = time.filter((r) => !r.invoiced_doc_id).reduce((s, r) => s + timeValue(r.minutes, Number(r.rate)), 0);
  const unbilledCosts = costs.filter((r) => r.chargeable && !r.invoiced_doc_id).reduce((s, r) => s + Number(r.amount), 0);
  return { minutes, timeValue: value, costs: costTotal, invoiced, unbilledTime, unbilledCosts, toInvoice: unbilledTime + unbilledCosts, profit: invoiced - costTotal };
}

async function project(c: PoolClient, id: number) {
  const p = (await c.query('SELECT p.*, ct.name AS contact_name FROM projects p JOIN contacts ct ON ct.id=p.contact_id WHERE p.id=$1', [id])).rows[0];
  if (!p) throw new NotFoundException('Project not found');
  return p;
}

const shape = (p: any, s: Awaited<ReturnType<typeof summary>>) => {
  const estimate = Number(p.estimate);
  return { id: Number(p.id), name: p.name, contactId: Number(p.contact_id), contactName: p.contact_name, estimate, deadline: p.deadline ? String(p.deadline).slice(0, 10) : null,
    status: p.status, ...s, estimateUsedPct: estimate ? Math.round(((s.timeValue + s.costs) / estimate) * 100) : null };
};

@Controller('orgs/:orgId/projects')
@UseGuards(AuthGuard)
export class ProjectsController {
  @Get()
  async list(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number) {
    await requireOrg(uid, orgId, 'read');
    return withOrg(orgId, async (c) => {
      const rows = (await c.query("SELECT p.*, p.deadline::text AS deadline, ct.name AS contact_name FROM projects p JOIN contacts ct ON ct.id=p.contact_id ORDER BY p.status, p.name")).rows;
      const out = [];
      for (const p of rows) out.push(shape(p, await summary(c, Number(p.id))));
      return out;
    });
  }

  @Post()
  async create(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'post');
    const b = parse(z.object({ name: z.string().min(1).max(200), contactId: z.number().int().positive(), estimate: z.number().int().min(0).default(0), deadline: date.optional() }), body);
    return withOrg(orgId, async (c) => {
      const ct = (await c.query('SELECT kind FROM contacts WHERE id=$1', [b.contactId])).rows[0];
      if (!ct || ct.kind === 'supplier') throw new BadRequestException('Choose a customer for the project');
      if ((await c.query('SELECT 1 FROM projects WHERE name=$1', [b.name])).rowCount) throw new ConflictException('A project with that name exists');
      const id = Number((await c.query('INSERT INTO projects(org_id,name,contact_id,estimate,deadline,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [orgId, b.name, b.contactId, b.estimate, b.deadline ?? null, uid])).rows[0].id);
      await writeAudit(c, { orgId, userId: uid, action: 'create', entity: 'project', entityId: id, after: b, ip });
      return { id };
    });
  }

  @Get(':id')
  async detail(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number) {
    await requireOrg(uid, orgId, 'read');
    return withOrg(orgId, async (c) => {
      const p = await project(c, id);
      const time = (await c.query(
        `SELECT t.id, t.work_date::text AS date, t.description, t.minutes, t.rate, t.invoiced_doc_id, u.full_name AS who, d.number AS invoice
           FROM project_time t JOIN users u ON u.id=t.user_id LEFT JOIN documents d ON d.id=t.invoiced_doc_id WHERE t.project_id=$1 ORDER BY t.work_date, t.id`, [id])).rows
        .map((r) => ({ id: Number(r.id), date: r.date, description: r.description, minutes: r.minutes, rate: Number(r.rate), value: timeValue(r.minutes, Number(r.rate)), who: r.who, invoice: r.invoice }));
      const costs = (await c.query(
        `SELECT k.id, k.cost_date::text AS date, k.description, k.amount, k.chargeable, d.number AS invoice
           FROM project_costs k LEFT JOIN documents d ON d.id=k.invoiced_doc_id WHERE k.project_id=$1 ORDER BY k.cost_date, k.id`, [id])).rows
        .map((r) => ({ id: Number(r.id), date: r.date, description: r.description, amount: Number(r.amount), chargeable: r.chargeable, invoice: r.invoice }));
      return { ...shape(p, await summary(c, id)), timeEntries: time, costEntries: costs };
    });
  }

  @Post(':id/time')
  async addTime(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number, @Body() body: unknown) {
    await requireOrg(uid, orgId, 'post');
    const b = parse(z.object({ date, description: z.string().min(1).max(300), minutes: z.number().int().min(1).max(24 * 60), rate: z.number().int().min(0) }), body);
    return withOrg(orgId, async (c) => {
      if ((await project(c, id)).status !== 'in_progress') throw new ConflictException('The project is closed');
      const r = (await c.query('INSERT INTO project_time(org_id,project_id,user_id,work_date,description,minutes,rate) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [orgId, id, uid, b.date, b.description, b.minutes, b.rate])).rows[0];
      return { id: Number(r.id), value: timeValue(b.minutes, b.rate) };
    });
  }

  @Post(':id/costs')
  async addCost(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number, @Body() body: unknown) {
    await requireOrg(uid, orgId, 'post');
    const b = parse(z.object({ date, description: z.string().min(1).max(300), amount: z.number().int().positive(), chargeable: z.boolean().default(true) }), body);
    return withOrg(orgId, async (c) => {
      if ((await project(c, id)).status !== 'in_progress') throw new ConflictException('The project is closed');
      const r = (await c.query('INSERT INTO project_costs(org_id,project_id,cost_date,description,amount,chargeable,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [orgId, id, b.date, b.description, b.amount, b.chargeable, uid])).rows[0];
      return { id: Number(r.id) };
    });
  }

  /** Invoice every unbilled time entry and chargeable cost as one sales invoice to the project's customer. */
  @Post(':id/invoice')
  async invoice(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'post');
    const b = parse(z.object({ issueDate: date.default(today()), dueDate: date.optional(), gstRateBp: z.number().int().min(0).max(5000).default(1800),
      accountId: z.number().int().positive().optional(), hsnSac: z.string().regex(/^\d{4,8}$/, 'HSN/SAC must be 4-8 digits').optional() }), body ?? {});
    return withOrg(orgId, async (c) => {
      const p = await project(c, id);
      await c.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [id]); // one invoice run at a time per project
      const time = (await c.query('SELECT id, work_date::text AS d, description, minutes, rate FROM project_time WHERE project_id=$1 AND invoiced_doc_id IS NULL AND rate > 0 ORDER BY work_date, id', [id])).rows;
      const costs = (await c.query('SELECT id, description, amount FROM project_costs WHERE project_id=$1 AND invoiced_doc_id IS NULL AND chargeable ORDER BY cost_date, id', [id])).rows;
      if (!time.length && !costs.length) throw new BadRequestException('Nothing to invoice: all time and chargeable costs are already billed');
      const common = { quantity: 1, gstRateBp: b.gstRateBp, ...(b.accountId ? { accountId: b.accountId } : {}), ...(b.hsnSac ? { hsnSac: b.hsnSac } : {}) };
      const lines = [
        ...time.map((t) => ({ ...common, description: `${p.name}: ${t.description} (${t.d}, ${hm(t.minutes)} @ Rs ${(Number(t.rate) / 100).toFixed(2)}/h)`.slice(0, 300), rate: timeValue(t.minutes, Number(t.rate)) })),
        ...costs.map((k) => ({ ...common, description: `${p.name}: ${k.description}`.slice(0, 300), rate: Number(k.amount) })),
      ];
      const doc = await createDocument(c, orgId, uid, { docType: 'invoice', contactId: Number(p.contact_id), issueDate: b.issueDate, dueDate: b.dueDate, lines } as any, ip);
      if (time.length) await c.query('UPDATE project_time SET invoiced_doc_id=$2 WHERE id = ANY($1)', [time.map((t) => t.id), doc.id]);
      if (costs.length) await c.query('UPDATE project_costs SET invoiced_doc_id=$2 WHERE id = ANY($1)', [costs.map((k) => k.id), doc.id]);
      await writeAudit(c, { orgId, userId: uid, action: 'invoice', entity: 'project', entityId: id, after: { documentId: doc.id, number: doc.number, time: time.length, costs: costs.length }, ip });
      return { documentId: doc.id, number: doc.number, subtotal: doc.subtotal, total: doc.total };
    });
  }

  @Post(':id/status')
  async status(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number, @Body() body: unknown) {
    await requireOrg(uid, orgId, 'post');
    const b = parse(z.object({ status: z.enum(['in_progress', 'closed']) }), body);
    return withOrg(orgId, async (c) => { await project(c, id); await c.query('UPDATE projects SET status=$2 WHERE id=$1', [id, b.status]); return { ok: true }; });
  }
}
