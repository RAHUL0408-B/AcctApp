import { ReactNode, useEffect, useState } from 'react';

export const APP_NAME = 'AcctApp';

/** Original logo mark: a rounded square holding a rising ledger line. */
export const Logo = ({ size = 28 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden><rect width="32" height="32" rx="8" fill="#6c5ce7" /><path d="M9 21.5 14 11l4 7 5-9" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /><circle cx="23" cy="9" r="2" fill="#fff" /></svg>
);

export function Field({ label, ...p }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium text-slate-600">{label}</span>
      <input {...p} className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-slate-900 shadow-sm outline-none placeholder:text-slate-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-200 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400" />
    </label>
  );
}

export function Button({ variant = 'primary', ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' }) {
  const cls = { primary: 'bg-brand-600 text-white shadow-sm hover:bg-brand-700', ghost: 'border border-slate-300 bg-white text-slate-700 shadow-sm hover:bg-slate-50', danger: 'bg-red-600 text-white shadow-sm hover:bg-red-700' }[variant];
  return <button {...p} className={`rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50 ${cls} ${p.className ?? ''}`} />;
}

export function Card({ title, children, actions }: { title?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="min-w-0 rounded-xl border border-slate-200 bg-white p-5 shadow-[0_1px_2px_rgba(16,24,40,0.05)]">
      {(title || actions) && <div className="mb-4 flex flex-wrap items-center justify-between gap-2"><h2 className="text-base font-semibold text-slate-900">{title}</h2>{actions}</div>}
      {/* A wide table scrolls sideways inside its card instead of making the whole page wider than the screen.
          The small negative margin and padding leave room for focus outlines at the edges. */}
      <div className="relative -m-1 overflow-x-auto p-1">{children}</div>
    </section>
  );
}

type Tone = 'error' | 'warning' | 'success' | 'info';
const TONE: Record<Tone, { box: string; icon: string; title: string; path: string }> = {
  error: { box: 'border-red-200 bg-red-50 text-red-800', icon: 'text-red-600', title: 'text-red-900', path: 'M12 8v5m0 3h.01M10.3 3.9 2.4 17.6A2 2 0 0 0 4.1 20.6h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z' },
  warning: { box: 'border-amber-200 bg-amber-50 text-amber-900', icon: 'text-amber-600', title: 'text-amber-950', path: 'M12 8v5m0 3h.01M10.3 3.9 2.4 17.6A2 2 0 0 0 4.1 20.6h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z' },
  success: { box: 'border-emerald-200 bg-emerald-50 text-emerald-900', icon: 'text-emerald-600', title: 'text-emerald-950', path: 'M20 6 9 17l-5-5' },
  info: { box: 'border-sky-200 bg-sky-50 text-sky-900', icon: 'text-sky-600', title: 'text-sky-950', path: 'M12 16v-5m0-3h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z' },
};
/** A message box with an icon, a coloured edge and an optional heading: errors, warnings, confirmations and tips all look alike. */
export function Callout({ tone = 'info', title, children, role, onClose, testId }: { tone?: Tone; title?: string; children?: ReactNode; role?: 'alert' | 'status'; onClose?: () => void; testId?: string }) {
  const t = TONE[tone];
  return (
    <div role={role ?? (tone === 'error' ? 'alert' : 'status')} data-testid={testId}
      className={`flex items-start gap-3 rounded-lg border border-l-4 px-4 py-3 text-sm shadow-sm ${t.box}`}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={`mt-0.5 shrink-0 ${t.icon}`}><path d={t.path} /></svg>
      <div className="min-w-0 flex-1">{title && <p className={`font-semibold ${t.title}`}>{title}</p>}{children && <div className={title ? 'mt-0.5' : ''}>{children}</div>}</div>
      {onClose && <button type="button" aria-label="Dismiss" onClick={onClose} className="-mr-1 rounded p-1 opacity-60 hover:opacity-100">✕</button>}
    </div>
  );
}
export const ErrorMsg = ({ msg }: { msg: string }) => (msg ? <Callout tone="error">{msg}</Callout> : null);
export const Ok = ({ msg }: { msg: string }) => (msg ? <Callout tone="success" role="status">{msg}</Callout> : null);

/** Run an async action, tracking busy + error state. */
export function useAction() {
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setError(''); setBusy(true);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return { error, busy, run, setError };
}

/** Shows a friendly message instead of a blank page if a screen crashes. */
import { Component } from 'react';
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: Error) { return { error: e.message }; }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-800">
        Something went wrong on this screen ({this.state.error}). <button className="underline" onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    );
  }
}

// ------------------------------------------------------------------ in-app confirmation box (instead of the browser's)
export interface AskOptions {
  title?: string; message?: ReactNode; confirmLabel?: string; cancelLabel?: string;
  tone?: 'danger' | 'warning' | 'info';
  /** Ask for a line of text as well (instead of the browser's prompt box). */
  input?: { label: string; placeholder?: string; value?: string };
}
type Pending = AskOptions & { resolve: (v: string | null) => void };
let showAsk: ((p: Pending) => void) | null = null;
const open = (o: AskOptions) => new Promise<string | null>((resolve) => {
  if (showAsk) showAsk({ ...o, resolve });
  else resolve(o.input ? window.prompt(String(o.title ?? ''), o.input.value ?? '') : window.confirm(String(o.message ?? o.title ?? '')) ? '' : null);
});
/** Ask the person to confirm: a themed box with a title, the message and two buttons. Resolves true when they confirm. */
export async function ask(o: AskOptions | string): Promise<boolean> {
  const opts = typeof o === 'string' ? { message: o } : o;
  return (await open(opts)) !== null;
}
/** Ask for a line of text (for example a name). Resolves null when cancelled. */
export async function askText(title: string, input: AskOptions['input'] & {}, message?: ReactNode): Promise<string | null> {
  return open({ title, message, input, confirmLabel: 'Save', tone: 'info' });
}
const ASK_ICON = {
  danger: { ring: 'bg-red-100 text-red-600', path: 'M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14M10 11v6m4-6v6', btn: 'bg-red-600 hover:bg-red-700' },
  warning: { ring: 'bg-amber-100 text-amber-600', path: 'M12 8v5m0 3h.01M10.3 3.9 2.4 17.6A2 2 0 0 0 4.1 20.6h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z', btn: 'bg-brand-600 hover:bg-brand-700' },
  info: { ring: 'bg-brand-100 text-brand-700', path: 'M12 16v-5m0-3h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z', btn: 'bg-brand-600 hover:bg-brand-700' },
};
/** Mounted once at the top of the app; draws whatever ask() / askText() is waiting for. */
export function ConfirmHost() {
  const [p, setP] = useState<Pending | null>(null);
  const [text, setText] = useState('');
  useEffect(() => { showAsk = (x) => { setText(x.input?.value ?? ''); setP(x); }; return () => { showAsk = null; }; }, []);
  useEffect(() => {
    if (!p) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); done(null); } };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }); // eslint-disable-line react-hooks/exhaustive-deps
  if (!p) return null;
  const done = (v: string | null) => { p.resolve(v); setP(null); };
  const tone = ASK_ICON[p.tone ?? (/delete|remove|undo|void|unlink|reverse/i.test(`${p.title ?? ''} ${typeof p.message === 'string' ? p.message : ''}`) ? 'danger' : 'warning')];
  const title = p.title ?? (typeof p.message === 'string' ? p.message.split(/[?.]/)[0] + (p.message.includes('?') ? '?' : '') : 'Are you sure?');
  const body = p.title ? p.message : typeof p.message === 'string' ? p.message.slice(title.length).trim() : p.message;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-[1px]" onMouseDown={(e) => { if (e.target === e.currentTarget) done(null); }}>
      <form role="alertdialog" aria-modal="true" aria-labelledby="ask-title" data-confirm className="w-full max-w-md rounded-xl border border-brand-100 bg-white p-5 shadow-2xl"
        onSubmit={(e) => { e.preventDefault(); if (p.input && !text.trim()) return; done(p.input ? text.trim() : ''); }}>
        <div className="flex items-start gap-3">
          <span className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${tone.ring}`}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={tone.path} /></svg></span>
          <div className="min-w-0 flex-1">
            <h2 id="ask-title" className="text-base font-semibold text-slate-900">{title}</h2>
            {body && <div data-confirm-message className="mt-1 whitespace-pre-line text-sm text-slate-600">{body}</div>}
            {p.input && <label className="mt-3 block text-sm"><span className="mb-1 block font-medium text-slate-600">{p.input.label}</span>
              <input autoFocus aria-label={p.input.label} placeholder={p.input.placeholder} value={text} onChange={(e) => setText(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200" /></label>}
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" data-confirm-cancel onClick={() => done(null)} className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">{p.cancelLabel ?? 'Cancel'}</button>
          <button type="submit" data-confirm-accept autoFocus={!p.input} className={`rounded-md px-4 py-2 text-sm font-medium text-white ${tone.btn}`}>{p.confirmLabel ?? 'Confirm'}</button>
        </div>
      </form>
    </div>
  );
}
