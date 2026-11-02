import { randomBytes, scrypt as _scrypt, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
const scrypt = promisify(_scrypt) as (p: string, s: Buffer, n: number) => Promise<Buffer>;

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [, saltHex, keyHex] = stored.split('$');
  const key = await scrypt(pw, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(keyHex, 'hex');
  return key.length === expected.length && timingSafeEqual(key, expected);
}

const COMMON = ['password', 'passw0rd', '1234567890', '123456789012', 'qwertyuiop', 'iloveyou', 'welcome123', 'admin12345', 'letmein123', 'abcdefghij', 'changeme123'];

/** Returns a message if the password is too weak, otherwise null. (Length is checked by the caller's schema.) */
export function weakPassword(pw: string, email: string): string | null {
  const lower = pw.toLowerCase();
  if (COMMON.some((c) => lower.includes(c))) return 'That password is too common. Choose something less guessable.';
  const local = email.split('@')[0].toLowerCase();
  if (local.length >= 4 && lower.includes(local)) return 'Password must not contain your email name.';
  if (new Set(pw).size < 5) return 'Password needs more variety.';
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  if (classes < 2) return 'Mix at least two kinds of characters (letters, numbers, symbols).';
  return null;
}
