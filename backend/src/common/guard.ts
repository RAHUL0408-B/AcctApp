import { BadRequestException, CanActivate, ExecutionContext, Injectable, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import { ZodType, ZodTypeDef } from 'zod';
import { verifyToken } from '../security/jwt';
import { getPool } from '../db/db';

// The current token version per user, cached briefly so most requests skip the lookup. A password change in this
// process clears the entry at once; another API instance notices within the cache time.
const versions = new Map<number, { v: number; at: number }>();
const CACHE_MS = 5_000;
export const forgetTokenVersion = (uid: number) => { versions.delete(uid); };
async function tokenVersion(uid: number): Promise<number> {
  const hit = versions.get(uid);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.v;
  const row = (await getPool().query('SELECT token_version FROM users WHERE id=$1', [uid])).rows[0];
  const v = row ? Number(row.token_version) : -1; // a deleted user matches no token
  versions.set(uid, { v, at: Date.now() });
  return v;
}

/** Requires a valid full-login bearer token issued since the last password change; puts the user id on req.userId. */
@Injectable()
export class AuthGuard implements CanActivate {
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const h: string | undefined = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) throw new UnauthorizedException('Missing token');
    let p;
    try {
      p = verifyToken(h.slice(7));
      if (p.stage !== 'full') throw new Error('partial');
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    if ((p.tv ?? 0) !== (await tokenVersion(Number(p.sub)))) throw new UnauthorizedException('Your password was changed. Log in again.');
    req.userId = p.sub;
    return true;
  }
}

export const UserId = createParamDecorator((_d, ctx: ExecutionContext) => ctx.switchToHttp().getRequest().userId as number);
export const Ip = createParamDecorator((_d, ctx: ExecutionContext) => ctx.switchToHttp().getRequest().ip as string);

/** Validate a request body with zod and return typed data. */
export function parse<T>(schema: ZodType<T, ZodTypeDef, any>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new BadRequestException(r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return r.data;
}
