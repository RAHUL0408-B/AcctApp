// Organisation settings beyond the basics (which stay in GET/PUT settings): organisation details, branding, payment
// services, invoice numbering, email templates, invoice reminders, lock dates, currencies and history.
import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, ParseIntPipe, Post, Put, Query, UnauthorizedException, UseGuards } from '@nestjs/common';
import { verifyPassword } from '../security/password';
import { z } from 'zod';
import { getPool, withOrg } from '../db/db';
import { writeAudit } from '../audit/audit';
import { AuthGuard, Ip, UserId, parse } from '../common/guard';
import { requireAnyOrg, requireOrg } from '../tenancy/acl';
import { financialYearOf } from '../ledger/ledger';
import { peekNumber } from '../accounting/documents.controller';
import { peekJournalNumber } from '../ledger/ledger.controller';
import { DEFAULT_PREFIX, DEFAULT_TEMPLATES, fillTemplate, PrefixType, upiLink } from './settings';
import { sendOverdueReminders } from '../extras/extras.controller';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const today = () => new Date().toISOString().slice(0, 10);
const text = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => (v === '' ? null : v));
const BUSINESS_TYPES = ['proprietorship', 'partnership', 'llp', 'private_limited', 'public_limited', 'opc', 'huf', 'trust', 'society', 'other'] as const;
const DOC_TYPES = ['invoice', 'bill', 'credit_note', 'debit_note'] as const;

const schema = z.object({
  // organisation details
  legalName: text(200), businessType: z.enum(BUSINESS_TYPES).nullable().optional(), industry: text(100),
  cin: text(30).refine((v) => !v || /^[A-Z0-9-]{6,30}$/.test(v), 'CIN/LLPIN: letters, digits and dashes only'),
  tan: text(10).refine((v) => !v || /^[A-Z]{4}\d{5}[A-Z]$/.test(v), 'Invalid TAN (e.g. MUMA12345B)'),
  description: text(500), addressLine1: text(200), addressLine2: text(200), city: text(100),
  pincode: text(6).refine((v) => !v || /^[1-9]\d{5}$/.test(v), 'PIN code must be 6 digits'),
  phone: text(20).refine((v) => !v || /^[+\d][\d\s-]{5,19}$/.test(v), 'Invalid phone number'),
  email: text(200).refine((v) => !v || z.string().email().safeParse(v).success, 'Invalid email'),
  website: text(200).refine((v) => !v || /^(https?:\/\/)?[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(v), 'Invalid website'),
  timezone: z.string().min(3).max(60).refine((v) => { try { new Intl.DateTimeFormat('en', { timeZone: v }); return true; } catch { return false; } }, 'Unknown time zone').optional(),
  // branding
  logo: z.string().max(420000).regex(/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/, 'The logo must be a PNG or JPEG image').nullable().optional(),
  // payment services
  bankName: text(100), bankAccountName: text(100),
  bankAccountNo: text(30).refine((v) => !v || /^\d{6,20}$/.test(v), 'Account number must be 6-20 digits'),
  bankIfsc: text(11).refine((v) => !v || /^[A-Z]{4}0[A-Z0-9]{6}$/.test(v), 'Invalid IFSC (e.g. HDFC0001234)'),
  upiId: text(100).refine((v) => !v || /^[A-Za-z0-9._-]{2,256}@[A-Za-z]{2,64}$/.test(v), 'Invalid UPI ID (e.g. business@okhdfcbank)'),
  showPaymentOnInvoice: z.boolean().optional(), showUpiQr: z.boolean().optional(),
  // numbering
  prefixes: z.record(z.enum(['invoice', 'bill', 'credit_note', 'debit_note', 'quote', 'purchase_order', 'journal']),
    z.string().trim().max(10).regex(/^[A-Za-z0-9-]*$/, 'A prefix may have letters, digits and dashes only')).optional(),
  // email
  emailReplyTo: text(200).refine((v) => !v || z.string().email().safeParse(v).success, 'Invalid reply-to email'),
  emailSenderName: text(100), emailInvoiceSubject: text(200), emailInvoiceBody: text(2000), emailReminderSubject: text(200), emailReminderBody: text(2000),
  // reminders
  autoRemind: z.boolean().optional(), remindEveryDays: z.number().int().min(1).max(90).optional(),
});
type Body = z.infer<typeof schema>;

/** API field → column. */
const COLUMNS: Partial<Record<keyof Body, string>> = {
  legalName: 'legal_name', businessType: 'business_type', industry: 'industry', cin: 'cin', tan: 'tan', description: 'description',
  addressLine1: 'address_line1', addressLine2: 'address_line2', city: 'city', pincode: 'pincode', phone: 'phone', email: 'email', website: 'website', timezone: 'timezone',
  logo: 'logo', bankName: 'bank_name', bankAccountName: 'bank_account_name', bankAccountNo: 'bank_account_no', bankIfsc: 'bank_ifsc', upiId: 'upi_id',
  showPaymentOnInvoice: 'show_payment_on_invoice', showUpiQr: 'show_upi_qr', emailReplyTo: 'email_reply_to', emailSenderName: 'email_sender_name',
  emailInvoiceSubject: 'email_invoice_subject', emailInvoiceBody: 'email_invoice_body', emailReminderSubject: 'email_reminder_subject', emailReminderBody: 'email_reminder_body',
  autoRemind: 'auto_remind', remindEveryDays: 'remind_every_days',
};

@Controller('orgs/:orgId')
@UseGuards(AuthGuard)
export class SettingsController {
  @Get('org-settings')
  async get(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number) {
    const role = await requireAnyOrg(uid, orgId, ['read', 'sales']);
    const o = (await getPool().query('SELECT * FROM organizations WHERE id=$1', [orgId])).rows[0];
    if (!o) throw new NotFoundException('Organization not found');
    const out: Record<string, unknown> = {};
    for (const [k, col] of Object.entries(COLUMNS)) out[k] = o[col!] ?? null;
    out.prefixes = { ...DEFAULT_PREFIX, ...(o.doc_prefixes ?? {}) };
    out.defaultPrefixes = DEFAULT_PREFIX;
    out.defaultTemplates = DEFAULT_TEMPLATES;
    out.staffLockThrough = (await getPool().query('SELECT staff_lock_through::text AS d FROM organizations WHERE id=$1', [orgId])).rows[0].d;
    out.lockThrough = (await withOrg(orgId, (c) => c.query('SELECT MAX(locked_through)::text AS d FROM financial_years'))).rows[0].d;
    out.fyStartMonth = Number(o.fy_start_month ?? 4);
    out.role = role;
    return out;
  }

  @Put('org-settings')
  async put(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'manage');
    const b = parse(schema, body);
    const sets: string[] = [], vals: unknown[] = [orgId];
    for (const [k, col] of Object.entries(COLUMNS)) {
      const v = (b as Record<string, unknown>)[k];
      if (v === undefined) continue;
      vals.push(v); sets.push(`${col}=$${vals.length}`);
    }
    if (b.prefixes) {
      // Only prefixes that differ from the built-in ones are stored; an empty one goes back to the default.
      // Types not sent keep their saved prefix.
      const saved = (await getPool().query('SELECT doc_prefixes FROM organizations WHERE id=$1', [orgId])).rows[0]?.doc_prefixes ?? {};
      const merged: Record<string, string> = { ...saved, ...Object.fromEntries(Object.entries(b.prefixes).map(([k, v]) => [k, v.toUpperCase()])) };
      const p = Object.fromEntries(Object.entries(merged).filter(([k, v]) => v && v !== DEFAULT_PREFIX[k as PrefixType]));
      vals.push(JSON.stringify(p)); sets.push(`doc_prefixes=$${vals.length}::jsonb`);
    }
    if (!sets.length) throw new BadRequestException('Nothing to save');
    return withOrg(orgId, async (c) => {
      const before = (await c.query('SELECT * FROM organizations WHERE id=$1', [orgId])).rows[0];
      await c.query(`UPDATE organizations SET ${sets.join(', ')} WHERE id=$1`, vals);
      const after = { ...b, ...(b.logo ? { logo: `(image, ${b.logo.length} bytes)` } : {}) };
      const changed = Object.keys(b);
      await writeAudit(c, { orgId, userId: uid, action: 'update_settings', entity: 'organization', entityId: orgId,
        before: Object.fromEntries(changed.map((k) => [k, k === 'logo' ? (before.logo ? '(image)' : null) : k === 'prefixes' ? before.doc_prefixes : before[COLUMNS[k as keyof Body] ?? k]])), after, ip });
      return { ok: true, saved: changed };
    });
  }

  /** Next numbers for each document type, and the option to start a type from a chosen number this financial year. */
  @Get('numbering')
  async numbering(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number) {
    await requireOrg(uid, orgId, 'read');
    const on = today(), fy = financialYearOf(on);
    return withOrg(orgId, async (c) => {
      const out: Record<string, string> = {};
      for (const t of DOC_TYPES) out[t] = await peekNumber(c, orgId, t, on);
      out.journal = await peekJournalNumber(c, orgId, on);
      for (const k of ['quote', 'purchase_order'] as const) {
        const n = Number((await c.query("SELECT next_no FROM doc_sequences WHERE org_id=$1 AND doc_type=$2 AND fy_label='-'", [orgId, k])).rows[0]?.next_no ?? 1);
        const p = (await c.query('SELECT doc_prefixes FROM organizations WHERE id=$1', [orgId])).rows[0].doc_prefixes?.[k] || DEFAULT_PREFIX[k];
        out[k] = `${p}-${String(n).padStart(4, '0')}`;
      }
      return { financialYear: fy.label, next: out };
    });
  }

  @Put('numbering/next')
  async setNext(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'manage');
    const b = parse(z.object({ type: z.enum(['invoice', 'bill', 'credit_note', 'debit_note', 'quote', 'purchase_order', 'journal']), next: z.number().int().min(1).max(999999) }), body);
    const fy = ['quote', 'purchase_order'].includes(b.type) ? '-' : financialYearOf(today()).label;
    return withOrg(orgId, async (c) => {
      const before = (await c.query('SELECT next_no FROM doc_sequences WHERE org_id=$1 AND doc_type=$2 AND fy_label=$3', [orgId, b.type, fy])).rows[0]?.next_no ?? 1;
      await c.query(`INSERT INTO doc_sequences(org_id,doc_type,fy_label,next_no) VALUES ($1,$2,$3,$4)
        ON CONFLICT (org_id,doc_type,fy_label) DO UPDATE SET next_no=EXCLUDED.next_no`, [orgId, b.type, fy, b.next]);
      await writeAudit(c, { orgId, userId: uid, action: 'set_next_number', entity: 'doc_sequence', before: { type: b.type, next: Number(before) }, after: b, ip });
      return { ok: true };
    });
  }

  /** Lock dates: one for staff (owners and accountants can still post), one for everybody. */
  @Put('lock-dates')
  async lockDates(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Body() body: unknown, @Ip() ip: string) {
    const role = await requireAnyOrg(uid, orgId, ['manage']);
    const b = parse(z.object({ staffLockThrough: date.nullable().optional(), lockThrough: date.nullable().optional(), password: z.string().min(1, 'Enter your password to confirm').max(200) }), body);
    // Locking or unlocking the books is confirmed with the person's own password.
    const hash = (await getPool().query('SELECT password_hash FROM users WHERE id=$1', [uid])).rows[0]?.password_hash;
    if (!hash || !(await verifyPassword(b.password, hash))) throw new UnauthorizedException('That password is not right');
    return withOrg(orgId, async (c) => {
      const before = { staffLockThrough: (await c.query('SELECT staff_lock_through::text AS d FROM organizations WHERE id=$1', [orgId])).rows[0].d,
        lockThrough: (await c.query('SELECT MAX(locked_through)::text AS d FROM financial_years')).rows[0].d };
      // Moving a lock date earlier, or removing it, opens periods that were closed: only the owner may do that.
      const opens = (old: string | null, next: string | null | undefined) => next !== undefined && !!old && (next === null || next < old);
      if (role !== 'owner' && (opens(before.staffLockThrough, b.staffLockThrough) || opens(before.lockThrough, b.lockThrough)))
        throw new ForbiddenException('Only the owner can unlock books that are locked. Ask the owner to change the lock date.');
      if (b.staffLockThrough !== undefined) await c.query('UPDATE organizations SET staff_lock_through=$2 WHERE id=$1', [orgId, b.staffLockThrough]);
      if (b.lockThrough !== undefined) {
        if (b.lockThrough === null) await c.query('UPDATE financial_years SET locked_through=NULL');
        else {
          const fy = financialYearOf(b.lockThrough);
          // A lock date moves the hard lock to exactly this date (earlier years stay locked to their end only if set later than this date).
          await c.query('UPDATE financial_years SET locked_through=NULL WHERE locked_through > $1', [b.lockThrough]);
          await c.query(`INSERT INTO financial_years(org_id,label,starts_on,ends_on,locked_through) VALUES ($1,$2,$3,$4,$5)
            ON CONFLICT (org_id,starts_on) DO UPDATE SET locked_through=EXCLUDED.locked_through`, [orgId, fy.label, fy.start, fy.end, b.lockThrough]);
        }
      }
      await writeAudit(c, { orgId, userId: uid, action: 'lock_dates', entity: 'organization', entityId: orgId, before, after: b, ip });
      return { ok: true };
    });
  }

  /** Example of the invoice email and reminder as they will be sent, with the saved (or typed) templates. */
  @Post('email-preview')
  async emailPreview(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Body() body: unknown) {
    await requireOrg(uid, orgId, 'read');
    const b = parse(z.object({ subject: z.string().max(200), body: z.string().max(2000) }), body);
    const org = (await getPool().query('SELECT name FROM organizations WHERE id=$1', [orgId])).rows[0];
    const vars = { contact: 'Kapoor Stores', number: 'INV/26-27/0014', amount: '11,800.00', due: today(), org: org.name, type: 'invoice' };
    return { subject: fillTemplate(b.subject, vars), body: `${fillTemplate(b.body, vars)}\n\nRegards,\n${org.name}` };
  }

  @Post('reminders/run')
  async runReminders(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'post');
    return sendOverdueReminders(orgId, uid, ip);
  }

  /** The UPI link the QR on invoices will carry, so the settings page can show a sample. */
  @Get('upi-sample')
  async upiSample(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number) {
    await requireOrg(uid, orgId, 'read');
    const o = (await getPool().query('SELECT name,upi_id,bank_account_name FROM organizations WHERE id=$1', [orgId])).rows[0];
    return { link: o.upi_id ? upiLink(o.upi_id, o.bank_account_name || o.name, 100000, 'INV/SAMPLE') : null };
  }

  // ---------- currencies ----------
  @Get('currencies')
  async currencies(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number) {
    await requireAnyOrg(uid, orgId, ['read', 'sales']);
    return withOrg(orgId, async (c) => (await c.query('SELECT code, rate::float8 AS rate, updated_at AS "updatedAt" FROM org_currencies ORDER BY code')).rows);
  }

  @Post('currencies')
  async addCurrency(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'manage');
    const b = parse(z.object({ code: z.string().trim().toUpperCase().pipe(z.string().regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code').refine((v) => v !== 'INR', 'INR is the base currency')),
      rate: z.number().positive().max(100000) }), body);
    return withOrg(orgId, async (c) => {
      await c.query(`INSERT INTO org_currencies(org_id,code,rate) VALUES ($1,$2,$3) ON CONFLICT (org_id,code) DO UPDATE SET rate=EXCLUDED.rate, updated_at=now()`, [orgId, b.code, b.rate]);
      await writeAudit(c, { orgId, userId: uid, action: 'set_currency', entity: 'currency', entityId: b.code, after: b, ip });
      return { ok: true };
    });
  }

  @Delete('currencies/:code')
  async removeCurrency(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('code') code: string, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'manage');
    return withOrg(orgId, async (c) => {
      const r = await c.query('DELETE FROM org_currencies WHERE code=$1', [code.toUpperCase()]);
      if (!r.rowCount) throw new NotFoundException('Currency not found');
      await writeAudit(c, { orgId, userId: uid, action: 'remove_currency', entity: 'currency', entityId: code.toUpperCase(), ip });
      return { ok: true };
    });
  }

  // ---------- history and notes ----------
  @Get('history')
  async history(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Query() q: Record<string, string>) {
    await requireOrg(uid, orgId, 'manage');
    const limit = Math.min(Math.max(parseInt(q.limit ?? '') || 100, 1), 500);
    const rows = await withOrg(orgId, async (c) => (await c.query(
      `SELECT id, user_id, action, entity, entity_id AS "entityId", after_data AS after, created_at AS "at" FROM audit_log
        WHERE ($1::text IS NULL OR entity=$1) AND ($2::text IS NULL OR action ILIKE '%'||$2||'%' OR entity ILIKE '%'||$2||'%')
        ORDER BY id DESC LIMIT $3`, [q.entity || null, q.q || null, limit])).rows);
    const ids = [...new Set(rows.map((r) => r.user_id).filter(Boolean))];
    const users = ids.length ? (await getPool().query('SELECT id, full_name AS name, email FROM users WHERE id = ANY($1)', [ids])).rows : [];
    const who = new Map(users.map((u) => [String(u.id), u.name || u.email]));
    return rows.map((r) => ({ id: Number(r.id), at: r.at, user: r.user_id ? who.get(String(r.user_id)) ?? 'Unknown user' : 'System', action: r.action, entity: r.entity, entityId: r.entityId, after: r.after }));
  }
}
