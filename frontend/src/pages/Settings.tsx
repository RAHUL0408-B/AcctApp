// Settings like Xero's: one hub page listing every setting, and a page per section. Owners and accountants can change
// them; everyone else sees them read-only.
import { useEffect, useState } from 'react';
import { api, fmt } from '../api';
import type { Org } from '../App';
import { Button, Card, ErrorMsg, Field, Ok, useAction } from '../ui';
import { EditMode, useEditing } from '../editmode';
import { ExportMenu } from '../table';
import { Empty, PageHeader, Select } from '../kit';

type S = Record<string, any>;

/** Load the organisation settings once; the form stays locked until they arrive (React runs effects twice in development). */
function useOrgSettings(org: Org) {
  const [s, setS] = useState<S | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => { let live = true; api<S>(`/orgs/${org.id}/org-settings`).then((x) => { if (live) setS(x); }); return () => { live = false; }; }, [org.id, n]);
  return { s, reload: () => setN((x) => x + 1) };
}
const save = (org: Org, body: S) => api(`/orgs/${org.id}/org-settings`, { method: 'PUT', body });
/** Empty text fields are sent as null, so clearing a field clears the setting. */
const nul = (v: string) => (v.trim() === '' ? null : v.trim());

const Toggle = ({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) => (
  <label className="flex items-center gap-2 text-sm"><input type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />{label}</label>
);
const Area = ({ label, value, onChange, disabled, rows = 4, placeholder }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean; rows?: number; placeholder?: string }) => (
  <label className="block text-sm"><span className="mb-1 block font-medium text-slate-600">{label}</span>
    <textarea aria-label={label} rows={rows} disabled={disabled} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} className="w-full rounded-md border border-slate-300 px-3 py-2" /></label>
);

// ---------------------------------------------------------------- hub

export const SETUP_SECTIONS: Record<string, string> = {
  financial: 'Financial settings', invoice: 'Invoice settings', payment: 'Payment services', email: 'Email settings', reminders: 'Invoice reminders',
  currencies: 'Currencies', 'tax-rates': 'Tax rates', history: 'History and notes', taxes: 'Duties and taxes',
};

export interface Tile { label: string; desc: string; to: string; manage?: boolean; owner?: boolean; firm?: boolean }
export const HUB: { group: string; tiles: Tile[] }[] = [
  { group: 'General', tiles: [
    { label: 'Organisation details', desc: 'Name, GSTIN, PAN, legal name, address, contact details and logo', to: 'settings' },
    { label: 'Users', desc: 'Invite people and choose what they can do', to: '#/team', firm: true },
    { label: 'Financial settings', desc: 'Financial year, time zone and lock dates', to: 'setup/financial' },
    { label: 'Subscription and billing', desc: 'Your plan and what it includes', to: '#/billing' },
    { label: 'Security', desc: 'Password and two-step sign-in', to: '#/security' },
  ] },
  { group: 'Sales and purchases', tiles: [
    { label: 'Invoice settings', desc: 'Number prefixes and the next number for invoices, notes, quotes and orders', to: 'setup/invoice' },
    { label: 'Payment services', desc: 'Bank details and a UPI QR code printed on invoices', to: 'setup/payment' },
    { label: 'Invoice reminders', desc: 'Remind customers about overdue invoices, by hand or automatically', to: 'setup/reminders' },
    { label: 'Email settings', desc: 'Sender name, reply-to address and email templates', to: 'setup/email' },
    { label: 'Sales settings', desc: 'Default due days and terms printed on invoices', to: 'sales-settings', manage: true },
    { label: 'Purchases settings', desc: 'Default due days for bills', to: 'purchases-settings', manage: true },
    { label: 'Products and services', desc: 'Items with rates, HSN/SAC codes and GST', to: 'items' },
    { label: 'Export templates', desc: 'How PDF and Excel exports look', to: 'export-templates', owner: true },
  ] },
  { group: 'Accounting', tiles: [
    { label: 'Chart of accounts', desc: 'The accounts transactions post to', to: 'coa' },
    { label: 'Duties and taxes', desc: 'GSTIN, PAN, TAN, the LUT for exports, and ledgers for duties such as customs', to: 'setup/taxes' },
    { label: 'Tax rates', desc: 'GST rates and TDS sections with their limits', to: 'setup/tax-rates' },
    { label: 'Currencies', desc: 'Foreign currencies and their default exchange rates', to: 'setup/currencies' },
    { label: 'Cost centres', desc: 'Tracking categories for reports by branch, project or department', to: 'tracking' },
    { label: 'Fixed assets', desc: 'Asset register and depreciation', to: 'assets' },
    { label: 'Bank rules', desc: 'Code bank lines automatically', to: 'bank-rules' },
    { label: 'Conversion balances', desc: 'Opening balances and data from other software', to: 'import', manage: true },
    { label: 'Scheduled emails', desc: 'Reports sent automatically', to: 'schedules', manage: true },
    { label: 'Year-end close', desc: 'Close the year and carry profit to reserves', to: 'year-end' },
    { label: 'History and notes', desc: 'Every change: who did what, and when', to: 'setup/history', manage: true },
  ] },
];

export function SettingsHub({ org, role, canTeam, go }: { org: Org; role: string; canTeam: boolean; go: (p: string) => void }) {
  const canManage = role === 'owner' || role === 'accountant';
  const [q, setQ] = useState('');
  const show = (t: Tile) => (!t.manage || canManage) && (!t.owner || role === 'owner') && (!t.firm || canTeam)
    && (!q || `${t.label} ${t.desc}`.toLowerCase().includes(q.toLowerCase()));
  const open = (to: string) => (to.startsWith('#') ? (location.hash = to) : go(to));
  return (
    <>
      <PageHeader title="Settings" subtitle={`Everything that controls how ${org.name}'s books work.${canManage ? '' : ' You can look; owners and accountants can change them.'}`}
        actions={<input aria-label="Search settings" placeholder="Search settings" value={q} onChange={(e) => setQ(e.target.value)} className="w-56 rounded-md border border-slate-300 px-3 py-2 text-sm" />} />
      {HUB.map((g) => {
        const tiles = g.tiles.filter(show);
        if (!tiles.length) return null;
        return (
          <section key={g.group} aria-label={g.group} className="mb-6">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">{g.group}</h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {tiles.map((t) => (
                <button key={t.label} onClick={() => open(t.to)} className="group rounded-xl border border-slate-200 bg-white p-4 text-left shadow-[0_1px_2px_rgba(16,24,40,0.05)] transition hover:border-brand-300 hover:shadow-md focus-visible:outline-2 focus-visible:outline-brand-500">
                  <span className="flex items-center justify-between text-sm font-semibold text-slate-900">{t.label}<span aria-hidden className="text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-brand-600">›</span></span>
                  <span className="mt-1 block text-xs text-slate-500">{t.desc}</span>
                </button>))}
            </div>
          </section>);
      })}
      {HUB.every((g) => !g.tiles.some(show)) && <Empty text="No setting matches your search." />}
    </>
  );
}

// ---------------------------------------------------------------- organisation details (shown under the business details)

const BUSINESS_TYPES: [string, string][] = [['', 'Not set'], ['proprietorship', 'Sole proprietorship'], ['partnership', 'Partnership firm'], ['llp', 'LLP'], ['private_limited', 'Private limited company'],
  ['public_limited', 'Public limited company'], ['opc', 'One person company'], ['huf', 'HUF'], ['trust', 'Trust'], ['society', 'Society'], ['other', 'Other']];
const DETAIL_KEYS = ['legalName', 'businessType', 'industry', 'cin', 'tan', 'description', 'addressLine1', 'addressLine2', 'city', 'pincode', 'phone', 'email', 'website'] as const;

export function OrgDetailsMore({ org, canManage }: { org: Org; canManage: boolean }) {
  const { s, reload } = useOrgSettings(org);
  const [f, setF] = useState<Record<string, string>>({});
  const [logo, setLogo] = useState<string | null>(null);
  const [ok, setOk] = useState('');
  const { error, busy, run, setError } = useAction();
  useEffect(() => { if (s) { setF(Object.fromEntries(DETAIL_KEYS.map((k) => [k, s[k] ?? '']))); setLogo(s.logo); } }, [s]);
  const { editing } = useEditing();
  const editable = canManage && !!s && editing;
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const saveDetails = () => run(async () => {
    await save(org, { ...Object.fromEntries(DETAIL_KEYS.map((k) => [k, nul(f[k] ?? '')])), tan: nul((f.tan ?? '').toUpperCase()), cin: nul((f.cin ?? '').toUpperCase()) });
    setOk('Organisation details saved. They are printed on your invoices.'); reload();
  });
  const pickLogo = (file?: File) => {
    setError(''); setOk('');
    if (!file) return;
    if (!/^image\/(png|jpeg)$/.test(file.type)) { setError('Choose a PNG or JPEG image.'); return; }
    if (file.size > 300_000) { setError('The logo must be 300 KB or smaller.'); return; }
    const r = new FileReader();
    r.onload = () => run(async () => { await save(org, { logo: String(r.result) }); setLogo(String(r.result)); setOk('Logo saved. It now appears on your invoices.'); });
    r.readAsDataURL(file);
  };
  return (
    <>
      <div className="space-y-2"><ErrorMsg msg={error} /><Ok msg={ok} /></div>
      <Card title="Legal and registration details">
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Legal name (if different)" value={f.legalName ?? ''} onChange={set('legalName')} disabled={!editable} />
          <Select label="Business type" value={f.businessType ?? ''} onChange={set('businessType')} disabled={!editable}>{BUSINESS_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
          <Field label="Industry" value={f.industry ?? ''} onChange={set('industry')} disabled={!editable} placeholder="e.g. Wholesale trade" />
          <Field label="CIN / LLPIN" value={f.cin ?? ''} onChange={set('cin')} disabled={!editable} />
          <Field label="TAN" value={f.tan ?? ''} onChange={set('tan')} disabled={!editable} placeholder="e.g. MUMS12345B" />
        </div>
        <div className="mt-3"><Area label="What the business does" rows={2} value={f.description ?? ''} onChange={(v) => setF({ ...f, description: v })} disabled={!editable} /></div>
      </Card>
      <Card title="Address and contact details">
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Address line 1" value={f.addressLine1 ?? ''} onChange={set('addressLine1')} disabled={!editable} />
          <Field label="Address line 2" value={f.addressLine2 ?? ''} onChange={set('addressLine2')} disabled={!editable} />
          <Field label="City" value={f.city ?? ''} onChange={set('city')} disabled={!editable} />
          <Field label="PIN code" inputMode="numeric" maxLength={6} value={f.pincode ?? ''} onChange={set('pincode')} disabled={!editable} />
          <Field label="Phone" value={f.phone ?? ''} onChange={set('phone')} disabled={!editable} />
          <Field label="Business email" type="email" value={f.email ?? ''} onChange={set('email')} disabled={!editable} />
          <Field label="Website" value={f.website ?? ''} onChange={set('website')} disabled={!editable} />
        </div>
        {canManage && editing && <div className="mt-3"><Button disabled={busy || !s} onClick={saveDetails}>Save details</Button></div>}
      </Card>
      <Card title="Logo">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex h-16 w-40 items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50">
            {logo ? <img src={logo} alt="Organisation logo" className="max-h-14 max-w-36 object-contain" /> : <span className="text-xs text-slate-400">No logo</span>}
          </div>
          {canManage && <>
            <label className="cursor-pointer rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50">Upload logo
              <input type="file" aria-label="Logo file" accept="image/png,image/jpeg" className="sr-only" onChange={(e) => pickLogo(e.target.files?.[0])} /></label>
            {logo && <Button variant="ghost" disabled={busy} onClick={() => run(async () => { await save(org, { logo: null }); setLogo(null); setOk('Logo removed.'); })}>Remove logo</Button>}
          </>}
        </div>
        <p className="mt-2 text-xs text-slate-500">PNG or JPEG, up to 300 KB. Printed at the top of invoices, bills and notes.</p>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- financial settings

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ZONES = ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'America/New_York', 'Australia/Sydney', 'UTC'];

function Financial({ org, canManage }: { org: Org; canManage: boolean }) {
  const { s, reload } = useOrgSettings(org);
  const [tz, setTz] = useState('Asia/Kolkata');
  const [staff, setStaff] = useState(''), [all, setAll] = useState(''), [pw, setPw] = useState('');
  const [ok, setOk] = useState('');
  const { error, busy, run } = useAction();
  useEffect(() => { if (s) { setTz(s.timezone); setStaff(s.staffLockThrough ?? ''); setAll(s.lockThrough ?? ''); } }, [s]);
  const { editing } = useEditing();
  const editable = canManage && !!s && editing;
  const fy = s ? `${MONTHS[s.fyStartMonth - 1]} to ${MONTHS[(s.fyStartMonth + 10) % 12]}` : '';
  return (
    <>
      <div className="mb-3 space-y-2"><ErrorMsg msg={error} /><Ok msg={ok} /></div>
      <Card title="Financial year and time zone">
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Financial year" value={fy} disabled readOnly />
          <Select label="Time zone" value={tz} disabled={!editable} onChange={(e) => setTz(e.target.value)}>{[...new Set([tz, ...ZONES])].map((z) => <option key={z}>{z}</option>)}</Select>
        </div>
        <p className="mt-2 text-xs text-slate-500">Indian books follow the April to March financial year (Income Tax Act and GST), so it cannot be changed.</p>
        {canManage && editing && <div className="mt-3"><Button disabled={busy || !s} onClick={() => run(async () => { await save(org, { timezone: tz }); setOk('Time zone saved.'); })}>Save</Button></div>}
      </Card>
      <Card title="Lock dates">
        <p className="mb-3 text-sm text-slate-600">Stop changes to periods you have already filed or reviewed. Nothing can be posted on or before a lock date.</p>
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <Field label="Stop staff (owners and accountants can still post) up to" aria-label="Staff lock date" type="date" value={staff} disabled={!editable} onChange={(e) => setStaff(e.target.value)} />
            <p className="mt-1 text-xs text-slate-500">Use this once a month is done, so only advisers can make late adjustments.</p>
          </div>
          <div>
            <Field label="Stop everyone, including owners, up to" aria-label="Lock date for everyone" type="date" value={all} disabled={!editable} onChange={(e) => setAll(e.target.value)} />
            <p className="mt-1 text-xs text-slate-500">Use this after filing GSTR-3B or closing the year.</p>
          </div>
        </div>
        {canManage && editing && <div className="mt-3 flex gap-2">
          <div className="w-64"><Field label="Your password, to confirm" aria-label="Password to confirm" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} /></div>
          <Button className="self-end" disabled={busy || !s || !pw} onClick={() => run(async () => { await api(`/orgs/${org.id}/lock-dates`, { method: 'PUT', body: { staffLockThrough: staff || null, lockThrough: all || null, password: pw } }); setPw(''); setOk(`Lock dates saved.${staff ? ` Staff: up to ${staff}.` : ''}${all ? ` Everyone: up to ${all}.` : ''}`); reload(); })}>Save lock dates</Button>
          {(s?.staffLockThrough || s?.lockThrough) && <Button className="self-end" variant="ghost" disabled={busy || !pw} onClick={() => run(async () => { await api(`/orgs/${org.id}/lock-dates`, { method: 'PUT', body: { staffLockThrough: null, lockThrough: null, password: pw } }); setPw(''); setOk('Lock dates removed. All periods are open again.'); reload(); })}>Remove lock dates</Button>}
        </div>}
        <p className="mt-2 text-xs text-slate-500">Locking asks for your password. Moving a lock date earlier, or removing it, unlocks books that were closed: only the owner can do that.</p>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- invoice settings (numbering)

const NUM_TYPES: [string, string][] = [['invoice', 'Invoices'], ['credit_note', 'Credit notes'], ['bill', 'Bills'], ['debit_note', 'Debit notes'], ['quote', 'Quotes'], ['purchase_order', 'Purchase orders'], ['journal', 'Journal vouchers']];

function InvoiceSettings({ org, canManage, go }: { org: Org; canManage: boolean; go: (p: string) => void }) {
  const { s, reload } = useOrgSettings(org);
  const [p, setP] = useState<Record<string, string>>({});
  const [next, setNext] = useState<Record<string, string>>({});
  const [nums, setNums] = useState<{ financialYear: string; next: Record<string, string> } | null>(null);
  const [n, setN] = useState(0);
  const [ok, setOk] = useState('');
  const { error, busy, run } = useAction();
  useEffect(() => { if (s) setP(s.prefixes); }, [s]);
  useEffect(() => { let live = true; api(`/orgs/${org.id}/numbering`).then((x) => { if (live) setNums(x); }); return () => { live = false; }; }, [org.id, n]);
  const { editing } = useEditing();
  const editable = canManage && !!s && editing;
  return (
    <>
      <div className="mb-3 space-y-2"><ErrorMsg msg={error} /><Ok msg={ok} /></div>
      <Card title="Document numbers">
        <p className="mb-3 text-sm text-slate-600">Invoices, notes and bills are numbered PREFIX/{nums?.financialYear.replace('FY ', '').slice(2) ?? 'YY-YY'}/0001 and restart every financial year, as GST requires. Quotes and orders run on.</p>
        <table className="w-full text-sm">
          <thead><tr className="text-left text-slate-500"><th className="py-1">Document</th><th>Prefix</th><th>Next number</th>{canManage && <th>Start next at</th>}</tr></thead>
          <tbody>{NUM_TYPES.map(([k, label]) => (
            <tr key={k} className="border-t border-slate-100">
              <td className="py-2 font-medium">{label}</td>
              <td><input aria-label={`${label} prefix`} maxLength={10} disabled={!editable} value={p[k] ?? ''} placeholder={s?.defaultPrefixes?.[k]} onChange={(e) => setP({ ...p, [k]: e.target.value.toUpperCase() })} className="w-28 rounded-md border border-slate-300 px-2 py-1" /></td>
              <td className="font-mono text-slate-700" data-testid={`next-${k}`}>{nums?.next[k] ?? '…'}</td>
              {canManage && <td><span className="flex items-center gap-2"><input aria-label={`${label} next number`} type="number" min={1} value={next[k] ?? ''} onChange={(e) => setNext({ ...next, [k]: e.target.value })} className="w-24 rounded-md border border-slate-300 px-2 py-1" />
                <Button variant="ghost" disabled={busy || !next[k]} onClick={() => run(async () => { await api(`/orgs/${org.id}/numbering/next`, { method: 'PUT', body: { type: k, next: Number(next[k]) } }); setNext({ ...next, [k]: '' }); setN((x) => x + 1); setOk(`${label} will continue from ${next[k]}.`); })}>Set</Button></span></td>}
            </tr>))}</tbody>
        </table>
        {canManage && editing && <div className="mt-3"><Button disabled={busy || !s} onClick={() => run(async () => { await save(org, { prefixes: p }); setOk('Prefixes saved. New documents use them; existing numbers do not change.'); reload(); setN((x) => x + 1); })}>Save prefixes</Button></div>}
        <p className="mt-2 text-xs text-slate-500">Leave a prefix empty to use the built-in one. Letters, digits and dashes only.</p>
      </Card>
      <Card title="More invoice settings">
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" onClick={() => go('sales-settings')}>Payment terms and invoice terms</Button>
          <Button variant="ghost" onClick={() => go('setup/payment')}>Bank details and UPI QR</Button>
          <Button variant="ghost" onClick={() => go('setup/reminders')}>Invoice reminders</Button>
          <Button variant="ghost" onClick={() => go('export-templates')}>Invoice look (templates)</Button>
        </div>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- payment services

const PAY_KEYS = ['bankAccountName', 'bankName', 'bankAccountNo', 'bankIfsc', 'upiId'] as const;
function PaymentServices({ org, canManage }: { org: Org; canManage: boolean }) {
  const { s, reload } = useOrgSettings(org);
  const [f, setF] = useState<Record<string, string>>({});
  const [show, setShow] = useState(false), [qr, setQr] = useState(false);
  const [ok, setOk] = useState('');
  const { error, busy, run } = useAction();
  useEffect(() => { if (s) { setF(Object.fromEntries(PAY_KEYS.map((k) => [k, s[k] ?? '']))); setShow(s.showPaymentOnInvoice); setQr(s.showUpiQr); } }, [s]);
  const { editing } = useEditing();
  const editable = canManage && !!s && editing;
  const set = (k: string, up = false) => (e: { target: { value: string } }) => setF({ ...f, [k]: up ? e.target.value.toUpperCase() : e.target.value });
  return (
    <>
      <div className="mb-3 space-y-2"><ErrorMsg msg={error} /><Ok msg={ok} /></div>
      <Card title="Bank account for customer payments">
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Account name" value={f.bankAccountName ?? ''} onChange={set('bankAccountName')} disabled={!editable} />
          <Field label="Bank name" value={f.bankName ?? ''} onChange={set('bankName')} disabled={!editable} />
          <Field label="Account number" inputMode="numeric" value={f.bankAccountNo ?? ''} onChange={set('bankAccountNo')} disabled={!editable} />
          <Field label="IFSC" maxLength={11} value={f.bankIfsc ?? ''} onChange={set('bankIfsc', true)} disabled={!editable} placeholder="e.g. HDFC0001234" />
          <Field label="UPI ID" value={f.upiId ?? ''} onChange={set('upiId')} disabled={!editable} placeholder="e.g. business@okhdfcbank" />
        </div>
        <div className="mt-4 space-y-2">
          <Toggle label="Print these payment details on sales invoices" checked={show} onChange={setShow} disabled={!editable} />
          <Toggle label="Add a UPI QR code with the invoice amount (customers scan to pay)" checked={qr} onChange={setQr} disabled={!editable || !show} />
        </div>
        {canManage && editing && <div className="mt-3"><Button disabled={busy || !s} onClick={() => run(async () => {
          await save(org, { ...Object.fromEntries(PAY_KEYS.map((k) => [k, nul(f[k] ?? '')])), showPaymentOnInvoice: show, showUpiQr: show && qr });
          setOk(show ? `Saved. Sales invoices now show how to pay${show && qr && f.upiId ? ', with a UPI QR code for the amount due' : ''}.` : 'Saved. Payment details are not printed on invoices.'); reload();
        })}>Save</Button></div>}
        <p className="mt-2 text-xs text-slate-500">The QR code is a standard UPI link (BHIM, Google Pay, PhonePe, Paytm and bank apps) for the invoice amount after TDS. It is left out on foreign-currency invoices.</p>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- email settings

const MAIL_KEYS = ['emailSenderName', 'emailReplyTo', 'emailInvoiceSubject', 'emailInvoiceBody', 'emailReminderSubject', 'emailReminderBody'] as const;
function EmailSettings({ org, canManage }: { org: Org; canManage: boolean }) {
  const { s, reload } = useOrgSettings(org);
  const [f, setF] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<{ subject: string; body: string } | null>(null);
  const [ok, setOk] = useState('');
  const { error, busy, run } = useAction();
  useEffect(() => {
    if (!s) return;
    const d = s.defaultTemplates;
    setF({ emailSenderName: s.emailSenderName ?? '', emailReplyTo: s.emailReplyTo ?? '', emailInvoiceSubject: s.emailInvoiceSubject ?? d.invoiceSubject, emailInvoiceBody: s.emailInvoiceBody ?? d.invoiceBody,
      emailReminderSubject: s.emailReminderSubject ?? d.reminderSubject, emailReminderBody: s.emailReminderBody ?? d.reminderBody });
  }, [s]);
  const { editing } = useEditing();
  const editable = canManage && !!s && editing;
  const set = (k: string) => (v: string) => setF({ ...f, [k]: v });
  const show = (subject: string, body: string) => run(async () => setPreview(await api(`/orgs/${org.id}/email-preview`, { body: { subject, body } })));
  return (
    <>
      <div className="mb-3 space-y-2"><ErrorMsg msg={error} /><Ok msg={ok} /></div>
      <Card title="Sender">
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Sender name" value={f.emailSenderName ?? ''} onChange={(e) => set('emailSenderName')(e.target.value)} disabled={!editable} placeholder={org.name} />
          <Field label="Replies go to" type="email" value={f.emailReplyTo ?? ''} onChange={(e) => set('emailReplyTo')(e.target.value)} disabled={!editable} placeholder="accounts@yourbusiness.in" />
        </div>
      </Card>
      <Card title="Templates">
        <p className="mb-3 text-sm text-slate-600">These words are filled in: <code>{'{contact}'}</code> <code>{'{number}'}</code> <code>{'{amount}'}</code> <code>{'{due}'}</code> <code>{'{org}'}</code> <code>{'{type}'}</code>. "Regards" and your organisation name are added at the end.</p>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-slate-800">Invoice email</h3>
            <Field label="Invoice email subject" value={f.emailInvoiceSubject ?? ''} onChange={(e) => set('emailInvoiceSubject')(e.target.value)} disabled={!editable} />
            <Area label="Invoice email message" value={f.emailInvoiceBody ?? ''} onChange={set('emailInvoiceBody')} disabled={!editable} />
            <Button variant="ghost" disabled={busy || !s} onClick={() => show(f.emailInvoiceSubject, f.emailInvoiceBody)}>Preview invoice email</Button>
          </div>
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-slate-800">Payment reminder</h3>
            <Field label="Reminder subject" value={f.emailReminderSubject ?? ''} onChange={(e) => set('emailReminderSubject')(e.target.value)} disabled={!editable} />
            <Area label="Reminder message" value={f.emailReminderBody ?? ''} onChange={set('emailReminderBody')} disabled={!editable} />
            <Button variant="ghost" disabled={busy || !s} onClick={() => show(f.emailReminderSubject, f.emailReminderBody)}>Preview reminder</Button>
          </div>
        </div>
        {preview && <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm" data-testid="email-preview"><p><b>Subject:</b> {preview.subject}</p><pre className="mt-2 whitespace-pre-wrap font-sans text-slate-700">{preview.body}</pre></div>}
        {canManage && editing && <div className="mt-3 flex gap-2">
          <Button disabled={busy || !s} onClick={() => run(async () => { await save(org, Object.fromEntries(MAIL_KEYS.map((k) => [k, nul(f[k] ?? '')]))); setOk('Email settings saved.'); reload(); })}>Save</Button>
          <Button variant="ghost" disabled={busy || !s} onClick={() => run(async () => { await save(org, { emailInvoiceSubject: null, emailInvoiceBody: null, emailReminderSubject: null, emailReminderBody: null }); setOk('Templates reset to the standard wording.'); setPreview(null); reload(); })}>Reset templates</Button>
        </div>}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- invoice reminders

function Reminders({ org, canManage, canPost }: { org: Org; canManage: boolean; canPost: boolean }) {
  const { s, reload } = useOrgSettings(org);
  const [auto, setAuto] = useState(false), [days, setDays] = useState('7');
  const [ok, setOk] = useState('');
  const { error, busy, run } = useAction();
  useEffect(() => { if (s) { setAuto(s.autoRemind); setDays(String(s.remindEveryDays)); } }, [s]);
  const { editing } = useEditing();
  const editable = canManage && !!s && editing;
  return (
    <>
      <div className="mb-3 space-y-2"><ErrorMsg msg={error} /><Ok msg={ok} /></div>
      <Card title="Reminders for overdue invoices">
        <div className="space-y-3">
          <Toggle label="Send reminders automatically every day" checked={auto} onChange={setAuto} disabled={!editable} />
          <div className="max-w-xs"><Field label="Wait this many days between reminders" aria-label="Days between reminders" type="number" min={1} max={90} value={days} disabled={!editable} onChange={(e) => setDays(e.target.value)} /></div>
        </div>
        <p className="mt-2 text-xs text-slate-500">A reminder goes to each customer with an email address, for every unpaid invoice past its due date. The wording is in Email settings.</p>
        <div className="mt-3 flex gap-2">
          {canManage && <Button disabled={busy || !s} onClick={() => run(async () => { await save(org, { autoRemind: auto, remindEveryDays: Number(days) }); setOk(auto ? `Saved. Reminders go out automatically, at most once every ${days} day(s) per invoice.` : 'Saved. Reminders are sent only when you click Send now.'); reload(); })}>Save</Button>}
          {canPost && <Button variant="ghost" disabled={busy} onClick={() => run(async () => { const r = await api(`/orgs/${org.id}/reminders/run`, { body: {} }); setOk(r.reminders ? `${r.reminders} reminder(s) queued.` : 'No overdue invoice needs a reminder right now.'); })}>Send reminders now</Button>}
        </div>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- currencies

function Currencies({ org, canManage }: { org: Org; canManage: boolean }) {
  const [list, setList] = useState<{ code: string; rate: number; updatedAt: string }[] | null>(null);
  const [f, setF] = useState({ code: '', rate: '' });
  const [ok, setOk] = useState('');
  const { error, busy, run } = useAction();
  const load = () => api(`/orgs/${org.id}/currencies`).then(setList);
  useEffect(() => { load(); }, [org.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <div className="mb-3 space-y-2"><ErrorMsg msg={error} /><Ok msg={ok} /></div>
      <Card title="Base currency"><p className="text-sm text-slate-700">Indian Rupee (INR). Books, GST and reports are always in rupees.</p></Card>
      <Card title="Foreign currencies">
        {canManage && <div className="mb-4 flex flex-wrap items-end gap-3">
          <div className="w-32"><Field label="Currency code" maxLength={3} placeholder="USD" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></div>
          <div className="w-40"><Field label="Rupees per 1 unit" aria-label="Default rate" inputMode="decimal" placeholder="83.25" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} /></div>
          <Button disabled={busy || f.code.length !== 3 || !(Number(f.rate) > 0)} onClick={() => run(async () => { await api(`/orgs/${org.id}/currencies`, { body: { code: f.code, rate: Number(f.rate) } }); setOk(`${f.code} saved at ₹${f.rate}.`); setF({ code: '', rate: '' }); await load(); })}>Add or update</Button>
        </div>}
        {!list ? <p className="text-sm text-slate-500">Loading…</p> : list.length === 0 ? <Empty text="No foreign currencies yet. Add one to bill or buy in it." /> : (
          <table className="w-full text-sm" data-testid="currency-rows">
            <thead><tr className="text-left text-slate-500"><th className="py-1">Currency</th><th className="text-right">Default rate (₹)</th><th>Updated</th><th /></tr></thead>
            <tbody>{list.map((c) => <tr key={c.code} className="border-t border-slate-100"><td className="py-2 font-medium">{c.code}</td><td className="text-right">{c.rate}</td><td>{String(c.updatedAt).slice(0, 10)}</td>
              <td className="text-right">{canManage && <Button variant="ghost" aria-label={`Remove ${c.code}`} disabled={busy} onClick={() => run(async () => { await api(`/orgs/${org.id}/currencies/${c.code}`, { method: 'DELETE' }); setOk(`${c.code} removed.`); await load(); })}>Remove</Button>}</td></tr>)}</tbody>
          </table>)}
        <p className="mt-3 text-xs text-slate-500">When you pick one of these currencies on an invoice or bill, its rate is filled in for you. You can still change it on the document.</p>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- tax rates

function TaxRates() {
  const [gst, setGst] = useState<{ rateBp: number; label: string }[]>([]);
  const [tds, setTds] = useState<{ code: string; description: string; rateIndividualBp: number; rateOtherBp: number; singleThreshold: number; annualThreshold: number }[]>([]);
  useEffect(() => { api('/config/gst-rates').then(setGst); api('/config/tds-sections').then(setTds); }, []);
  const pct = (bp: number) => `${bp / 100}%`;
  return (
    <>
      <Card title="GST rates">
        <table className="w-full text-sm" data-testid="gst-rates">
          <thead><tr className="text-left text-slate-500"><th className="py-1">Rate</th><th>Name</th><th>Within the state</th><th>Other states</th></tr></thead>
          <tbody>{gst.map((r) => <tr key={r.rateBp} className="border-t border-slate-100"><td className="py-2 font-medium">{pct(r.rateBp)}</td><td>{r.label}</td><td>CGST {pct(r.rateBp / 2)} + SGST {pct(r.rateBp / 2)}</td><td>IGST {pct(r.rateBp)}</td></tr>)}</tbody>
        </table>
        <p className="mt-2 text-xs text-slate-500">CGST + SGST or IGST is chosen on each document from the place of supply. Rates follow the GST Council notifications.</p>
      </Card>
      <Card title="TDS sections">
        <table className="w-full text-sm" data-testid="tds-rates">
          <thead><tr className="text-left text-slate-500"><th className="py-1">Section</th><th>Payment</th><th className="text-right">Individual / HUF</th><th className="text-right">Others</th><th className="text-right">Single payment limit</th><th className="text-right">Yearly limit</th></tr></thead>
          <tbody>{tds.map((t) => <tr key={t.code} className="border-t border-slate-100"><td className="py-2 font-medium">{t.code}</td><td>{t.description}</td><td className="text-right">{pct(t.rateIndividualBp)}</td><td className="text-right">{pct(t.rateOtherBp)}</td>
            <td className="text-right">{t.singleThreshold ? `₹${fmt(t.singleThreshold)}` : '—'}</td><td className="text-right">{t.annualThreshold ? `₹${fmt(t.annualThreshold)}` : '—'}</td></tr>)}</tbody>
        </table>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- history and notes

const ACTION_TEXT: Record<string, string> = { update_settings: 'Changed settings', create: 'Created', update: 'Updated', void: 'Voided', edit: 'Edited', email: 'Emailed', remind_overdue: 'Sent payment reminders',
  auto_remind_overdue: 'Sent automatic reminders', lock_period: 'Locked the books', lock_dates: 'Changed lock dates', set_next_number: 'Changed the next number', set_currency: 'Saved a currency', remove_currency: 'Removed a currency' };
function History({ org }: { org: Org }) {
  const [rows, setRows] = useState<{ id: number; at: string; user: string; action: string; entity: string; entityId: string | null; after: unknown }[] | null>(null);
  const [q, setQ] = useState('');
  const { error, run } = useAction();
  const load = (term = q) => run(async () => setRows(await api(`/orgs/${org.id}/history?limit=200${term ? `&q=${encodeURIComponent(term)}` : ''}`)));
  useEffect(() => { load(''); }, [org.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <ErrorMsg msg={error} />
      <Card title="Changes, newest first" actions={<span className="flex gap-2"><input aria-label="Filter history" placeholder="e.g. document, settings" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && load()} className="w-56 rounded-md border border-slate-300 px-3 py-1.5 text-sm" /><Button variant="ghost" onClick={() => load()}>Filter</Button>
        <ExportMenu orgId={org.id} disabled={!rows?.length} build={() => ({ title: 'History', subtitle: q ? `Filter: ${q}` : 'Newest first',
          columns: [{ header: 'When' }, { header: 'Who' }, { header: 'What' }, { header: 'Record' }, { header: 'Details' }],
          rows: (rows ?? []).map((r) => [new Date(r.at).toLocaleString('en-IN'), r.user, ACTION_TEXT[r.action] ?? r.action.replace(/_/g, ' '), `${r.entity.replace(/_/g, ' ')}${r.entityId ? ` #${r.entityId}` : ''}`, r.after ? JSON.stringify(r.after).slice(0, 1500) : '']) })} /></span>}>
        {!rows ? <p className="text-sm text-slate-500">Loading…</p> : rows.length === 0 ? <Empty text="Nothing recorded yet." /> : (
          <table className="w-full text-sm" data-testid="history-rows">
            <thead><tr className="text-left text-slate-500"><th className="py-1">When</th><th>Who</th><th>What</th><th>Record</th></tr></thead>
            <tbody>{rows.map((r) => <tr key={r.id} className="border-t border-slate-100 align-top"><td className="whitespace-nowrap py-2 text-slate-600">{new Date(r.at).toLocaleString('en-IN')}</td><td>{r.user}</td>
              <td>{ACTION_TEXT[r.action] ?? r.action.replace(/_/g, ' ')}</td><td className="text-slate-600">{r.entity.replace(/_/g, ' ')}{r.entityId ? ` #${r.entityId}` : ''}</td></tr>)}</tbody>
          </table>)}
        <p className="mt-3 text-xs text-slate-500">The history cannot be edited or deleted, so it can be shown to an auditor.</p>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- one section

export function SettingsSection({ org, role, sub, go }: { org: Org; role: string; sub?: string; go: (p: string) => void }) {
  const canManage = role === 'owner' || role === 'accountant', canPost = role !== 'client';
  const title = SETUP_SECTIONS[sub ?? ''];
  if (!title) return <Empty text="That setting was not found." />;
  if (sub === 'history' && !canManage) return <><PageHeader title={title} /><Empty text="Only owners and accountants can see the history." /></>;
  const SUB: Record<string, string> = {
    financial: 'Financial year, time zone and the dates up to which the books are locked.', invoice: 'How invoices, notes, bills, quotes and purchase orders are numbered.',
    payment: 'How customers can pay you, printed on every sales invoice.', email: 'Who emails come from and what they say.', reminders: 'Chase overdue invoices without writing each email.',
    currencies: 'Currencies you invoice or buy in, with the exchange rate to start from.', 'tax-rates': 'The GST rates and TDS sections the app applies.', history: 'Every change made in these books.',
    taxes: 'GST, PAN and TAN, the Letter of Undertaking for exports, and ledgers for duties and taxes.',
  };
  return (
    <>
      <PageHeader title={title} subtitle={SUB[sub!]} />
      <EditMode canManage={canManage && !['history', 'tax-rates'].includes(sub!)}>
      <div className="space-y-5">
        {sub === 'financial' && <Financial org={org} canManage={canManage} />}
        {sub === 'invoice' && <InvoiceSettings org={org} canManage={canManage} go={go} />}
        {sub === 'payment' && <PaymentServices org={org} canManage={canManage} />}
        {sub === 'email' && <EmailSettings org={org} canManage={canManage} />}
        {sub === 'reminders' && <Reminders org={org} canManage={canManage} canPost={canPost} />}
        {sub === 'currencies' && <Currencies org={org} canManage={canManage} />}
        {sub === 'tax-rates' && <TaxRates />}
        {sub === 'history' && <History org={org} />}
        {sub === 'taxes' && <DutiesAndTaxes org={org} canManage={canManage} go={go} />}
      </div>
      </EditMode>
    </>
  );
}

// ---------------------------------------------------------------- duties and taxes

/** GST, PAN and TAN, the LUT for zero-rated supplies, and the ledgers for duties and taxes (add one for customs duty, cess…). */
function DutiesAndTaxes({ org, canManage, go }: { org: Org; canManage: boolean; go: (p: string) => void }) {
  const { editing } = useEditing();
  const [f, setF] = useState<{ gstin: string; pan: string; tan: string; gstScheme: string; lutNumber: string; lutFrom: string; lutTo: string } | null>(null);
  const [ledgers, setLedgers] = useState<{ id: number; code: string; name: string; group: string; subGroup: string | null; isActive: boolean }[]>([]);
  const [nl, setNl] = useState({ name: '', subGroup: 'Other Statutory Dues' });
  const [ok, setOk] = useState('');
  const { error, busy, run } = useAction();
  const load = () => {
    api(`/orgs/${org.id}/settings`).then((s) => setF({ gstin: s.gstin ?? '', pan: s.pan ?? '', tan: s.tan ?? '', gstScheme: s.gstScheme, lutNumber: s.lutNumber ?? '', lutFrom: s.lutFrom ?? '', lutTo: s.lutTo ?? '' }));
    api<any[]>(`/orgs/${org.id}/accounts`).then((a) => setLedgers(a.filter((x) => /duties|tax|gst|tds|statutory/i.test(`${x.group} ${x.subGroup ?? ''}`) && x.type === 'liability')));
  };
  useEffect(load, [org.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!f) return <p className="text-slate-500">Loading…</p>;
  const editable = canManage && editing;
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: k === 'lutFrom' || k === 'lutTo' || k === 'gstScheme' ? e.target.value : e.target.value.toUpperCase() });
  const lutOk = !f.lutNumber ? 'No LUT entered: exports and SEZ supplies need IGST.' : f.lutTo && f.lutTo < new Date().toISOString().slice(0, 10) ? `The LUT ended on ${f.lutTo}: enter the new one.` : `LUT ${f.lutNumber}${f.lutTo ? ` valid up to ${f.lutTo}` : ''}: exports and SEZ supplies can be zero-rated.`;
  return (
    <>
      <div className="mb-3 space-y-2"><ErrorMsg msg={error} /><Ok msg={ok} /></div>
      <Card title="Registrations">
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="GSTIN" value={f.gstin} onChange={set('gstin')} disabled={!editable} />
          <Field label="PAN" value={f.pan} onChange={set('pan')} disabled={!editable} />
          <Field label="TAN (for TDS)" aria-label="TAN" value={f.tan} onChange={set('tan')} disabled={!editable} placeholder="e.g. PNEA12345B" />
          <Select label="GST scheme" aria-label="GST scheme" value={f.gstScheme} disabled={!editable} onChange={set('gstScheme')}><option value="regular">Regular</option><option value="composition">Composition</option></Select>
        </div>
      </Card>
      <Card title="Letter of Undertaking (LUT) for exports and SEZ">
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="LUT / ARN number" aria-label="LUT number" value={f.lutNumber} onChange={set('lutNumber')} disabled={!editable} />
          <Field label="Valid from" aria-label="LUT valid from" type="date" value={f.lutFrom} onChange={set('lutFrom')} disabled={!editable} />
          <Field label="Valid up to" aria-label="LUT valid up to" type="date" value={f.lutTo} onChange={set('lutTo')} disabled={!editable} />
        </div>
        <p className="mt-2 text-xs text-slate-500">{lutOk} An overseas or SEZ customer's invoice picks "under LUT" while it is valid, and "with IGST" otherwise.</p>
      </Card>
      {editable && <div><Button disabled={busy} onClick={() => run(async () => {
        await api(`/orgs/${org.id}/settings`, { method: 'PUT', body: { gstin: f.gstin || null, pan: f.pan || null, tan: f.tan || null, gstScheme: f.gstScheme, lutNumber: f.lutNumber || null, lutFrom: f.lutFrom || null, lutTo: f.lutTo || null } });
        setOk('Duties and taxes saved.'); load();
      })}>Save duties and taxes</Button></div>}
      <Card title="Ledgers for duties and taxes">
        <table className="w-full text-sm"><thead><tr className="text-left"><th>Code</th><th>Ledger</th><th>Group</th><th>Sub-group</th></tr></thead>
          <tbody>{ledgers.map((l) => <tr key={l.id}><td>{l.code}</td><td>{l.name}{!l.isActive && <span className="ml-1 text-xs text-slate-400">archived</span>}</td><td>{l.group}</td><td>{l.subGroup ?? '—'}</td></tr>)}</tbody></table>
        {editable && (
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <div className="w-64"><Field label="New duty or tax ledger" aria-label="New duty ledger" placeholder="e.g. Customs Duty Payable" value={nl.name} onChange={(e) => setNl({ ...nl, name: e.target.value })} /></div>
            <Select label="Sub-group" aria-label="Duty sub-group" value={nl.subGroup} onChange={(e) => setNl({ ...nl, subGroup: e.target.value })}>
              {['Output Tax Liability', 'TDS Payable', 'Other Statutory Dues'].map((x) => <option key={x}>{x}</option>)}</Select>
            <Button disabled={busy || !nl.name.trim()} onClick={() => run(async () => {
              const r = await api(`/orgs/${org.id}/accounts`, { body: { fsli: 'cl', group: 'Duties & Taxes', subGroup: nl.subGroup, name: nl.name.trim() } });
              setOk(`Ledger ${r.code} · ${nl.name.trim()} created under Current Liabilities › Duties & Taxes › ${nl.subGroup}.`); setNl({ ...nl, name: '' }); load();
            })}>Create ledger</Button>
            <Button variant="ghost" onClick={() => go('coa')}>Open chart of accounts</Button>
          </div>)}
        <p className="mt-2 text-xs text-slate-500">GST, cess and TDS ledgers are created and posted to automatically. Add your own here for other duties, such as customs duty paid on imports.</p>
      </Card>
    </>
  );
}
