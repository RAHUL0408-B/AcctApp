import { FormEvent, useEffect, useState } from 'react';
import { api, setToken } from '../api';
import { APP_NAME, Button, ErrorMsg, Field, Logo, useAction } from '../ui';
import { LandingFooter, LandingSections, PAGE_LINKS } from './Landing';

/** An illustration of the product: a dashboard with figures, a chart, an invoice list and two floating status cards. */
function HeroArt() {
  const bars = [38, 52, 44, 66, 58, 82, 74];
  return (
    <svg role="img" aria-label="Illustration of the dashboard: cash, receivables and profit figures, a monthly income chart and a list of GST invoices" viewBox="0 0 640 430" className="h-auto w-full drop-shadow-2xl">
      <defs>
        <linearGradient id="hero-line" x1="0" x2="1"><stop offset="0" stopColor="#8b7cf6" /><stop offset="1" stopColor="#34d399" /></linearGradient>
        <linearGradient id="hero-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#8b7cf6" stopOpacity=".35" /><stop offset="1" stopColor="#8b7cf6" stopOpacity="0" /></linearGradient>
      </defs>
      {/* window */}
      <rect x="20" y="20" width="600" height="390" rx="18" fill="#ffffff" />
      <rect x="20" y="20" width="600" height="40" rx="18" fill="#f1f0ff" />
      <rect x="20" y="42" width="600" height="18" fill="#f1f0ff" />
      <circle cx="44" cy="40" r="5" fill="#fb7185" /><circle cx="62" cy="40" r="5" fill="#fbbf24" /><circle cx="80" cy="40" r="5" fill="#34d399" />
      {/* menu pills */}
      {[['#64748b', 50], ['#059669', 62], ['#ea580c', 76], ['#7c3aed', 66], ['#0284c7', 78], ['#e11d48', 44]].map(([c, w], i, a) => (
        <rect key={i} x={40 + a.slice(0, i).reduce((s, x) => s + (x[1] as number) + 8, 0)} y="72" width={w as number} height="18" rx="6" fill={c as string} />))}
      {/* figures */}
      {[['Cash and bank', '₹4,82,300', '#4f46e5'], ['Owed to you', '₹1,26,500', '#059669'], ['You owe', '₹38,900', '#ea580c'], ['Profit FY', '₹2,14,750', '#7c3aed']].map(([l, v, c], i) => (
        <g key={l as string} transform={`translate(${40 + i * 145} 106)`}>
          <rect width="132" height="62" rx="10" fill="#f8fafc" stroke="#e2e8f0" />
          <rect width="4" height="62" rx="2" fill={c as string} />
          <text x="16" y="22" fontSize="10" fill="#64748b" fontFamily="Inter, system-ui, sans-serif">{l}</text>
          <text x="16" y="46" fontSize="17" fontWeight="700" fill="#0f172a" fontFamily="Inter, system-ui, sans-serif">{v}</text>
        </g>))}
      {/* chart */}
      <g transform="translate(40 184)">
        <rect width="330" height="200" rx="12" fill="#ffffff" stroke="#e2e8f0" />
        <text x="16" y="26" fontSize="11" fontWeight="600" fill="#0f172a" fontFamily="Inter, system-ui, sans-serif">Income and expenses</text>
        {bars.map((h, i) => (<g key={i}><rect x={24 + i * 43} y={176 - h * 1.6} width="14" height={h * 1.6} rx="3" fill="#6c5ce7" /><rect x={40 + i * 43} y={176 - h * 1.05} width="14" height={h * 1.05} rx="3" fill="#f472b6" /></g>))}
        <path d="M30 150 C 70 120, 100 135, 140 100 S 220 90, 250 62 S 300 50, 312 40" fill="none" stroke="url(#hero-line)" strokeWidth="3" strokeLinecap="round" />
        <path d="M30 150 C 70 120, 100 135, 140 100 S 220 90, 250 62 S 300 50, 312 40 L312 176 L30 176 Z" fill="url(#hero-fill)" />
      </g>
      {/* invoice list */}
      <g transform="translate(384 184)">
        <rect width="216" height="200" rx="12" fill="#ffffff" stroke="#e2e8f0" />
        <text x="14" y="26" fontSize="11" fontWeight="600" fill="#0f172a" fontFamily="Inter, system-ui, sans-serif">Latest invoices</text>
        {[['INV/26-27/0014', '₹11,800', 'CGST + SGST', '#059669'], ['INV/26-27/0013', '₹59,000', 'IGST', '#7c3aed'], ['INV/26-27/0012', '₹5,900', 'Paid', '#0284c7'], ['BILL/26-27/0007', '₹23,600', 'TDS 194J', '#ea580c']].map(([n, a, t, c], i) => (
          <g key={n as string} transform={`translate(14 ${44 + i * 36})`}>
            <rect width="188" height="30" rx="8" fill="#f8fafc" />
            <text x="10" y="13" fontSize="9" fontWeight="600" fill="#0f172a" fontFamily="Inter, system-ui, sans-serif">{n}</text>
            <text x="10" y="24" fontSize="8" fill="#64748b" fontFamily="Inter, system-ui, sans-serif">{a}</text>
            <rect x="116" y="8" width="64" height="14" rx="7" fill={c as string} opacity=".15" />
            <text x="148" y="18" fontSize="8" fontWeight="600" textAnchor="middle" fill={c as string} fontFamily="Inter, system-ui, sans-serif">{t}</text>
          </g>))}
      </g>
      {/* floating cards */}
      <g transform="translate(470 0)"><rect width="150" height="46" rx="12" fill="#ecfdf5" stroke="#6ee7b7" />
        <circle cx="24" cy="23" r="11" fill="#10b981" /><path d="M18 23.5l4 4 7-8" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
        <text x="42" y="20" fontSize="10" fontWeight="700" fill="#065f46" fontFamily="Inter, system-ui, sans-serif">GSTR-3B ready</text><text x="42" y="33" fontSize="8.5" fill="#047857" fontFamily="Inter, system-ui, sans-serif">Due on the 20th</text></g>
      <g transform="translate(0 380)"><rect width="168" height="46" rx="12" fill="#eff6ff" stroke="#93c5fd" />
        <circle cx="24" cy="23" r="11" fill="#3b82f6" /><path d="M18 23h12M26 18l5 5-5 5" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        <text x="42" y="20" fontSize="10" fontWeight="700" fill="#1e3a8a" fontFamily="Inter, system-ui, sans-serif">12 bank lines matched</text><text x="42" y="33" fontSize="8.5" fill="#1d4ed8" fontFamily="Inter, system-ui, sans-serif">To invoices and bills</text></g>
    </svg>
  );
}

/** Emailed links open the app with a one-time token in the address, for example #/reset?token=... */
const emailLink = (() => {
  const m = /^#\/(reset|invite)\?token=([0-9a-f]{20,200})$/.exec(typeof location === 'undefined' ? '' : location.hash);
  return m ? { kind: m[1] as 'reset' | 'invite', token: m[2] } : null;
})();
interface InviteInfo { email: string; firmName: string; orgName: string | null; role: string; roleText: string; hasAccount: boolean }

export function AuthScreen({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<'login' | 'register' | 'forgot' | 'reset' | 'invite'>(emailLink?.kind ?? 'login');
  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [inviteError, setInviteError] = useState('');
  const [note, setNote] = useState('');
  const [again, setAgain] = useState('');
  useEffect(() => {
    if (emailLink?.kind !== 'invite') return;
    api<InviteInfo>(`/auth/invitations/${emailLink.token}`).then((i) => { setInvite(i); setF((x) => ({ ...x, email: i.email })); }).catch((e) => setInviteError((e as Error).message));
  }, []);
  const [f, setF] = useState({ email: '', password: '', fullName: '', firmName: '' });
  const [accept, setAccept] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [temp, setTemp] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const { error, busy, run, setError } = useAction();
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const switchTo = (m: 'login' | 'register' | 'forgot') => { setMode(m); setError(''); setNote(''); };
  const leaveLink = () => { if (location.hash) history.replaceState(null, '', location.pathname); };
  // The page links scroll within the page. They are buttons, not #links, because the address bar's # is used for navigation inside the app.
  const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      if (mode === 'forgot') { const r = await api('/auth/forgot-password', { body: { email: f.email } }); setNote(r.message); return; }
      if (mode === 'reset') {
        if (f.password !== again) throw new Error('The two passwords are different');
        await api('/auth/reset-password', { body: { token: emailLink!.token, password: f.password } });
        leaveLink(); setF({ ...f, password: '' }); setAgain(''); setMode('login'); setNote('Your password has been changed. Log in with the new one.'); return;
      }
      // After a login, an invited person who already had an account is given the invited access.
      const finish = async (token: string) => {
        setToken(token);
        if (mode === 'invite' && invite?.hasAccount) await api('/auth/invitations/accept', { body: { token: emailLink!.token } });
        leaveLink(); onDone();
      };
      if (temp) {
        const r = await api('/auth/2fa/verify', { body: { tempToken: temp, code: code.trim() } });
        return finish(r.token);
      }
      const joining = mode === 'invite' && !invite?.hasAccount;
      const r = mode === 'login' || (mode === 'invite' && invite?.hasAccount)
        ? await api('/auth/login', { body: { email: f.email, password: f.password } })
        : await api('/auth/register', { body: joining ? { email: f.email, password: f.password, fullName: f.fullName, inviteToken: emailLink!.token, acceptTerms: accept } : { ...f, acceptTerms: accept } });
      if (r.twoFactorRequired) return setTemp(r.tempToken);
      await finish(r.token);
    });
  };

  return (
    <div className="flex min-h-screen flex-col bg-white">
      <header className="sticky top-0 z-20 border-b border-white/10 bg-nav text-white">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-6">
          <span className="flex items-center gap-2 text-xl font-bold"><Logo size={32} />{APP_NAME}</span>
          <nav aria-label="Page sections" className="hidden items-center gap-1 text-sm font-medium lg:flex">
            {PAGE_LINKS.map(([id, label]) => (
              <button key={id} type="button" onClick={() => scrollTo(id)} className="rounded-md px-3 py-2 text-indigo-100 hover:bg-white/10 hover:text-white">{label}</button>))}
          </nav>
          <p className="text-sm text-indigo-100">
            {mode === 'login' ? <>New here? <button type="button" className="font-semibold text-white underline-offset-2 hover:underline" onClick={() => switchTo('register')}>Try it free</button></>
              : mode === 'register' ? <>Have an account? <button type="button" className="font-semibold text-white underline-offset-2 hover:underline" onClick={() => switchTo('login')}>Log in</button></> : null}
          </p>
        </div>
      </header>

      <main className="flex-1">
        {/* Hero: the promise, a picture of the product, and the form */}
        <div className="relative overflow-hidden bg-gradient-to-br from-nav via-brand-900 to-brand-700 text-white">
          <div aria-hidden className="absolute -right-24 -top-24 h-96 w-96 rounded-full bg-brand-500/30 blur-3xl" />
          <div aria-hidden className="absolute -bottom-32 left-1/3 h-96 w-96 rounded-full bg-emerald-400/10 blur-3xl" />
          <div className="relative mx-auto grid max-w-7xl items-center gap-10 px-6 py-12 lg:grid-cols-[1fr_minmax(0,25rem)] lg:py-16">
            <div>
              <p className="inline-block rounded-full bg-white/10 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-brand-100">Cloud accounting for India</p>
              <h2 className="mt-4 text-4xl font-bold leading-tight tracking-tight sm:text-5xl">Books, GST and TDS for every client, in one place.</h2>
              <p className="mt-4 max-w-xl text-lg text-indigo-100">{APP_NAME} is built for CA firms, accountants and small businesses. Raise GST invoices, match your bank, file with confidence, and let your clients see their own numbers.</p>
              <ul className="mt-5 flex flex-wrap gap-2 text-sm">
                {['GST ready', 'TDS on bills', 'Bank matching', 'PDF and Excel reports', 'Many clients, one login'].map((t) => (
                  <li key={t} className="rounded-full border border-white/20 bg-white/10 px-3 py-1 text-indigo-50">{t}</li>))}
              </ul>
              <div className="mt-8 max-w-2xl"><HeroArt /></div>
            </div>

            <section aria-label="Log in or create an account" className="order-first lg:order-last">
              <h1 className="text-3xl font-bold tracking-tight">{temp ? 'Two-step verification' : mode === 'login' ? 'Log in' : mode === 'forgot' ? 'Reset your password' : mode === 'reset' ? 'Choose a new password' : mode === 'invite' ? (invite?.hasAccount ? 'Log in to accept' : 'Join your team') : 'Create your firm account'}</h1>
              <p className="mt-2 text-indigo-100">{temp ? 'One more step to keep your clients’ books safe.' : mode === 'login' ? 'Welcome back. Log in to see your clients’ books.' : mode === 'forgot' ? 'Enter your email and we will send you a link to choose a new password.' : mode === 'reset' ? 'Use at least 10 characters. Logging in again is needed afterwards on every device.' : mode === 'invite' ? (inviteError || (invite ? `You have been invited to ${invite.orgName ? `${invite.orgName} at ` : ''}${invite.firmName} as ${invite.roleText}.` : 'Checking your invitation…')) : 'Free for 14 days. No card needed.'}</p>
              <form onSubmit={submit} className="mt-6 space-y-4 rounded-2xl border border-white/20 bg-white p-6 text-slate-900 shadow-2xl">
                {note && <p role="status" className="rounded bg-green-50 px-3 py-2 text-sm text-green-800">{note}</p>}
                {mode === 'forgot' && !temp ? (
                  <Field label="Email" type="email" value={f.email} onChange={set('email')} required autoComplete="username" placeholder="you@yourfirm.com" />
                ) : mode === 'reset' && !temp ? (
                  <>
                    <Field label="New password" type={showPw ? 'text' : 'password'} value={f.password} onChange={set('password')} required minLength={10} autoComplete="new-password" />
                    <Field label="New password again" type={showPw ? 'text' : 'password'} value={again} onChange={(e) => setAgain(e.target.value)} required minLength={10} autoComplete="new-password" />
                    <label className="flex items-center gap-2 text-xs text-slate-500"><input type="checkbox" checked={showPw} onChange={(e) => setShowPw(e.target.checked)} />Show what I typed</label>
                  </>
                ) : temp ? (
                  <>
                    <p className="text-sm text-slate-600">Enter the 6-digit code from your authenticator app, or one of your recovery codes.</p>
                    <Field label="Code" value={code} onChange={(e) => setCode(e.target.value)} autoFocus autoComplete="one-time-code" inputMode="numeric" />
                  </>
                ) : (
                  <>
                    {(mode === 'register' || (mode === 'invite' && invite && !invite.hasAccount)) && <Field label="Your name" value={f.fullName} onChange={set('fullName')} required autoComplete="name" />}
                    {mode === 'register' && <Field label="Firm name" value={f.firmName} onChange={set('firmName')} required autoComplete="organization" placeholder="e.g. Sharma & Associates" />}
                    <Field label="Email" type="email" value={f.email} onChange={set('email')} required autoComplete="username" placeholder="you@yourfirm.com" readOnly={mode === 'invite'} />
                    <div>
                      <Field label="Password" type={showPw ? 'text' : 'password'} value={f.password} onChange={set('password')} required minLength={mode === 'register' || (mode === 'invite' && !invite?.hasAccount) ? 10 : 1} autoComplete={mode === 'register' || (mode === 'invite' && !invite?.hasAccount) ? 'new-password' : 'current-password'} />
                      <label className="mt-1.5 flex items-center gap-2 text-xs text-slate-500"><input type="checkbox" checked={showPw} onChange={(e) => setShowPw(e.target.checked)} />Show what I typed</label>
                    </div>
                    {(mode === 'register' || (mode === 'invite' && invite && !invite.hasAccount)) && <>
                      <p className="text-xs text-slate-500">At least 10 characters, mixing letters with numbers or symbols.</p>
                      <label className="flex items-start gap-2 text-sm"><input type="checkbox" aria-label="Accept terms" checked={accept} onChange={(e) => setAccept(e.target.checked)} className="mt-1" />
                        <span>I agree to the Terms of Service and Privacy Policy, and consent to my data being processed to provide the service.</span></label>
                    </>}
                  </>
                )}
                <ErrorMsg msg={error} />
                <Button className="w-full !py-2.5 text-base" disabled={busy || (mode === 'invite' && !invite)}>{busy ? 'Please wait…' : temp ? 'Verify' : mode === 'login' ? 'Log in' : mode === 'forgot' ? 'Send reset link' : mode === 'reset' ? 'Change password' : mode === 'invite' ? (invite?.hasAccount ? 'Log in and accept' : 'Create my login') : 'Create firm account'}</Button>
                {(mode === 'login' || (mode === 'invite' && invite?.hasAccount)) && !temp && <p className="text-center text-xs"><button type="button" className="font-medium text-brand-700 hover:underline" onClick={() => switchTo('forgot')}>Forgot your password?</button></p>}
              </form>
              {!temp && (mode === 'login' || mode === 'register') && (
                <p className="mt-4 text-sm text-indigo-100">
                  {mode === 'login' ? 'New firm? ' : 'Already registered? '}
                  <button type="button" className="font-semibold text-white underline-offset-2 hover:underline" onClick={() => switchTo(mode === 'login' ? 'register' : 'login')}>{mode === 'login' ? 'Create an account' : 'Log in instead'}</button>
                </p>
              )}
              {!temp && (mode === 'forgot' || mode === 'reset') && (
                <p className="mt-4 text-sm text-indigo-100"><button type="button" className="font-semibold text-white underline-offset-2 hover:underline" onClick={() => { leaveLink(); switchTo('login'); }}>Back to log in</button></p>
              )}
              <ul className="mt-5 space-y-2 text-sm text-indigo-100">
                {['Secure HTTPS connection and optional two-step login', 'Encrypted daily backups', 'Data stays private to your firm (DPDP consent built in)'].map((t) => (
                  <li key={t} className="flex items-center gap-2"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="shrink-0 text-emerald-300"><path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>{t}</li>))}
              </ul>
            </section>
          </div>
        </div>

        <LandingSections onStart={() => { switchTo('register'); window.scrollTo({ top: 0, behavior: 'smooth' }); }} />
      </main>

      <LandingFooter />
    </div>
  );
}
