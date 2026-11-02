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
      <input {...p} className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-slate-900 shadow-sm outline-none placeholder:text-slate-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-200" />
    </label>
  );
}

export function Button({ variant = 'primary', ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' }) {
  const cls = { primary: 'bg-brand-600 text-white shadow-sm hover:bg-brand-700', ghost: 'border border-slate-300 bg-white text-slate-700 shadow-sm hover:bg-slate-50', danger: 'bg-red-600 text-white shadow-sm hover:bg-red-700' }[variant];
  return <button {...p} className={`rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50 ${cls} ${p.className ?? ''}`} />;
}

export function Card({ title, children, actions }: { title?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-[0_1px_2px_rgba(16,24,40,0.05)]">
      {(title || actions) && <div className="mb-4 flex items-center justify-between"><h2 className="text-base font-semibold text-slate-900">{title}</h2>{actions}</div>}
      {children}
    </section>
  );
}

export const ErrorMsg = ({ msg }: { msg: string }) => (msg ? <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">{msg}</p> : null);
export const Ok = ({ msg }: { msg: string }) => (msg ? <p className="rounded bg-green-50 px-3 py-2 text-sm text-green-800">{msg}</p> : null);

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
