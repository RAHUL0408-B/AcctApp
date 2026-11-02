// One screen across every client: money owed, cash, and work waiting.
import { useEffect, useState } from 'react';
import { api, fmt } from '../api';
import { Empty, PageHeader, Stat } from '../kit';
import { Card } from '../ui';

interface Row { id: number; name: string; gstin: string | null; cash: number; receivable: number; receivableOverdue: number; payable: number; payableOverdue: number;
  unreconciled: number; openTasks: number; overdueTasks: number; awaitingApproval: number; lastEntry: string | null; lockedThrough: string | null }
interface Overview { clients: Row[]; totals: { clients: number; cash: number; receivable: number; receivableOverdue: number; payable: number; overdueTasks: number; unreconciled: number; awaitingApproval: number } }

export function PracticeOverview({ onOpen }: { onOpen: (id: number) => void }) {
  const [d, setD] = useState<Overview | null>(null);
  useEffect(() => { api<Overview>('/practice/overview').then(setD); }, []);
  if (!d) return <p>Loading…</p>;
  const warn = (n: number) => (n > 0 ? 'font-medium text-red-700' : 'text-slate-400');
  return (
    <>
      <PageHeader title="Practice overview" subtitle="Every client at a glance. Click a client to open its books." />
      <div className="grid gap-4 md:grid-cols-4">
        <Stat label="Clients" value={String(d.totals.clients)} testId="practice-clients" />
        <Stat label="Owed to your clients" value={`₹${fmt(d.totals.receivable)}`} sub={`₹${fmt(d.totals.receivableOverdue)} overdue`} tone={d.totals.receivableOverdue > 0 ? 'bad' : 'default'} />
        <Stat label="Bank lines to reconcile" value={String(d.totals.unreconciled)} tone={d.totals.unreconciled > 0 ? 'bad' : 'good'} />
        <Stat label="Overdue tasks / awaiting approval" value={`${d.totals.overdueTasks} / ${d.totals.awaitingApproval}`} tone={d.totals.overdueTasks > 0 ? 'bad' : 'default'} />
      </div>
      <Card>
        {d.clients.length === 0 ? <Empty text="No clients yet." /> : (
          <div className="overflow-x-auto"><table className="w-full text-sm" data-testid="practice-table">
            <thead><tr className="text-left"><th>Client</th><th className="text-right">Cash and bank</th><th className="text-right">Receivable</th><th className="text-right">Overdue</th><th className="text-right">Payable</th>
              <th className="text-right">To reconcile</th><th className="text-right">Overdue tasks</th><th className="text-right">Awaiting approval</th><th>Last entry</th><th>Locked to</th></tr></thead>
            <tbody>{d.clients.map((c) => (
              <tr key={c.id} className="cursor-pointer" onClick={() => onOpen(c.id)}>
                <td><span className="font-medium text-brand-700">{c.name}</span>{c.gstin && <span className="block text-xs text-slate-500">{c.gstin}</span>}</td>
                <td className="text-right">{fmt(c.cash)}</td><td className="text-right">{fmt(c.receivable)}</td><td className={`text-right ${warn(c.receivableOverdue)}`}>{fmt(c.receivableOverdue)}</td>
                <td className="text-right">{fmt(c.payable)}</td><td className={`text-right ${warn(c.unreconciled)}`}>{c.unreconciled}</td><td className={`text-right ${warn(c.overdueTasks)}`}>{c.overdueTasks}</td>
                <td className={`text-right ${warn(c.awaitingApproval)}`}>{c.awaitingApproval}</td><td>{c.lastEntry ?? '—'}</td><td>{c.lockedThrough ?? '—'}</td>
              </tr>))}</tbody></table></div>
        )}
      </Card>
    </>
  );
}
