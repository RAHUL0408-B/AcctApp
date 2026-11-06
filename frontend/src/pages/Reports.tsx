import { Fragment, useEffect, useRef, useState } from 'react';
import { api, download, fmt, today } from '../api';
import type { Org } from '../App';
import { Button, Card, ErrorMsg, useAction } from '../ui';
import { CombinePanel } from '../export';

const fyStart = () => { const d = new Date(); const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; return `${y}-04-01`; };
const REPORTS = [
  ['tb', 'Trial balance'], ['pnl', 'Profit & loss'], ['bs', 'Balance sheet'], ['ledger', 'Ledger'],
  ['cf', 'Cash flow'], ['ar', 'Aged receivables'], ['ap', 'Aged payables'], ['gstr1', 'GSTR-1'], ['gstr3b', 'GSTR-3B'],
  ['pnlm', 'P&L by month'], ['pnlt', 'P&L by cost centre'], ['bva', 'Budget vs actual'],
  ['stcf', 'Short-term cash flow'], ['snap', 'Business snapshot'], ['tds', 'TDS deducted'],
  ['alll', 'All ledgers'], ['invw', 'Invoice-wise'], ['billw', 'Bill-wise'], ['preg', 'Purchase register'], ['far', 'Fixed asset register'],
] as const;

/** Starred reports, kept in this browser and shown in the Reporting menu. */
const FAV_KEY = 'favourite-reports';
export const favouriteReports = (): { key: string; label: string }[] => {
  let keys: string[] = [];
  try { keys = JSON.parse(localStorage.getItem(FAV_KEY) ?? '[]'); } catch { /* ignore a damaged value */ }
  return REPORTS.filter(([k]) => keys.includes(k)).map(([key, label]) => ({ key, label }));
};
const toggleFavourite = (k: string) => {
  const keys = favouriteReports().map((f) => f.key);
  localStorage.setItem(FAV_KEY, JSON.stringify(keys.includes(k) ? keys.filter((x) => x !== k) : [...keys, k]));
};
const RANGED = ['pnl', 'ledger', 'gstr1', 'gstr3b', 'cf', 'pnlm', 'pnlt', 'bva', 'snap', 'tds', 'alll', 'invw', 'billw', 'preg'];
/** Reports that come from the shared table builder, so they can be shown as a table and exported. */
const TABLE: Record<string, string> = { alll: 'all-ledgers', invw: 'invoice-wise', billw: 'bill-wise', preg: 'purchase-register', far: 'fixed-assets' };
const EXPORT: Record<string, string> = { tb: 'trial-balance', pnl: 'pnl', bs: 'balance-sheet', ledger: 'ledger', cf: '', ar: 'aged-receivables', ap: 'aged-payables', gstr1: 'gstr1-b2b', gstr3b: 'gstr3b', pnlm: '', pnlt: '', bva: '', stcf: '', snap: '', tds: '', alll: 'all-ledgers', invw: 'invoice-wise', billw: 'bill-wise', preg: 'purchase-register', far: 'fixed-assets' };

export function Reports({ org, accounts, initial }: { org: Org; accounts: { id: number; code: string; name: string }[]; initial?: string }) {
  const known = (k?: string) => (k && REPORTS.some(([x]) => x === k) ? k : undefined);
  const [rep, setRep] = useState<string>(known(initial) ?? 'pnl');
  useEffect(() => { const k = known(initial); if (k) setRep(k); }, [initial]); // eslint-disable-line react-hooks/exhaustive-deps
  const [days, setDays] = useState('30');
  const [, setFavTick] = useState(0);
  const isFav = favouriteReports().some((f) => f.key === rep);
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
    if (rep === 'stcf') p.set('days', days);
    return p;
  };
  const load = () => run(async () => {
    const mine = ++latest.current;
    setData(null);
    const q = query();
    const url = { tb: `/trial-balance?asOf=${to}`, pnl: `/reports/pnl?${q}`, bs: `/reports/balance-sheet?${q}`, ledger: `/reports/ledger/${accountId}?${q}`,
      cf: `/reports/cash-flow?${q}`, ar: `/reports/aged-receivables?${q}`, ap: `/reports/aged-payables?${q}`, gstr1: `/reports/gstr1?${q}`, gstr3b: `/reports/gstr3b?${q}`,
      pnlm: `/reports/pnl-by-month?${q}`, pnlt: `/reports/pnl-by-tracking?${q}`, bva: `/reports/budget-vs-actual?${q}`,
      stcf: `/reports/short-term-cash-flow?${q}`, snap: `/reports/business-snapshot?${q}`, tds: `/reports/tds?${q}`,
      alll: `/report-table/all-ledgers?${q}`, invw: `/report-table/invoice-wise?${q}`, billw: `/report-table/bill-wise?${q}`, preg: `/report-table/purchase-register?${q}`, far: `/report-table/fixed-assets?${q}` }[rep]!;
    if ((rep === 'ledger' && !accountId) || (rep === 'pnlt' && !categoryId) || (rep === 'bva' && !budgetId)) return;
    const current = rep;
    const d = await api(`/orgs/${org.id}${url}`);
    if (mine === latest.current) setData({ rep: current, d });
  });
  useEffect(() => { load(); }, [rep, org.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const exp = (format: 'pdf' | 'xlsx') => run(() => download(`/orgs/${org.id}/export/${EXPORT[rep]}?format=${format}&${query()}`, `${EXPORT[rep]}.${format}`));
  // Several reports combined into one file. How the file looks comes from the organisation's report template.
  const [combine, setCombine] = useState(false);
  const manyChoices = REPORTS.filter(([k]) => EXPORT[k]).map(([k, label]) => ({ key: k, label, disabled: k === 'ledger' && !accountId ? 'choose an account first' : undefined }));
  const exportMany = (format: 'pdf' | 'xlsx', chosen: string[]) => run(() => {
    const p = new URLSearchParams({ from, to, asOf: to, ...(accountId ? { accountId } : {}) });
    return download(`/orgs/${org.id}/export-multi?format=${format}&reports=${chosen.map((k) => EXPORT[k]).join(',')}&${p}`, `reports.${format}`);
  });
  // Every account's ledger in one file, for the same dates.
  const expAll = (format: 'pdf' | 'xlsx') => run(() => { const p = new URLSearchParams({ from, to }); return download(`/orgs/${org.id}/export/all-ledgers?format=${format}&${p}`, `all-ledgers.${format}`); });

  return (
    <>
      <div className="flex flex-wrap gap-1 text-sm">{REPORTS.map(([k, l]) => <button key={k} className={`rounded px-3 py-1 ${rep === k ? 'bg-slate-800 text-white' : 'border border-slate-300 bg-white'}`} onClick={() => setRep(k)}>{l}</button>)}</div>
      <Card>
        <div className="flex flex-wrap items-end gap-3 text-sm">
          {RANGED.includes(rep) && <label>From <input aria-label="From" type="date" className="rounded border border-slate-300 px-2 py-1" value={from} onChange={(e) => setFrom(e.target.value)} /></label>}
          {rep === 'stcf' ? <label>Next <select aria-label="Days ahead" className="rounded border border-slate-300 px-2 py-1" value={days} onChange={(e) => setDays(e.target.value)}>{['30', '60', '90'].map((d) => <option key={d} value={d}>{d} days</option>)}</select></label>
            : <label>{RANGED.includes(rep) ? 'To' : 'As at'} <input aria-label="To" type="date" className="rounded border border-slate-300 px-2 py-1" value={to} onChange={(e) => setTo(e.target.value)} /></label>}
          {rep === 'ledger' && <select aria-label="Ledger account" className="rounded border border-slate-300 px-2 py-1" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">Account…</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select>}
          {rep === 'pnlt' && (categories.length ? <select aria-label="Cost centre group" className="rounded border border-slate-300 px-2 py-1" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
            : <span className="text-slate-500">Add a cost centre group under Accounting first.</span>)}
          {rep === 'bva' && (budgets.length ? <select aria-label="Budget" className="rounded border border-slate-300 px-2 py-1" value={budgetId} onChange={(e) => setBudgetId(e.target.value)}>{budgets.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
            : <span className="text-slate-500">Create a budget under Accounting first.</span>)}
          <Button onClick={load}>Run</Button>
          <Button variant="ghost" aria-pressed={isFav} onClick={() => { toggleFavourite(rep); setFavTick((n) => n + 1); }}>{isFav ? '★ Favourite' : '☆ Add to favourites'}</Button>
          {EXPORT[rep] && <><Button variant="ghost" onClick={() => exp('pdf')}>Export PDF</Button>
          <Button variant="ghost" onClick={() => exp('xlsx')}>Export Excel</Button></>}
          <Button variant="ghost" aria-expanded={combine} onClick={() => setCombine(!combine)}>Export several reports…</Button>
          {rep === 'ledger' && <><Button variant="ghost" onClick={() => expAll('xlsx')}>Export all accounts (Excel)</Button><Button variant="ghost" onClick={() => expAll('pdf')}>Export all accounts (PDF)</Button></>}
        </div>
        <div className="mt-3"><ErrorMsg msg={error} /></div>
      </Card>
      {combine && <CombinePanel title="Export several reports in one file" choices={manyChoices} chosen={EXPORT[rep] ? [rep] : []} busy={false} onExport={exportMany} onClose={() => setCombine(false)} />}
      {data && data.rep === rep && <Card title={REPORTS.find((r) => r[0] === rep)![1]}><ReportView rep={rep} d={data.d} org={org} reload={load} /></Card>}
    </>
  );
}

const Row = ({ label, v, bold }: { label: string; v: number; bold?: boolean }) => (
  <tr className={`border-t border-slate-100 ${bold ? 'font-semibold' : ''}`}><td className="py-1">{label}</td><td className="text-right">{fmt(v)}</td></tr>
);

function ReportView({ rep, d, org, reload }: { rep: string; d: any; org: Org; reload: () => void }) {
  if (TABLE[rep]) return <TableReport d={d} org={org} reload={reload} selectable={['invw', 'billw', 'preg'].includes(rep)} />;
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
  if (rep === 'stcf') return <CashForecast d={d} />;
  if (rep === 'snap') return <Snapshot d={d} />;
  if (rep === 'tds') return <TdsReport d={d} />;
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

/** Cash now plus money due in and out, week by week. */
function CashForecast({ d }: { d: any }) {
  return (
    <div className="text-sm">
      <div className="mb-4 grid gap-3 md:grid-cols-3">
        <div className="rounded bg-slate-50 p-3"><p className="text-slate-500">Cash and bank today</p><p className="text-lg font-semibold">₹{fmt(d.opening)}</p></div>
        <div className="rounded bg-slate-50 p-3"><p className="text-slate-500">Projected in {d.days} days</p><p className={`text-lg font-semibold ${d.projected < 0 ? 'text-red-700' : ''}`} data-testid="stcf-projected">₹{fmt(d.projected)}</p></div>
        <div className="rounded bg-slate-50 p-3"><p className="text-slate-500">If overdue items are settled too</p><p className="text-lg font-semibold">₹{fmt(d.projectedIncludingOverdue)}</p>
          <p className="text-xs text-slate-500">Overdue: ₹{fmt(d.overdue.cashIn)} in · ₹{fmt(d.overdue.cashOut)} out</p></div>
      </div>
      <table className="w-full" data-testid="stcf"><thead><tr className="text-left"><th>Week</th><th className="text-right">Money in</th><th className="text-right">Money out</th><th className="text-right">Net</th><th className="text-right">Balance</th></tr></thead>
        <tbody>{d.weeks.map((w: any) => <tr key={w.start}><td>{w.start} to {w.end}</td><td className="text-right text-green-700">{fmt(w.cashIn)}</td><td className="text-right text-red-700">{fmt(w.cashOut)}</td><td className="text-right">{fmt(w.net)}</td>
          <td className={`text-right font-medium ${w.closing < 0 ? 'text-red-700' : ''}`}>{fmt(w.closing)}</td></tr>)}</tbody></table>
      {d.items.length > 0 && <><h3 className="mt-4 font-semibold">Invoices and bills behind these figures</h3>
        <table className="w-full"><tbody>{d.items.map((i: any) => <tr key={i.number}><td>{i.date}{i.overdue && <span className="ml-2 text-xs text-red-700">overdue</span>}</td><td>{i.number}</td><td>{i.contact}</td>
          <td className={`text-right ${i.direction === 'in' ? 'text-green-700' : 'text-red-700'}`}>{i.direction === 'in' ? '+' : '−'}{fmt(i.amount)}</td></tr>)}</tbody></table></>}
      <p className="mt-3 text-xs text-slate-500">Based on due dates of unpaid invoices and bills. Repeating invoices not yet raised, salaries and taxes are not included.</p>
    </div>
  );
}

const TONE: Record<string, string> = { good: 'bg-green-100 text-green-800', watch: 'bg-amber-100 text-amber-800', concern: 'bg-red-100 text-red-800', 'n/a': 'bg-slate-100 text-slate-600' };

/** Key figures and a simple health scorecard. */
function Snapshot({ d }: { d: any }) {
  const pct = (v: number | null) => (v == null ? '—' : `${v}%`), num = (v: number | null, u = '') => (v == null ? '—' : `${v}${u}`);
  const tiles: [string, string][] = [['Income', `₹${fmt(d.income)}`], ['Gross profit', `₹${fmt(d.grossProfit)} (${pct(d.grossMarginPct)})`], ['Expenses', `₹${fmt(d.expenses)}`], ['Net profit', `₹${fmt(d.profit)} (${pct(d.netMarginPct)})`],
    ['Cash and bank', `₹${fmt(d.cash)}`], ['Owed to you', `₹${fmt(d.receivables)}`], ['You owe', `₹${fmt(d.payables)}`], ['Current ratio', num(d.currentRatio, '×')],
    ['Debtor days', num(d.debtorDays)], ['Creditor days', num(d.creditorDays)], ['Avg. days to get paid', num(d.daysToGetPaid)], ['Avg. days to pay suppliers', num(d.daysToPaySuppliers)]];
  return (
    <div className="text-sm">
      <div className="grid gap-3 md:grid-cols-4">{tiles.map(([k, v]) => <div key={k} className="rounded bg-slate-50 p-3"><p className="text-slate-500">{k}</p><p className="font-semibold">{v}</p></div>)}</div>
      <h3 className="mt-5 font-semibold">Business health scorecard</h3>
      <table className="mt-2 w-full" data-testid="scorecard"><tbody>{d.scorecard.map((s: any) => (
        <tr key={s.metric}><td className="font-medium">{s.metric}</td><td className="text-right">{s.value == null ? '—' : `${s.value} ${s.unit}`}</td>
          <td><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${TONE[s.status]}`}>{s.status}</span></td><td className="text-slate-500">{s.help}</td></tr>))}</tbody></table>
      <p className="mt-3 text-xs text-slate-500">Guidance only. Thresholds are general rules of thumb; what is healthy depends on the business.</p>
    </div>
  );
}

/** TDS deducted on bills, by section and by month, with deposit due dates. */
function TdsReport({ d }: { d: any }) {
  return (
    <div className="space-y-4 text-sm">
      <div className="grid gap-4 md:grid-cols-2">
        <div><h3 className="font-semibold">By section</h3><table className="w-full"><thead><tr className="text-left"><th>Section</th><th className="text-right">Bills</th><th className="text-right">Amount</th><th className="text-right">TDS</th></tr></thead>
          <tbody>{d.bySection.map((x: any) => <tr key={x.section}><td>{x.section}</td><td className="text-right">{x.count}</td><td className="text-right">{fmt(x.amount)}</td><td className="text-right">{fmt(x.tds)}</td></tr>)}</tbody></table></div>
        <div><h3 className="font-semibold">Deposit by</h3><table className="w-full"><thead><tr className="text-left"><th>Month deducted</th><th className="text-right">TDS</th><th>Deposit by</th></tr></thead>
          <tbody>{d.byMonth.map((x: any) => <tr key={x.month}><td>{x.month}</td><td className="text-right">{fmt(x.tds)}</td><td>{x.depositBy}</td></tr>)}</tbody></table></div>
      </div>
      <div><h3 className="font-semibold">Deductions (for 26Q)</h3>
        {d.rows.length === 0 ? <p className="text-slate-500">No TDS deducted in this period.</p> : (
          <table className="w-full" data-testid="tds-rows"><thead><tr className="text-left"><th>Date</th><th>Quarter</th><th>Bill</th><th>Party</th><th>PAN</th><th>Section</th><th className="text-right">Amount</th><th className="text-right">TDS</th></tr></thead>
            <tbody>{d.rows.map((x: any) => <tr key={x.id}><td>{x.date}</td><td>{x.quarter}</td><td>{x.number}</td><td>{x.party}</td><td>{x.pan ?? <span className="text-red-700">missing</span>}</td><td>{x.section}</td><td className="text-right">{fmt(x.amount)}</td><td className="text-right">{fmt(x.tds)}</td></tr>)}
              <tr className="border-t-2 font-semibold"><td colSpan={7}>Total TDS</td><td className="text-right" data-testid="tds-total">{fmt(d.totalTds)}</td></tr></tbody></table>)}
      </div>
      <p className="text-xs text-amber-700">{d.note}</p>
    </div>
  );
}

/** A report built as a plain table. Document reports let you tick rows and archive or delete them. */
function TableReport({ d, org, reload, selectable }: { d: any; org: Org; reload: () => void; selectable: boolean }) {
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [ok, setOk] = useState('');
  const { error, busy, run } = useAction();
  const ids: (number | null)[] = d.rowIds ?? [];
  const bold = new Set<number>(d.boldRows ?? []);
  const toggle = (id: number) => setPicked((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const act = (what: 'archive' | 'delete') => run(async () => {
    const list = [...picked]; if (!list.length) return;
    if (what === 'delete') {
      if (!window.confirm(`Delete ${list.length} document(s)? Each is cancelled with a reversing entry. Ones with payments or credit/debit notes are skipped.`)) return;
      const r = await api(`/orgs/${org.id}/documents/bulk-void`, { body: { ids: list, date: today(), reason: 'Deleted from a report' } });
      setOk(`${r.voided.length} deleted.${r.failed.length ? ` ${r.failed.length} skipped: ${r.failed.map((x: any) => `${x.number ?? x.id} (${x.reason})`).join('; ')}` : ''}`);
    } else {
      await api(`/orgs/${org.id}/documents/bulk-archive`, { body: { ids: list, archived: true } });
      setOk(`${list.length} archived. They no longer appear in this report or the lists; use "Show archived" on the Invoices or Bills page to see them.`);
    }
    setPicked(new Set()); reload();
  });
  return (
    <div className="text-sm">
      <p className="mb-2 text-slate-500">{d.subtitle}</p>
      {selectable && picked.size > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded bg-brand-50 px-3 py-2"><b>{picked.size} selected</b>
          <Button variant="danger" disabled={busy} onClick={() => act('delete')}>Delete selected</Button>
          <Button variant="ghost" disabled={busy} onClick={() => act('archive')}>Archive selected</Button>
          <Button variant="ghost" onClick={() => setPicked(new Set())}>Clear</Button></div>)}
      <div className="mb-2 space-y-2"><ErrorMsg msg={error} />{ok && <p className="rounded bg-green-50 px-3 py-2 text-green-800">{ok}</p>}</div>
      <div className="overflow-x-auto">
        <table className="w-full" data-testid="table-report"><thead><tr className="text-left text-slate-500">{selectable && <th className="w-8" />}{d.columns.map((c: any, i: number) => <th key={i} className={c.type === 'money' ? 'text-right' : ''}>{c.header}</th>)}</tr></thead>
          <tbody>{d.rows.map((r: (string | number)[], ri: number) => (
            <tr key={ri} className={`border-t border-slate-100 ${bold.has(ri) ? 'font-semibold' : ''}`}>
              {selectable && <td>{ids[ri] != null && <input type="checkbox" aria-label={`Select ${r[0]}`} checked={picked.has(ids[ri] as number)} onChange={() => toggle(ids[ri] as number)} />}</td>}
              {r.map((v, ci) => <td key={ci} className={d.columns[ci].type === 'money' ? 'text-right' : ''}>{d.columns[ci].type === 'money' ? (typeof v === 'number' ? fmt(v) : '') : String(v)}</td>)}
            </tr>))}</tbody></table>
        {d.rows.length === 0 && <p className="py-6 text-center text-slate-500">Nothing to show for these dates.</p>}
      </div>
    </div>
  );
}
