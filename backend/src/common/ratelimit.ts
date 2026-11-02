import { HttpException, HttpStatus } from '@nestjs/common';

/** Simple in-memory sliding-window limiter. Use Redis instead if you run more than one API instance. */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private max: number, private windowMs: number) {}

  hit(key: string, now = Date.now()) {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) throw new HttpException('Too many attempts. Please wait a minute.', HttpStatus.TOO_MANY_REQUESTS);
    recent.push(now);
    this.hits.set(key, recent);
  }

  reset() { this.hits.clear(); }
}
