import { FormEvent, useState } from 'react';
import { api, setToken } from '../api';
import { APP_NAME, Button, Card, ErrorMsg, Field, Logo, useAction } from '../ui';

export function AuthScreen({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [f, setF] = useState({ email: '', password: '', fullName: '', firmName: '' });
  const [accept, setAccept] = useState(false);
  const [temp, setTemp] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const { error, busy, run } = useAction();
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      if (temp) {
        const r = await api('/auth/2fa/verify', { body: { tempToken: temp, code: code.trim() } });
        setToken(r.token); return onDone();
      }
      const r = mode === 'login'
        ? await api('/auth/login', { body: { email: f.email, password: f.password } })
        : await api('/auth/register', { body: { ...f, acceptTerms: accept } });
      if (r.twoFactorRequired) return setTemp(r.tempToken);
      setToken(r.token); onDone();
    });
  };

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-1/2 max-w-xl flex-col justify-between bg-gradient-to-br from-nav via-brand-900 to-brand-700 p-12 text-white lg:flex">
        <div className="flex items-center gap-3 text-2xl font-bold"><Logo size={36} />{APP_NAME}</div>
        <div>
          <h2 className="text-4xl font-semibold leading-tight">Books, GST and TDS for every client, in one place.</h2>
          <ul className="mt-6 space-y-3 text-indigo-100">
            {['Invoices, bills, quotes and repeating invoices', 'GST returns and TDS worked out automatically', 'Bank reconciliation with rules', 'Every client kept separate, with a full audit trail'].map((t) => (
              <li key={t} className="flex items-start gap-2"><span className="mt-0.5 text-brand-200">✓</span>{t}</li>
            ))}
          </ul>
        </div>
        <p className="text-sm text-indigo-200">Built for Indian CA firms and small businesses.</p>
      </aside>
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-sm space-y-5">
          <div className="text-center lg:text-left">
            <h1 className="mb-2 flex items-center justify-center gap-2 text-2xl font-bold text-brand-700 lg:hidden"><Logo />{APP_NAME}</h1>
            <h2 className="text-2xl font-semibold text-slate-900">{mode === 'login' ? 'Log in to your account' : 'Create your firm account'}</h2>
            <p className="mt-1 text-sm text-slate-500">Cloud accounting for Indian CA firms and their clients</p>
          </div>
          <Card>
            <form onSubmit={submit} className="space-y-3">
              {temp ? (
                <>
                  <p className="text-sm">Enter the 6-digit code from your authenticator app, or a recovery code.</p>
                  <Field label="Code" value={code} onChange={(e) => setCode(e.target.value)} autoFocus autoComplete="one-time-code" />
                </>
              ) : (
                <>
                  {mode === 'register' && <>
                    <Field label="Your name" value={f.fullName} onChange={set('fullName')} required />
                    <Field label="Firm name" value={f.firmName} onChange={set('firmName')} required />
                  </>}
                  <Field label="Email" type="email" value={f.email} onChange={set('email')} required autoComplete="username" />
                  <Field label="Password" type="password" value={f.password} onChange={set('password')} required minLength={mode === 'register' ? 10 : 1} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
                  {mode === 'register' && <>
                    <p className="text-xs text-slate-500">At least 10 characters, mixing letters with numbers or symbols.</p>
                    <label className="flex items-start gap-2 text-sm"><input type="checkbox" aria-label="Accept terms" checked={accept} onChange={(e) => setAccept(e.target.checked)} className="mt-1" />
                      <span>I agree to the Terms of Service and Privacy Policy, and consent to my data being processed to provide the service.</span></label>
                  </>}
                </>
              )}
              <ErrorMsg msg={error} />
              <Button className="w-full" disabled={busy}>{temp ? 'Verify' : mode === 'login' ? 'Log in' : 'Create firm account'}</Button>
            </form>
          </Card>
          {!temp && (
            <p className="text-center text-sm lg:text-left">
              {mode === 'login' ? 'New firm? ' : 'Already registered? '}
              <button className="font-medium text-brand-700 underline" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>{mode === 'login' ? 'Create an account' : 'Log in'}</button>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
