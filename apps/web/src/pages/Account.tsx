// Account-level pages: billing, privacy (DPDP rights), help.
import { useCallback, useEffect, useState } from 'react';
import { api, fmt, setToken } from '../api';
import type { Me } from '../App';
import { APP_NAME, Button, Card, ErrorMsg, Field, Ok, useAction } from '../ui';

export function Billing({ me }: { me: Me }) {
  const firm = me.memberships.find((m) => m.orgId === null && m.role === 'owner');
  const [plans, setPlans] = useState<any[]>([]);
  const [b, setB] = useState<any>(null);
  const [ok, setOk] = useState('');
  const { error, busy, run } = useAction();
  const load = useCallback(() => { if (firm) api(`/firms/${firm.firmId}/billing`).then(setB); }, [firm?.firmId]);
  useEffect(() => { api('/plans').then(setPlans); load(); }, [load]);
  if (!firm) return <Card title="Billing"><p className="text-sm">Only the firm owner can manage billing.</p></Card>;
  return (
    <>
      {b && <Card title="Your plan">
        <p className="text-sm">Current: <b data-testid="current-plan">{b.effectivePlan.name}</b> ({b.subscription?.status}{b.subscription?.trialEnds ? `, trial ends ${b.subscription.trialEnds}` : ''}{b.subscription?.currentPeriodEnd ? `, paid until ${b.subscription.currentPeriodEnd}` : ''})</p>
        <p className="text-sm text-slate-600">Using {b.usage.orgs} of {b.effectivePlan.maxOrgs} clients and {b.usage.members} of {b.effectivePlan.maxMembers} team members.</p>
      </Card>}
      <div className="grid gap-4 md:grid-cols-4">{plans.map((p) => (
        <Card key={p.code} title={p.name}>
          <p className="text-2xl font-semibold">₹{fmt(p.amount)}<span className="text-sm font-normal text-slate-500">/month</span></p>
          <p className="text-xs text-slate-500">+ GST ₹{fmt(p.gst)} = ₹{fmt(p.total)}</p>
          <ul className="my-3 text-sm"><li>Up to {p.maxOrgs} client(s)</li><li>Up to {p.maxMembers} team members</li></ul>
          <Button disabled={busy || b?.effectivePlan.code === p.code} onClick={() => run(async () => { const r = await api(`/firms/${firm.firmId}/billing/subscribe`, { body: { planCode: p.code } }); setOk(`Switched to ${p.name}.${r.invoice ? ` Invoice ${r.invoice}.` : ''}`); load(); })}>
            {b?.effectivePlan.code === p.code ? 'Current plan' : 'Choose'}</Button>
        </Card>))}</div>
      <div className="space-y-2"><ErrorMsg msg={error} /><Ok msg={ok} /></div>
      {b?.invoices.length > 0 && <Card title="Billing history">{b.invoices.map((i: any) => <p key={i.id} className="flex justify-between text-sm"><span>{i.number} · {i.plan_code} · {i.period_start} to {i.period_end}</span><span>₹{fmt(i.total)} {i.status}</span></p>)}</Card>}
      <p className="text-xs text-slate-500">Payments run in test mode until a payment gateway is connected.</p>
    </>
  );
}

export function Privacy({ onDeleted }: { onDeleted: () => void }) {
  const [consents, setConsents] = useState<any[]>([]);
  const [pw, setPw] = useState(''), [confirm, setConfirm] = useState('');
  const [ok, setOk] = useState('');
  const { error, busy, run } = useAction();
  const load = () => api('/me/consents').then(setConsents);
  useEffect(() => { load(); }, []);
  const granted = (p: string) => consents.find((c) => c.purpose === p)?.granted ?? false;
  const exportData = () => run(async () => {
    const data = await api('/me/export');
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'my-data.json'; a.click();
    setOk('Your data has been downloaded.');
  });
  return (
    <>
      <Card title="Consent">
        <p className="mb-2 text-sm">Terms of service and privacy policy: accepted {consents.find((c) => c.purpose === 'terms')?.created_at?.slice(0, 10) ?? ''}</p>
        {['marketing', 'analytics'].map((p) => (
          <label key={p} className="flex items-center gap-2 text-sm"><input type="checkbox" aria-label={`${p} consent`} checked={granted(p)} onChange={(e) => run(async () => { await api('/me/consents', { body: { purpose: p, granted: e.target.checked } }); load(); })} />
            {p === 'marketing' ? 'Send me product news by email' : 'Allow anonymous usage analytics'}</label>))}
      </Card>
      <Card title="Your data">
        <p className="mb-3 text-sm">Download a copy of the personal data {APP_NAME} holds about you.</p>
        <Button variant="ghost" disabled={busy} onClick={exportData}>Download my data</Button>
      </Card>
      <Card title="Delete my account">
        <p className="mb-3 text-sm text-slate-600">Your name, email, password and 2FA are erased. Accounting entries you made stay in your clients' books, because Indian law requires businesses to keep their records, but they will no longer show who you are. If you are the only owner of a firm, add another owner first.</p>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Password" type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
          <Field label='Type "DELETE" to confirm' value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          <Button variant="danger" disabled={busy || confirm !== 'DELETE'} onClick={() => run(async () => { await api('/me/delete', { body: { password: pw, confirm } }); setToken(null); onDeleted(); })}>Delete account</Button>
        </div>
      </Card>
      <div className="space-y-2"><ErrorMsg msg={error} /><Ok msg={ok} /></div>
    </>
  );
}

const HELP: [string, string][] = [
  ['Getting started', 'Add a client from the Clients page and pick a chart of accounts template. Open the client, add customers and suppliers under Contacts, then raise invoices under Sales and record bills under Purchases.'],
  ['GST', 'Enter the client\'s GSTIN when you add them. Each line on an invoice or bill picks a GST rate. If the customer is in the same state, CGST and SGST are charged; if not, IGST. Rates come from a settings table, so they can change without a software update.'],
  ['TDS', 'On a purchase bill, choose the TDS section (for example 194J for professional fees). The tax is worked out from the section rate and threshold; the supplier is paid the net amount and the TDS goes to TDS Payable.'],
  ['Bank reconciliation', 'Connect a bank account to ledger account 1010, import a CSV statement, then match each line to a payment already in the books or create an entry for it, such as bank charges.'],
  ['Fixing mistakes', 'Posted entries are never edited or deleted. Use Reverse on a journal entry or Void on an invoice; the app posts an opposite entry so the audit trail stays complete.'],
  ['Locking periods', 'After filing returns, lock the period so nothing can be posted on or before that date.'],
  ['Reports and returns', 'Reports covers trial balance, P&L, balance sheet, ledger, aged receivables and payables, plus GSTR-1 and GSTR-3B summaries. Export any report to PDF or Excel, or schedule it by email.'],
  ['Client access', 'Firm owners can give a client a view-only login. Clients see their own books and reports and can upload documents, but cannot change anything.'],
  ['Security', 'Turn on two-factor authentication under Security. Sessions expire after 8 hours.'],
];

export function Help() {
  return (
    <Card title="Help">
      <div className="space-y-4">{HELP.map(([q, a]) => <div key={q}><h3 className="font-semibold">{q}</h3><p className="text-sm text-slate-700">{a}</p></div>)}</div>
      <p className="mt-6 text-xs text-slate-500">GST and TDS working papers are aids. Review them with a Chartered Accountant before filing.</p>
    </Card>
  );
}
