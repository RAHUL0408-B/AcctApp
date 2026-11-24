// Batch payments and receipts: each one settled several bills or invoices with a single bank entry.
import { useCallback, useEffect, useState } from 'react';
import { api, fmt } from '../api';
import type { Org } from '../App';
import { Badge, Empty, PageHeader } from '../kit';
import { Button, Callout, Card, ErrorMsg, Ok, useAction , ask } from '../ui';
import { DataTable } from '../table';

interface Batch { id: number; side: 'pay' | 'receive'; date: string; reference: string | null; total: number; status: string; account: string; items: { documentId: number; number: string; contact: string; amount: number }[] }

export function BatchPayments({ org, canPost, go, focusId }: { org: Org; canPost: boolean; go: (p: string) => void; /** opened from a payment that belongs to this batch */ focusId?: number }) {
  const [list, setList] = useState<Batch[] | null>(null);
  const [ok, setOk] = useState('');
  const { error, busy, run } = useAction();
  const load = useCallback(() => api<Batch[]>(`/orgs/${org.id}/payment-batches`).then(setList), [org.id]);
  useEffect(() => { load(); }, [load]);
  const undo = (b: Batch) => run(async () => {
    if (!await ask(`Undo batch ${b.side === 'pay' ? 'payment' : 'receipt'} #${b.id} of ₹${fmt(b.total)}? Its entry is reversed and the ${b.items.length} document(s) become outstanding again.`)) return;
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
        {focusId && <div className="mb-3"><Callout tone="info">Batch #{focusId} is highlighted below. To change one of its payments, undo the whole batch and record it again.</Callout></div>}
        {!list ? <p className="text-sm text-slate-500">Loading…</p> : (
          <div data-testid="batch-rows">
          <DataTable dateKey="date" facets={['status', 'type', 'kind', 'group', 'side']} id="batches" rows={list} rowKey={(b) => b.id} orgId={org.id} exportTitle="Batch payments" empty="No batch payments yet." searchLabel="Search batches (number, party, reference)"
            rowClass={(b) => (b.id === focusId ? 'bg-amber-50 font-medium' : '')}
            columns={[
              { key: 'id', label: '#', value: (b) => b.id },
              { key: 'date', label: 'Date', value: (b) => b.date },
              { key: 'kind', label: 'Kind', value: (b) => (b.side === 'pay' ? 'Payment' : 'Receipt') },
              { key: 'account', label: 'Account', value: (b) => b.account },
              { key: 'reference', label: 'Reference', value: (b) => b.reference },
              { key: 'parties', label: 'Parties', value: (b) => [...new Set(b.items.map((i) => i.contact))].join(', '), hidden: true },
              { key: 'docs', label: 'Documents', value: (b) => (b.items.length ? b.items.map((i) => `${i.number} (${i.contact})`).join(', ') : null) },
              { key: 'count', label: 'How many', value: (b) => b.items.length, hidden: true, noSearch: true },
              { key: 'total', label: 'Total', value: (b) => b.total, money: true, noSearch: true },
              { key: 'status', label: 'Status', value: (b) => (b.status === 'posted' ? 'posted' : 'undone'), render: (b) => <Badge text={b.status === 'posted' ? 'posted' : 'undone'} /> },
            ]}
            trailing={(b) => (canPost && b.status === 'posted' ? <Button variant="ghost" disabled={busy} onClick={() => undo(b)}>Undo</Button> : null)} />
          </div>)}
      </Card>
    </>
  );
}
