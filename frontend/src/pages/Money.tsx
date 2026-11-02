// Spend money, receive money and transfer money between bank accounts, without an invoice or bill.
import { useEffect, useState } from 'react';
import { api, fmt, toPaise, today } from '../api';
import type { Org } from '../App';
import { Empty, PageHeader, Select } from '../kit';
import { Button, Card, ErrorMsg, Field, Ok, useAction } from '../ui';
import type { Account } from './Lines';

type Tab = 'spend' | 'receive' | 'transfer';
const TITLES: Record<Tab, [string, string]> = {
  spend: ['Spend money', 'Money paid straight from the bank without a bill: bank charges, small expenses, drawings.'],
  receive: ['Receive money', 'Money received without an invoice: interest, refunds, capital introduced.'],
  transfer: ['Transfer money', 'Move money between two of your bank accounts.'],
};
const blank = () => ({ accountId: '', description: '', amount: '' });

export function Money({ org, canPost, accounts, tab, go }: { org: Org; canPost: boolean; accounts: Account[]; tab: Tab; go: (p: string) => void }) {
  const [banks, setBanks] = useState<{ id: number; name: string; accountId: number }[]>([]);
  const [f, setF] = useState({ bankId: '', toBankId: '', date: today(), payee: '', reference: '', amount: '' });
  const [lines, setLines] = useState([blank()]);
  const [ok, setOk] = useState('');
  const { error, busy, run } = useAction();
  useEffect(() => { api(`/orgs/${org.id}/bank-accounts`).then((b) => { setBanks(b); if (b[0]) setF((x) => ({ ...x, bankId: x.bankId || String(b[0].id) })); }); }, [org.id]);
  useEffect(() => { setOk(''); }, [tab]);

  const bank = banks.find((b) => String(b.id) === f.bankId);
  const total = lines.reduce((s, l) => { try { return s + (l.amount ? toPaise(l.amount) : 0); } catch { return s; } }, 0);
  const submit = () => run(async () => {
    setOk('');
    if (tab === 'transfer') {
      const r = await api(`/orgs/${org.id}/bank-transfers`, { body: { date: f.date, fromBankAccountId: Number(f.bankId), toBankAccountId: Number(f.toBankId), amount: toPaise(f.amount), ...(f.reference ? { reference: f.reference } : {}) } });
      setOk(`Transferred ₹${f.amount}. Posted as journal entry #${r.entryId}.`); setF({ ...f, amount: '', reference: '' }); return;
    }
    const r = await api(`/orgs/${org.id}/bank-accounts/${f.bankId}/${tab}`, { body: { date: f.date, payee: f.payee, ...(f.reference ? { reference: f.reference } : {}),
      lines: lines.filter((l) => l.accountId).map((l) => ({ accountId: Number(l.accountId), amount: toPaise(l.amount), ...(l.description ? { description: l.description } : {}) })) } });
    setOk(`${tab === 'spend' ? 'Spent' : 'Received'} ₹${fmt(r.total)} ${tab === 'spend' ? 'from' : 'into'} ${r.bank}. Posted as journal entry #${r.entryId}; it will be suggested when you reconcile the bank line.`);
    setLines([blank()]); setF({ ...f, payee: '', reference: '' });
  });

  return (
    <>
      <PageHeader title={TITLES[tab][0]} subtitle={TITLES[tab][1]} />
      <div className="mb-4 flex gap-1 text-sm">{(Object.keys(TITLES) as Tab[]).map((t) => (
        <button key={t} className={`rounded-md px-3 py-1.5 ${t === tab ? 'bg-slate-800 text-white' : 'border border-slate-300 bg-white'}`} onClick={() => go(`money/${t}`)}>{TITLES[t][0]}</button>))}</div>
      <div className="mb-3 space-y-2"><ErrorMsg msg={error} /><Ok msg={ok} /></div>
      {banks.length === 0 ? <Card><Empty text="Add a bank account first, under Accounting → Bank accounts." /></Card> : !canPost ? <Card><Empty text="You can view but not post transactions." /></Card> : (
        <Card>
          <div className="grid gap-3 md:grid-cols-4">
            <Select label={tab === 'transfer' ? 'From' : tab === 'spend' ? 'Paid from' : 'Received into'} aria-label="Bank account" value={f.bankId} onChange={(e) => setF({ ...f, bankId: e.target.value })}>
              {banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select>
            {tab === 'transfer' ? (
              <Select label="To" aria-label="To bank account" value={f.toBankId} onChange={(e) => setF({ ...f, toBankId: e.target.value })}>
                <option value="">Select…</option>{banks.filter((b) => String(b.id) !== f.bankId).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select>
            ) : <Field label={tab === 'spend' ? 'Paid to' : 'Received from'} aria-label="Payee" value={f.payee} onChange={(e) => setF({ ...f, payee: e.target.value })} />}
            <Field label="Date" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
            <Field label="Reference" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />
            {tab === 'transfer' && <Field label="Amount (₹)" aria-label="Transfer amount" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />}
          </div>
          {tab !== 'transfer' && (
            <table className="mt-4 w-full text-sm">
              <thead><tr className="text-left"><th>Account</th><th>Description</th><th className="w-40 text-right">Amount (₹)</th></tr></thead>
              <tbody>{lines.map((l, i) => (
                <tr key={i}>
                  <td><select aria-label={`Money account ${i + 1}`} className="w-full rounded border border-slate-300 px-2 py-1" value={l.accountId} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, accountId: e.target.value } : x)))}>
                    <option value="">Select account…</option>{accounts.filter((a) => a.id !== bank?.accountId).map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select></td>
                  <td><input aria-label={`Money description ${i + 1}`} className="w-full rounded border border-slate-300 px-2 py-1" value={l.description} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} /></td>
                  <td><input aria-label={`Money amount ${i + 1}`} inputMode="decimal" className="w-full rounded border border-slate-300 px-2 py-1 text-right" value={l.amount} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} /></td>
                </tr>))}</tbody>
              <tfoot><tr className="font-semibold"><td><Button variant="ghost" onClick={() => setLines([...lines, blank()])}>Add line</Button></td><td className="text-right">Total</td><td className="text-right">₹{fmt(total)}</td></tr></tfoot>
            </table>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button disabled={busy} onClick={submit}>{tab === 'transfer' ? 'Transfer' : tab === 'spend' ? 'Save spend' : 'Save receipt'}</Button>
            {tab !== 'transfer' && <p className="text-xs text-slate-500">No GST is worked out here. For a purchase or sale with GST you want in GSTR-1 or GSTR-3B, enter a bill or invoice instead.</p>}
          </div>
        </Card>
      )}
    </>
  );
}
