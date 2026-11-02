// Sales overview and purchases overview: what is waiting, what is late, and the last six months at a glance.
import { useEffect, useState } from 'react';
import { api, fmt } from '../api';
import type { Org } from '../App';
import { BarChart, Empty, PageHeader, Stat } from '../kit';
import { Button, Card } from '../ui';

interface Sum { count: number; total: number }
interface Data {
  fyLabel: string; awaitingApproval: Sum; awaitingPayment: Sum; overdue: Sum; dueThisWeek: Sum;
  quotes?: { open: number; openTotal: number; accepted: number }; purchaseOrders?: { open: number; openTotal: number; accepted: number };
  months: { month: string; billed: number; paid: number }[]; top: { contact: string; total: number }[];
  oldestOverdue: { id: number; number: string; contact: string; due: string; outstanding: number }[];
}

export function Overview({ org, side, go }: { org: Org; side: 'sales' | 'purchases'; go: (p: string) => void }) {
  const [d, setD] = useState<Data | null>(null);
  useEffect(() => { setD(null); api<Data>(`/orgs/${org.id}/overview/${side}`).then(setD); }, [org.id, side]);
  const sales = side === 'sales';
  const docs = sales ? 'invoices' : 'bills', pre = sales ? d?.quotes : d?.purchaseOrders;
  const label = (m: string) => new Date(m + '-01T00:00:00Z').toLocaleString('en-IN', { month: 'short', timeZone: 'UTC' });
  return (
    <>
      <PageHeader title={sales ? 'Sales overview' : 'Purchases overview'} subtitle={sales ? 'Money owed to you and what is coming in.' : 'Money you owe and what is going out.'}
        actions={<><Button variant="ghost" onClick={() => go(sales ? 'quotes/new' : 'purchase-orders/new')}>{sales ? 'New quote' : 'New purchase order'}</Button><Button onClick={() => go(`${docs}/new`)}>{sales ? 'New invoice' : 'New bill'}</Button></>} />
      {!d ? <p className="text-sm text-slate-500">Loading…</p> : (
        <>
          <div className="grid gap-4 md:grid-cols-4">
            <Stat label="Awaiting approval" value={`₹${fmt(d.awaitingApproval.total)}`} sub={`${d.awaitingApproval.count} ${docs}`} />
            <Stat label="Awaiting payment" value={`₹${fmt(d.awaitingPayment.total)}`} sub={`${d.awaitingPayment.count} ${docs}`} testId="awaiting-payment" />
            <Stat label="Overdue" value={`₹${fmt(d.overdue.total)}`} sub={`${d.overdue.count} ${docs}`} tone={d.overdue.count ? 'bad' : 'default'} testId="overdue" />
            <Stat label="Due in the next 7 days" value={`₹${fmt(d.dueThisWeek.total)}`} sub={`${d.dueThisWeek.count} ${docs}`} />
          </div>
          <div className="mt-4 grid gap-4 md:grid-cols-3">
            <div className="md:col-span-2"><Card title={sales ? 'Invoiced and received, last 6 months' : 'Billed and paid, last 6 months'}>
              <BarChart data={d.months.map((m) => ({ label: label(m.month), values: [m.billed, m.paid] }))} series={[{ name: sales ? 'Invoiced' : 'Billed', color: '#6c5ce7' }, { name: sales ? 'Received' : 'Paid', color: '#10b981' }]} />
            </Card></div>
            <Card title={sales ? 'Quotes' : 'Purchase orders'} actions={<button className="text-sm text-brand-700 underline" onClick={() => go(sales ? 'quotes' : 'purchase-orders')}>Open</button>}>
              <p className="text-sm">{pre?.open ?? 0} open, worth ₹{fmt(pre?.openTotal ?? 0)}</p>
              <p className="mt-1 text-sm">{pre?.accepted ?? 0} accepted and ready to convert to {sales ? 'an invoice' : 'a bill'}</p>
            </Card>
          </div>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <Card title={sales ? `Top customers, ${d.fyLabel}` : `Top suppliers, ${d.fyLabel}`}>
              {d.top.length === 0 ? <Empty text="Nothing yet this year." /> : d.top.map((c) => <p key={c.contact} className="flex justify-between py-1 text-sm"><span>{c.contact}</span><span>₹{fmt(c.total)}</span></p>)}
            </Card>
            <Card title="Oldest overdue" actions={<button className="text-sm text-brand-700 underline" onClick={() => go(docs)}>All {docs}</button>}>
              {d.oldestOverdue.length === 0 ? <Empty text="Nothing overdue." /> : d.oldestOverdue.map((x) => (
                <p key={x.id} className="flex justify-between py-1 text-sm"><span>{x.number} · {x.contact} <span className="text-red-700">due {x.due}</span></span><span>₹{fmt(x.outstanding)}</span></p>))}
            </Card>
          </div>
        </>
      )}
    </>
  );
}
