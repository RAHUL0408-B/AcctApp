import jwt from 'jsonwebtoken';

const secret = () => {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (process.env.NODE_ENV === 'production') throw new Error('JWT_SECRET is required in production');
  return 'dev-only-secret-change-me';
};

export interface TokenPayload { sub: number; stage: 'full' | '2fa'; }

export const signToken = (sub: number, stage: TokenPayload['stage']) =>
  jwt.sign({ sub, stage }, secret(), { expiresIn: stage === 'full' ? '8h' : '5m' });

export const verifyToken = (t: string): TokenPayload => jwt.verify(t, secret()) as unknown as TokenPayload;
