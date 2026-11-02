import { Body, Controller, Get, HttpCode, Post, UnauthorizedException, UseGuards, ConflictException, BadRequestException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { getPool, tx } from '../db/db';
import { writeAudit } from '../audit/audit';
import { AuthGuard, UserId, Ip, parse } from '../common/guard';
import { hashPassword, verifyPassword, weakPassword } from '../security/password';
import { signToken, verifyToken } from '../security/jwt';
import { generateSecret, otpauthUrl, verifyTotp } from '../security/totp';
import { RateLimiter } from '../common/ratelimit';

const APP_NAME = process.env.APP_NAME ?? 'AcctApp';
const limiter = new RateLimiter(10, 60_000); // 10 attempts per minute per key

const registerSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(10, 'Use at least 10 characters').max(200),
  fullName: z.string().min(1).max(120),
  firmName: z.string().min(1).max(160),
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
    return tx(async (c) => {
      const dup = await c.query('SELECT 1 FROM users WHERE email=$1', [b.email]);
      if (dup.rowCount) throw new ConflictException('Email already registered');
      const firm = (await c.query('INSERT INTO firms(name) VALUES ($1) RETURNING id', [b.firmName])).rows[0];
      const user = (await c.query('INSERT INTO users(email,password_hash,full_name) VALUES ($1,$2,$3) RETURNING id', [b.email, hash, b.fullName])).rows[0];
      await c.query("INSERT INTO memberships(user_id,firm_id,org_id,role) VALUES ($1,$2,NULL,'owner')", [user.id, firm.id]);
      for (const purpose of ['terms', 'privacy']) await c.query('INSERT INTO consents(user_id,purpose,version,granted,ip) VALUES ($1,$2,$3,true,$4)', [user.id, purpose, '2025-01', ip]);
      // 14-day free trial of the Practice plan; afterwards the Free plan limits apply until a plan is bought
      await c.query("INSERT INTO subscriptions(firm_id,plan_code,status,trial_ends) VALUES ($1,'practice','trialing',CURRENT_DATE + 14)", [firm.id]);
      await writeAudit(c, { userId: user.id, action: 'register', entity: 'user', entityId: user.id, ip });
      return { token: signToken(user.id, 'full'), userId: Number(user.id), firmId: Number(firm.id) };
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
    if (u.totp_enabled) return { twoFactorRequired: true, tempToken: signToken(Number(u.id), '2fa') };
    await tx((c) => writeAudit(c, { userId: u.id, action: 'login', entity: 'user', entityId: u.id, ip }));
    return { token: signToken(Number(u.id), 'full') };
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
    return { token: signToken(sub, 'full') };
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
    const u = (await getPool().query('SELECT id,email,full_name,totp_enabled FROM users WHERE id=$1', [uid])).rows[0];
    const m = (await getPool().query(
      `SELECT m.firm_id, f.name AS firm_name, m.org_id, m.role FROM memberships m JOIN firms f ON f.id=m.firm_id WHERE m.user_id=$1`, [uid])).rows;
    // The newest login is this session; the one before it is what the user wants to see ("last login").
    const prev = (await getPool().query(
      "SELECT created_at, ip FROM audit_log WHERE user_id=$1 AND action IN ('login','login_2fa') ORDER BY id DESC OFFSET 1 LIMIT 1", [uid])).rows[0];
    return { id: Number(u.id), email: u.email, fullName: u.full_name, twoFactorEnabled: u.totp_enabled,
      lastLogin: prev ? { at: new Date(prev.created_at).toISOString(), ip: prev.ip } : null,
      memberships: m.map((r) => ({ firmId: Number(r.firm_id), firmName: r.firm_name, orgId: r.org_id ? Number(r.org_id) : null, role: r.role })) };
  }
}
