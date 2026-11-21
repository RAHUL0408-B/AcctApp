import { ReactNode, useState } from 'react';

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
