import { useEffect, useState } from 'react';
import { api, fmt } from '../api';
import type { Org } from '../App';
import { BarChart, PageHeader, Stat } from '../kit';
import { Button, Card } from '../ui';

interface Dash {
  banks: { id: number; name: string; balance: number; unreconciled: number }[]; cashInHand: number; totalCash: number;
  receivables: { total: number; overdue: number; top: { contact: string; total: number }[] }; payables: { total: number; overdue: number };
  months: { month: string; income: number; expense: number; cashIn: number; cashOut: number }[];
  ytd: { label: string; income: number; expense: number; profit: number }; tasks: { open: number; overdue: number };
}
interface Guide { completed: number; total: number; steps: { key: string; label: string; text: string; page: string; done: boolean }[] }

/** Cards the user can hide with "Edit homepage". Remembered per organisation in this browser. */
const CARDS: [string, string][] = [['figures', 'Key figures'], ['charts', 'Charts'], ['bank', 'Bank accounts'], ['owed', 'Who owes you most'], ['tasks', 'Tasks']];
const store = (key: string) => ({
  get: <T,>(fallback: T): T => { try { return JSON.parse(localStorage.getItem(key) ?? '') as T; } catch { return fallback; } },
  set: (v: unknown) => localStorage.setItem(key, JSON.stringify(v)),
});

/** "3 days ago" for the last-login line. */
export function ago(iso: string) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  const [n, u] = s < 3600 ? [Math.round(s / 60), 'minute'] : s < 86400 ? [Math.round(s / 3600), 'hour'] : s < 2592000 ? [Math.round(s / 86400), 'day'] : [Math.round(s / 2592000), 'month'];
  return n <= 0 ? 'just now' : `${n} ${u}${n === 1 ? '' : 's'} ago`;
}

export function Dashboard({ org, go, lastLogin }: { org: Org; go: (page: string) => void; lastLogin?: string | null }) {
  const [d, setD] = useState<Dash | null>(null);
  const [guide, setGuide] = useState<Guide | null>(null);
  const hiddenStore = store(`home-hidden-${org.id}`), guideStore = store(`home-guide-hidden-${org.id}`);
  const [hidden, setHidden] = useState<string[]>(() => hiddenStore.get<string[]>([]));
  const [guideHidden, setGuideHidden] = useState<boolean>(() => guideStore.get(false));
  const [editing, setEditing] = useState(false);
  useEffect(() => { api<Dash>(`/orgs/${org.id}/dashboard`).then(setD); api<Guide>(`/orgs/${org.id}/setup-guide`).then(setGuide); }, [org.id]);
  if (!d) return <p>Loading…</p>;
  const show = (k: string) => !hidden.includes(k);
  const toggle = (k: string) => { const next = show(k) ? [...hidden, k] : hidden.filter((x) => x !== k); setHidden(next); hiddenStore.set(next); };
  const setGuideVisible = (v: boolean) => { setGuideHidden(!v); guideStore.set(!v); };
  const label = (m: string) => new Date(m + '-01T00:00:00Z').toLocaleString('en-IN', { month: 'short', timeZone: 'UTC' });
  const toReconcile = d.banks.reduce((s, b) => s + b.unreconciled, 0);

  return (
    <>
      <PageHeader title="Dashboard" subtitle={`${org.name} · ${d.ytd.label}`}
        actions={<div className="flex items-center gap-3">
          {lastLogin && <span className="text-sm text-slate-500" data-testid="last-login">Last login: <span className="text-brand-700">{ago(lastLogin)}</span></span>}
          <Button variant={editing ? 'primary' : 'ghost'} onClick={() => setEditing(!editing)}>{editing ? 'Done' : 'Edit homepage'}</Button></div>} />

      {editing && (
        <Card title="Choose what the homepage shows">
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" checked={!guideHidden} onChange={(e) => setGuideVisible(e.target.checked)} />Setup guide</label>
            {CARDS.map(([k, l]) => <label key={k} className="flex items-center gap-2"><input type="checkbox" aria-label={`Show ${l}`} checked={show(k)} onChange={() => toggle(k)} />{l}</label>)}
          </div>
        </Card>
      )}

      {guide && !guideHidden && guide.completed < guide.total && (
        <section className="mb-4" aria-label="Setup guide">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-900">Setup guide <span className="ml-2 text-sm font-normal text-slate-500" data-testid="guide-progress">{guide.completed} of {guide.total} completed</span></h2>
            <Button variant="ghost" onClick={() => setGuideVisible(false)}>Hide</Button>
          </div>
          <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
            {guide.steps.map((s) => (
              <button key={s.key} onClick={() => go(s.page)} className={`rounded-xl border p-4 text-left transition hover:shadow-md ${s.done ? 'border-green-200 bg-green-50' : 'border-slate-200 bg-white'}`}>
                <p className={`flex items-center gap-2 font-semibold ${s.done ? 'text-green-800' : 'text-brand-700'}`}>{s.done ? '✓' : '›'} {s.label}</p>
                <p className="mt-1 text-xs text-slate-600">{s.text}</p>
                <div className="mt-3 h-1.5 rounded bg-slate-200"><div className={`h-full rounded ${s.done ? 'w-full bg-green-500' : 'w-0'}`} /></div>
              </button>))}
          </div>
        </section>
      )}

      {show('figures') && <div className="grid gap-4 md:grid-cols-4">
        <Stat label="Cash and bank" value={`₹${fmt(d.totalCash)}`} sub={`${d.banks.length} bank account(s)`} testId="total-cash" />
        <Stat label="Owed to you" value={`₹${fmt(d.receivables.total)}`} sub={`₹${fmt(d.receivables.overdue)} overdue`} tone={d.receivables.overdue > 0 ? 'bad' : 'default'} testId="receivables" />
        <Stat label="You owe" value={`₹${fmt(d.payables.total)}`} sub={`₹${fmt(d.payables.overdue)} overdue`} tone={d.payables.overdue > 0 ? 'bad' : 'default'} testId="payables" />
        <Stat label={`Profit ${d.ytd.label}`} value={`₹${fmt(d.ytd.profit)}`} sub={`Income ₹${fmt(d.ytd.income)} · Expenses ₹${fmt(d.ytd.expense)}`} tone={d.ytd.profit < 0 ? 'bad' : 'good'} testId="ytd-profit" />
      </div>}
      {show('charts') && <div className="mt-4 grid gap-4 md:grid-cols-2">
        <Card title="Income and expenses, last 6 months"><BarChart data={d.months.map((m) => ({ label: label(m.month), values: [m.income, m.expense] }))} series={[{ name: 'Income', color: '#6c5ce7' }, { name: 'Expenses', color: '#e11d48' }]} /></Card>
        <Card title="Cash in and out, last 6 months"><BarChart data={d.months.map((m) => ({ label: label(m.month), values: [m.cashIn, m.cashOut] }))} series={[{ name: 'Cash in', color: '#2563eb' }, { name: 'Cash out', color: '#f59e0b' }]} /></Card>
      </div>}
      <div className="mt-4 grid gap-4 md:grid-cols-3">
        {show('bank') && <Card title="Bank accounts" actions={<button className="text-sm text-brand-700 underline" onClick={() => go('bank')}>Open</button>}>
          {d.banks.length === 0 ? <p className="text-sm text-slate-500">No bank account connected yet.</p> : d.banks.map((b) => (
            <p key={b.id} className="flex justify-between py-1 text-sm"><span>{b.name}{b.unreconciled > 0 && <span className="ml-2 rounded bg-amber-100 px-1.5 text-xs text-amber-800">{b.unreconciled} to reconcile</span>}</span><span>₹{fmt(b.balance)}</span></p>))}
          {toReconcile === 0 && d.banks.length > 0 && <p className="mt-2 text-xs text-green-700">✓ Everything reconciled</p>}
        </Card>}
        {show('owed') && <Card title="Who owes you most" actions={<button className="text-sm text-brand-700 underline" onClick={() => go('invoices')}>Invoices</button>}>
          {d.receivables.top.length === 0 ? <p className="text-sm text-slate-500">Nobody owes you anything.</p> : d.receivables.top.map((c) => <p key={c.contact} className="flex justify-between py-1 text-sm"><span>{c.contact}</span><span>₹{fmt(c.total)}</span></p>)}
        </Card>}
        {show('tasks') && <Card title="Tasks" actions={<button className="text-sm text-brand-700 underline" onClick={() => go('tasks')}>Open</button>}>
          <p className="text-sm">{d.tasks.open} open{d.tasks.overdue > 0 && <span className="ml-2 font-medium text-red-700">{d.tasks.overdue} overdue</span>}</p>
          <p className="mt-2 text-xs text-slate-500">GST and TDS due dates are added from Tasks.</p>
        </Card>}
      </div>
    </>
  );
}
