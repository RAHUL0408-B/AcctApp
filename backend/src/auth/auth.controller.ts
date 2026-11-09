import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, UnauthorizedException, UseGuards, ConflictException, BadRequestException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { getPool, tx } from '../db/db';
import { writeAudit } from '../audit/audit';
import { AuthGuard, UserId, Ip, parse, forgetTokenVersion } from '../common/guard';
import { hashPassword, verifyPassword, weakPassword } from '../security/password';
import { signToken, verifyToken } from '../security/jwt';
import { generateSecret, otpauthUrl, verifyTotp } from '../security/totp';
import { RateLimiter } from '../common/ratelimit';
import { queueMail } from '../firm/mailer';
import { acceptInvitation, findInvitation, hashToken, linkFor, newToken, ROLE_TEXT } from '../tenancy/invitations';
import { PoolClient } from 'pg';

const APP_NAME = process.env.APP_NAME ?? 'AcctApp';
const limiter = new RateLimiter(10, 60_000); // 10 attempts per minute per key

const registerSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(10, 'Use at least 10 characters').max(200),
  fullName: z.string().min(1).max(120),
  // Not needed when joining someone else's firm through an invitation.
  firmName: z.string().min(1).max(160).optional(),
  inviteToken: z.string().max(200).optional(),
  acceptTerms: z.literal(true, { errorMap: () => ({ message: 'You must accept the Terms and Privacy Policy' }) }),
});
const loginSchema = z.object({ email: z.string().email().toLowerCase(), password: z.string().min(1) });

@Controller('auth')
export class AuthController {
  @Post('register')
  async register(@Body() body: unknown, @Ip() ip: string) {
    const b = parse(registerSchema, body);
    limiter.hit(`reg:${ip}`);
    const weak = weakPassword(b.password, b.email);
    if (weak) throw new BadRequestException(weak);
    const hash = await hashPassword(b.password);
    if (!b.inviteToken && !b.firmName) throw new BadRequestException('firmName: Enter your firm name');
    const result = await tx(async (c) => {
      const dup = await c.query('SELECT 1 FROM users WHERE email=$1', [b.email]);
      if (dup.rowCount) throw new ConflictException('Email already registered');
      const inv = b.inviteToken ? await findInvitation(c, b.inviteToken) : null;
      if (b.inviteToken && !inv) throw new BadRequestException('This invitation link has expired or was already used. Ask for a new one.');
      const user = (await c.query('INSERT INTO users(email,password_hash,full_name) VALUES ($1,$2,$3) RETURNING id', [b.email, hash, b.fullName])).rows[0];
      for (const purpose of ['terms', 'privacy']) await c.query('INSERT INTO consents(user_id,purpose,version,granted,ip) VALUES ($1,$2,$3,true,$4)', [user.id, purpose, '2025-01', ip]);
      let firmId: number | null = null;
      if (inv) {
        // Joining an existing firm: no firm or trial of their own.
        await acceptInvitation(c, inv, Number(user.id), b.email);
        firmId = inv.firm_id;
      } else {
        const firm = (await c.query('INSERT INTO firms(name) VALUES ($1) RETURNING id', [b.firmName])).rows[0];
        firmId = Number(firm.id);
        await c.query("INSERT INTO memberships(user_id,firm_id,org_id,role) VALUES ($1,$2,NULL,'owner')", [user.id, firm.id]);
        // 14-day free trial of the Practice plan; afterwards the Free plan limits apply until a plan is bought
        await c.query("INSERT INTO subscriptions(firm_id,plan_code,status,trial_ends) VALUES ($1,'practice','trialing',CURRENT_DATE + 14)", [firm.id]);
      }
      await writeAudit(c, { userId: user.id, action: inv ? 'register_invited' : 'register', entity: 'user', entityId: user.id, ip });
      return { token: signToken(user.id, 'full'), userId: Number(user.id), firmId, invited: !!inv };
    });
    // Invited people proved their address by following the emailed link; everyone else gets a check link.
    if (!result.invited) await this.sendVerification(result.userId, b.email);
    return result;
  }

  /** Create a one-time link and email it. Older unused links of the same kind stop working. */
  private async issueLink(c: PoolClient | null, userId: number, purpose: 'reset' | 'verify', minutes: number) {
    const q = c ?? getPool();
    await q.query('UPDATE auth_tokens SET used_at=now() WHERE user_id=$1 AND purpose=$2 AND used_at IS NULL', [userId, purpose]);
    const t = newToken();
    await q.query(`INSERT INTO auth_tokens(user_id,purpose,token_hash,expires_at) VALUES ($1,$2,$3, now() + make_interval(mins => $4))`, [userId, purpose, t.hash, minutes]);
    return linkFor(purpose, t.raw);
  }

  private async sendVerification(userId: number, email: string) {
    const link = await this.issueLink(null, userId, 'verify', 7 * 24 * 60);
    await queueMail({ to: email, subject: `Confirm your email for ${APP_NAME}`,
      body: `Hello,\n\nPlease confirm this is your email address by opening this link within 7 days:\n${link}\n\nIf you did not create an ${APP_NAME} account, ignore this email.` });
  }

  /** The one-time link of this kind, if it is still valid. */
  private async linkRow(raw: string, purpose: 'reset' | 'verify') {
    return (await getPool().query(
      `SELECT t.id, t.user_id, u.email FROM auth_tokens t JOIN users u ON u.id = t.user_id
        WHERE t.token_hash=$1 AND t.purpose=$2 AND t.used_at IS NULL AND t.expires_at > now()`, [hashToken(raw), purpose])).rows[0];
  }

  /** Always answers the same way, so it cannot be used to find out who has an account. */
  @Post('forgot-password')
  @HttpCode(200)
  async forgot(@Body() body: unknown, @Ip() ip: string) {
    const b = parse(z.object({ email: z.string().email().toLowerCase() }), body);
    limiter.hit(`forgot:${ip}`);
    limiter.hit(`forgot:${b.email}`);
    const u = (await getPool().query('SELECT id FROM users WHERE email=$1', [b.email])).rows[0];
    if (u) {
      const link = await this.issueLink(null, Number(u.id), 'reset', 60);
      await queueMail({ to: b.email, subject: `Reset your ${APP_NAME} password`,
        body: `Hello,\n\nSomeone asked to reset the password for this email address. To choose a new password, open this link within 1 hour:\n${link}\n\nIf it was not you, ignore this email: your password stays the same.` });
      await tx((c) => writeAudit(c, { userId: u.id, action: 'request_password_reset', entity: 'user', entityId: u.id, ip }));
    }
    return { ok: true, message: 'If that address has an account, we have emailed a link to reset the password. It works for 1 hour.' };
  }

  /** Set a new password from an emailed link. Every existing session ends. */
  @Post('reset-password')
  @HttpCode(200)
  async reset(@Body() body: unknown, @Ip() ip: string) {
    const b = parse(z.object({ token: z.string().min(10).max(200), password: z.string().min(10, 'Use at least 10 characters').max(200) }), body);
    limiter.hit(`reset:${ip}`);
    const row = await this.linkRow(b.token, 'reset');
    if (!row) throw new BadRequestException('This reset link has expired or was already used. Ask for a new one.');
    const weak = weakPassword(b.password, row.email);
    if (weak) throw new BadRequestException(weak);
    const hash = await hashPassword(b.password);
    await tx(async (c) => {
      await c.query(`UPDATE users SET password_hash=$2, token_version=token_version+1, failed_logins=0, locked_until=NULL,
                       email_verified_at=COALESCE(email_verified_at, now()) WHERE id=$1`, [row.user_id, hash]);
      await c.query("UPDATE auth_tokens SET used_at=now() WHERE user_id=$1 AND purpose='reset' AND used_at IS NULL", [row.user_id]);
      await writeAudit(c, { userId: row.user_id, action: 'reset_password', entity: 'user', entityId: row.user_id, ip });
    });
    forgetTokenVersion(Number(row.user_id));
    return { ok: true };
  }

  /** Change the password while logged in. Other sessions end; this one gets a new token. */
  @Post('change-password')
  @UseGuards(AuthGuard)
  @HttpCode(200)
  async changePassword(@UserId() uid: number, @Body() body: unknown, @Ip() ip: string) {
    const b = parse(z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(10, 'Use at least 10 characters').max(200) }), body);
    limiter.hit(`chpw:${uid}`);
    const u = (await getPool().query('SELECT email,password_hash FROM users WHERE id=$1', [uid])).rows[0];
    if (!(await verifyPassword(b.currentPassword, u.password_hash))) throw new UnauthorizedException('Your current password is wrong');
    if (b.currentPassword === b.newPassword) throw new BadRequestException('Choose a password different from the current one');
    const weak = weakPassword(b.newPassword, u.email);
    if (weak) throw new BadRequestException(weak);
    const hash = await hashPassword(b.newPassword);
    const tv = await tx(async (c) => {
      const r = (await c.query('UPDATE users SET password_hash=$2, token_version=token_version+1 WHERE id=$1 RETURNING token_version', [uid, hash])).rows[0];
      await writeAudit(c, { userId: uid, action: 'change_password', entity: 'user', entityId: uid, ip });
      return Number(r.token_version);
    });
    forgetTokenVersion(Number(uid));
    return { ok: true, token: signToken(Number(uid), 'full', tv) };
  }

  @Post('verify-email')
  @HttpCode(200)
  async verifyEmail(@Body() body: unknown, @Ip() ip: string) {
    const b = parse(z.object({ token: z.string().min(10).max(200) }), body);
    limiter.hit(`verify:${ip}`);
    const row = await this.linkRow(b.token, 'verify');
    if (!row) throw new BadRequestException('This link has expired or was already used. Log in and ask for a new one.');
    await tx(async (c) => {
      await c.query('UPDATE users SET email_verified_at=COALESCE(email_verified_at, now()) WHERE id=$1', [row.user_id]);
      await c.query("UPDATE auth_tokens SET used_at=now() WHERE user_id=$1 AND purpose='verify' AND used_at IS NULL", [row.user_id]);
      await writeAudit(c, { userId: row.user_id, action: 'verify_email', entity: 'user', entityId: row.user_id, ip });
    });
    return { ok: true, email: row.email };
  }

  @Post('resend-verification')
  @UseGuards(AuthGuard)
  @HttpCode(200)
  async resend(@UserId() uid: number) {
    limiter.hit(`resend:${uid}`);
    const u = (await getPool().query('SELECT email,email_verified_at FROM users WHERE id=$1', [uid])).rows[0];
    if (u.email_verified_at) return { ok: true, alreadyVerified: true };
    await this.sendVerification(Number(uid), u.email);
    return { ok: true };
  }

  /** What an invitation link is for, so the screen can say who invited you to what. No login needed. */
  @Get('invitations/:token')
  async invitation(@Param('token') token: string, @Ip() ip: string) {
    limiter.hit(`invite:${ip}`);
    const inv = await tx((c) => findInvitation(c, token));
    if (!inv) throw new NotFoundException('This invitation has expired, was cancelled or was already used. Ask for a new one.');
    const exists = (await getPool().query('SELECT 1 FROM users WHERE email=$1', [inv.email])).rowCount;
    return { email: inv.email, firmName: inv.firm_name, orgName: inv.org_name, role: inv.role, roleText: ROLE_TEXT[inv.role], hasAccount: !!exists };
  }

  /** Accept an invitation while logged in with the invited address. */
  @Post('invitations/accept')
  @UseGuards(AuthGuard)
  @HttpCode(200)
  async accept(@UserId() uid: number, @Body() body: unknown, @Ip() ip: string) {
    const b = parse(z.object({ token: z.string().min(10).max(200) }), body);
    const email = (await getPool().query('SELECT email FROM users WHERE id=$1', [uid])).rows[0].email;
    return tx(async (c) => {
      const inv = await findInvitation(c, b.token);
      if (!inv) throw new NotFoundException('This invitation has expired, was cancelled or was already used. Ask for a new one.');
      await acceptInvitation(c, inv, Number(uid), email);
      await writeAudit(c, { orgId: inv.org_id, userId: uid, action: 'accept_invitation', entity: 'invitation', entityId: inv.id, ip });
      return { ok: true, firmName: inv.firm_name, orgId: inv.org_id };
    });
  }

  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Ip() ip: string) {
    const b = parse(loginSchema, body);
    limiter.hit(`login:${ip}:${b.email}`);
    const u = (await getPool().query('SELECT * FROM users WHERE email=$1', [b.email])).rows[0];
    const bad = new UnauthorizedException('Wrong email or password');
    if (!u) { await hashPassword(b.password); throw bad; } // keep timing similar
    if (u.locked_until && new Date(u.locked_until) > new Date()) throw new UnauthorizedException('Account temporarily locked. Try again later.');
    if (!(await verifyPassword(b.password, u.password_hash))) {
      const fails = u.failed_logins + 1;
      await getPool().query('UPDATE users SET failed_logins=$2, locked_until=$3 WHERE id=$1',
        [u.id, fails, fails >= 5 ? new Date(Date.now() + 15 * 60_000) : null]);
      throw bad;
    }
    await getPool().query('UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=$1', [u.id]);
    if (u.totp_enabled) return { twoFactorRequired: true, tempToken: signToken(Number(u.id), '2fa', Number(u.token_version)) };
    await tx((c) => writeAudit(c, { userId: u.id, action: 'login', entity: 'user', entityId: u.id, ip }));
    return { token: signToken(Number(u.id), 'full', Number(u.token_version)) };
  }

  /** Second login step: authenticator code or a one-time recovery code. */
  @Post('2fa/verify')
  @HttpCode(200)
  async verify2fa(@Body() body: unknown, @Ip() ip: string) {
    const b = parse(z.object({ tempToken: z.string(), code: z.string().min(6).max(20) }), body);
    let sub: number;
    try {
      const p = verifyToken(b.tempToken);
      if (p.stage !== '2fa') throw new Error();
      sub = p.sub;
    } catch { throw new UnauthorizedException('Login step expired'); }
    limiter.hit(`2fa:${sub}`);
    const u = (await getPool().query('SELECT * FROM users WHERE id=$1', [sub])).rows[0];
    let ok = verifyTotp(u.totp_secret, b.code);
    if (!ok && u.recovery_codes.includes(b.code)) {
      ok = true;
      await getPool().query('UPDATE users SET recovery_codes = array_remove(recovery_codes,$2) WHERE id=$1', [sub, b.code]);
    }
    if (!ok) throw new UnauthorizedException('Wrong code');
    await tx((c) => writeAudit(c, { userId: sub, action: 'login_2fa', entity: 'user', entityId: sub, ip }));
    return { token: signToken(sub, 'full', Number(u.token_version)) };
  }

  @Post('2fa/setup')
  @UseGuards(AuthGuard)
  @HttpCode(200)
  async setup(@UserId() uid: number) {
    const u = (await getPool().query('SELECT email,totp_enabled FROM users WHERE id=$1', [uid])).rows[0];
    if (u.totp_enabled) throw new ConflictException('2FA is already enabled');
    const secret = generateSecret();
    await getPool().query('UPDATE users SET totp_secret=$2 WHERE id=$1', [uid, secret]);
    return { secret, otpauthUrl: otpauthUrl(secret, u.email, APP_NAME) };
  }

  @Post('2fa/enable')
  @UseGuards(AuthGuard)
  @HttpCode(200)
  async enable(@UserId() uid: number, @Body() body: unknown, @Ip() ip: string) {
    const b = parse(z.object({ code: z.string().length(6) }), body);
    const u = (await getPool().query('SELECT totp_secret FROM users WHERE id=$1', [uid])).rows[0];
    if (!u.totp_secret) throw new BadRequestException('Call 2fa/setup first');
    if (!verifyTotp(u.totp_secret, b.code)) throw new UnauthorizedException('Wrong code');
    const recovery = Array.from({ length: 8 }, () => randomBytes(5).toString('hex'));
    await tx(async (c) => {
      await c.query('UPDATE users SET totp_enabled=true, recovery_codes=$2 WHERE id=$1', [uid, recovery]);
      await writeAudit(c, { userId: uid, action: 'enable_2fa', entity: 'user', entityId: uid, ip });
    });
    return { recoveryCodes: recovery };
  }

  @Get('me')
  @UseGuards(AuthGuard)
  async me(@UserId() uid: number) {
    const u = (await getPool().query('SELECT id,email,full_name,totp_enabled,email_verified_at FROM users WHERE id=$1', [uid])).rows[0];
    const m = (await getPool().query(
      `SELECT m.firm_id, f.name AS firm_name, m.org_id, m.role FROM memberships m JOIN firms f ON f.id=m.firm_id WHERE m.user_id=$1`, [uid])).rows;
    // The newest login is this session; the one before it is what the user wants to see ("last login").
    const prev = (await getPool().query(
      "SELECT created_at, ip FROM audit_log WHERE user_id=$1 AND action IN ('login','login_2fa') ORDER BY id DESC OFFSET 1 LIMIT 1", [uid])).rows[0];
    return { id: Number(u.id), email: u.email, fullName: u.full_name, twoFactorEnabled: u.totp_enabled, emailVerified: !!u.email_verified_at,
      lastLogin: prev ? { at: new Date(prev.created_at).toISOString(), ip: prev.ip } : null,
      memberships: m.map((r) => ({ firmId: Number(r.firm_id), firmName: r.firm_name, orgId: r.org_id ? Number(r.org_id) : null, role: r.role })) };
  }
}
