// Subscription rules. Plans (prices and limits) live in the `plans` table; this file only applies them.
import { percentOf } from '../money';

export interface Plan { code: string; name: string; pricePaiseMonthly: number; maxOrgs: number; maxMembers: number; }
export interface Subscription { planCode: string; status: 'trialing' | 'active' | 'past_due' | 'cancelled'; trialEnds: string | null; currentPeriodEnd: string | null; }

export const SUBSCRIPTION_GST_BP = 1800; // GST on software subscriptions - confirm the current rate with your CA

/** The plan whose limits apply right now. Lapsed trials, cancelled or unpaid subscriptions fall back to Free. */
export function effectivePlan(sub: Subscription | null, plans: Plan[], today: string): Plan {
  const free = plans.find((p) => p.code === 'free')!;
  if (!sub) return free;
  const plan = plans.find((p) => p.code === sub.planCode) ?? free;
  if (sub.status === 'active') return plan;
  if (sub.status === 'trialing' && sub.trialEnds && sub.trialEnds >= today) return plan;
  if (sub.status === 'cancelled' && sub.currentPeriodEnd && sub.currentPeriodEnd >= today) return plan; // paid-up until period end
  return free;
}

export function priceWithGst(pricePaise: number) {
  const gst = percentOf(pricePaise, SUBSCRIPTION_GST_BP);
  return { amount: pricePaise, gst, total: pricePaise + gst };
}

export const addDaysIso = (iso: string, days: number) => new Date(Date.parse(iso) + days * 86400000).toISOString().slice(0, 10);
export const addMonthsIso = (iso: string, months: number) => { const d = new Date(Date.parse(iso)); d.setUTCMonth(d.getUTCMonth() + months); return d.toISOString().slice(0, 10); };

/** Payment gateway boundary. Wire Razorpay/Stripe/etc. here; the rest of the app only sees this interface. */
export interface PaymentProvider { name: string; charge(req: { firmId: number; amountTotal: number; description: string }): Promise<{ ok: boolean; ref: string; error?: string }>; }

export class TestProvider implements PaymentProvider {
  name = 'test';
  async charge(req: { firmId: number; amountTotal: number }) { return { ok: true, ref: `test_${req.firmId}_${Date.now()}` }; }
}

export function getProvider(): PaymentProvider {
  const p = process.env.PAYMENT_PROVIDER ?? (process.env.NODE_ENV === 'production' ? '' : 'test');
  if (p === 'test') return new TestProvider();
  throw new Error('No payment provider configured. Implement PaymentProvider for your gateway and set PAYMENT_PROVIDER.');
}
