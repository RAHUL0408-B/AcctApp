import { FormEvent, useState } from 'react';
import { api, setToken } from '../api';
import { APP_NAME, Button, ErrorMsg, Field, Logo, useAction } from '../ui';

/** The company behind the product. Only facts published on its website; add phone, email and address here when confirmed. */
export const PARENT = {
  name: 'FinTaxVers',
  url: 'https://fintaxvers.com',
  region: 'Nagpur & Pan-India',
  services: ['GST', 'Income Tax', 'Tax Audit', 'Internal Audit', 'Accounting', 'Business & MSME Loan', 'Subsidy', 'ROC & Company Registration'],
};

const FEATURES: [string, string][] = [
  ['Invoices and bills', 'GST worked out for you: CGST + SGST or IGST from the place of supply.'],
  ['Bank reconciliation', 'Import statements, match lines, and let rules handle the routine ones.'],
  ['GST and TDS', 'GSTR-1 and GSTR-3B summaries, TDS on bills, filing due dates as tasks.'],
  ['Reports', 'Profit and loss, balance sheet, cash flow and ageing, in PDF or Excel.'],
  ['Every client separate', 'One firm, many clients, each in its own locked-down set of books.'],
  ['Safe by design', 'Posted entries are never deleted, only reversed. Daily encrypted backups.'],
];

const STEPS: [string, string][] = [
  ['Create your firm account', 'Takes a minute. You get a 14-day trial.'],
  ['Add a client', 'Pick a chart of accounts: trading, services or manufacturing.'],
  ['Start working', 'Raise an invoice, enter a bill or import a bank statement.'],
];

export function AuthScreen({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [f, setF] = useState({ email: '', password: '', fullName: '', firmName: '' });
  const [accept, setAccept] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [temp, setTemp] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const { error, busy, run, setError } = useAction();
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const switchTo = (m: 'login' | 'register') => { setMode(m); setError(''); };

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
    <div className="flex min-h-screen flex-col bg-white">
      {/* Top bar */}
      <header className="border-b border-slate-200">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-2 text-xl font-bold text-slate-900"><Logo size={32} />{APP_NAME}</span>
            <span className="hidden text-sm text-slate-500 sm:inline">by <a href={PARENT.url} target="_blank" rel="noreferrer" className="font-medium text-brand-700 hover:underline">{PARENT.name}</a></span>
          </div>
          <p className="text-sm text-slate-600">
            {mode === 'login' ? <>New here? <button type="button" className="font-semibold text-brand-700 hover:underline" onClick={() => switchTo('register')}>Try it free</button></>
              : <>Have an account? <button type="button" className="font-semibold text-brand-700 hover:underline" onClick={() => switchTo('login')}>Log in</button></>}
          </p>
        </div>
      </header>

      <main className="flex-1">
        <div className="mx-auto grid max-w-7xl gap-10 px-6 py-10 lg:grid-cols-[minmax(0,26rem)_1fr] lg:py-14">
          {/* Form */}
          <section>
            <h1 className="text-3xl font-bold tracking-tight text-slate-900">{temp ? 'Two-step verification' : mode === 'login' ? 'Log in' : 'Create your firm account'}</h1>
            <p className="mt-2 text-slate-600">{temp ? 'One more step to keep your clients’ books safe.' : mode === 'login' ? 'Welcome back. Log in to see your clients’ books.' : 'Free for 14 days. No card needed.'}</p>
            <form onSubmit={submit} className="mt-6 space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
              {temp ? (
                <>
                  <p className="text-sm text-slate-600">Enter the 6-digit code from your authenticator app, or one of your recovery codes.</p>
                  <Field label="Code" value={code} onChange={(e) => setCode(e.target.value)} autoFocus autoComplete="one-time-code" inputMode="numeric" />
                </>
              ) : (
                <>
                  {mode === 'register' && <>
                    <Field label="Your name" value={f.fullName} onChange={set('fullName')} required autoComplete="name" />
                    <Field label="Firm name" value={f.firmName} onChange={set('firmName')} required autoComplete="organization" placeholder="e.g. Sharma & Associates" />
                  </>}
                  <Field label="Email" type="email" value={f.email} onChange={set('email')} required autoComplete="username" placeholder="you@yourfirm.com" />
                  <div>
                    <Field label="Password" type={showPw ? 'text' : 'password'} value={f.password} onChange={set('password')} required minLength={mode === 'register' ? 10 : 1} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
                    <label className="mt-1.5 flex items-center gap-2 text-xs text-slate-500"><input type="checkbox" checked={showPw} onChange={(e) => setShowPw(e.target.checked)} />Show what I typed</label>
                  </div>
                  {mode === 'register' && <>
                    <p className="text-xs text-slate-500">At least 10 characters, mixing letters with numbers or symbols.</p>
                    <label className="flex items-start gap-2 text-sm"><input type="checkbox" aria-label="Accept terms" checked={accept} onChange={(e) => setAccept(e.target.checked)} className="mt-1" />
                      <span>I agree to the Terms of Service and Privacy Policy, and consent to my data being processed to provide the service.</span></label>
                  </>}
                </>
              )}
              <ErrorMsg msg={error} />
              <Button className="w-full !py-2.5 text-base" disabled={busy}>{busy ? 'Please wait…' : temp ? 'Verify' : mode === 'login' ? 'Log in' : 'Create firm account'}</Button>
              {mode === 'login' && !temp && <p className="text-center text-xs text-slate-500">Forgot your password? Ask your firm&apos;s owner to re-invite you.</p>}
            </form>
            {!temp && (
              <p className="mt-4 text-sm text-slate-600">
                {mode === 'login' ? 'New firm? ' : 'Already registered? '}
                <button type="button" className="font-semibold text-brand-700 hover:underline" onClick={() => switchTo(mode === 'login' ? 'register' : 'login')}>{mode === 'login' ? 'Create an account' : 'Log in instead'}</button>
              </p>
            )}
            <ul className="mt-6 space-y-2 text-sm text-slate-600">
              {['Secure HTTPS connection and optional two-step login', 'Encrypted daily backups', 'Data stays private to your firm (DPDP consent built in)'].map((t) => (
                <li key={t} className="flex items-center gap-2"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="text-green-600"><path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>{t}</li>))}
            </ul>
          </section>

          {/* Introduction for first-time users */}
          <section className="space-y-6">
            <div className="rounded-2xl bg-gradient-to-br from-nav via-brand-900 to-brand-700 p-8 text-white">
              <p className="text-sm font-medium uppercase tracking-wider text-brand-200">Cloud accounting for India</p>
              <h2 className="mt-2 text-3xl font-semibold leading-tight">Books, GST and TDS for every client, in one place.</h2>
              <p className="mt-3 max-w-xl text-indigo-100">{APP_NAME} is built for CA firms, accountants and small businesses. Work on any client&apos;s books from anywhere, and let your clients see their own numbers.</p>
              <ol className="mt-6 grid gap-3 sm:grid-cols-3">
                {STEPS.map(([title, text], i) => (
                  <li key={title} className="rounded-xl bg-white/10 p-4">
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white text-sm font-bold text-brand-800">{i + 1}</span>
                    <p className="mt-2 font-semibold">{title}</p><p className="text-sm text-indigo-100">{text}</p>
                  </li>))}
              </ol>
            </div>

            <div>
              <h3 className="text-lg font-semibold text-slate-900">What you can do</h3>
              <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {FEATURES.map(([title, text]) => (
                  <div key={title} className="rounded-xl border border-slate-200 p-4">
                    <p className="font-semibold text-slate-900">{title}</p><p className="mt-1 text-sm text-slate-600">{text}</p>
                  </div>))}
              </div>
            </div>

            <div className="rounded-2xl border border-brand-100 bg-brand-50 p-6" aria-label={`About ${PARENT.name}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-lg font-semibold text-slate-900">A {PARENT.name} product</h3>
                <a href={PARENT.url} target="_blank" rel="noreferrer" className="text-sm font-medium text-brand-700 hover:underline">fintaxvers.com ↗</a>
              </div>
              <p className="mt-1 text-sm text-slate-700">{APP_NAME} comes from {PARENT.name}, tax and accounting professionals serving businesses in {PARENT.region}. Need help beyond the software? Our team offers:</p>
              <ul className="mt-3 flex flex-wrap gap-2">
                {PARENT.services.map((s) => <li key={s} className="rounded-full border border-brand-200 bg-white px-3 py-1 text-sm text-brand-800">{s}</li>)}
              </ul>
            </div>
          </section>
        </div>
      </main>

      <footer className="border-t border-slate-200 bg-slate-50">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2 px-6 py-4 text-xs text-slate-500">
          <span>© {new Date().getFullYear()} {PARENT.name}. {APP_NAME} is a {PARENT.name} product.</span>
          <span>{PARENT.region} · <a href={PARENT.url} target="_blank" rel="noreferrer" className="hover:underline">{PARENT.url.replace('https://', '')}</a></span>
        </div>
      </footer>
    </div>
  );
}
