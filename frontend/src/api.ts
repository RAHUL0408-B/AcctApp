// Thin fetch wrapper. The token lives in sessionStorage so closing the tab logs you out.
export const getToken = () => sessionStorage.getItem('token');
export const setToken = (t: string | null) => (t ? sessionStorage.setItem('token', t) : sessionStorage.removeItem('token'));

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch('/api' + path, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
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
