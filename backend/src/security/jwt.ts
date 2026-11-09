import jwt from 'jsonwebtoken';

const secret = () => {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (process.env.NODE_ENV === 'production') throw new Error('JWT_SECRET is required in production');
  return 'dev-only-secret-change-me';
};

/** tv is the user's token version when the token was issued. Changing the password raises it, which ends older sessions. */
export interface TokenPayload { sub: number; stage: 'full' | '2fa'; tv?: number }

export const signToken = (sub: number, stage: TokenPayload['stage'], tv = 0) =>
  jwt.sign({ sub, stage, tv }, secret(), { expiresIn: stage === 'full' ? '8h' : '5m' });

export const verifyToken = (t: string): TokenPayload => jwt.verify(t, secret()) as unknown as TokenPayload;
