// The marketing part of the landing page: product tour, compliance checks, features, audiences, access levels, pricing,
// security, questions and how to start. Every claim here describes something the app does today; figures in the
// illustrations are examples and say so.
import { ReactNode, useEffect, useState } from 'react';
import { APP_NAME, Logo } from '../ui';

const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
export const PAGE_LINKS: [string, string][] = [['tour', 'Features'], ['compliance', 'Compliance'], ['audience', 'Who it is for'], ['roles', 'Access levels'], ['pricing', 'Pricing'], ['faq', 'Questions']];

const Check = ({ className = 'text-emerald-600' }: { className?: string }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className={`mt-0.5 shrink-0 ${className}`}><path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
);
const Icon = ({ d, tone }: { d: string; tone: string }) => (
  <span className={`flex h-10 w-10 items-center justify-center rounded-lg ${tone}`}>
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={d} /></svg>
  </span>
);
const Section = ({ id, title, lead, children, kicker }: { id: string; title: string; lead?: string; kicker?: string; children: ReactNode }) => (
  <section id={id} aria-labelledby={`${id}-h`} className="mx-auto max-w-7xl scroll-mt-20 px-6 py-16">
    {kicker && <p className="text-sm font-semibold uppercase tracking-wider text-brand-600">{kicker}</p>}
    <h2 id={`${id}-h`} className="mt-1 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">{title}</h2>
    {lead && <p className="mt-2 max-w-3xl text-slate-600">{lead}</p>}
    <div className="mt-8">{children}</div>
  </section>
);

// ------------------------------------------------------------------ a small picture of a screen
type Chip = 'green' | 'amber' | 'red' | 'blue' | 'violet' | 'slate';
const CHIP: Record<Chip, string> = { green: 'bg-emerald-100 text-emerald-800', amber: 'bg-amber-100 text-amber-800', red: 'bg-red-100 text-red-800', blue: 'bg-sky-100 text-sky-800', violet: 'bg-violet-100 text-violet-800', slate: 'bg-slate-100 text-slate-700' };
/** A picture of an app screen drawn with HTML: a title bar, optional figures and a few rows. Labelled for screen readers. */
function Screen({ label, title, tiles, rows, foot }: { label: string; title: string; tiles?: [string, string, Chip?][]; rows: [string, string, string, Chip][]; foot?: string }) {
  return (
    <div role="img" aria-label={label} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl">
      <div className="flex items-center gap-1.5 border-b border-slate-100 bg-slate-50 px-4 py-2.5">
        <span className="h-2.5 w-2.5 rounded-full bg-rose-400" /><span className="h-2.5 w-2.5 rounded-full bg-amber-400" /><span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
        <span className="ml-3 text-xs font-medium text-slate-500">{title}</span>
      </div>
      <div className="p-4">
        {tiles && <div className="mb-3 grid grid-cols-3 gap-2">{tiles.map(([k, v, c]) => (
          <div key={k} className={`rounded-lg border p-2 ${c === 'red' ? 'border-red-200 bg-red-50' : c === 'green' ? 'border-emerald-200 bg-emerald-50' : 'border-slate-200'}`}>
            <p className="text-[10px] text-slate-500">{k}</p><p className="text-sm font-bold text-slate-900">{v}</p></div>))}</div>}
        <div className="divide-y divide-slate-100 text-xs">
          {rows.map(([a, b, chip, tone], i) => (
            <div key={i} className="flex items-center justify-between gap-3 py-2"><span className="min-w-0"><span className="block truncate font-medium text-slate-800">{a}</span><span className="block truncate text-slate-500">{b}</span></span>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${CHIP[tone]}`}>{chip}</span></div>))}
        </div>
        {foot && <p className="mt-3 text-[10px] text-slate-400">{foot}</p>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ product tour
const TOUR: { key: string; tab: string; title: string; text: string; points: string[]; screen: Parameters<typeof Screen>[0] }[] = [
  { key: 'sales', tab: 'Sales', title: 'Invoices that get GST right the first time',
    text: 'CGST and SGST or IGST is chosen from the customer’s GSTIN, with a warning if you change it. Totals show before you save.',
    points: ['Quotes that turn into invoices after a review', 'Repeating invoices and overdue reminders by email', 'Your own invoice number, templates and attachments', 'Edit a posted invoice by clicking its amount', 'Foreign-currency invoices with exchange gain or loss'],
    screen: { label: 'Example invoices list', title: 'Sales · Invoices', tiles: [['Awaiting payment', '₹1,26,500'], ['Overdue', '₹18,400', 'red'], ['Paid this month', '₹2,04,000', 'green']],
      rows: [['INV/26-27/0014 · Kapoor Stores', 'CGST + SGST · ₹11,800', 'Awaiting', 'amber'], ['INV/26-27/0013 · Bengaluru Retail', 'IGST · ₹59,000', 'Paid', 'green'], ['INV/26-27/0012 · Export Corp (USD)', 'Export under LUT', 'Sent', 'blue']], foot: 'Example figures' } },
  { key: 'purchases', tab: 'Purchases', title: 'Bills, TDS and approvals in one flow',
    text: 'Enter a bill once: input GST, TDS by section and threshold, and the net amount payable are worked out for you.',
    points: ['Purchase orders reviewed before they become bills', 'TDS by section, with the higher rate when PAN is missing', 'Reverse charge, composition and imports handled', 'Approval before posting, expense claims and repayment', 'A warning before the same supplier bill is entered twice'],
    screen: { label: 'Example bills list', title: 'Purchases · Bills', tiles: [['To pay', '₹3,18,200'], ['Due this week', '₹42,500', 'red'], ['TDS deducted', '₹6,000']],
      rows: [['BILL/26-27/0007 · Pro Advisors', '194J TDS ₹6,000 · net ₹54,000', 'Approved', 'green'], ['BILL/26-27/0006 · Tiny Tools (micro)', 'Pay by 22 Nov under 43B(h)', 'Due soon', 'amber'], ['BILL/26-27/0005 · Steel Co', 'Same bill number as 0003', 'Duplicate?', 'red']], foot: 'Example figures' } },
  { key: 'bank', tab: 'Bank', title: 'Reconcile the bank in minutes',
    text: 'Import a statement, and each line is matched to an invoice, a bill or a rule. Unlink a wrong match in one click.',
    points: ['CSV statements from any bank, duplicates skipped', 'Match by amount, or search for the invoice or bill', 'Bank rules for charges, rent and other routine lines', 'Spend, receive and transfer money', 'Short-term cash flow for the next 30 to 90 days'],
    screen: { label: 'Example bank reconciliation', title: 'Accounting · Bank accounts', tiles: [['Statement lines', '48'], ['Matched', '45', 'green'], ['To check', '3', 'red']],
      rows: [['NEFT KAPOOR STORES · ₹11,800', 'Invoice INV/26-27/0014', 'Match', 'green'], ['BANK CHARGES · ₹15.50', 'Rule: Bank Charges', 'Rule', 'violet'], ['IMPS 88231 · ₹5,000', 'Find an invoice or bill…', 'Check', 'amber']], foot: 'Example figures' } },
  { key: 'tax', tab: 'GST & TDS', title: 'GST and TDS working papers, ready for filing',
    text: 'GSTR-1 and GSTR-3B summaries, the TDS deducted report, filing due dates as tasks, and checks that catch problems before the return.',
    points: ['GSTR-1 and GSTR-3B summaries from the books', 'GSTR-2B matched against your bills', 'MSME payments under 43B(h) and the 180-day ITC rule', 'TDS deducted by section and month', 'Due dates for GST and TDS as tasks'],
    screen: { label: 'Example GSTR-3B summary', title: 'Tax · GSTR-3B', tiles: [['Output tax', '₹84,600'], ['Input credit', '₹51,200', 'green'], ['To pay', '₹33,400']],
      rows: [['3.1(a) Outward taxable supplies', 'Taxable ₹4,70,000', 'Ready', 'green'], ['3.1(b) Zero-rated exports', 'Under LUT', 'Ready', 'green'], ['4(A) Input tax credit', '2 suppliers not in GSTR-2B', 'Check', 'amber']], foot: 'Example figures' } },
  { key: 'reports', tab: 'Reports', title: 'Reports that look like you made them',
    text: 'Profit and loss, balance sheet, cash flow, ageing and more, exported to PDF or Excel in your firm’s own template.',
    points: ['Trial balance, P&L, balance sheet, ledgers, cash flow', 'P&L by month and by cost centre, budget vs actual', 'Several reports in one PDF or one workbook', 'Five ready-made templates or your own design', 'Business snapshot with a health scorecard'],
    screen: { label: 'Example reports list', title: 'Reporting · All reports', tiles: [['Net profit FY', '₹5,82,150', 'green'], ['Current ratio', '1.8'], ['Debtor days', '38']],
      rows: [['Profit and loss', 'Apr–Sep, by month', 'PDF', 'violet'], ['Balance sheet', 'As at 30 Sep', 'Excel', 'blue'], ['Board pack: 4 reports', 'One PDF, firm template', 'PDF', 'violet']], foot: 'Example figures' } },
  { key: 'practice', tab: 'Practice', title: 'Every client of the firm, one login',
    text: 'Each client’s books are kept apart at the database level. The practice overview shows what needs attention across all of them.',
    points: ['Practice overview across all clients', 'Invite staff and clients by email with the right access', 'Tasks, deadlines and document sharing', 'Import contacts, accounts and opening balances by CSV', 'Projects with time, costs and unbilled work'],
    screen: { label: 'Example practice overview', title: 'Practice overview', tiles: [['Clients', '24'], ['Overdue invoices', '9', 'red'], ['Deadlines this week', '6']],
      rows: [['Nair Traders', '3 bank lines to reconcile', 'Attention', 'amber'], ['Mehta Consulting', 'GSTR-3B due on the 20th', 'Due', 'blue'], ['Rao Design Studio', 'All up to date', 'OK', 'green']], foot: 'Example figures' } },
];

function Tour() {
  const [k, setK] = useState(TOUR[0].key);
  const t = TOUR.find((x) => x.key === k)!;
  return (
    <Section id="tour" kicker="One platform" title="Everything your practice runs on" lead="Sales, purchases, bank, tax, reports and the practice itself, in one place and in one set of books for each client.">
      <div role="tablist" aria-label="Product areas" className="flex flex-wrap gap-2">
        {TOUR.map((x) => <button key={x.key} role="tab" aria-selected={k === x.key} onClick={() => setK(x.key)}
          className={`rounded-full px-4 py-2 text-sm font-semibold transition ${k === x.key ? 'bg-brand-600 text-white shadow' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}>{x.tab}</button>)}
      </div>
      <div role="tabpanel" aria-label={t.tab} className="mt-8 grid items-center gap-10 lg:grid-cols-2">
        <div>
          <h3 className="text-2xl font-bold text-slate-900">{t.title}</h3>
          <p className="mt-2 text-slate-600">{t.text}</p>
          <ul className="mt-5 space-y-2.5 text-slate-700">{t.points.map((p) => <li key={p} className="flex gap-2"><Check />{p}</li>)}</ul>
        </div>
        <Screen {...t.screen} />
      </div>
    </Section>
  );
}

// ------------------------------------------------------------------ compliance band
const CHECKS: { title: string; text: string; points: string[]; screen: Parameters<typeof Screen>[0] }[] = [
  { title: 'GSTR-2B match', text: 'Upload the file from the GST portal. Every bill is matched by the supplier’s GSTIN and invoice number, however it is written.',
    points: ['Bills the supplier has not reported', 'Tax that differs from your bill', 'Credit at risk and who to chase, with a reminder to send'],
    screen: { label: 'Example GSTR-2B match', title: 'GSTR-2B · October', tiles: [['Matched', '42', 'green'], ['Not reported', '3', 'red'], ['Credit at risk', '₹18,400', 'red']],
      rows: [['Lazy Filer · LF-7', 'Not in GSTR-2B', 'Chase', 'red'], ['Good Filer · GF/0042 = gf-42', 'Same invoice', 'Matched', 'green']], foot: 'Example figures' } },
  { title: 'MSME payments: section 43B(h)', text: 'Bills from micro and small suppliers must be paid in 15 days, or the agreed days up to 45, or the expense is not allowed for the year.',
    points: ['Pay-by date on every MSME bill', 'What to pay now to keep the expense allowed', 'Expense not allowed for the year, for the tax audit (clause 22)'],
    screen: { label: 'Example MSME payments check', title: 'MSME payments · FY 2026-27', tiles: [['Pay now', '₹1,180', 'red'], ['Due in 7 days', '₹590'], ['Not allowed', '₹1,000', 'red']],
      rows: [['Tiny Tools (micro)', 'Bill 15 Oct · pay by 30 Oct', 'Overdue', 'red'], ['Tiny Tools (micro)', 'Bill 7 Nov · pay by 22 Nov', 'In 13 days', 'slate']], foot: 'Example figures' } },
  { title: 'ITC 180-day rule', text: 'Credit on a bill not paid within 180 days has to be reversed. See it before the return, and pay in time to keep it.',
    points: ['Credit to reverse on the unpaid part', 'Bills reaching 180 days within 30 days', 'PDF and Excel for the file'],
    screen: { label: 'Example 180-day check', title: 'ITC 180-day rule', tiles: [['Reverse now', '₹180', 'red'], ['Within 30 days', '₹1,620'], ['Bills', '4']],
      rows: [['GF/0001 · 200 days unpaid', 'Unpaid ₹1,180 · GST ₹180', 'Reverse', 'red'], ['SP/0044 · day 180 in 12 days', 'Pay to keep ₹900', 'Soon', 'amber']], foot: 'Example figures' } },
  { title: 'Duplicate bill guard', text: 'The same supplier bill entered twice claims its GST credit twice. It is stopped, even across two contacts with one GSTIN.',
    points: ['INV/0042, inv-42 and INV 42 count as one number', 'Asks before posting, never silently', 'Alerts in notifications for everything above'],
    screen: { label: 'Example duplicate bill warning', title: 'New bill', rows: [['Possible duplicate', 'BILL/26-27/0003 already has supplier bill no. GF/0042', 'Stop', 'red'], ['You typed: gf-42', 'Post anyway only if you are sure', 'Ask', 'amber']] } },
];

function ComplianceBand() {
  return (
    <div className="bg-gradient-to-br from-nav via-brand-900 to-brand-800 text-white">
      <section id="compliance" aria-labelledby="compliance-h" className="mx-auto max-w-7xl scroll-mt-20 px-6 py-16">
        <p className="text-sm font-semibold uppercase tracking-wider text-brand-200">Built for India</p>
        <h2 id="compliance-h" className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">Compliance checks that usually live in spreadsheets</h2>
        <p className="mt-2 max-w-3xl text-indigo-100">Worked out from the books every month and at year-end, with alerts when something needs doing. Global accounting software does not do these for Indian tax law.</p>
        <div className="mt-10 grid gap-6 lg:grid-cols-2">
          {CHECKS.map((c) => (
            <article key={c.title} className="rounded-2xl bg-white/10 p-6 ring-1 ring-white/10">
              <h3 className="text-xl font-semibold">{c.title}</h3>
              <p className="mt-1 text-sm text-indigo-100">{c.text}</p>
              <ul className="mt-3 space-y-1.5 text-sm text-indigo-50">{c.points.map((p) => <li key={p} className="flex gap-2"><Check className="text-emerald-300" />{p}</li>)}</ul>
              <div className="mt-5 text-slate-900"><Screen {...c.screen} /></div>
            </article>))}
        </div>
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ features, audiences, roles
const FEATURES: { title: string; text: string; tone: string; icon: string }[] = [
  { title: 'Invoices and bills', text: 'GST from the place of supply, your own numbers, templates, attachments, editing after posting.', tone: 'bg-emerald-100 text-emerald-700', icon: 'M7 3h8l4 4v14H7zM15 3v4h4M10 12h6M10 16h6' },
  { title: 'Bank reconciliation', text: 'Statement import, matching to invoices and bills, rules, and unlinking a wrong match.', tone: 'bg-sky-100 text-sky-700', icon: 'M3 10l9-6 9 6M5 10v8M9 10v8M15 10v8M19 10v8M3 20h18' },
  { title: 'GST and TDS', text: 'GSTR-1 and GSTR-3B summaries, TDS by section, reverse charge, exports and SEZ.', tone: 'bg-rose-100 text-rose-700', icon: 'M5 4h14v16H5zM9 9h6M9 13h6M9 17h3' },
  { title: 'Compliance checks', text: 'GSTR-2B match, MSME payments under 43B(h), the 180-day ITC rule and duplicate bills.', tone: 'bg-red-100 text-red-700', icon: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4' },
  { title: 'Reports that look right', text: 'Your own PDF and Excel templates, several reports in one file, the columns you choose.', tone: 'bg-violet-100 text-violet-700', icon: 'M4 20V10M10 20V4M16 20v-7M22 20H2' },
  { title: 'Cost centres', text: 'Tag any invoice, bill or journal to a branch or department and see profit for each.', tone: 'bg-amber-100 text-amber-700', icon: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5' },
  { title: 'Fixed assets', text: 'Asset groups with Income Tax and Companies Act rates, depreciation, disposal with gain or loss.', tone: 'bg-orange-100 text-orange-700', icon: 'M3 21h18M5 21V8l7-4 7 4v13M9 21v-6h6v6' },
  { title: 'Inventory and projects', text: 'Stock at weighted average cost, and projects with time, costs and unbilled work.', tone: 'bg-lime-100 text-lime-700', icon: 'M21 8l-9-5-9 5v8l9 5 9-5zM3 8l9 5 9-5M12 13v8' },
  { title: 'Approvals and expense claims', text: 'Approve invoices and bills before posting; staff claim expenses and get repaid.', tone: 'bg-cyan-100 text-cyan-700', icon: 'M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9' },
  { title: 'People and access', text: 'Invite by email; six access levels from owner to an employee who only claims expenses.', tone: 'bg-teal-100 text-teal-700', icon: 'M16 11a4 4 0 1 0-8 0 4 4 0 0 0 8 0zM4 21c0-4 4-6 8-6s8 2 8 6' },
  { title: 'Every client separate', text: 'One firm, many clients, each in its own locked-down set of books.', tone: 'bg-indigo-100 text-indigo-700', icon: 'M3 7h18M3 12h18M3 17h18' },
  { title: 'Safe by design', text: 'Posted entries are never deleted, only reversed. Every change is recorded.', tone: 'bg-slate-200 text-slate-700', icon: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z' },
];

const AUDIENCES: { title: string; text: string; points: string[]; border: string }[] = [
  { title: 'CA and accounting firms', text: 'Run many clients from one login.', border: 'border-emerald-500', points: ['A practice overview of every client', 'Compliance checks for each client every month', 'Invite staff and clients with the right access'] },
  { title: 'Traders and small businesses', text: 'Keep your own books without the jargon.', border: 'border-orange-500', points: ['Invoice in a minute, with GST done for you', 'See who owes you and what you owe', 'Hand clean reports to your CA'] },
  { title: 'Clients of a firm', text: 'See your own numbers any time.', border: 'border-violet-500', points: ['Read-only access to your books', 'Download invoices and reports', 'No one else’s data is ever visible'] },
];

const ROLES: [string, string, string][] = [
  ['Owner', 'Everything, including people, billing and export templates.', 'bg-brand-700'],
  ['Accountant', 'Manages the books, approves, runs reports and year-end.', 'bg-sky-600'],
  ['Staff', 'Raises invoices and bills and records payments.', 'bg-emerald-600'],
  ['Sales', 'Raises invoices and quotes and adds customers. Nothing else.', 'bg-orange-600'],
  ['Employee', 'Submits and follows their own expense claims only.', 'bg-teal-600'],
  ['Client', 'Read-only view of their own books and reports.', 'bg-amber-600'],
];

// ------------------------------------------------------------------ pricing (live from the API)
interface Plan { code: string; name: string; amount: number; gst: number; total: number; maxOrgs: number; maxMembers: number }
const rupees = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

function Pricing({ onStart }: { onStart: () => void }) {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  useEffect(() => { fetch('/api/plans').then((r) => (r.ok ? r.json() : [])).then(setPlans).catch(() => setPlans([])); }, []);
  if (plans && plans.length === 0) return null; // the server is asleep or unreachable: leave the section out rather than show wrong prices
  return (
    <Section id="pricing" kicker="Pricing" title="Simple plans for every size of practice" lead="Every new firm starts with a 14-day free trial of the Practice plan. No card needed. Prices are per month; GST at 18% is added.">
      {!plans ? <p className="text-sm text-slate-500">Loading plans…</p> : (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {plans.map((p) => {
            const pick = p.code === 'practice';
            return (
              <div key={p.code} className={`relative flex flex-col rounded-2xl border bg-white p-6 shadow-sm ${pick ? 'border-brand-500 ring-2 ring-brand-200' : 'border-slate-200'}`}>
                {pick && <span className="absolute -top-3 left-6 rounded-full bg-brand-600 px-3 py-0.5 text-xs font-semibold text-white">Free for 14 days</span>}
                <h3 className="text-lg font-semibold text-slate-900">{p.name}</h3>
                <p className="mt-3"><span className="text-3xl font-bold text-slate-900">{p.amount ? rupees(p.amount) : '₹0'}</span><span className="text-sm text-slate-500"> / month</span></p>
                <p className="text-xs text-slate-500">{p.amount ? `${rupees(p.total)} with GST` : 'Free for ever'}</p>
                <ul className="mt-5 flex-1 space-y-2 text-sm text-slate-700">
                  <li className="flex gap-2"><Check />{p.maxOrgs === 1 ? '1 client' : `Up to ${p.maxOrgs} clients`}</li>
                  <li className="flex gap-2"><Check />{`Up to ${p.maxMembers} people`}</li>
                  <li className="flex gap-2"><Check />All features, including compliance checks</li>
                </ul>
                <button type="button" onClick={onStart} className={`mt-6 rounded-lg px-4 py-2.5 text-sm font-semibold ${pick ? 'bg-brand-600 text-white hover:bg-brand-700' : 'border border-slate-300 text-slate-800 hover:bg-slate-50'}`}>{p.amount ? `Try ${p.name}` : 'Start free'}</button>
              </div>);
          })}
        </div>)}
    </Section>
  );
}

// ------------------------------------------------------------------ security, questions
const TRUST: [string, string][] = [
  ['Two-step login', 'An authenticator app on top of the password, with recovery codes.'],
  ['Each client walled off', 'The database itself keeps every client’s books apart.'],
  ['Nothing quietly deleted', 'Posted entries are reversed, never erased, and the books can be locked after filing.'],
  ['Every change recorded', 'An audit log shows who changed what, and what it was before.'],
  ['Encrypted daily backups', 'Backed up every day and test-restored automatically.'],
  ['Your data, your rights', 'Consent recorded under the DPDP Act; export or erase your data any time.'],
];

const FAQ: [string, string][] = [
  ['Can my clients log in?', 'Yes. Invite them from People and access as a Client: they see only their own books and reports, read-only. You can also invite a client’s sales person to raise invoices, or employees to claim expenses.'],
  ['Does it file GST returns?', 'Not yet. It prepares the GSTR-1 and GSTR-3B working papers, matches your bills against GSTR-2B and runs the MSME and 180-day checks, so filing on the portal is quick and correct.'],
  ['Can I move my clients from other software?', 'Yes. Import contacts, the chart of accounts, vouchers and opening balances from a CSV. A dry run checks the file first, and a blank template is provided.'],
  ['Does it work on a phone?', 'It runs in the browser on any phone, tablet or computer, and can be added to the home screen. There is no separate app to install.'],
  ['What does it cost?', 'See the plans above. Every new firm gets a 14-day free trial of the Practice plan, without a card.'],
  ['Who can see my data?', 'Only the people you invite, and only what their access level allows. Each client’s books are kept apart in the database.'],
];

const STEPS: [string, string][] = [
  ['Create your firm account', 'Takes a minute. You get a 14-day trial, no card needed.'],
  ['Add a client', 'Pick a chart of accounts: trading, services or manufacturing.'],
  ['Start working', 'Raise an invoice, enter a bill or import a bank statement.'],
];

/** Everything below the sign-in area. onStart switches the form to sign-up and scrolls up to it. */
export function LandingSections({ onStart }: { onStart: () => void }) {
  return (
    <>
      <div className="border-b border-slate-200 bg-slate-50">
        <dl className="mx-auto grid max-w-7xl grid-cols-2 gap-6 px-6 py-6 text-center sm:grid-cols-4">
          {[['14 days', 'free trial, no card'], ['4 compliance checks', 'GSTR-2B, 43B(h), 180 days, duplicates'], ['6 access levels', 'owner to employee'], ['PDF and Excel', 'in your own template']].map(([n, l]) => (
            <div key={n}><dt className="text-2xl font-bold text-brand-700">{n}</dt><dd className="text-sm text-slate-600">{l}</dd></div>))}
        </dl>
      </div>

      <Tour />
      <ComplianceBand />

      <Section id="features" title="What you can do" lead="Everything a practice needs to keep clients’ books right, without a pile of spreadsheets.">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {FEATURES.map((x) => (
            <div key={x.title} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
              <Icon d={x.icon} tone={x.tone} />
              <p className="mt-3 font-semibold text-slate-900">{x.title}</p>
              <p className="mt-1 text-sm text-slate-600">{x.text}</p>
            </div>))}
        </div>
      </Section>

      <div className="bg-slate-50">
        <Section id="audience" title="Who it is for">
          <div className="grid gap-4 md:grid-cols-3">
            {AUDIENCES.map((a) => (
              <div key={a.title} className={`rounded-2xl border-t-4 bg-white p-6 shadow-sm ${a.border}`}>
                <h3 className="text-lg font-semibold text-slate-900">{a.title}</h3>
                <p className="text-sm text-slate-600">{a.text}</p>
                <ul className="mt-4 space-y-2 text-sm text-slate-700">{a.points.map((p) => <li key={p} className="flex gap-2"><Check />{p}</li>)}</ul>
              </div>))}
          </div>
        </Section>
      </div>

      <Section id="roles" title="The right access for everyone" lead="Give each person exactly what they need. Invite them by email; clients only ever see their own books.">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {ROLES.map(([role, what, bg]) => (
            <div key={role} className="overflow-hidden rounded-xl border border-slate-200 bg-white">
              <div className={`px-4 py-2 text-sm font-bold text-white ${bg}`}>{role}</div>
              <p className="p-4 text-sm text-slate-700">{what}</p>
            </div>))}
        </div>
      </Section>

      <div className="bg-slate-50"><Pricing onStart={onStart} /></div>

      <Section id="security" kicker="Trust" title="Safe enough for your clients’ books">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {TRUST.map(([t, d]) => <div key={t} className="flex gap-3 rounded-xl border border-slate-200 p-5"><Check /><div><p className="font-semibold text-slate-900">{t}</p><p className="mt-1 text-sm text-slate-600">{d}</p></div></div>)}
        </div>
      </Section>

      <div className="bg-slate-50">
        <Section id="faq" title="Questions people ask">
          <div className="max-w-3xl divide-y divide-slate-200 rounded-2xl border border-slate-200 bg-white">
            {FAQ.map(([q, a]) => (
              <details key={q} className="group px-5 py-4">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium text-slate-900">{q}
                  <span aria-hidden className="text-slate-400 transition group-open:rotate-45">+</span></summary>
                <p className="mt-2 text-sm text-slate-600">{a}</p>
              </details>))}
          </div>
        </Section>
      </div>

      <div className="bg-gradient-to-br from-nav to-brand-800 text-white">
        <section id="steps" aria-labelledby="steps-h" className="mx-auto max-w-7xl scroll-mt-20 px-6 py-16">
          <h2 id="steps-h" className="text-2xl font-bold tracking-tight sm:text-3xl">Up and running in three steps</h2>
          <ol className="mt-8 grid gap-4 md:grid-cols-3">
            {STEPS.map(([title, text], i) => (
              <li key={title} className="rounded-2xl bg-white/10 p-6">
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-base font-bold text-brand-800">{i + 1}</span>
                <p className="mt-3 text-lg font-semibold">{title}</p><p className="mt-1 text-sm text-indigo-100">{text}</p>
              </li>))}
          </ol>
          <button type="button" className="mt-8 rounded-lg bg-white px-5 py-2.5 font-semibold text-brand-800 shadow hover:bg-brand-50" onClick={onStart}>Start your free trial</button>
        </section>
      </div>
    </>
  );
}

export function LandingFooter() {
  const col = (title: string, links: [string, string][]) => (
    <div><p className="text-sm font-semibold text-slate-900">{title}</p>
      <ul className="mt-3 space-y-2 text-sm">{links.map(([id, l]) => <li key={id}><button type="button" className="text-slate-600 hover:text-brand-700" onClick={() => scrollTo(id)}>{l}</button></li>)}</ul></div>
  );
  return (
    <footer className="border-t border-slate-200 bg-white">
      <div className="mx-auto grid max-w-7xl gap-8 px-6 py-12 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <span className="flex items-center gap-2 text-lg font-bold text-slate-900"><Logo size={26} />{APP_NAME}</span>
          <p className="mt-3 text-sm text-slate-600">Cloud accounting for Indian CA firms and their clients: books, GST, TDS and compliance checks in one place.</p>
        </div>
        {col('Product', [['tour', 'Features'], ['compliance', 'Compliance checks'], ['pricing', 'Pricing']])}
        {col('For you', [['audience', 'Who it is for'], ['roles', 'Access levels'], ['security', 'Security']])}
        {col('Help', [['faq', 'Questions'], ['steps', 'How to start']])}
      </div>
      <div className="border-t border-slate-200 bg-slate-50">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2 px-6 py-4 text-xs text-slate-500">
          <span>© {new Date().getFullYear()} {APP_NAME}. Cloud accounting for India.</span>
          <span>GST · TDS · Bank reconciliation · Compliance checks · Reports</span>
        </div>
      </div>
    </footer>
  );
}
