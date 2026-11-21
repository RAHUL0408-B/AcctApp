// Thin fetch wrapper. The token lives in sessionStorage so closing the tab logs you out.
export const getToken = () => sessionStorage.getItem('token');
export const setToken = (t: string | null) => (t ? sessionStorage.setItem('token', t) : sessionStorage.removeItem('token'));

// 502/503/504 come from the host, not the API: on free hosting the server sleeps when idle and takes up to a minute to wake.
const WAKING = new Set([502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The host puts the server to sleep after about 15 idle minutes. lastOk is when it last answered.
let lastOk = 0;
let waking: Promise<void> | null = null;
/** Ask the server whether it is up. The answer is read to the end, so the browser does not keep the connection open. */
const ping = async () => { const r = await fetch('/api/health'); await r.text().catch(() => ''); return r.ok; };
/** Resolve once /health answers, polling for up to about 3 minutes (a cold start has been seen to take 2.5). Shared, so many callers make one wake-up. */
export function wakeServer(): Promise<void> {
  if (Date.now() - lastOk < 60_000) return Promise.resolve();
  return (waking ??= (async () => {
    for (let i = 0; i < 60; i++) {
      try { if (await ping()) { lastOk = Date.now(); return; } } catch { /* network blip: try again */ }
      await sleep(3000);
    }
  })().finally(() => { waking = null; }));
}
// Start waking the server as soon as the page opens, and keep it awake while the tab is open.
if (typeof window !== 'undefined') {
  wakeServer();
  setInterval(() => { if (document.visibilityState === 'visible') ping().then((ok) => { if (ok) lastOk = Date.now(); }, () => {}); }, 10 * 60_000);
}

/** The server said the login is no longer valid (expired after 8 hours, or the password was changed). */
export class SessionEnded extends Error {}
const SESSION_MESSAGES = new Set(['Missing token', 'Invalid or expired token', 'Your password was changed. Log in again.']);
/** The server could not be reached or is still starting: not a reason to log anyone out. */
export class ServerBusy extends Error {}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = opts.method ?? (opts.body ? 'POST' : 'GET');
  // A save is never retried, so make sure the server is awake before sending it.
  if (method !== 'GET' && Date.now() - lastOk > 5 * 60_000) await wakeServer();
  let res!: Response;
  const sent = getToken();
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch('/api' + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(sent ? { Authorization: `Bearer ${sent}` } : {}) },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
    } catch {
      // No answer at all (offline, or the connection dropped). A read is safe to try again.
      if (method === 'GET' && attempt < 4) { await sleep(2000 * (attempt + 1)); continue; }
      throw new ServerBusy('Could not reach the server. Check your internet connection and try again.');
    }
    // Only reads are retried: a save may already have reached the server, and repeating it could post it twice.
    if (!WAKING.has(res.status) || method !== 'GET' || attempt >= 4) break;
    await sleep(5000 * (attempt + 1));
  }
  if (!WAKING.has(res.status)) lastOk = Date.now();
  const data = await res.json().catch(() => ({}));
  if (WAKING.has(res.status)) throw new ServerBusy('The server is still starting up. This can take up to 3 minutes after a quiet spell. Check whether your change appears, then try again shortly.');
  if (res.status === 401 && sent && SESSION_MESSAGES.has(data.message)) {
    // Tell the app once, so it shows the login page with a reason instead of an error on every screen.
    if (getToken() === sent) { setToken(null); window.dispatchEvent(new CustomEvent('session-ended', { detail: data.message })); }
    throw new SessionEnded(data.message === 'Your password was changed. Log in again.' ? data.message : 'You were logged out because the session ended. Log in again.');
  }
  if (res.status === 429) throw new ServerBusy(data.message ?? 'Too many requests. Wait a minute and try again.');
  if (!res.ok) throw new Error(Array.isArray(data.message) ? data.message.join('; ') : data.message ?? `Error ${res.status}`);
  return data;
}

/** Paise (integer) -> "1,23,456.78" */
export function fmt(paise: number): string {
  const neg = paise < 0, abs = Math.abs(paise);
  const r = Math.floor(abs / 100).toString(), f = String(abs % 100).padStart(2, '0');
  const rest = r.slice(0, -3);
  return `${neg ? '-' : ''}${rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' : ''}${r.slice(-3)}.${f}`;
}

/** "1234.50" -> 123450 paise without floating point maths */
export function toPaise(s: string): number {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s.replace(/,/g, '').trim());
  if (!m) throw new Error(`Invalid amount "${s}"`);
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
}

/** Download a file from an authenticated endpoint (PDF, Excel, uploaded document). */
export async function download(path: string, filename: string) {
  const res = await fetch('/api' + path, { headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {} });
  if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.message ?? `Error ${res.status}`); }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** POST something and save the file that comes back (exports of on-screen tables). */
export async function postDownload(path: string, body: unknown, filename: string) {
  const res = await fetch('/api' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}) }, body: JSON.stringify(body) });
  if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(Array.isArray(d.message) ? d.message.join('; ') : d.message ?? `Error ${res.status}`); }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** POST something and get back a PDF as an object URL, to show in a frame (used to preview a template design). */
export async function previewPdf(path: string, body: unknown): Promise<string> {
  const res = await fetch('/api' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}) }, body: JSON.stringify(body) });
  if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(Array.isArray(d.message) ? d.message.join('; ') : d.message ?? `Error ${res.status}`); }
  return URL.createObjectURL(await res.blob());
}

export const today = () => new Date().toISOString().slice(0, 10);

/** Read a File as base64 (without the data: prefix). */
export function fileToBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(new Error('Could not read the file'));
    r.readAsDataURL(f);
  });
}
