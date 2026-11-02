// Tiny in-process metrics, JSON logs and a webhook alert for bursts of server errors.
import { randomUUID } from 'crypto';
import { RateLimiter } from '../common/ratelimit';

export const metrics = { startedAt: Date.now(), requests: 0, byStatus: {} as Record<string, number>, latencyMsTotal: 0, errors5xx: 0, workerLastTick: null as string | null, workerLastError: null as string | null };
const recent5xx: number[] = [];
let lastAlert = 0;
const globalLimiter = new RateLimiter(Number(process.env.RATE_LIMIT_PER_MIN ?? 600), 60_000);

export const log = (level: 'info' | 'warn' | 'error', msg: string, extra: object = {}) =>
  (level === 'error' ? console.error : console.log)(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));

export async function maybeAlert(now = Date.now()) {
  recent5xx.push(now);
  while (recent5xx.length && now - recent5xx[0] > 60_000) recent5xx.shift();
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url || recent5xx.length < 5 || now - lastAlert < 10 * 60_000) return false;
  lastAlert = now;
  try {
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: `AcctApp alert: ${recent5xx.length} server errors in the last minute` }) });
  } catch (e) { log('error', 'alert webhook failed', { error: (e as Error).message }); }
  return true;
}

/** Express middleware: request id, per-IP rate limit, access log, counters. */
export function requestMiddleware(req: any, res: any, next: () => void) {
  const id = req.headers['x-request-id']?.toString().slice(0, 64) || randomUUID();
  req.id = id; res.setHeader('X-Request-Id', id);
  try { globalLimiter.hit(req.ip ?? 'unknown'); } catch { return res.status(429).json({ message: 'Too many requests' }); }
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    metrics.requests++; metrics.latencyMsTotal += ms; metrics.byStatus[res.statusCode] = (metrics.byStatus[res.statusCode] ?? 0) + 1;
    if (res.statusCode >= 500) { metrics.errors5xx++; void maybeAlert(); }
    if (process.env.LOG_REQUESTS !== 'off') log(res.statusCode >= 500 ? 'error' : 'info', 'request', { id, method: req.method, path: String(req.originalUrl).split('?')[0], status: res.statusCode, ms });
  });
  next();
}

export function resetGlobalLimiter() { globalLimiter.reset(); }
