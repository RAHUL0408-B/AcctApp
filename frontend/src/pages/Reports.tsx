import { Fragment, useEffect, useRef, useState } from 'react';
import { api, download, fmt, today } from '../api';
import type { Org } from '../App';
import { Button, Card, ErrorMsg, useAction } from '../ui';

const fyStart = () => { const d = new Date(); const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; return `${y}-04-01`; };
const REPORTS = [
  ['tb', 'Trial balance'], ['pnl', 'Profit & loss'], ['bs', 'Balance sheet'], ['ledger', 'Ledger'],
  ['cf', 'Cash flow'], ['ar', 'Aged receivables'], ['ap', 'Aged payables'], ['gstr1', 'GSTR-1'], ['gstr3b', 'GSTR-3B'],
  ['pnlm', 'P&L by month'], ['pnlt', 'P&L by category'], ['bva', 'Budget vs actual'],
] as const;
const RANGED = ['pnl', 'ledger', 'gstr1', 'gstr3b', 'cf', 'pnlm', 'pnlt', 'bva'];
const EXPORT: Record<string, string> = { tb: 'trial-balance', pnl: 'pnl', bs: 'balance-sheet', ledger: 'ledger', cf: '', ar: 'aged-receivables', ap: 'aged-payables', gstr1: 'gstr1-b2b', gstr3b: 'gstr3b', pnlm: '', pnlt: '', bva: '' };

export function Reports({ org, accounts }: { org: Org; accounts: { id: number; code: string; name: string }[] }) {
  const [rep, setRep] = useState<string>('pnl');
  const [from, setFrom] = useState(fyStart()), [to, setTo] = useState(today()), [accountId, setAccountId] = useState('');
  const [categories, setCategories] = useState<{ id: number; name: string }[]>([]), [budgets, setBudgets] = useState<{ id: number; name: string }[]>([]);
  const [categoryId, setCategoryId] = useState(''), [budgetId, setBudgetId] = useState('');
  useEffect(() => {
    api<{ id: number; name: string }[]>(`/orgs/${org.id}/tracking`).then((c) => { setCategories(c); if (c[0]) setCategoryId(String(c[0].id)); });
    api<{ id: number; name: string }[]>(`/orgs/${org.id}/budgets`).then((b) => { setBudgets(b); if (b[0]) setBudgetId(String(b[0].id)); });
  }, [org.id]);
  const [data, setData] = useState<{ rep: string; d: any } | null>(null); // tagged so a stale report never renders in another layout
  const { error, run } = useAction();
  const latest = useRef(0); // only the newest request may set the result; slower, older responses are dropped

  const query = () => {
    const p = new URLSearchParams();
    if (RANGED.includes(rep)) { p.set('from', from); p.set('to', to); } else p.set('asOf', to);
    if (rep === 'ledger') p.set('accountId', accountId);
    if (rep === 'pnlt') p.set('categoryId', categoryId);
    if (rep === 'bva') p.set('budgetId', budgetId);
    return p;
  };
  const load = () => run(async () => {
    const mine = ++latest.current;
    setData(null);
    const q = query();
    const url = { tb: `/trial-balance?asOf=${to}`, pnl: `/reports/pnl?${q}`, bs: `/reports/balance-sheet?${q}`, ledger: `/reports/ledger/${accountId}?${q}`,
      cf: `/reports/cash-flow?${q}`, ar: `/reports/aged-receivables?${q}`, ap: `/reports/aged-payables?${q}`, gstr1: `/reports/gstr1?${q}`, gstr3b: `/reports/gstr3b?${q}`,
      pnlm: `/reports/pnl-by-month?${q}`, pnlt: `/reports/pnl-by-tracking?${q}`, bva: `/reports/budget-vs-actual?${q}` }[rep]!;
    if ((rep === 'ledger' && !accountId) || (rep === 'pnlt' && !categoryId) || (rep === 'bva' && !budgetId)) return;
    const current = rep;
    const d = await api(`/orgs/${org.id}${url}`);
    if (mine === latest.current) setData({ rep: current, d });
  });
  useEffect(() => { load(); }, [rep, org.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const exp = (format: 'pdf' | 'xlsx') => run(() => download(`/orgs/${org.id}/export/${EXPORT[rep]}?format=${format}&${query()}`, `${EXPORT[rep]}.${format}`));

  return (
    <>
      <div className="flex flex-wrap gap-1 text-sm">{REPORTS.map(([k, l]) => <button key={k} className={`rounded px-3 py-1 ${rep === k ? 'bg-slate-800 text-white' : 'border border-slate-300 bg-white'}`} onClick={() => setRep(k)}>{l}</button>)}</div>
      <Card>
        <div className="flex flex-wrap items-end gap-3 text-sm">
          {RANGED.includes(rep) && <label>From <input aria-label="From" type="date" className="rounded border border-slate-300 px-2 py-1" value={from} onChange={(e) => setFrom(e.target.value)} /></label>}
          <label>{RANGED.includes(rep) ? 'To' : 'As at'} <input aria-label="To" type="date" className="rounded border border-slate-300 px-2 py-1" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          {rep === 'ledger' && <select aria-label="Ledger account" className="rounded border border-slate-300 px-2 py-1" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">Account…</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select>}
          {rep === 'pnlt' && (categories.length ? <select aria-label="Tracking category" className="rounded border border-slate-300 px-2 py-1" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
            : <span className="text-slate-500">Add a tracking category under Setup first.</span>)}
          {rep === 'bva' && (budgets.length ? <select aria-label="Budget" className="rounded border border-slate-300 px-2 py-1" value={budgetId} onChange={(e) => setBudgetId(e.target.value)}>{budgets.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
            : <span className="text-slate-500">Create a budget under Accounting first.</span>)}
          <Button onClick={load}>Run</Button>
          {EXPORT[rep] && <><Button variant="ghost" onClick={() => exp('pdf')}>Export PDF</Button>
          <Button variant="ghost" onClick={() => exp('xlsx')}>Export Excel</Button></>}
        </div>
        <div className="mt-3"><ErrorMsg msg={error} /></div>
      </Card>
      {data && data.rep === rep && <Card title={REPORTS.find((r) => r[0] === rep)![1]}><ReportView rep={rep} d={data.d} /></Card>}
    </>
  );
}

const Row = ({ label, v, bold }: { label: string; v: number; bold?: boolean }) => (
  <tr className={`border-t border-slate-100 ${bold ? 'font-semibold' : ''}`}><td className="py-1">{label}</td><td className="text-right">{fmt(v)}</td></tr>
);

function ReportView({ rep, d }: { rep: string; d: any }) {
  if (rep === 'tb') return (
    <table className="w-full text-sm"><thead><tr className="text-left text-slate-500"><th>Account</th><th className="text-right">Debit</th><th className="text-right">Credit</th></tr></thead>
      <tbody>{d.accounts.map((a: any) => <tr key={a.code} className="border-t border-slate-100"><td>{a.code} {a.name}</td><td className="text-right">{a.debit ? fmt(a.debit) : ''}</td><td className="text-right">{a.credit ? fmt(a.credit) : ''}</td></tr>)}
        <tr className="border-t-2 font-semibold"><td>Total {d.balanced ? '✓' : '✗'}</td><td className="text-right" data-testid="tb-debit">{fmt(d.totalDebit)}</td><td className="text-right" data-testid="tb-credit">{fmt(d.totalCredit)}</td></tr></tbody></table>);
  if (rep === 'pnl') return (
    <table className="w-full text-sm"><tbody>
      <tr><td className="pt-2 font-semibold text-slate-500">Income</td></tr>{d.income.items.map((i: any) => <Row key={i.code} label={`${i.code} ${i.name}`} v={i.amount} />)}<Row label="Total income" v={d.income.total} bold />
      <tr><td className="pt-4 font-semibold text-slate-500">Expenses</td></tr>{d.expenses.items.map((i: any) => <Row key={i.code} label={`${i.code} ${i.name}`} v={i.amount} />)}<Row label="Total expenses" v={d.expenses.total} bold />
      <tr className="border-t-2 text-base font-bold"><td className="py-2">Net profit / (loss)</td><td className="text-right" data-testid="net-profit">{fmt(d.netProfit)}</td></tr></tbody></table>);
  if (rep === 'bs') return (
    <table className="w-full text-sm"><tbody>
      {(['assets', 'liabilities', 'equity'] as const).map((s) => (<Fragment key={s}>
        <tr><td className="pt-3 font-semibold capitalize text-slate-500">{s}</td></tr>
        {d[s].items.map((i: any) => <Row key={s + i.code} label={`${i.code} ${i.name}`} v={i.amount} />)}
        {s === 'equity' && <Row label="Profit to date" v={d.equity.profitToDate} />}
        <Row label={`Total ${s}`} v={d[s].total} bold /></Fragment>))}
      <tr><td className="pt-3 text-sm">{d.balanced ? '✓ Assets = Liabilities + Equity' : '✗ Out of balance'}</td></tr></tbody></table>);
  if (rep === 'cf') return (
    <table className="w-full text-sm" data-testid="cashflow"><thead><tr className="text-left text-slate-500"><th>Month</th><th className="text-right">Opening</th><th className="text-right">Cash in</th><th className="text-right">Cash out</th><th className="text-right">Closing</th></tr></thead>
      <tbody><tr><td colSpan={4}>Opening balance</td><td className="text-right">{fmt(d.openingBalance)}</td></tr>
        {d.months.map((m: any) => <tr key={m.month} className="border-t border-slate-100"><td>{m.month}</td><td className="text-right">{fmt(m.opening)}</td><td className="text-right text-green-700">{fmt(m.cashIn)}</td><td className="text-right text-red-700">{fmt(m.cashOut)}</td><td className="text-right">{fmt(m.closing)}</td></tr>)}
        <tr className="border-t-2 font-semibold"><td>Total</td><td /><td className="text-right">{fmt(d.totalIn)}</td><td className="text-right">{fmt(d.totalOut)}</td><td className="text-right" data-testid="cf-closing">{fmt(d.closingBalance)}</td></tr></tbody></table>);
  if (rep === 'ledger') return (
    <table className="w-full text-sm"><thead><tr className="text-left text-slate-500"><th>Date</th><th>Narration</th><th className="text-right">Debit</th><th className="text-right">Credit</th><th className="text-right">Balance</th></tr></thead>
      <tbody><tr><td /><td>Opening balance</td><td /><td /><td className="text-right">{fmt(d.openingBalance)}</td></tr>
        {d.lines.map((l: any, i: number) => <tr key={i} className="border-t border-slate-100"><td>{l.date}</td><td>{l.narration}</td><td className="text-right">{l.debit ? fmt(l.debit) : ''}</td><td className="text-right">{l.credit ? fmt(l.credit) : ''}</td><td className="text-right">{fmt(l.balance)}</td></tr>)}</tbody></table>);
  if (rep === 'ar' || rep === 'ap') return (
    <table className="w-full text-sm"><thead><tr className="text-left text-slate-500"><th>Contact</th>{['Not due', '1-30', '31-60', '61-90', '90+', 'Total'].map((h) => <th key={h} className="text-right">{h}</th>)}</tr></thead>
      <tbody>{[...d.contacts, { contact: 'Total', ...d.totals }].map((c: any) => <tr key={c.contact} className={`border-t border-slate-100 ${c.contact === 'Total' ? 'font-semibold' : ''}`}><td>{c.contact}</td>
        {['notDue', 'days1to30', 'days31to60', 'days61to90', 'over90', 'total'].map((k) => <td key={k} className="text-right">{fmt(c[k])}</td>)}</tr>)}</tbody></table>);
  if (rep === 'gstr1') return (
    <div className="space-y-4 text-sm">
      {(['b2b', 'b2cl', 'exp', 'cdnr', 'cdnur'] as const).map((s) => (
        <div key={s}><h3 className="font-semibold uppercase">{s} ({d[s].length})</h3>
          {d[s].length > 0 && <table className="w-full"><tbody>{d[s].map((x: any) => <tr key={x.number} className="border-t border-slate-100"><td>{x.number}</td><td>{x.date}</td><td>{x.gstin ?? x.party}</td><td>POS {x.placeOfSupply}</td><td className="text-right">{fmt(x.taxable)}</td><td className="text-right">IGST {fmt(x.igst)} · CGST {fmt(x.cgst)} · SGST {fmt(x.sgst)}</td></tr>)}</tbody></table>}</div>))}
      <div><h3 className="font-semibold">B2CS (by place of supply and rate)</h3>{d.b2cs.map((x: any, i: number) => <p key={i}>POS {x.pos} @ {x.rateBp / 100}%: taxable {fmt(x.taxable)}</p>)}</div>
      <div><h3 className="font-semibold">HSN summary</h3>{d.hsn.map((x: any, i: number) => <p key={i}>{x.hsn} @ {x.rateBp / 100}% · qty {x.quantity} · taxable {fmt(x.taxable)}</p>)}</div>
      <p className="text-xs text-slate-500">Working paper only. Review with your CA before filing on the GST portal.</p>
    </div>);
  if (rep === 'pnlm' || rep === 'pnlt') return <GridReport d={d} />;
  if (rep === 'bva') return (
    <table className="w-full text-sm" data-testid="bva"><thead><tr className="text-left"><th>Account</th><th className="text-right">Budget</th><th className="text-right">Actual</th><th className="text-right">Variance</th></tr></thead>
      <tbody>{d.lines.map((l: any) => <tr key={l.code}><td>{l.code} {l.name}</td><td className="text-right">{fmt(l.budget)}</td><td className="text-right">{fmt(l.actual)}</td>
        <td className={`text-right ${l.favourable ? 'text-green-700' : 'text-red-700'}`}>{fmt(l.variance)}</td></tr>)}
        <tr className="border-t-2 font-semibold"><td>Profit</td><td className="text-right">{fmt(d.totals.profitBudget)}</td><td className="text-right">{fmt(d.totals.profitActual)}</td><td className="text-right">{fmt(d.totals.profitActual - d.totals.profitBudget)}</td></tr></tbody></table>);
  if (rep === 'gstr3b') {
    const o = d.section31a_outwardTaxable, itc = d.section4_itcAvailable, n = d.netTaxPayable;
    return (
      <div className="text-sm"><table className="w-full"><thead><tr className="text-left text-slate-500"><th /><th className="text-right">Taxable</th><th className="text-right">IGST</th><th className="text-right">CGST</th><th className="text-right">SGST</th></tr></thead>
        <tbody><tr className="border-t"><td>3.1(a) Outward taxable</td><td className="text-right">{fmt(o.taxable)}</td><td className="text-right">{fmt(o.igst)}</td><td className="text-right">{fmt(o.cgst)}</td><td className="text-right">{fmt(o.sgst)}</td></tr>
          <tr className="border-t"><td>3.1(b) Zero-rated (exports, SEZ)</td><td className="text-right">{fmt(d.section31b_zeroRated.taxable)}</td><td className="text-right">{fmt(d.section31b_zeroRated.igst)}</td><td /><td /></tr>
          <tr className="border-t"><td>3.1(c) Nil / exempt</td><td className="text-right">{fmt(d.section31c_nilRatedExempt.taxable)}</td><td /><td /><td /></tr>
          <tr className="border-t"><td>3.1(d) Inward reverse charge</td><td className="text-right">{fmt(d.section31d_inwardReverseCharge.taxable)}</td><td className="text-right">{fmt(d.section31d_inwardReverseCharge.igst)}</td><td className="text-right">{fmt(d.section31d_inwardReverseCharge.cgst)}</td><td className="text-right">{fmt(d.section31d_inwardReverseCharge.sgst)}</td></tr>
          <tr className="border-t"><td>4. ITC available</td><td /><td className="text-right">{fmt(itc.igst)}</td><td className="text-right">{fmt(itc.cgst)}</td><td className="text-right">{fmt(itc.sgst)}</td></tr>
          <tr className="border-t-2 font-semibold"><td>Net payable (negative = carry forward)</td><td /><td className="text-right">{fmt(n.igst)}</td><td className="text-right">{fmt(n.cgst)}</td><td className="text-right">{fmt(n.sgst)}</td></tr></tbody></table>
        <p className="mt-2 text-xs text-amber-700">{d.note}</p></div>);
  }
  return null;
}

/** Profit and loss with several amount columns (months or tracking options). */
function GridReport({ d }: { d: any }) {
  const section = (title: string, s: any) => (<Fragment key={title}>
    <tr><td className="pt-3 font-semibold text-slate-500" colSpan={d.columns.length + 2}>{title}</td></tr>
    {s.items.map((i: any) => <tr key={title + i.code}><td className="whitespace-nowrap">{i.code} {i.name}</td>{i.amounts.map((v: number, k: number) => <td key={k} className="text-right">{v ? fmt(v) : ''}</td>)}<td className="text-right font-medium">{fmt(i.total)}</td></tr>)}
    <tr className="font-semibold"><td>Total {title.toLowerCase()}</td>{s.totals.map((v: number, k: number) => <td key={k} className="text-right">{fmt(v)}</td>)}<td className="text-right">{fmt(s.total)}</td></tr></Fragment>);
  return (
    <div className="overflow-x-auto"><table className="w-full text-sm" data-testid="grid-report"><thead><tr className="text-left"><th>Account</th>{d.columns.map((c: string) => <th key={c} className="text-right">{c}</th>)}<th className="text-right">Total</th></tr></thead>
      <tbody>{section('Income', d.income)}{section('Expenses', d.expenses)}
        <tr className="border-t-2 font-bold"><td>Net profit</td>{d.netProfit.map((v: number, k: number) => <td key={k} className="text-right">{fmt(v)}</td>)}<td className="text-right" data-testid="grid-net">{fmt(d.netProfitTotal)}</td></tr></tbody></table></div>);
}
