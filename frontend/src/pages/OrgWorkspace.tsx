import { useCallback, useEffect, useState } from 'react';
import { api, fmt, toPaise } from '../api';
import type { Org } from '../App';
import { Button, Card, ErrorMsg, Field, Ok, useAction } from '../ui';
import { Documents } from './Documents';
import { Contacts } from './Contacts';
import { Bank } from './Bank';
import { Reports } from './Reports';
import { Files, Import, Schedules, Tasks } from './Practice';
import { PreDocs, Recurring } from './Sales';
import { FixedAssets, Items, OrgSettings } from './Accounting';
import { Dashboard } from './Dashboard';
import { PageHeader } from '../kit';

interface Account { id: number; code: string; name: string; type: string; group: string }
interface Entry { id: number; date: string; narration: string; reversesId: number | null; lines: { accountId: number; debit: number; credit: number }[] }
interface TB { accounts: { code: string; name: string; debit: number; credit: number }[]; totalDebit: number; totalCredit: number; balanced: boolean }

export type PageKey = 'dashboard' | 'invoices' | 'quotes' | 'recurring' | 'customers' | 'bills' | 'purchase-orders' | 'suppliers' | 'bank' | 'journal' | 'coa' | 'assets' | 'items' | 'reports' | 'tasks' | 'files' | 'import' | 'schedules' | 'settings';

/** Sidebar structure. Entries marked manage are only shown to owners and accountants. */
export const NAV: { group: string; items: { key: PageKey; label: string; manage?: boolean }[] }[] = [
  { group: 'Overview', items: [{ key: 'dashboard', label: 'Dashboard' }] },
  { group: 'Sales', items: [{ key: 'invoices', label: 'Invoices' }, { key: 'quotes', label: 'Quotes' }, { key: 'recurring', label: 'Repeating invoices' }, { key: 'customers', label: 'Customers' }] },
  { group: 'Purchases', items: [{ key: 'bills', label: 'Bills' }, { key: 'purchase-orders', label: 'Purchase orders' }, { key: 'suppliers', label: 'Suppliers' }] },
  { group: 'Accounting', items: [{ key: 'bank', label: 'Bank accounts' }, { key: 'journal', label: 'Manual journals' }, { key: 'coa', label: 'Chart of accounts' }, { key: 'assets', label: 'Fixed assets' }, { key: 'items', label: 'Products and services' }] },
  { group: 'Reporting', items: [{ key: 'reports', label: 'Reports' }] },
  { group: 'Compliance', items: [{ key: 'tasks', label: 'Tasks and deadlines' }, { key: 'files', label: 'Documents' }] },
  { group: 'Setup', items: [{ key: 'import', label: 'Import data', manage: true }, { key: 'schedules', label: 'Scheduled emails', manage: true }, { key: 'settings', label: 'Organisation settings' }] },
];

export function OrgPage({ org, role, page, go, onOrgChanged }: { org: Org; role: string; page: PageKey; go: (p: PageKey) => void; onOrgChanged: () => void }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const reloadAccounts = () => api<Account[]>(`/orgs/${org.id}/accounts`).then(setAccounts);
  useEffect(() => { reloadAccounts(); }, [org.id]);
  const canPost = role !== 'client';
  const canManage = role === 'owner' || role === 'accountant';
  switch (page) {
    case 'dashboard': return <Dashboard org={org} go={(p) => go(p as PageKey)} />;
    case 'invoices': return <Documents org={org} kind="sales" canPost={canPost} accounts={accounts} />;
    case 'quotes': return <PreDocs org={org} kind="quote" canPost={canPost} accounts={accounts} />;
    case 'recurring': return <Recurring org={org} canPost={canPost} accounts={accounts} />;
    case 'customers': return <Contacts org={org} canPost={canPost} only="customer" />;
    case 'bills': return <Documents org={org} kind="purchases" canPost={canPost} accounts={accounts} />;
    case 'purchase-orders': return <PreDocs org={org} kind="purchase_order" canPost={canPost} accounts={accounts} />;
    case 'suppliers': return <Contacts org={org} canPost={canPost} only="supplier" />;
    case 'bank': return <Bank org={org} canPost={canPost} canManage={canManage} accounts={accounts} />;
    case 'journal': return <><PageHeader title="Manual journals" subtitle="Double-entry adjustments. Posted entries are never edited; reverse them instead." /><Journal org={org} accounts={accounts} canPost={canPost} /></>;
    case 'coa': return <><PageHeader title="Chart of accounts" subtitle="Every account that transactions can post to." /><Chart org={org} accounts={accounts} canManage={canManage} reload={reloadAccounts} /></>;
    case 'assets': return <FixedAssets org={org} canManage={canManage} />;
    case 'items': return <Items org={org} canPost={canPost} accounts={accounts} />;
    case 'reports': return <><PageHeader title="Reports" subtitle="Financial statements, ageing and GST summaries. Export to PDF or Excel." /><Reports org={org} accounts={accounts} /></>;
    case 'tasks': return <><PageHeader title="Tasks and deadlines" subtitle="Filing due dates and anything else the team needs to do for this client." /><Tasks org={org} canPost={canPost} /></>;
    case 'files': return <><PageHeader title="Documents" subtitle="Files shared between the firm and the client." /><Files org={org} canManage={canManage} /></>;
    case 'import': return canManage ? <><PageHeader title="Import data" subtitle="Bring in contacts, accounts and opening balances from other software." /><Import org={org} /></> : null;
    case 'schedules': return canManage ? <><PageHeader title="Scheduled emails" subtitle="Reports sent to you or your client automatically." /><Schedules org={org} /></> : null;
    case 'settings': return <OrgSettings org={org} canManage={canManage} onSaved={onOrgChanged} />;
  }
}

export function Journal({ org, accounts, canPost }: { org: Org; accounts: Account[]; canPost: boolean }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today), [narration, setNarration] = useState('');
  const [rows, setRows] = useState([{ accountId: '', debit: '', credit: '' }, { accountId: '', debit: '', credit: '' }]);
  const { error, busy, run, setError } = useAction();
  const [ok, setOk] = useState(''), [reason, setReason] = useState('Correction');
  const load = useCallback(() => api(`/orgs/${org.id}/journal`).then(setEntries), [org.id]);
  useEffect(() => { load(); }, [load]);

  const name = (id: number) => accounts.find((a) => a.id === id)?.name ?? `#${id}`;
  const totalD = rows.reduce((s, r) => s + (r.debit ? safe(r.debit) : 0), 0), totalC = rows.reduce((s, r) => s + (r.credit ? safe(r.credit) : 0), 0);

  const submit = () => run(async () => {
    setOk('');
    const lines = rows.filter((r) => r.accountId).map((r) => ({ accountId: Number(r.accountId), ...(r.debit ? { debit: toPaise(r.debit) } : {}), ...(r.credit ? { credit: toPaise(r.credit) } : {}) }));
    await api(`/orgs/${org.id}/journal`, { body: { date, narration, lines } });
    setNarration(''); setRows(rows.map(() => ({ accountId: '', debit: '', credit: '' }))); setOk('Entry posted.'); load();
  });
  const reverse = (id: number) => run(async () => {
        await api(`/orgs/${org.id}/journal/${id}/reverse`, { body: { date: today, reason } }); setOk('Reversal posted.'); load();
  });

  return (
    <>
      {canPost && (
        <Card title="New journal entry">
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            <div className="md:col-span-2"><Field label="Narration" value={narration} onChange={(e) => setNarration(e.target.value)} /></div>
          </div>
          <table className="mt-4 w-full text-sm">
            <thead><tr className="text-left text-slate-500"><th>Account</th><th className="w-36">Debit (₹)</th><th className="w-36">Credit (₹)</th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td className="pr-2"><select aria-label={`Account ${i + 1}`} className="w-full rounded border border-slate-300 px-2 py-1" value={r.accountId}
                    onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, accountId: e.target.value } : x)))}>
                    <option value="">Select account…</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
                  </select></td>
                  <td className="pr-2"><input aria-label={`Debit ${i + 1}`} className="w-full rounded border border-slate-300 px-2 py-1 text-right" inputMode="decimal" value={r.debit}
                    onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, debit: e.target.value, credit: e.target.value ? '' : x.credit } : x)))} /></td>
                  <td><input aria-label={`Credit ${i + 1}`} className="w-full rounded border border-slate-300 px-2 py-1 text-right" inputMode="decimal" value={r.credit}
                    onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, credit: e.target.value, debit: e.target.value ? '' : x.debit } : x)))} /></td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr className="font-medium"><td className="py-2 text-right">Totals {totalD === totalC && totalD > 0 ? '✓ balanced' : ''}</td><td className="text-right">{fmt(totalD)}</td><td className="text-right">{fmt(totalC)}</td></tr></tfoot>
          </table>
          <div className="mt-3 flex items-center gap-3">
            <Button variant="ghost" onClick={() => setRows([...rows, { accountId: '', debit: '', credit: '' }])}>Add line</Button>
            <Button onClick={submit} disabled={busy}>Post entry</Button>
          </div>
          <div className="mt-3 space-y-2"><ErrorMsg msg={error} /><Ok msg={ok} /></div>
        </Card>
      )}
      <Card title="Posted entries">
        {canPost && <div className="mb-3 max-w-sm"><Field label="Reason used when reversing an entry" value={reason} onChange={(e) => setReason(e.target.value)} /></div>}
        {entries.length === 0 ? <p className="text-sm text-slate-500">Nothing posted yet.</p> : entries.map((e) => (
          <div key={e.id} className="border-b border-slate-100 py-3 last:border-0">
            <div className="flex items-center justify-between text-sm">
              <span><b>#{e.id}</b> · {e.date} · {e.narration}{e.reversesId && <em className="ml-2 text-amber-700">(reversal of #{e.reversesId})</em>}</span>
              {canPost && !e.reversesId && <Button variant="ghost" onClick={() => { setError(''); reverse(e.id); }}>Reverse</Button>}
            </div>
            <ul className="mt-1 text-sm text-slate-600">{e.lines.map((l, i) => <li key={i} className="flex justify-between"><span>{name(l.accountId)}</span><span>{l.debit ? `Dr ${fmt(l.debit)}` : `Cr ${fmt(l.credit)}`}</span></li>)}</ul>
          </div>
        ))}
      </Card>
    </>
  );
}

function safe(s: string) { try { return toPaise(s); } catch { return 0; } }

function TrialBalance({ org }: { org: Org }) {
  const [tb, setTb] = useState<TB | null>(null);
  useEffect(() => { api(`/orgs/${org.id}/trial-balance`).then(setTb); }, [org.id]);
  if (!tb) return <p>Loading…</p>;
  return (
    <Card title="Trial balance">
      <table className="w-full text-sm">
        <thead><tr className="text-left text-slate-500"><th>Code</th><th>Account</th><th className="text-right">Debit (₹)</th><th className="text-right">Credit (₹)</th></tr></thead>
        <tbody>{tb.accounts.map((a) => <tr key={a.code} className="border-t border-slate-100"><td>{a.code}</td><td>{a.name}</td><td className="text-right">{a.debit ? fmt(a.debit) : ''}</td><td className="text-right">{a.credit ? fmt(a.credit) : ''}</td></tr>)}</tbody>
        <tfoot><tr className="border-t-2 border-slate-300 font-semibold"><td colSpan={2}>Total {tb.balanced ? '✓' : '✗ OUT OF BALANCE'}</td><td className="text-right" data-testid="tb-debit">{fmt(tb.totalDebit)}</td><td className="text-right" data-testid="tb-credit">{fmt(tb.totalCredit)}</td></tr></tfoot>
      </table>
    </Card>
  );
}

export function Chart({ org, accounts, canManage, reload }: { org: Org; accounts: Account[]; canManage: boolean; reload: () => void }) {
  const [f, setF] = useState({ code: '', name: '', type: 'expense', group: '' });
  const { error, busy, run } = useAction();
  const groups = accounts.reduce<Record<string, Account[]>>((m, a) => ((m[a.type] ??= []).push(a), m), {});
  return (
    <>
      {canManage && (
        <Card title="Add account">
          <div className="grid gap-3 md:grid-cols-4">
            <Field label="Code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />
            <Field label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            <label className="block text-sm"><span className="mb-1 block font-medium text-slate-600">Type</span>
              <select className="w-full rounded-md border border-slate-300 bg-white px-3 py-2" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
                {['asset', 'liability', 'equity', 'income', 'expense'].map((t) => <option key={t}>{t}</option>)}</select></label>
            <Field label="Group" value={f.group} onChange={(e) => setF({ ...f, group: e.target.value })} />
          </div>
          <div className="mt-3 space-y-2"><ErrorMsg msg={error} /><Button disabled={busy} onClick={() => run(async () => { await api(`/orgs/${org.id}/accounts`, { body: f }); setF({ ...f, code: '', name: '' }); reload(); })}>Add</Button></div>
        </Card>
      )}
      {['asset', 'liability', 'equity', 'income', 'expense'].map((t) => (
        <Card key={t} title={t[0].toUpperCase() + t.slice(1) + 's'}>
          <ul className="grid gap-x-8 text-sm md:grid-cols-2">{(groups[t] ?? []).map((a) => <li key={a.id} className="flex justify-between border-b border-slate-100 py-1"><span>{a.code} · {a.name}</span><span className="text-slate-400">{a.group}</span></li>)}</ul>
        </Card>
      ))}
    </>
  );
}
