// Shared helpers for API tests: boots an embedded PostgreSQL and the Nest app.
import request from 'supertest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { INestApplication } from '@nestjs/common';
import { startDevDb } from './devdb';
import { closePool, getPool } from '../src/db/db';
import { migrate } from '../src/db/migrate';

export const pw = 'S3cure-passphrase!';
export const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** Build a GSTIN with the correct check character from its first 14 characters. */
export function mkGstin(first14: string): string {
  let s = 0;
  for (let i = 0; i < 14; i++) { const v = CHARS.indexOf(first14[i]) * (i % 2 ? 2 : 1); s += Math.floor(v / 36) + (v % 36); }
  return first14 + CHARS[(36 - (s % 36)) % 36];
}

export async function boot(port: number) {
  const dir = mkdtempSync(join(tmpdir(), 'acctapp-pg-'));
  const db = await startDevDb(dir, port);
  process.env.DATABASE_URL = db.url;
  await migrate(getPool());
  const { createApp } = await import('../src/main');
  const app: INestApplication = await createApp();
  await app.init();
  const http = () => request(app.getHttpServer());
  const stop = async () => { await app.close(); await closePool(); await db.stop(); rmSync(dir, { recursive: true, force: true }); };

  const register = async (email: string, firmName = 'Firm ' + email) => {
    const r = await http().post('/api/auth/register').send({ email, password: pw, fullName: 'T ' + email, firmName, acceptTerms: true }).expect(201);
    return { token: r.body.token as string, firmId: r.body.firmId as number, userId: r.body.userId as number };
  };
  const newOrg = async (t: string, firmId: number, name: string, extra: object = {}) =>
    (await http().post('/api/orgs').set(auth(t)).send({ firmId, name, template: 'trading', ...extra }).expect(201)).body.id as number;
  const accounts = async (t: string, orgId: number) => {
    const a = (await http().get(`/api/orgs/${orgId}/accounts`).set(auth(t)).expect(200)).body as { id: number; code: string }[];
    return (code: string) => a.find((x) => x.code === code)!.id;
  };
  return { app, http, stop, register, newOrg, accounts };
}
