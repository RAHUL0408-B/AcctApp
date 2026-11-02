import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppExceptionFilter, AppModule } from './app.module';
import { startWorker } from './firm/scheduler';
import { requestMiddleware } from './ops/metrics';

/** Refuse to start in production without the secrets that protect data. */
export function checkProductionConfig() {
  if (process.env.NODE_ENV !== 'production') return;
  const missing = ['DATABASE_URL', 'JWT_SECRET', 'BACKUP_KEY', 'WEB_ORIGIN'].filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  if ((process.env.JWT_SECRET ?? '').length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
}

export async function createApp() {
  checkProductionConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['error', 'warn'] });
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? true : Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
  app.useGlobalFilters(new AppExceptionFilter());
  app.useBodyParser('json', { limit: '15mb' }); // file uploads are base64 in JSON
  app.setGlobalPrefix('api');
  app.enableCors({ origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173' });
  app.use(requestMiddleware);
  app.use((_req: any, res: any, next: () => void) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    res.setHeader('Cache-Control', 'no-store');
    if (process.env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });
  return app;
}

if (require.main === module) {
  createApp().then(async (app) => {
    const port = Number(process.env.PORT ?? 3000);
    await app.listen(port);
    startWorker();
    console.log(`API listening on http://localhost:${port}/api`);
  }).catch((e) => { console.error(e.message); process.exit(1); });
}
