import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Param, ParseIntPipe, Post, Req, ServiceUnavailableException, UnauthorizedException, UseGuards, ConflictException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { getPool, tx } from '../db/db';
import { writeAudit } from '../audit/audit';
import { AuthGuard, Ip, UserId, parse } from '../common/guard';
import { verifyPassword } from '../security/password';
import { firmRole } from '../tenancy/acl';
import { addDaysIso, addMonthsIso, effectivePlan, getProvider, Plan, priceWithGst, Subscription } from './billing';
import { metrics } from './metrics';

const today = () => new Date().toISOString().slice(0, 10);
export const CONSENT_VERSION = '2025-01';

async function loadPlans(): Promise<Plan[]> {
  return (await getPool().query('SELECT code,name,price_paise_monthly,max_orgs,max_members FROM plans WHERE active ORDER BY sort_order')).rows
    .map((r) => ({ code: r.code, name: r.name, pricePaiseMonthly: Number(r.price_paise_monthly), maxOrgs: r.max_orgs, maxMembers: r.max_members }));
}
async function loadSub(firmId: number): Promise<Subscription | null> {
  const r = (await getPool().query('SELECT plan_code,status,trial_ends,current_period_end FROM subscriptions WHERE firm_id=$1', [firmId])).rows[0];
  return r ? { planCode: r.plan_code, status: r.status, trialEnds: r.trial_ends, currentPeriodEnd: r.current_period_end } : null;
}
/** Plan limits that apply to a firm right now, plus current usage. */
export async function firmPlan(firmId: number) {
  const plan = effectivePlan(await loadSub(firmId), await loadPlans(), today());
  const orgs = Number((await getPool().query('SELECT count(*) FROM organizations WHERE firm_id=$1', [firmId])).rows[0].count);
  const members = Number((await getPool().query('SELECT count(DISTINCT user_id) FROM memberships WHERE firm_id=$1', [firmId])).rows[0].count);
  return { plan, usage: { orgs, members } };
}

@Controller()
export class LaunchController {
  // ---------- monitoring ----------
  @Get('health')
  async health() {
    const t = Date.now();
    try { await getPool().query('SELECT 1'); } catch { throw new ServiceUnavailableException({ status: 'down', db: 'unreachable' }); }
    return { status: 'ok', db: 'ok', dbMs: Date.now() - t, uptimeSec: Math.round((Date.now() - metrics.startedAt) / 1000), worker: { lastTick: metrics.workerLastTick, lastError: metrics.workerLastError } };
  }

  @Get('metrics')
  metricsEndpoint(@Req() req: any) {
    const token = process.env.METRICS_TOKEN;
    if (!token || req.headers.authorization !== `Bearer ${token}`) throw new UnauthorizedException();
    return { ...metrics, avgLatencyMs: metrics.requests ? Math.round(metrics.latencyMsTotal / metrics.requests) : 0 };
  }

  // ---------- plans and billing ----------
  @Get('plans')
  async plans() {
    return (await loadPlans()).map((p) => ({ ...p, ...priceWithGst(p.pricePaiseMonthly) }));
  }

  @Get('firms/:firmId/billing')
  @UseGuards(AuthGuard)
  async billing(@UserId() uid: number, @Param('firmId', ParseIntPipe) firmId: number) {
    if ((await firmRole(uid, firmId)) !== 'owner') throw new ForbiddenException('Only the firm owner can see billing');
    const sub = await loadSub(firmId);
    const { plan, usage } = await firmPlan(firmId);
    const invoices = (await getPool().query('SELECT id,number,plan_code,period_start,period_end,amount,gst,total,status FROM billing_invoices WHERE firm_id=$1 ORDER BY id DESC', [firmId])).rows
      .map((r) => ({ ...r, id: Number(r.id), amount: Number(r.amount), gst: Number(r.gst), total: Number(r.total) }));
    return { subscription: sub, effectivePlan: plan, usage, invoices };
  }

  @Post('firms/:firmId/billing/subscribe')
  @UseGuards(AuthGuard)
  async subscribe(@UserId() uid: number, @Param('firmId', ParseIntPipe) firmId: number, @Body() body: unknown, @Ip() ip: string) {
    if ((await firmRole(uid, firmId)) !== 'owner') throw new ForbiddenException('Only the firm owner can change the plan');
    const b = parse(z.object({ planCode: z.string() }), body);
    const plans = await loadPlans();
    const plan = plans.find((p) => p.code === b.planCode);
    if (!plan) throw new BadRequestException('Unknown plan');
    const { usage } = await firmPlan(firmId);
    if (usage.orgs > plan.maxOrgs || usage.members > plan.maxMembers) throw new BadRequestException(`You use ${usage.orgs} clients and ${usage.members} team members, which is over the ${plan.name} limits (${plan.maxOrgs} / ${plan.maxMembers}).`);
    const price = priceWithGst(plan.pricePaiseMonthly);
    let ref = 'free';
    if (price.total > 0) {
      let provider;
      try { provider = getProvider(); } catch (e) { throw new ServiceUnavailableException((e as Error).message); }
      const res = await provider.charge({ firmId, amountTotal: price.total, description: `${plan.name} plan` });
      if (!res.ok) throw new BadRequestException(res.error ?? 'Payment failed');
      ref = res.ref;
    }
    return tx(async (c) => {
      const start = today(), end = addMonthsIso(start, 1);
      await c.query(`INSERT INTO subscriptions(firm_id,plan_code,status,current_period_end,provider_ref,updated_at) VALUES ($1,$2,'active',$3,$4,now())
        ON CONFLICT (firm_id) DO UPDATE SET plan_code=$2, status='active', current_period_end=$3, provider_ref=$4, trial_ends=NULL, updated_at=now()`, [firmId, plan.code, end, ref]);
      let number = null;
      if (price.total > 0) {
        number = `SUB-${firmId}-${Date.now()}`;
        await c.query("INSERT INTO billing_invoices(firm_id,number,plan_code,period_start,period_end,amount,gst,total,status,paid_at,provider_ref) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'paid',now(),$9)",
          [firmId, number, plan.code, start, end, price.amount, price.gst, price.total, ref]);
      }
      await writeAudit(c, { userId: uid, action: 'subscribe', entity: 'subscription', entityId: firmId, after: { plan: plan.code, number }, ip });
      return { plan: plan.code, invoice: number, total: price.total, validUntil: end };
    });
  }

  @Post('firms/:firmId/billing/cancel')
  @UseGuards(AuthGuard)
  @HttpCode(200)
  async cancel(@UserId() uid: number, @Param('firmId', ParseIntPipe) firmId: number, @Ip() ip: string) {
    if ((await firmRole(uid, firmId)) !== 'owner') throw new ForbiddenException('Only the firm owner can cancel');
    return tx(async (c) => {
      await c.query("UPDATE subscriptions SET status='cancelled', updated_at=now() WHERE firm_id=$1 AND status IN ('active','trialing','past_due')", [firmId]);
      await writeAudit(c, { userId: uid, action: 'cancel_subscription', entity: 'subscription', entityId: firmId, ip });
      return { ok: true };
    });
  }

  // ---------- privacy (DPDP Act) ----------
  @Get('me/consents')
  @UseGuards(AuthGuard)
  async consents(@UserId() uid: number) {
    const rows = (await getPool().query('SELECT DISTINCT ON (purpose) purpose, version, granted, created_at FROM consents WHERE user_id=$1 ORDER BY purpose, id DESC', [uid])).rows;
    return rows;
  }

  /** Grant or withdraw consent. Terms and privacy are required to use the service, so they can only be withdrawn by deleting the account. */
  @Post('me/consents')
  @UseGuards(AuthGuard)
  async setConsent(@UserId() uid: number, @Body() body: unknown, @Ip() ip: string) {
    const b = parse(z.object({ purpose: z.enum(['marketing', 'analytics']), granted: z.boolean() }), body);
    await getPool().query('INSERT INTO consents(user_id,purpose,version,granted,ip) VALUES ($1,$2,$3,$4,$5)', [uid, b.purpose, CONSENT_VERSION, b.granted, ip]);
    return { ok: true };
  }

  /** Right to access/portability: everything we hold about the signed-in person. */
  @Get('me/export')
  @UseGuards(AuthGuard)
  async exportMine(@UserId() uid: number, @Ip() ip: string) {
    const q = (sql: string) => getPool().query(sql, [uid]).then((r) => r.rows);
    const user = (await q('SELECT id,email,full_name,totp_enabled,created_at FROM users WHERE id=$1'))[0];
    const data = {
      exportedAt: new Date().toISOString(), user,
      memberships: await q('SELECT firm_id,org_id,role FROM memberships WHERE user_id=$1'),
      consents: await q('SELECT purpose,version,granted,ip,created_at FROM consents WHERE user_id=$1 ORDER BY id'),
      activity: await q('SELECT action,entity,entity_id,ip,created_at FROM audit_log WHERE user_id=$1 ORDER BY id'),
      uploadedFiles: await q('SELECT name,mime,size,created_at FROM files WHERE uploaded_by=$1').catch(() => []),
    };
    await tx((c) => writeAudit(c, { userId: uid, action: 'dpdp_export', entity: 'user', entityId: uid, ip }));
    return data;
  }

  /**
   * Right to erasure. Personal details are removed or anonymised at once. Accounting records are kept: Indian law
   * (Companies Act / GST) requires books to be retained, so ledger entries stay but no longer identify the person.
   */
  @Post('me/delete')
  @UseGuards(AuthGuard)
  @HttpCode(200)
  async deleteMe(@UserId() uid: number, @Body() body: unknown, @Ip() ip: string) {
    const b = parse(z.object({ password: z.string().min(1), confirm: z.literal('DELETE') }), body);
    const u = (await getPool().query('SELECT password_hash FROM users WHERE id=$1 AND deleted_at IS NULL', [uid])).rows[0];
    if (!u || !(await verifyPassword(b.password, u.password_hash))) throw new UnauthorizedException('Wrong password');
    return tx(async (c) => {
      const sole = (await c.query(
        `SELECT m.firm_id FROM memberships m WHERE m.user_id=$1 AND m.org_id IS NULL AND m.role='owner'
            AND NOT EXISTS (SELECT 1 FROM memberships o WHERE o.firm_id=m.firm_id AND o.org_id IS NULL AND o.role='owner' AND o.user_id<>$1)`, [uid])).rows;
      if (sole.length) throw new ConflictException('You are the only owner of a firm. Make someone else an owner first (the firm\'s books must have an owner).');
      await c.query("UPDATE users SET email=$2, full_name='Deleted user', password_hash=$3, totp_secret=NULL, totp_enabled=false, recovery_codes='{}', deleted_at=now() WHERE id=$1",
        [uid, `deleted-${uid}@deleted.invalid`, 'deleted$' + randomBytes(16).toString('hex')]);
      await c.query('DELETE FROM memberships WHERE user_id=$1', [uid]);
      await c.query("INSERT INTO deletion_requests(user_id,note) VALUES ($1,'Personal data anonymised; accounting records retained by law')", [uid]);
      await writeAudit(c, { userId: uid, action: 'dpdp_erasure', entity: 'user', entityId: uid, ip });
      return { deleted: true, retained: 'Accounting entries you created stay in your clients\' books without your name or email.' };
    });
  }
}
