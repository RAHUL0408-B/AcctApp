import { FormEvent, ReactNode, useState } from 'react';
import { api, setToken } from '../api';
import { APP_NAME, Button, ErrorMsg, Field, Logo, useAction } from '../ui';

/** Each tile: a short heading, one line of what it does, and the colour of its icon badge. */
const FEATURES: { title: string; text: string; tone: string; icon: string }[] = [
  { title: 'Invoices and bills', text: 'CGST + SGST or IGST worked out from the place of supply. Edit, attach files and email a PDF.', tone: 'bg-emerald-100 text-emerald-700', icon: 'M7 3h8l4 4v14H7zM15 3v4h4M10 12h6M10 16h6' },
  { title: 'Bank reconciliation', text: 'Import statements, match a line to an invoice or bill by amount, and let rules book the routine ones.', tone: 'bg-sky-100 text-sky-700', icon: 'M3 10l9-6 9 6M5 10v8M9 10v8M15 10v8M19 10v8M3 20h18' },
  { title: 'GST and TDS', text: 'GSTR-1 and GSTR-3B summaries, TDS on bills, and filing due dates created as tasks.', tone: 'bg-rose-100 text-rose-700', icon: 'M5 4h14v16H5zM9 9h6M9 13h6M9 17h3' },
  { title: 'Reports that look right', text: 'Five PDF and Excel templates. Combine several reports into one file and choose the columns.', tone: 'bg-violet-100 text-violet-700', icon: 'M4 20V10M10 20V4M16 20v-7M22 20H2' },
  { title: 'Cost centres', text: 'Tag any invoice, bill or journal to a branch or department and see profit for each.', tone: 'bg-amber-100 text-amber-700', icon: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5' },
  { title: 'Fixed assets', text: 'Asset groups with Income Tax and Companies Act rates, depreciation, and a sale with gain or loss.', tone: 'bg-orange-100 text-orange-700', icon: 'M3 21h18M5 21V8l7-4 7 4v13M9 21v-6h6v6' },
  { title: 'Every client separate', text: 'One firm, many clients. Each client has its own locked-down set of books.', tone: 'bg-teal-100 text-teal-700', icon: 'M16 11a4 4 0 1 0-8 0 4 4 0 0 0 8 0zM4 21c0-4 4-6 8-6s8 2 8 6' },
  { title: 'Safe by design', text: 'Posted entries are never deleted, only reversed. Every change is recorded. Daily encrypted backups.', tone: 'bg-indigo-100 text-indigo-700', icon: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4' },
];

const AUDIENCES: { title: string; text: string; points: string[] }[] = [
  { title: 'CA and accounting firms', text: 'Run many clients from one login.', points: ['A practice overview of every client', 'Deadlines and tasks per client', 'Invite staff and clients with the right access'] },
  { title: 'Traders and small businesses', text: 'Keep your own books without the jargon.', points: ['Invoice in a minute, with GST done for you', 'See who owes you and what you owe', 'Hand clean reports to your CA'] },
  { title: 'Clients of a firm', text: 'See your own numbers any time.', points: ['Read-only access to your books', 'Download invoices and reports', 'No one else’s data is ever visible'] },
];

const ROLES: [string, string][] = [
  ['Owner', 'Everything, including users, billing and settings.'],
  ['Accountant', 'Manages the books, approves, runs reports and year-end.'],
  ['Staff', 'Raises invoices and bills and records payments. No approvals or settings.'],
  ['Client', 'Read-only view of their own books and reports.'],
];

const STEPS: [string, string][] = [
  ['Create your firm account', 'Takes a minute. You get a 14-day trial, no card needed.'],
  ['Add a client', 'Pick a chart of accounts: trading, services or manufacturing.'],
  ['Start working', 'Raise an invoice, enter a bill or import a bank statement.'],
];

const Badge = ({ d, tone }: { d: string; tone: string }) => (
  <span className={`flex h-10 w-10 items-center justify-center rounded-lg ${tone}`}>
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={d} /></svg>
  </span>
);

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

const Section = ({ id, title, lead, children }: { id: string; title: string; lead?: string; children: ReactNode }) => (
  <section id={id} aria-labelledby={`${id}-h`} className="mx-auto max-w-7xl px-6 py-14">
    <h2 id={`${id}-h`} className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">{title}</h2>
    {lead && <p className="mt-2 max-w-2xl text-slate-600">{lead}</p>}
    <div className="mt-8">{children}</div>
  </section>
);

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
  // The page links scroll within the page. They are buttons, not #links, because the address bar's # is used for navigation inside the app.
  const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

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
      <header className="sticky top-0 z-20 border-b border-white/10 bg-nav text-white">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-6">
          <span className="flex items-center gap-2 text-xl font-bold"><Logo size={32} />{APP_NAME}</span>
          <nav aria-label="Page sections" className="hidden items-center gap-1 text-sm font-medium md:flex">
            {([['features', 'Features'], ['audience', 'Who it is for'], ['roles', 'Access levels'], ['steps', 'How it works']] as const).map(([id, label]) => (
              <button key={id} type="button" onClick={() => scrollTo(id)} className="rounded-md px-3 py-2 text-indigo-100 hover:bg-white/10 hover:text-white">{label}</button>))}
          </nav>
          <p className="text-sm text-indigo-100">
            {mode === 'login' ? <>New here? <button type="button" className="font-semibold text-white underline-offset-2 hover:underline" onClick={() => switchTo('register')}>Try it free</button></>
              : <>Have an account? <button type="button" className="font-semibold text-white underline-offset-2 hover:underline" onClick={() => switchTo('login')}>Log in</button></>}
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
              <h1 className="text-3xl font-bold tracking-tight">{temp ? 'Two-step verification' : mode === 'login' ? 'Log in' : 'Create your firm account'}</h1>
              <p className="mt-2 text-indigo-100">{temp ? 'One more step to keep your clients’ books safe.' : mode === 'login' ? 'Welcome back. Log in to see your clients’ books.' : 'Free for 14 days. No card needed.'}</p>
              <form onSubmit={submit} className="mt-6 space-y-4 rounded-2xl border border-white/20 bg-white p-6 text-slate-900 shadow-2xl">
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
                <p className="mt-4 text-sm text-indigo-100">
                  {mode === 'login' ? 'New firm? ' : 'Already registered? '}
                  <button type="button" className="font-semibold text-white underline-offset-2 hover:underline" onClick={() => switchTo(mode === 'login' ? 'register' : 'login')}>{mode === 'login' ? 'Create an account' : 'Log in instead'}</button>
                </p>
              )}
              <ul className="mt-5 space-y-2 text-sm text-indigo-100">
                {['Secure HTTPS connection and optional two-step login', 'Encrypted daily backups', 'Data stays private to your firm (DPDP consent built in)'].map((t) => (
                  <li key={t} className="flex items-center gap-2"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="shrink-0 text-emerald-300"><path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>{t}</li>))}
              </ul>
            </section>
          </div>
        </div>

        {/* A strip of plain facts about the product */}
        <div className="border-b border-slate-200 bg-slate-50">
          <dl className="mx-auto grid max-w-7xl grid-cols-2 gap-6 px-6 py-6 text-center sm:grid-cols-4">
            {[['14 days', 'free trial, no card'], ['3 tax types', 'CGST, SGST and IGST'], ['5 templates', 'for PDF and Excel exports'], ['4 access levels', 'owner to client']].map(([n, l]) => (
              <div key={n}><dt className="text-2xl font-bold text-brand-700">{n}</dt><dd className="text-sm text-slate-600">{l}</dd></div>))}
          </dl>
        </div>

        <Section id="features" title="What you can do" lead="Everything a practice needs to keep clients’ books right, without a pile of spreadsheets.">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {FEATURES.map((x) => (
              <div key={x.title} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
                <Badge d={x.icon} tone={x.tone} />
                <p className="mt-3 font-semibold text-slate-900">{x.title}</p>
                <p className="mt-1 text-sm text-slate-600">{x.text}</p>
              </div>))}
          </div>
        </Section>

        <div className="bg-slate-50">
          <Section id="audience" title="Who it is for">
            <div className="grid gap-4 md:grid-cols-3">
              {AUDIENCES.map((a, i) => (
                <div key={a.title} className={`rounded-2xl border-t-4 bg-white p-6 shadow-sm ${['border-emerald-500', 'border-orange-500', 'border-violet-500'][i]}`}>
                  <h3 className="text-lg font-semibold text-slate-900">{a.title}</h3>
                  <p className="text-sm text-slate-600">{a.text}</p>
                  <ul className="mt-4 space-y-2 text-sm text-slate-700">
                    {a.points.map((p) => <li key={p} className="flex gap-2"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="mt-0.5 shrink-0 text-emerald-600"><path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>{p}</li>)}
                  </ul>
                </div>))}
            </div>
          </Section>
        </div>

        <Section id="roles" title="The right access for everyone" lead="Give each person exactly what they need. Clients only ever see their own books.">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {ROLES.map(([role, what], i) => (
              <div key={role} className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                <div className={`px-4 py-2 text-sm font-bold text-white ${['bg-brand-700', 'bg-sky-600', 'bg-emerald-600', 'bg-amber-600'][i]}`}>{role}</div>
                <p className="p-4 text-sm text-slate-700">{what}</p>
              </div>))}
          </div>
        </Section>

        <div className="bg-gradient-to-br from-nav to-brand-800 text-white">
          <section id="steps" aria-labelledby="steps-h" className="mx-auto max-w-7xl px-6 py-14">
            <h2 id="steps-h" className="text-2xl font-bold tracking-tight sm:text-3xl">Up and running in three steps</h2>
            <ol className="mt-8 grid gap-4 md:grid-cols-3">
              {STEPS.map(([title, text], i) => (
                <li key={title} className="rounded-2xl bg-white/10 p-6">
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-base font-bold text-brand-800">{i + 1}</span>
                  <p className="mt-3 text-lg font-semibold">{title}</p><p className="mt-1 text-sm text-indigo-100">{text}</p>
                </li>))}
            </ol>
            <button type="button" className="mt-8 rounded-lg bg-white px-5 py-2.5 font-semibold text-brand-800 shadow hover:bg-brand-50" onClick={() => { switchTo('register'); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>Start your free trial</button>
          </section>
        </div>
      </main>

      <footer className="border-t border-slate-200 bg-slate-50">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2 px-6 py-4 text-xs text-slate-500">
          <span className="flex items-center gap-2"><Logo size={18} />© {new Date().getFullYear()} {APP_NAME}. Cloud accounting for India.</span>
          <span>GST · TDS · Bank reconciliation · Reports</span>
        </div>
      </footer>
    </div>
  );
}
