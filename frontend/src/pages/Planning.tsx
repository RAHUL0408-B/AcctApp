// Tracking categories, budgets and year-end closing.
import { useCallback, useEffect, useState } from 'react';
import { api, fmt, toPaise, today } from '../api';
import type { Org } from '../App';
import { Empty, PageHeader, Select, Stat } from '../kit';
import { Button, Card, ErrorMsg, Field, Ok, useAction } from '../ui';
import type { Account, TrackingCategory } from './Lines';

/** The financial year (April-March) containing a date. */
const fyOf = (d: string) => { const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7)); const s = m >= 4 ? y : y - 1; return { start: `${s}-04-01`, end: `${s + 1}-03-31`, label: `FY ${s}-${String((s + 1) % 100).padStart(2, '0')}` }; };

export function Tracking({ org, canManage }: { org: Org; canManage: boolean }) {
  const [cats, setCats] = useState<TrackingCategory[]>([]);
  const [f, setF] = useState({ name: '', options: '' });
  const [newOpt, setNewOpt] = useState<Record<number, string>>({});
  const { error, busy, run } = useAction();
  const load = useCallback(() => api<TrackingCategory[]>(`/orgs/${org.id}/tracking`).then(setCats), [org.id]);
  useEffect(() => { load(); }, [load]);
  return (
    <>
      <PageHeader title="Tracking categories" subtitle="Tag income and expense lines (for example by branch or project) and see profit for each under Reports." />
      <div className="mb-3"><ErrorMsg msg={error} /></div>
      {canManage && (
        <Card title="New category">
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Category name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Branch" />
            <div className="md:col-span-2"><Field label="Options, separated by commas" value={f.options} onChange={(e) => setF({ ...f, options: e.target.value })} placeholder="Mumbai, Pune" /></div>
          </div>
          <div className="mt-3"><Button disabled={busy || !f.name} onClick={() => run(async () => {
            await api(`/orgs/${org.id}/tracking`, { body: { name: f.name, options: f.options.split(',').map((x) => x.trim()).filter(Boolean) } }); setF({ name: '', options: '' }); load();
          })}>Add category</Button></div>
        </Card>
      )}
      {cats.length === 0 ? <Card><Empty text="No tracking categories yet." /></Card> : cats.map((c) => (
        <Card key={c.id} title={c.name}>
          <div className="flex flex-wrap gap-2">{c.options.map((o) => <span key={o.id} className="rounded-full bg-brand-50 px-3 py-1 text-sm text-brand-800">{o.name}</span>)}</div>
          {canManage && <div className="mt-3 flex items-end gap-2"><Field label="Add option" value={newOpt[c.id] ?? ''} onChange={(e) => setNewOpt({ ...newOpt, [c.id]: e.target.value })} />
            <Button variant="ghost" disabled={busy || !newOpt[c.id]} onClick={() => run(async () => { await api(`/orgs/${org.id}/tracking/${c.id}/options`, { body: { name: newOpt[c.id] } }); setNewOpt({ ...newOpt, [c.id]: '' }); load(); })}>Add</Button></div>}
        </Card>
      ))}
    </>
  );
}

interface Budget { id: number; name: string; fyStart: string; total: number }
interface BudgetDetail { id: number; name: string; fyStart: string; months: string[]; lines: { accountId: number; month: string; amount: number }[] }

export function Budgets({ org, canManage, accounts }: { org: Org; canManage: boolean; accounts: Account[] }) {
  const [list, setList] = useState<Budget[]>([]);
  const [open, setOpen] = useState<BudgetDetail | null>(null);
  const [f, setF] = useState({ name: '', fyStart: fyOf(today()).start });
  const [edit, setEdit] = useState({ accountId: '', monthly: '' });
  const [ok, setOk] = useState('');
  const { error, busy, run } = useAction();
  const load = useCallback(() => api<Budget[]>(`/orgs/${org.id}/budgets`).then(setList), [org.id]);
  useEffect(() => { load(); }, [load]);
  const show = (id: number) => run(async () => setOpen(await api<BudgetDetail>(`/orgs/${org.id}/budgets/${id}`)));
  const plAccounts = accounts.filter((a) => a.type === 'income' || a.type === 'expense');
  const spread = () => run(async () => {
    if (!open) return;
    const amount = toPaise(edit.monthly);
    await api(`/orgs/${org.id}/budgets/${open.id}/lines`, { method: 'PUT', body: { lines: open.months.map((month) => ({ accountId: Number(edit.accountId), month, amount })) } });
    setOk('Saved for every month of the year.'); setEdit({ accountId: '', monthly: '' }); show(open.id); load();
  });
  const byAccount = open ? [...new Set(open.lines.map((l) => l.accountId))] : [];
  return (
    <>
      <PageHeader title="Budgets" subtitle="Plan income and spending month by month, then compare with actuals under Reports, Budget vs actual." />
      <div className="mb-3 space-y-2"><ErrorMsg msg={error} /><Ok msg={ok} /></div>
      {canManage && (
        <Card title="New budget">
          <div className="grid gap-3 md:grid-cols-3"><Field label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Plan" />
            <Field label="Financial year starts" type="date" value={f.fyStart} onChange={(e) => setF({ ...f, fyStart: e.target.value })} /></div>
          <div className="mt-3"><Button disabled={busy || !f.name} onClick={() => run(async () => { const r = await api(`/orgs/${org.id}/budgets`, { body: f }); setF({ ...f, name: '' }); await load(); show(r.id); })}>Create budget</Button></div>
        </Card>
      )}
      <Card title="Budgets">
        {list.length === 0 ? <Empty text="No budgets yet." /> : (
          <table className="w-full text-sm"><thead><tr className="text-left"><th>Name</th><th>Year</th><th className="text-right">Total budgeted</th><th /></tr></thead>
            <tbody>{list.map((b) => <tr key={b.id}><td className="font-medium">{b.name}</td><td>{fyOf(b.fyStart).label}</td><td className="text-right">{fmt(b.total)}</td><td className="text-right"><Button variant="ghost" onClick={() => show(b.id)}>Open</Button></td></tr>)}</tbody></table>
        )}
      </Card>
      {open && (
        <Card title={`${open.name}: ${fyOf(open.fyStart).label}`}>
          {canManage && <div className="mb-4 flex flex-wrap items-end gap-3">
            <div className="w-72"><Select label="Account" aria-label="Budget account" value={edit.accountId} onChange={(e) => setEdit({ ...edit, accountId: e.target.value })}><option value="">Select…</option>{plAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</Select></div>
            <Field label="Amount per month (₹)" value={edit.monthly} onChange={(e) => setEdit({ ...edit, monthly: e.target.value })} />
            <Button disabled={busy || !edit.accountId || !edit.monthly} onClick={spread}>Set for all 12 months</Button></div>}
          {byAccount.length === 0 ? <Empty text="No amounts yet." /> : (
            <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="text-left"><th>Account</th>{open.months.map((m) => <th key={m} className="text-right">{m.slice(5)}</th>)}</tr></thead>
              <tbody>{byAccount.map((id) => {
                const a = accounts.find((x) => x.id === id);
                return <tr key={id}><td className="whitespace-nowrap">{a ? `${a.code} ${a.name}` : id}</td>{open.months.map((m) => <td key={m} className="text-right">{fmt(open.lines.find((l) => l.accountId === id && l.month === m)?.amount ?? 0)}</td>)}</tr>;
              })}</tbody></table></div>
          )}
        </Card>
      )}
    </>
  );
}

export function YearEnd({ org, canManage }: { org: Org; canManage: boolean }) {
  const lastYearEnd = fyOf(`${Number(fyOf(today()).start.slice(0, 4))}-03-31`).end; // the year that ended most recently
  const [fyEnd, setFyEnd] = useState(lastYearEnd);
  const [p, setP] = useState<{ year: string; income: number; expense: number; netProfit: number; closed: boolean } | null>(null);
  const [lock, setLock] = useState(true);
  const [ok, setOk] = useState('');
  const { error, busy, run, setError } = useAction();
  const load = useCallback(() => { setError(''); api(`/orgs/${org.id}/year-end?fyEnd=${fyEnd}`).then(setP).catch((e) => { setP(null); setError(e.message); }); }, [org.id, fyEnd]);
  useEffect(() => { load(); }, [load]);
  return (
    <>
      <PageHeader title="Year-end close" subtitle="Move a finished year's profit into Reserves and Surplus, then lock the year. That year's profit and loss report is unchanged." />
      <div className="mb-3 space-y-2"><ErrorMsg msg={error} /><Ok msg={ok} /></div>
      <Card>
        <div className="flex items-end gap-3"><Field label="Year ending on" type="date" value={fyEnd} onChange={(e) => setFyEnd(e.target.value)} /></div>
      </Card>
      {p && (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            <Stat label={`Income ${p.year}`} value={`₹${fmt(p.income)}`} />
            <Stat label={`Expenses ${p.year}`} value={`₹${fmt(p.expense)}`} />
            <Stat label="Profit to move to reserves" value={`₹${fmt(p.netProfit)}`} tone={p.netProfit < 0 ? 'bad' : 'good'} testId="year-profit" />
          </div>
          <Card title={p.closed ? `${p.year} is closed` : `Close ${p.year}`}>
            {p.closed ? <p className="text-sm text-slate-600">The closing entry has been posted. To reopen, reverse it under Manual journals (and unlock the year in Organisation settings).</p> : canManage ? (
              <>
                <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={lock} onChange={(e) => setLock(e.target.checked)} />Also lock the year so nothing else can be posted into it</label>
                <Button disabled={busy} onClick={() => run(async () => { const r = await api(`/orgs/${org.id}/year-end/close`, { body: { fyEnd, lock } }); setOk(`${r.year} closed: ₹${fmt(r.netProfit)} moved to reserves.`); load(); })}>Close {p.year}</Button>
              </>
            ) : <p className="text-sm text-slate-600">Only an owner or accountant can close the year.</p>}
          </Card>
        </>
      )}
    </>
  );
}
