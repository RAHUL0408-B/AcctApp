// Invoices and bills waiting for approval, and employee expense claims.
import { useCallback, useEffect, useState } from 'react';
import { api, fmt, toPaise, today } from '../api';
import type { Org } from '../App';
import { Badge, Empty, PageHeader, Select } from '../kit';
import { Button, Card, ErrorMsg, Field, Ok, useAction } from '../ui';
import type { Account } from './Lines';

interface Draft { id: number; docType: string; total: number; status: string; reason: string | null; contactName: string; submittedBy: string; postedNumber: string | null; issueDate: string }
interface Claim { id: number; date: string; title: string; total: number; status: string; reason: string | null; claimant: string; lines: { description: string; amount: number }[] }

const BADGE_TEXT: Record<string, string> = { submitted: 'open', approved: 'accepted', rejected: 'declined', paid: 'paid' };

export function Approvals({ org, canManage }: { org: Org; canManage: boolean }) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [reason, setReason] = useState('');
  const [ok, setOk] = useState('');
  const { error, busy, run } = useAction();
  const load = useCallback(() => api<Draft[]>(`/orgs/${org.id}/drafts`).then(setDrafts), [org.id]);
  useEffect(() => { load(); }, [load]);
  const decide = (d: Draft, approve: boolean) => run(async () => {
    if (approve) { const r = await api(`/orgs/${org.id}/drafts/${d.id}/approve`, { body: {} }); setOk(`Approved and posted as ${r.number}.`); }
    else { await api(`/orgs/${org.id}/drafts/${d.id}/reject`, { body: { reason } }); setOk('Rejected.'); }
    load();
  });
  const waiting = drafts.filter((d) => d.status === 'submitted');
  return (
    <>
      <PageHeader title="Awaiting approval" subtitle="Invoices and bills sent for approval. Nothing reaches the books until an owner or accountant approves it." />
      <div className="mb-3 space-y-2"><ErrorMsg msg={error} /><Ok msg={ok} /></div>
      <Card title={`Waiting (${waiting.length})`} actions={canManage && waiting.length > 0 && <div className="w-72"><Field label="Reason, if you reject" value={reason} onChange={(e) => setReason(e.target.value)} /></div>}>
        {drafts.length === 0 ? <Empty text="Nothing has been sent for approval. Use “Submit for approval” on a new invoice or bill." /> : (
          <table className="w-full text-sm"><thead><tr className="text-left"><th>Type</th><th>Contact</th><th>Date</th><th>Submitted by</th><th className="text-right">Total</th><th>Status</th><th /></tr></thead>
            <tbody>{drafts.map((d) => (
              <tr key={d.id}><td className="capitalize">{d.docType}</td><td>{d.contactName}</td><td>{d.issueDate}</td><td>{d.submittedBy}</td><td className="text-right">{fmt(d.total)}</td>
                <td><Badge text={BADGE_TEXT[d.status] ?? d.status} /> {d.postedNumber && <span className="text-xs text-slate-500">{d.postedNumber}</span>}{d.reason && <span className="text-xs text-slate-500"> {d.reason}</span>}</td>
                <td className="space-x-1 text-right">{canManage && d.status === 'submitted' && <><Button onClick={() => decide(d, true)} disabled={busy}>Approve</Button><Button variant="ghost" onClick={() => decide(d, false)} disabled={busy || !reason}>Reject</Button></>}</td></tr>))}</tbody></table>
        )}
      </Card>
    </>
  );
}

export function ExpenseClaims({ org, canPost, canManage, accounts }: { org: Org; canPost: boolean; canManage: boolean; accounts: Account[] }) {
  const [claims, setClaims] = useState<Claim[]>([]);
  const [f, setF] = useState({ title: '', date: today() });
  const [lines, setLines] = useState([{ description: '', accountId: '', amount: '' }]);
  const [payFrom, setPayFrom] = useState('');
  const [reason, setReason] = useState('');
  const [ok, setOk] = useState('');
  const { error, busy, run } = useAction();
  const load = useCallback(() => api<Claim[]>(`/orgs/${org.id}/expense-claims`).then(setClaims), [org.id]);
  useEffect(() => { load(); }, [load]);
  const expenses = accounts.filter((a) => a.type === 'expense'), banks = accounts.filter((a) => a.type === 'asset' && ['1000', '1010'].includes(a.code));
  const submit = () => run(async () => {
    const r = await api(`/orgs/${org.id}/expense-claims`, { body: { ...f, lines: lines.map((l) => ({ description: l.description, accountId: Number(l.accountId), amount: toPaise(l.amount) })) } });
    setOk(`Claim for ₹${fmt(r.total)} submitted.`); setF({ ...f, title: '' }); setLines([{ description: '', accountId: '', amount: '' }]); load();
  });
  const act = (c: Claim, action: 'approve' | 'reject' | 'pay') => run(async () => {
    if (action === 'reject') await api(`/orgs/${org.id}/expense-claims/${c.id}/reject`, { body: { reason } });
    else await api(`/orgs/${org.id}/expense-claims/${c.id}/${action}`, { body: action === 'pay' ? { date: today(), accountId: Number(payFrom) } : {} });
    setOk(action === 'approve' ? 'Approved: the expenses are booked and the amount is owed to the employee.' : action === 'pay' ? 'Repaid.' : 'Rejected.'); load();
  });
  return (
    <>
      <PageHeader title="Expense claims" subtitle="Money staff spent from their own pocket. Approve to book the expense; repay from the bank." />
      <div className="mb-3 space-y-2"><ErrorMsg msg={error} /><Ok msg={ok} /></div>
      {canPost && (
        <Card title="New claim">
          <div className="grid gap-3 md:grid-cols-3"><Field label="What was it for?" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /><Field label="Date" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></div>
          <table className="mt-3 w-full text-sm"><thead><tr className="text-left"><th>Description</th><th className="w-60">Expense account</th><th className="w-36">Amount (₹)</th></tr></thead>
            <tbody>{lines.map((l, i) => (
              <tr key={i}>
                <td className="pr-1"><input aria-label={`Claim description ${i + 1}`} className="w-full rounded border border-slate-300 px-2 py-1" value={l.description} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} /></td>
                <td className="pr-1"><select aria-label={`Claim account ${i + 1}`} className="w-full rounded border border-slate-300 px-1 py-1" value={l.accountId} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, accountId: e.target.value } : x)))}>
                  <option value="">Select…</option>{expenses.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select></td>
                <td><input aria-label={`Claim amount ${i + 1}`} className="w-full rounded border border-slate-300 px-2 py-1 text-right" inputMode="decimal" value={l.amount} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} /></td>
              </tr>))}</tbody></table>
          <div className="mt-3 flex gap-3"><Button variant="ghost" onClick={() => setLines([...lines, { description: '', accountId: '', amount: '' }])}>Add line</Button><Button disabled={busy || !f.title} onClick={submit}>Submit claim</Button></div>
        </Card>
      )}
      <Card title="Claims" actions={canPost && <div className="flex gap-2">{canManage && <div className="w-56"><Field label="Reason, if you reject" value={reason} onChange={(e) => setReason(e.target.value)} /></div>}<div className="w-56"><Select label="Repay from" aria-label="Repay from" value={payFrom} onChange={(e) => setPayFrom(e.target.value)}><option value="">Select…</option>{banks.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</Select></div></div>}>
        {claims.length === 0 ? <Empty text="No claims yet." /> : (
          <table className="w-full text-sm"><thead><tr className="text-left"><th>Date</th><th>Claim</th><th>Claimant</th><th className="text-right">Total</th><th>Status</th><th /></tr></thead>
            <tbody>{claims.map((c) => (
              <tr key={c.id}><td>{c.date}</td><td>{c.title}<span className="block text-xs text-slate-500">{c.lines.map((l) => l.description).join(', ')}</span></td><td>{c.claimant}</td><td className="text-right">{fmt(c.total)}</td>
                <td><Badge text={BADGE_TEXT[c.status] ?? c.status} />{c.reason && <span className="text-xs text-slate-500"> {c.reason}</span>}</td>
                <td className="space-x-1 whitespace-nowrap text-right">
                  {canManage && c.status === 'submitted' && <><Button onClick={() => act(c, 'approve')} disabled={busy}>Approve</Button><Button variant="ghost" onClick={() => act(c, 'reject')} disabled={busy || !reason}>Reject</Button></>}
                  {canPost && c.status === 'approved' && <Button onClick={() => act(c, 'pay')} disabled={busy || !payFrom}>Repay</Button>}
                </td></tr>))}</tbody></table>
        )}
      </Card>
    </>
  );
}
