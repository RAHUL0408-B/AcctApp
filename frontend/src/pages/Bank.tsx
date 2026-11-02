import { useCallback, useEffect, useState } from 'react';
import { api, fmt } from '../api';
import type { Org } from '../App';
import { Button, Card, ErrorMsg, Field, Ok, useAction } from '../ui';
import { Empty, PageHeader, Select } from '../kit';

interface BankAcc { id: number; name: string; accountId: number; bookBalance: number; statementTotal: number; unreconciled: number }
interface Txn { id: number; date: string; description: string; amount: number; status: string; matchedEntryId: number | null; ruleAccountId: number | null }
interface Rule { id: number; name: string; matchText: string; direction: string; accountName: string }
interface Account { id: number; code: string; name: string; type: string }

export function Bank({ org, canPost, canManage, accounts, section = 'reconcile' }: { org: Org; canPost: boolean; canManage: boolean; accounts: Account[]; section?: 'reconcile' | 'rules' }) {
  const [banks, setBanks] = useState<BankAcc[]>([]);
  const [sel, setSel] = useState<number | null>(null);
  const [txns, setTxns] = useState<Txn[]>([]);
  const [sugg, setSugg] = useState<Record<number, { id: number; date: string; narration: string }[]>>({});
  const [cat, setCat] = useState<Record<number, string>>({});
  const [newBank, setNewBank] = useState({ name: '', accountId: '' });
  const [ok, setOk] = useState('');
  const [rules, setRules] = useState<Rule[]>([]);
  const [rf, setRf] = useState({ name: '', matchText: '', direction: 'any', accountId: '' });
  const { error, busy, run } = useAction();
  const loadRules = useCallback(() => api<Rule[]>(`/orgs/${org.id}/bank-rules`).then(setRules), [org.id]);
  useEffect(() => { loadRules(); }, [loadRules]);

  const loadBanks = useCallback(() => api<BankAcc[]>(`/orgs/${org.id}/bank-accounts`).then((b) => { setBanks(b); if (!sel && b[0]) setSel(b[0].id); }), [org.id, sel]);
  const loadTxns = useCallback(async () => {
    if (!sel) return;
    const t = await api<Txn[]>(`/orgs/${org.id}/bank-accounts/${sel}/transactions`);
    setTxns(t);
    const s: typeof sugg = {};
    for (const x of t.filter((x) => x.status === 'unreconciled')) s[x.id] = await api(`/orgs/${org.id}/bank-transactions/${x.id}/suggestions`);
    setSugg(s);
  }, [org.id, sel]);
  useEffect(() => { loadBanks(); }, [loadBanks]);
  useEffect(() => { loadTxns(); }, [loadTxns]);
  const refresh = () => { loadBanks(); loadTxns(); };
  const ruled = txns.filter((t) => t.status === 'unreconciled' && t.ruleAccountId).length;
  const acceptRules = () => run(async () => { const r = await api(`/orgs/${org.id}/bank-accounts/${sel}/accept-rules`, { method: 'POST', body: {} }); setOk(`${r.reconciled} line(s) booked by rules and reconciled.`); refresh(); });

  const importFile = (file: File) => run(async () => {
    const r = await api(`/orgs/${org.id}/bank-accounts/${sel}/import`, { body: { csv: await file.text() } });
    setOk(`Imported ${r.imported} lines (${r.skippedDuplicates} duplicates skipped).`); refresh();
  });
  const match = (txnId: number, entryId: number) => run(async () => { await api(`/orgs/${org.id}/bank-transactions/${txnId}/reconcile`, { body: { entryId } }); setOk('Matched.'); refresh(); });
  const categorize = (txnId: number) => run(async () => { await api(`/orgs/${org.id}/bank-transactions/${txnId}/categorize`, { body: { accountId: Number(cat[txnId]) } }); setOk('Entry created and reconciled.'); refresh(); });
  const undo = (txnId: number) => run(async () => { await api(`/orgs/${org.id}/bank-transactions/${txnId}/unreconcile`, { method: 'POST', body: {} }); refresh(); });
  const bank = banks.find((b) => b.id === sel);

  const rulesCard = (
        <Card title="Bank rules">
          <p className="mb-3 text-sm text-slate-600">If a bank line contains the text, suggest the account. Rules are checked in order; the first match wins.</p>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Rule name" value={rf.name} onChange={(e) => setRf({ ...rf, name: e.target.value })} />
            <Field label="Narration contains" value={rf.matchText} onChange={(e) => setRf({ ...rf, matchText: e.target.value })} />
            <Select label="Money" aria-label="Rule direction" value={rf.direction} onChange={(e) => setRf({ ...rf, direction: e.target.value })}><option value="any">In or out</option><option value="out">Out only</option><option value="in">In only</option></Select>
            <Select label="Post to" aria-label="Rule account" value={rf.accountId} onChange={(e) => setRf({ ...rf, accountId: e.target.value })}><option value="">Select…</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</Select>
            <Button disabled={busy} onClick={() => run(async () => { await api(`/orgs/${org.id}/bank-rules`, { body: { name: rf.name, matchText: rf.matchText, direction: rf.direction, accountId: Number(rf.accountId) } }); setRf({ name: '', matchText: '', direction: 'any', accountId: '' }); loadRules(); loadTxns(); })}>Add rule</Button>
          </div>
          {rules.length === 0 ? <Empty text="No rules yet." /> : <ul className="mt-3 divide-y divide-slate-100 text-sm">{rules.map((r) => (
            <li key={r.id} className="flex justify-between py-2"><span><b>{r.name}</b>: contains &quot;{r.matchText}&quot; ({r.direction}) → {r.accountName}</span>
              <Button variant="ghost" onClick={() => run(async () => { await api(`/orgs/${org.id}/bank-rules/${r.id}/delete`, { method: 'POST', body: {} }); loadRules(); })}>Delete</Button></li>))}</ul>}
        </Card>
  );

  if (section === 'rules') return (
    <>
      <PageHeader title="Bank rules" subtitle="Rules suggest an account for routine bank lines, such as bank charges or rent, when a statement is imported." />
      <div className="mb-3 space-y-2"><ErrorMsg msg={error} /><Ok msg={ok} /></div>
      {!canManage && <Card><Empty text="Only owners and accountants can change bank rules." /></Card>}
      {canManage && rulesCard}
    </>
  );

  return (
    <>
      <PageHeader title="Bank accounts" subtitle="Import statements, match them to your books, and let rules categorise the routine lines." />
      {canManage && (
        <Card title="Connect a bank account">
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm">Name<input aria-label="Bank name" className="ml-2 rounded border border-slate-300 px-2 py-1" value={newBank.name} onChange={(e) => setNewBank({ ...newBank, name: e.target.value })} placeholder="HDFC Current" /></label>
            <label className="text-sm">Ledger account<select aria-label="Bank ledger account" className="ml-2 rounded border border-slate-300 px-2 py-1" value={newBank.accountId} onChange={(e) => setNewBank({ ...newBank, accountId: e.target.value })}>
              <option value="">Select…</option>{accounts.filter((a) => a.type === 'asset').map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select></label>
            <Button disabled={busy} onClick={() => run(async () => { await api(`/orgs/${org.id}/bank-accounts`, { body: { name: newBank.name, accountId: Number(newBank.accountId) } }); setNewBank({ name: '', accountId: '' }); loadBanks(); })}>Add</Button>
          </div>
        </Card>
      )}
      <div className="space-y-2"><ErrorMsg msg={error} /><Ok msg={ok} /></div>
      {banks.length > 0 && (
        <Card title="Reconcile" actions={<>
          {canPost && ruled > 0 && <Button variant="ghost" disabled={busy} onClick={acceptRules}>Accept {ruled} rule suggestion(s)</Button>}
          <select aria-label="Bank account" className="rounded border border-slate-300 px-2 py-1 text-sm" value={sel ?? ''} onChange={(e) => setSel(Number(e.target.value))}>
            {banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></>}>
          {bank && (
            <div className="mb-4 grid grid-cols-3 gap-3 text-sm">
              <div className="rounded bg-slate-50 p-3"><p className="text-slate-500">Balance in books</p><p className="text-lg font-semibold">₹{fmt(bank.bookBalance)}</p></div>
              <div className="rounded bg-slate-50 p-3"><p className="text-slate-500">Statement lines total</p><p className="text-lg font-semibold">₹{fmt(bank.statementTotal)}</p></div>
              <div className="rounded bg-slate-50 p-3"><p className="text-slate-500">To reconcile</p><p className="text-lg font-semibold" data-testid="unreconciled">{bank.unreconciled}</p></div>
            </div>
          )}
          {canPost && <label className="mb-4 block text-sm">Import statement (CSV with Date, Narration and Debit/Credit or Amount columns): <input aria-label="Statement file" type="file" accept=".csv,text/csv" onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} /></label>}
          <table className="w-full text-sm">
            <thead><tr className="text-left text-slate-500"><th>Date</th><th>Description</th><th className="text-right">Amount</th><th>Match</th></tr></thead>
            <tbody>{txns.map((t) => (
              <tr key={t.id} className="border-t border-slate-100 align-top">
                <td className="py-2">{t.date}</td><td>{t.description}</td>
                <td className={`text-right ${t.amount < 0 ? 'text-red-700' : 'text-green-700'}`}>{fmt(t.amount)}</td>
                <td className="pl-3">
                  {t.status === 'reconciled' ? (
                    <span className="text-green-700">✓ Reconciled (entry #{t.matchedEntryId}) {canPost && <button className="ml-2 text-xs underline" onClick={() => undo(t.id)}>undo</button>}</span>
                  ) : canPost ? (
                    <div className="space-y-1">
                      {t.ruleAccountId && <p className="text-xs text-brand-700">Rule suggests {accounts.find((a) => a.id === t.ruleAccountId)?.name}</p>}
                      {(sugg[t.id] ?? []).map((s) => <div key={s.id}><Button variant="ghost" onClick={() => match(t.id, s.id)}>Match #{s.id} · {s.date} · {s.narration}</Button></div>)}
                      <div className="flex gap-1">
                        <select aria-label={`Category for ${t.description}`} className="rounded border border-slate-300 px-1 py-1" value={cat[t.id] ?? ''} onChange={(e) => setCat({ ...cat, [t.id]: e.target.value })}>
                          <option value="">Create entry to…</option>{accounts.filter((a) => a.id !== bank?.accountId).map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select>
                        <Button variant="ghost" disabled={!cat[t.id]} onClick={() => categorize(t.id)}>OK</Button>
                      </div>
                    </div>
                  ) : 'Unreconciled'}
                </td>
              </tr>))}</tbody>
          </table>
        </Card>
      )}
    </>
  );
}
