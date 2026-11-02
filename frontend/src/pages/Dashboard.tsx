import { useEffect, useState } from 'react';
import { api, fmt } from '../api';
import type { Org } from '../App';
import { BarChart, PageHeader, Stat } from '../kit';
import { Card } from '../ui';

interface Dash {
  banks: { id: number; name: string; balance: number; unreconciled: number }[]; cashInHand: number; totalCash: number;
  receivables: { total: number; overdue: number; top: { contact: string; total: number }[] }; payables: { total: number; overdue: number };
  months: { month: string; income: number; expense: number; cashIn: number; cashOut: number }[];
  ytd: { label: string; income: number; expense: number; profit: number }; tasks: { open: number; overdue: number };
}

export function Dashboard({ org, go }: { org: Org; go: (page: string) => void }) {
  const [d, setD] = useState<Dash | null>(null);
  useEffect(() => { api<Dash>(`/orgs/${org.id}/dashboard`).then(setD); }, [org.id]);
  if (!d) return <p>Loading…</p>;
  const label = (m: string) => new Date(m + '-01T00:00:00Z').toLocaleString('en-IN', { month: 'short', timeZone: 'UTC' });
  const toReconcile = d.banks.reduce((s, b) => s + b.unreconciled, 0);
  return (
    <>
      <PageHeader title="Dashboard" subtitle={`${org.name} · ${d.ytd.label}`} />
      <div className="grid gap-4 md:grid-cols-4">
        <Stat label="Cash and bank" value={`₹${fmt(d.totalCash)}`} sub={`${d.banks.length} bank account(s)`} testId="total-cash" />
        <Stat label="Owed to you" value={`₹${fmt(d.receivables.total)}`} sub={`₹${fmt(d.receivables.overdue)} overdue`} tone={d.receivables.overdue > 0 ? 'bad' : 'default'} testId="receivables" />
        <Stat label="You owe" value={`₹${fmt(d.payables.total)}`} sub={`₹${fmt(d.payables.overdue)} overdue`} tone={d.payables.overdue > 0 ? 'bad' : 'default'} testId="payables" />
        <Stat label={`Profit ${d.ytd.label}`} value={`₹${fmt(d.ytd.profit)}`} sub={`Income ₹${fmt(d.ytd.income)} · Expenses ₹${fmt(d.ytd.expense)}`} tone={d.ytd.profit < 0 ? 'bad' : 'good'} testId="ytd-profit" />
      </div>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <Card title="Income and expenses, last 6 months"><BarChart data={d.months.map((m) => ({ label: label(m.month), values: [m.income, m.expense] }))} series={[{ name: 'Income', color: '#6c5ce7' }, { name: 'Expenses', color: '#e11d48' }]} /></Card>
        <Card title="Cash in and out, last 6 months"><BarChart data={d.months.map((m) => ({ label: label(m.month), values: [m.cashIn, m.cashOut] }))} series={[{ name: 'Cash in', color: '#2563eb' }, { name: 'Cash out', color: '#f59e0b' }]} /></Card>
      </div>
      <div className="mt-4 grid gap-4 md:grid-cols-3">
        <Card title="Bank accounts" actions={<button className="text-sm text-brand-700 underline" onClick={() => go('bank')}>Open</button>}>
          {d.banks.length === 0 ? <p className="text-sm text-slate-500">No bank account connected yet.</p> : d.banks.map((b) => (
            <p key={b.id} className="flex justify-between py-1 text-sm"><span>{b.name}{b.unreconciled > 0 && <span className="ml-2 rounded bg-amber-100 px-1.5 text-xs text-amber-800">{b.unreconciled} to reconcile</span>}</span><span>₹{fmt(b.balance)}</span></p>))}
          {toReconcile === 0 && d.banks.length > 0 && <p className="mt-2 text-xs text-green-700">✓ Everything reconciled</p>}
        </Card>
        <Card title="Who owes you most" actions={<button className="text-sm text-brand-700 underline" onClick={() => go('invoices')}>Invoices</button>}>
          {d.receivables.top.length === 0 ? <p className="text-sm text-slate-500">Nobody owes you anything.</p> : d.receivables.top.map((c) => <p key={c.contact} className="flex justify-between py-1 text-sm"><span>{c.contact}</span><span>₹{fmt(c.total)}</span></p>)}
        </Card>
        <Card title="Tasks" actions={<button className="text-sm text-brand-700 underline" onClick={() => go('tasks')}>Open</button>}>
          <p className="text-sm">{d.tasks.open} open{d.tasks.overdue > 0 && <span className="ml-2 font-medium text-red-700">{d.tasks.overdue} overdue</span>}</p>
          <p className="mt-2 text-xs text-slate-500">GST and TDS due dates are added from Tasks.</p>
        </Card>
      </div>
    </>
  );
}
