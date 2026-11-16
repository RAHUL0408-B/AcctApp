// Batch payments and receipts: each one settled several bills or invoices with a single bank entry.
import { useCallback, useEffect, useState } from 'react';
import { api, fmt } from '../api';
import type { Org } from '../App';
import { Badge, Empty, PageHeader } from '../kit';
import { Button, Card, ErrorMsg, Ok, useAction } from '../ui';

interface Batch { id: number; side: 'pay' | 'receive'; date: string; reference: string | null; total: number; status: string; account: string; items: { documentId: number; number: string; contact: string; amount: number }[] }

export function BatchPayments({ org, canPost, go }: { org: Org; canPost: boolean; go: (p: string) => void }) {
  const [list, setList] = useState<Batch[] | null>(null);
  const [ok, setOk] = useState('');
  const { error, busy, run } = useAction();
  const load = useCallback(() => api<Batch[]>(`/orgs/${org.id}/payment-batches`).then(setList), [org.id]);
  useEffect(() => { load(); }, [load]);
  const undo = (b: Batch) => run(async () => {
    if (!window.confirm(`Undo batch ${b.side === 'pay' ? 'payment' : 'receipt'} #${b.id} of ₹${fmt(b.total)}? Its entry is reversed and the ${b.items.length} document(s) become outstanding again.`)) return;
    await api(`/orgs/${org.id}/payment-batches/${b.id}`, { method: 'DELETE' });
    setOk(`Batch #${b.id} undone.`); load();
  });
  return (
    <>
      <PageHeader title="Batch payments" subtitle="Several bills paid (or invoices received) with one bank payment, posted as one entry so it matches your bank statement."
        actions={canPost && <><Button variant="ghost" onClick={() => go('bills')}>Pay bills</Button><Button variant="ghost" onClick={() => go('invoices')}>Receive for invoices</Button></>} />
      <div className="mb-3 space-y-2"><ErrorMsg msg={error} /><Ok msg={ok} /></div>
      <Card>
        <p className="mb-3 text-sm text-slate-600">To make one: open Bills (or Invoices), tick the ones to settle, and choose "Pay … together".</p>
        {!list ? <p className="text-sm text-slate-500">Loading…</p> : list.length === 0 ? <Empty text="No batch payments yet." /> : (
          <table className="w-full text-sm" data-testid="batch-rows">
            <thead><tr className="text-left text-slate-500"><th className="py-1">#</th><th>Date</th><th>Kind</th><th>Account</th><th>Reference</th><th>Documents</th><th className="text-right">Total</th><th className="pl-3">Status</th><th /></tr></thead>
            <tbody>{list.map((b) => (
              <tr key={b.id} className="border-t border-slate-100 align-top">
                <td className="py-2">{b.id}</td><td>{b.date}</td><td>{b.side === 'pay' ? 'Payment' : 'Receipt'}</td><td>{b.account}</td><td>{b.reference ?? '—'}</td>
                <td>{b.items.length ? b.items.map((i) => `${i.number} (${i.contact})`).join(', ') : '—'}</td>
                <td className="text-right font-medium">{fmt(b.total)}</td>
                <td className="pl-3"><Badge text={b.status === 'posted' ? 'posted' : 'void'} />{b.status !== 'posted' && <span className="ml-1 text-xs text-slate-500">undone</span>}</td>
                <td className="text-right">{canPost && b.status === 'posted' && <Button variant="ghost" disabled={busy} onClick={() => undo(b)}>Undo</Button>}</td>
              </tr>))}</tbody>
          </table>)}
      </Card>
    </>
  );
}
