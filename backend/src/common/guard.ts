import { BadRequestException, CanActivate, ExecutionContext, Injectable, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import { ZodType, ZodTypeDef } from 'zod';
import { verifyToken } from '../security/jwt';

/** Requires a valid full-login bearer token; puts the user id on req.userId. */
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const h: string | undefined = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) throw new UnauthorizedException('Missing token');
    try {
      const p = verifyToken(h.slice(7));
      if (p.stage !== 'full') throw new Error('partial');
      req.userId = p.sub;
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
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
