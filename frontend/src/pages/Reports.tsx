import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { api, download, fmt, today } from '../api';
import type { Org } from '../App';
import { Button, Callout, Card, ErrorMsg, Ok, useAction , ask } from '../ui';
import { FORMATS, Icon, exportTable, useAnchor, useOutside, type ExportFormat, type ExportTable } from '../table';
import { CombinePanel } from '../export';
import { Combo, PickList } from '../combo';

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

/** The report picker, grouped. "All ledgers" is now the ledger report with no account range chosen. */
const MENU: [string, string[]][] = [
  ['Financial statements', ['pnl', 'bs', 'tb', 'cf']], ['Ledgers', ['ledger']], ['Receivables and payables', ['ar', 'ap', 'invw', 'billw', 'preg']],
  ['GST and TDS', ['gstr1', 'gstr3b', 'tds']], ['Analytics', ['pnlm', 'pnlt', 'bva', 'stcf', 'snap']], ['Registers', ['far']],
];
const nameOf = (k: string) => REPORTS.find((r) => r[0] === k)?.[1] ?? k;
type Level = 'ledger' | 'group' | 'fsli';
const FSLI_NAME: Record<string, string> = { equity: 'Capital and Reserves & Surplus', ncl: 'Non-Current Liabilities', cl: 'Current Liabilities', nca: 'Non-Current Assets', ca: 'Current Assets', di: 'Direct Incomes', ii: 'Indirect Incomes', de: 'Direct Expenses', ie: 'Indirect Expenses' };
interface Item { id?: number; code: string; name: string; group?: string; subGroup?: string | null; fsli?: string; amount: number }
/** Items of a P&L or Balance Sheet section added up to the chosen level (ledger, group, or statement line). */
export function rollUp(items: Item[], level: Level): { key: string; label: string; amount: number; code?: string }[] {
  if (level === 'ledger') return items.map((i) => ({ key: i.code, label: `${i.code} ${i.name}`, amount: i.amount, code: i.code }));
  const m = new Map<string, number>();
  for (const i of items) { const k = level === 'group' ? i.group ?? 'Other' : FSLI_NAME[i.fsli ?? ''] ?? 'Other'; m.set(k, (m.get(k) ?? 0) + i.amount); }
  return [...m.entries()].map(([k, v]) => ({ key: k, label: k, amount: v }));
}

export function Reports({ org, accounts, initial, go }: { org: Org; accounts: { id: number; code: string; name: string }[]; initial?: string; go?: (p: string) => void }) {
  // "reports/ar-run" (from a dashboard figure) opens the report already run; a menu link waits for Run.
  const known = (k?: string) => { const x = k === 'alll' || k?.startsWith('ledger-') || k?.startsWith('ledgers-') ? 'ledger' : k?.replace(/-run$/, ''); return x && REPORTS.some(([r]) => r === x) ? x : undefined; };
  const saved = (() => { try { return JSON.parse(sessionStorage.getItem(`report-state-${org.id}`) ?? 'null'); } catch { return null; } })();
  const [rep, setRep] = useState<string>(known(initial) ?? 'pnl');
  useEffect(() => {
    const k = known(initial);
    if (!k) return;
    setRep(k); setData(null);
    const one = /^ledger-(?!run$)(.+)$/.exec(initial ?? '');        // "reports/ledger-5000": that account's ledger, already run
    // "reports/ledgers-1000~1099~2026-04-01~2026-04-30": a range of ledgers for given dates (a cash flow month opened)
    const range = /^ledgers-([^~]*)~([^~]*)~(\d{4}-\d{2}-\d{2})~(\d{4}-\d{2}-\d{2})$/.exec(initial ?? '');
    if (one) { setFromCode(one[1]); setToCode(one[1]); load('ledger', { fromCode: one[1], toCode: one[1] }); }
    else if (range) { setFromCode(range[1]); setToCode(range[2]); setFrom(range[3]); setTo(range[4]); load('ledger', { fromCode: range[1], toCode: range[2] }, { from: range[3], to: range[4] }); }
    else if (initial?.endsWith('-run')) load(k);
  }, [initial]); // eslint-disable-line react-hooks/exhaustive-deps
  const [days, setDays] = useState('30');
  const [, setFavTick] = useState(0);
  const isFav = favouriteReports().some((f) => f.key === rep);
  const [from, setFrom] = useState<string>(saved?.from ?? fyStart()), [to, setTo] = useState<string>(saved?.to ?? today());
  const [fromCode, setFromCode] = useState<string>(saved?.fromCode ?? ''), [toCode, setToCode] = useState<string>(saved?.toCode ?? '');
  const [level, setLevel] = useState<Level>(saved?.level ?? 'ledger');
  useEffect(() => { try { sessionStorage.setItem(`report-state-${org.id}`, JSON.stringify({ from, to, fromCode, toCode, level })); } catch { /* storage may be off */ } }, [org.id, from, to, fromCode, toCode, level]);
  const [categories, setCategories] = useState<{ id: number; name: string }[]>([]), [budgets, setBudgets] = useState<{ id: number; name: string }[]>([]);
  const [categoryId, setCategoryId] = useState(''), [budgetId, setBudgetId] = useState('');
  useEffect(() => {
    api<{ id: number; name: string }[]>(`/orgs/${org.id}/tracking`).then((c) => { setCategories(c); if (c[0]) setCategoryId(String(c[0].id)); });
    api<{ id: number; name: string }[]>(`/orgs/${org.id}/budgets`).then((b) => { setBudgets(b); if (b[0]) setBudgetId(String(b[0].id)); });
  }, [org.id]);
  const [data, setData] = useState<{ rep: string; d: any } | null>(null); // tagged so a stale report never renders in another layout
  const { error, busy, run } = useAction();
  const latest = useRef(0); // only the newest request may set the result; slower, older responses are dropped
  const codeOf = (t: string) => { const v = t.trim(); const a = accounts.find((x) => `${x.code} · ${x.name}`.toLowerCase() === v.toLowerCase()) ?? accounts.find((x) => x.code === v); return a ? a.code : v.split(' ')[0]; };

  const query = (r = rep, codes?: { fromCode: string; toCode: string }, dates?: { from: string; to: string }) => {
    const p = new URLSearchParams();
    if (RANGED.includes(r)) { p.set('from', dates?.from ?? from); p.set('to', dates?.to ?? to); } else p.set('asOf', dates?.to ?? to);
    if (r === 'ledger') { const fc = codes ? codes.fromCode : codeOf(fromCode), tc = codes ? codes.toCode : codeOf(toCode); if (fc) p.set('fromCode', fc); if (tc) p.set('toCode', tc); }
    if (r === 'pnlt') p.set('categoryId', categoryId);
    if (r === 'bva') p.set('budgetId', budgetId);
    if (r === 'stcf') p.set('days', days);
    return p;
  };
  const load = (r = rep, codes?: { fromCode: string; toCode: string }, dates?: { from: string; to: string }) => run(async () => {
    const mine = ++latest.current;
    setData(null);
    let q = query(r, codes, dates);
    // Opened straight from a link: the budget or cost centre group may not have loaded yet.
    if (r === 'bva' && !budgetId) { const b = await api<{ id: number }[]>(`/orgs/${org.id}/budgets`); if (b[0]) { setBudgetId(String(b[0].id)); q.set('budgetId', String(b[0].id)); } }
    if (r === 'pnlt' && !categoryId) { const t = await api<{ id: number }[]>(`/orgs/${org.id}/tracking`); if (t[0]) { setCategoryId(String(t[0].id)); q.set('categoryId', String(t[0].id)); } }
    if ((r === 'pnlt' && !q.get('categoryId')) || (r === 'bva' && !q.get('budgetId'))) throw new Error(r === 'pnlt' ? 'Add a cost centre group under Accounting first.' : 'Create a budget under Accounting first.');
    const url = { tb: `/trial-balance?asOf=${to}`, pnl: `/reports/pnl?${q}`, bs: `/reports/balance-sheet?${q}`, ledger: `/report-table/all-ledgers?${q}`,
      cf: `/reports/cash-flow?${q}`, ar: `/reports/aged-receivables?${q}`, ap: `/reports/aged-payables?${q}`, gstr1: `/reports/gstr1?${q}`, gstr3b: `/reports/gstr3b?${q}`,
      pnlm: `/reports/pnl-by-month?${q}`, pnlt: `/reports/pnl-by-tracking?${q}`, bva: `/reports/budget-vs-actual?${q}`,
      stcf: `/reports/short-term-cash-flow?${q}`, snap: `/reports/business-snapshot?${q}`, tds: `/reports/tds?${q}`,
      invw: `/report-table/invoice-wise?${q}`, billw: `/report-table/bill-wise?${q}`, preg: `/report-table/purchase-register?${q}`, far: `/report-table/fixed-assets?${q}` }[r]!;
    const d = await api(`/orgs/${org.id}${url}`);
    if (mine === latest.current) setData({ rep: r, d });
  });
  const choose = (k: string) => { setRep(k); setData(null); };
  /** Click an account anywhere in a report: its ledger for the same dates. A screen of its own, so Back returns to the report. */
  const openLedger = (code: string) => { if (go) { go(`reports/ledger-${code}`); return; } setRep('ledger'); setFromCode(code); setToCode(code); load('ledger', { fromCode: code, toCode: code }); };
  /** Run: shown as its own screen ("reports/pnl-run"), so Back from a drill-down comes back to it. */
  const runNow = () => { if (go && initial !== `${rep}-run`) go(`reports/${rep}-run`); else load(); };
  /** Click a ledger line: the invoice, bill or journal behind it. */
  const openSource = (l: any) => {
    if (!go || !l) return;
    if (l.kind === 'document') go(`${l.docType === 'invoice' || l.docType === 'credit_note' ? 'invoices' : 'bills'}/open-${l.id}`);
    else if (l.kind === 'journal') go(`journal/open-${l.id}`);
    else if (l.kind === 'account') openLedger(l.code);
  };

  /** Every report exports in every format: from the server's table where there is one, otherwise from what is on screen. */
  const exportAs = (f: ExportFormat) => run(async () => {
    const serverName = EXPORT[rep] === 'ledger' ? 'all-ledgers' : EXPORT[rep];
    if (serverName && !((rep === 'pnl' || rep === 'bs') && level !== 'ledger')) {
      await download(`/orgs/${org.id}/export/${serverName}?format=${f}&${query()}`, `${serverName}.${f}`); return;
    }
    if (!data || data.rep !== rep) throw new Error('Click Run first, then export what is shown.');
    await exportTable(org.id, screenTable(rep, data.d, { from, to, level }), f);
  });
  const [combine, setCombine] = useState(false);
  const manyChoices = REPORTS.filter(([k]) => EXPORT[k] && k !== 'alll').map(([k, label]) => ({ key: k, label }));
  const exportMany = (format: 'pdf' | 'xlsx', chosen: string[]) => run(() => {
    const p = new URLSearchParams({ from, to, asOf: to });
    return download(`/orgs/${org.id}/export-multi?format=${format}&reports=${chosen.map((k) => (k === 'ledger' ? 'all-ledgers' : EXPORT[k])).join(',')}&${p}`, `reports.${format}`);
  });
  const inputCls = 'rounded-md border border-slate-300 px-2 py-1.5';

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <label className="block"><span className="mb-1 block font-medium text-slate-600">Report</span>
            <PickList ariaLabel="Report" className="min-w-60" value={rep} onChange={choose}
              options={MENU.flatMap(([g, keys]) => keys.map((k) => ({ value: k, label: nameOf(k), group: g })))} /></label>
          {RANGED.includes(rep) && <label className="block"><span className="mb-1 block font-medium text-slate-600">From</span><input aria-label="From" type="date" className={inputCls} value={from} onChange={(e) => setFrom(e.target.value)} /></label>}
          {rep === 'stcf' ? <label className="block"><span className="mb-1 block font-medium text-slate-600">Next</span><select aria-label="Days ahead" className={inputCls} value={days} onChange={(e) => setDays(e.target.value)}>{['30', '60', '90'].map((d) => <option key={d} value={d}>{d} days</option>)}</select></label>
            : <label className="block"><span className="mb-1 block font-medium text-slate-600">{RANGED.includes(rep) ? 'To' : 'As at'}</span><input aria-label="To" type="date" className={inputCls} value={to} onChange={(e) => setTo(e.target.value)} /></label>}
          {rep === 'ledger' && <>
            <label className="block"><span className="mb-1 block font-medium text-slate-600">From account</span>
              <Combo ariaLabel="From account" placeholder="First account" className="w-56" value={fromCode} onText={setFromCode} searchFirst={accounts.length > 12}
                options={accounts.map((a) => ({ text: `${a.code} · ${a.name}`, lead: a.code, label: a.name }))} /></label>
            <label className="block"><span className="mb-1 block font-medium text-slate-600">To account</span>
              <Combo ariaLabel="To account" placeholder="Last account" className="w-56" value={toCode} onText={setToCode} searchFirst={accounts.length > 12}
                options={accounts.map((a) => ({ text: `${a.code} · ${a.name}`, lead: a.code, label: a.name }))} /></label></>}
          {rep === 'pnlt' && (categories.length ? <label className="block"><span className="mb-1 block font-medium text-slate-600">Cost centre group</span><select aria-label="Cost centre group" className={inputCls} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
            : <span className="pb-2 text-slate-500">Add a cost centre group under Accounting first.</span>)}
          {rep === 'bva' && (budgets.length ? <label className="block"><span className="mb-1 block font-medium text-slate-600">Budget</span><select aria-label="Budget" className={inputCls} value={budgetId} onChange={(e) => setBudgetId(e.target.value)}>{budgets.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
            : <span className="pb-2 text-slate-500">Create a budget under Accounting first.</span>)}
          {(rep === 'pnl' || rep === 'bs') && <label className="block"><span className="mb-1 block font-medium text-slate-600">Show</span>
            <select aria-label="Show by" className={inputCls} value={level} onChange={(e) => setLevel(e.target.value as Level)}><option value="ledger">Each ledger</option><option value="group">Groups</option><option value="fsli">Statement lines</option></select></label>}
          <Button disabled={busy} onClick={runNow}>Run</Button>
          <ReportExport onExport={exportAs} disabled={busy} />
          <Button variant="ghost" aria-expanded={combine} onClick={() => setCombine(!combine)}>Several reports in one file…</Button>
          <Button variant="ghost" aria-pressed={isFav} onClick={() => { toggleFavourite(rep); setFavTick((n) => n + 1); }}>{isFav ? '★ Favourite' : '☆ Add to favourites'}</Button>
        </div>
        {rep === 'ledger' && <p className="mt-2 text-xs text-slate-500">Leave both accounts empty for every ledger; choose the same account twice for one ledger. Click a line to open the invoice, bill or journal behind it.</p>}
        <div className="mt-3"><ErrorMsg msg={error} /></div>
      </Card>
      {combine && <CombinePanel title="Export several reports in one file" choices={manyChoices} chosen={EXPORT[rep] ? [rep] : []} busy={false} onExport={exportMany} onClose={() => setCombine(false)} />}
      {data && data.rep === rep
        ? <Card title={nameOf(rep)}><ReportView rep={rep} d={data.d} org={org} reload={() => load()} level={level} openLedger={openLedger} openSource={openSource} go={go}
          openRange={go ? (month: string) => { const [y, mo] = month.split('-').map(Number); const end = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10); go(`reports/ledgers-1000~1099~${month}-01~${end}`); } : undefined} /></Card>
        : !busy && <Callout tone="info">Choose the dates{rep === 'ledger' ? ' and accounts' : ''}, then click <b>Run</b> to see {nameOf(rep)}.</Callout>}
    </>
  );
}

/** "Export ▾" for a report: Excel, PDF, CSV or XML. */
function ReportExport({ onExport, disabled }: { onExport: (f: ExportFormat) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const shut = useCallback(() => setOpen(false), []);
  const ref = useOutside(open, shut);
  // Fixed to the screen under the button, so the card around it never cuts the menu off.
  const { btn, pos } = useAnchor(open, shut, 176);
  return (
    <div ref={ref} className="relative">
      <button ref={btn} type="button" aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen(!open)}
        className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"><span className="inline-flex items-center gap-1.5"><Icon name="download" />Export ▾</span></button>
      {open && <div role="menu" data-popover style={pos} className="z-50 overflow-y-auto rounded-lg border border-brand-100 bg-white py-1 shadow-xl">
        {FORMATS.map(([f, label]) => <button key={f} type="button" role="menuitem" className="block w-full px-3 py-2 text-left text-sm hover:bg-slate-50" onClick={() => { setOpen(false); onExport(f); }}>{label} (.{f})</button>)}</div>}
    </div>
  );
}

/** The report on screen as a table, for the reports the server does not export itself (and for grouped views). */
function screenTable(rep: string, d: any, o: { from: string; to: string; level: Level }): ExportTable {
  const t = (title: string, columns: ExportTable['columns'], rows: ExportTable['rows'], boldRows?: number[]) => ({ title, subtitle: `${o.from} to ${o.to}`, columns, rows, boldRows });
  const M = (h: string) => ({ header: h, money: true }), T = (h: string) => ({ header: h });
  if (rep === 'pnl' || rep === 'bs') {
    const rows: ExportTable['rows'] = [], bold: number[] = [];
    const secs: [string, any][] = rep === 'pnl' ? [['Income', d.income], ['Expenses', d.expenses]] : [['Assets', d.assets], ['Liabilities', d.liabilities], ['Equity', d.equity]];
    for (const [name, s] of secs) {
      bold.push(rows.length); rows.push([name.toUpperCase(), null]);
      for (const r of rollUp(s.items, o.level)) rows.push([r.label, r.amount]);
      if (name === 'Equity') rows.push(['Profit to date', d.equity.profitToDate]);
      bold.push(rows.length); rows.push([`Total ${name.toLowerCase()}`, s.total]);
    }
    if (rep === 'pnl') { bold.push(rows.length); rows.push(['NET PROFIT / (LOSS)', d.netProfit]); }
    return { ...t(rep === 'pnl' ? 'Profit and Loss' : 'Balance Sheet', [T(o.level === 'ledger' ? 'Account' : o.level === 'group' ? 'Group' : 'Statement line'), M('Amount')], rows, bold), subtitle: rep === 'bs' ? `As at ${o.to}` : `${o.from} to ${o.to}` };
  }
  if (rep === 'cf') return t('Cash flow', [T('Month'), M('Opening'), M('Cash in'), M('Cash out'), M('Closing')],
    [...d.months.map((m: any) => [m.month, m.opening, m.cashIn, m.cashOut, m.closing]), ['Total', null, d.totalIn, d.totalOut, d.closingBalance]], [d.months.length]);
  if (rep === 'pnlm' || rep === 'pnlt') {
    const rows: ExportTable['rows'] = [], bold: number[] = [];
    for (const [name, s] of [['Income', d.income], ['Expenses', d.expenses]] as [string, any][]) {
      bold.push(rows.length); rows.push([name.toUpperCase(), ...d.columns.map(() => null), null]);
      for (const i of s.items) rows.push([`${i.code} ${i.name}`, ...i.amounts, i.total]);
      bold.push(rows.length); rows.push([`Total ${name.toLowerCase()}`, ...s.totals, s.total]);
    }
    bold.push(rows.length); rows.push(['Net profit', ...d.netProfit, d.netProfitTotal]);
    return t(rep === 'pnlm' ? 'Profit and Loss by month' : 'Profit and Loss by cost centre', [T('Account'), ...d.columns.map((c: string) => M(c)), M('Total')], rows, bold);
  }
  if (rep === 'bva') return t('Budget vs actual', [T('Account'), M('Budget'), M('Actual'), M('Variance')],
    [...d.lines.map((l: any) => [`${l.code} ${l.name}`, l.budget, l.actual, l.variance]), ['Profit', d.totals.profitBudget, d.totals.profitActual, d.totals.profitActual - d.totals.profitBudget]], [d.lines.length]);
  if (rep === 'stcf') return t(`Short-term cash flow (${d.days} days)`, [T('Week'), M('Money in'), M('Money out'), M('Net'), M('Balance')],
    d.weeks.map((w: any) => [`${w.start} to ${w.end}`, w.cashIn, w.cashOut, w.net, w.closing]));
  if (rep === 'snap') return t('Business snapshot', [T('Measure'), T('Value'), T('Status')], d.scorecard.map((s: any) => [s.metric, s.value == null ? '' : `${s.value} ${s.unit}`, s.status]));
  if (rep === 'tds') return t('TDS deducted', [T('Date'), T('Quarter'), T('Bill'), T('Party'), T('PAN'), T('Section'), M('Amount'), M('TDS')],
    [...d.rows.map((x: any) => [x.date, x.quarter, x.number, x.party, x.pan ?? 'missing', x.section, x.amount, x.tds]), ['Total', '', '', '', '', '', null, d.totalTds]], [d.rows.length]);
  if (rep === 'gstr1') return t('GSTR-1', [T('Section'), T('Number'), T('Date'), T('GSTIN / party'), T('Place of supply'), M('Taxable'), M('IGST'), M('CGST'), M('SGST'), M('Cess')],
    (['b2b', 'b2cl', 'exp', 'cdnr', 'cdnur'] as const).flatMap((s) => d[s].map((x: any) => [s.toUpperCase(), x.number, x.date, x.gstin ?? x.party, x.placeOfSupply, x.taxable, x.igst, x.cgst, x.sgst, x.cess ?? 0])));
  if (rep === 'tb') return t('Trial balance', [T('Code'), T('Account'), M('Debit'), M('Credit')], [...d.accounts.map((a: any) => [a.code, a.name, a.debit, a.credit]), ['', 'Total', d.totalDebit, d.totalCredit]], [d.accounts.length]);
  if (rep === 'ar' || rep === 'ap') return t(rep === 'ar' ? 'Aged receivables' : 'Aged payables', [T('Contact'), M('Not due'), M('1-30'), M('31-60'), M('61-90'), M('90+'), M('Total')],
    [...d.contacts, { contact: 'Total', ...d.totals }].map((c: any) => [c.contact, c.notDue, c.days1to30, c.days31to60, c.days61to90, c.over90, c.total]));
  if (d.columns && d.rows) return { title: d.title, subtitle: d.subtitle, columns: d.columns.map((c: any) => ({ header: c.header, money: c.type === 'money' })), rows: d.rows, boldRows: d.boldRows };
  throw new Error('This report cannot be exported yet');
}

/** A report line; with a code, the label and amount open that account's ledger. */
const Row = ({ label, v, bold, code, open }: { label: string; v: number; bold?: boolean; code?: string; open?: (code: string) => void }) => (
  <tr className={`border-t border-slate-100 ${bold ? 'total-row' : ''}`}>
    <td className="py-1">{code && open ? <button type="button" className="text-left hover:text-brand-700 hover:underline" title="Open the ledger" onClick={() => open(code)}>{label}</button> : label}</td>
    <td className="text-right tabular-nums">{code && open ? <button type="button" className="link" aria-label={`Ledger of ${label}`} onClick={() => open(code)}>{fmt(v)}</button> : fmt(v)}</td></tr>
);
const Link = ({ code, open, children, amount }: { code: string; open: (c: string) => void; children: React.ReactNode; amount?: boolean }) =>
  <button type="button" className={amount ? 'link tabular-nums' : 'text-left hover:text-brand-700 hover:underline'} onClick={() => open(code)}>{children}</button>;

function ReportView({ rep, d, org, reload, level = 'ledger', openLedger, openSource, openRange, go }: { rep: string; d: any; org: Org; reload: () => void; level?: Level; openLedger: (code: string) => void; openSource: (l: any) => void;
  openRange?: (month: string) => void; go?: (p: string) => void }) {
  if (rep === 'ledger') return <LedgerView d={d} onLink={openSource} />;
  if (TABLE[rep]) return <TableReport d={d} org={org} reload={reload} selectable={['invw', 'billw', 'preg'].includes(rep)} />;
  if (rep === 'tb') return (
    <table className="w-full text-sm"><thead><tr className="text-left text-slate-500"><th>Account</th><th className="text-right">Debit</th><th className="text-right">Credit</th></tr></thead>
      <tbody>{d.accounts.map((a: any) => <tr key={a.code} className="border-t border-slate-100"><td><Link code={a.code} open={openLedger}>{a.code} {a.name}</Link></td>
        <td className="text-right">{a.debit ? <Link amount code={a.code} open={openLedger}>{fmt(a.debit)}</Link> : ''}</td><td className="text-right">{a.credit ? <Link amount code={a.code} open={openLedger}>{fmt(a.credit)}</Link> : ''}</td></tr>)}
        <tr className="total-row"><td>Total {d.balanced ? '✓' : '✗'}</td><td className="text-right" data-testid="tb-debit">{fmt(d.totalDebit)}</td><td className="text-right" data-testid="tb-credit">{fmt(d.totalCredit)}</td></tr></tbody></table>);
  if (rep === 'pnl') return (
    <table className="w-full text-sm"><tbody>
      <tr><td className="pt-2 font-semibold text-slate-500">Income</td></tr>{rollUp(d.income.items, level).map((i) => <Row key={i.key} label={i.label} v={i.amount} code={i.code} open={openLedger} />)}<Row label="Total income" v={d.income.total} bold />
      <tr><td className="pt-4 font-semibold text-slate-500">Expenses</td></tr>{rollUp(d.expenses.items, level).map((i) => <Row key={i.key} label={i.label} v={i.amount} code={i.code} open={openLedger} />)}<Row label="Total expenses" v={d.expenses.total} bold />
      <tr className="border-t-2 text-base font-bold"><td className="py-2">Net profit / (loss)</td><td className="text-right" data-testid="net-profit">{fmt(d.netProfit)}</td></tr></tbody></table>);
  if (rep === 'bs') return (
    <table className="w-full text-sm"><tbody>
      {(['assets', 'liabilities', 'equity'] as const).map((s) => (<Fragment key={s}>
        <tr><td className="pt-3 font-semibold capitalize text-slate-500">{s}</td></tr>
        {rollUp(d[s].items, level).map((i) => <Row key={s + i.key} label={i.label} v={i.amount} code={i.code} open={openLedger} />)}
        {s === 'equity' && <Row label="Profit to date" v={d.equity.profitToDate} />}
        <Row label={`Total ${s}`} v={d[s].total} bold /></Fragment>))}
      <tr><td className="pt-3 text-sm">{d.balanced ? '✓ Assets = Liabilities + Equity' : '✗ Out of balance'}</td></tr></tbody></table>);
  if (rep === 'cf') return (
    <table className="w-full text-sm" data-testid="cashflow"><thead><tr className="text-left text-slate-500"><th>Month</th><th className="text-right">Opening</th><th className="text-right">Cash in</th><th className="text-right">Cash out</th><th className="text-right">Closing</th></tr></thead>
      <tbody><tr><td colSpan={4}>Opening balance</td><td className="text-right">{fmt(d.openingBalance)}</td></tr>
        {d.months.map((m: any) => { const open = () => openRange?.(m.month); return <tr key={m.month} className="border-t border-slate-100"><td>{openRange ? <button type="button" className="link" onClick={open}>{m.month}</button> : m.month}</td><td className="text-right">{fmt(m.opening)}</td>
          <td className="text-right">{openRange && m.cashIn ? <button type="button" className="link" title="The cash and bank entries of this month" onClick={open}>{fmt(m.cashIn)}</button> : fmt(m.cashIn)}</td>
          <td className="text-right">{openRange && m.cashOut ? <button type="button" className="link" title="The cash and bank entries of this month" onClick={open}>{fmt(m.cashOut)}</button> : fmt(m.cashOut)}</td><td className="text-right">{fmt(m.closing)}</td></tr>; })}
        <tr className="total-row"><td>Total</td><td /><td className="text-right">{fmt(d.totalIn)}</td><td className="text-right">{fmt(d.totalOut)}</td><td className="text-right" data-testid="cf-closing">{fmt(d.closingBalance)}</td></tr></tbody></table>);
  if (rep === 'ledger') return (
    <table className="w-full text-sm"><thead><tr className="text-left text-slate-500"><th>Date</th><th>Narration</th><th className="text-right">Debit</th><th className="text-right">Credit</th><th className="text-right">Balance</th></tr></thead>
      <tbody><tr><td /><td>Opening balance</td><td /><td /><td className="text-right">{fmt(d.openingBalance)}</td></tr>
        {d.lines.map((l: any, i: number) => <tr key={i} className="border-t border-slate-100"><td>{l.date}</td><td>{l.narration}</td><td className="text-right">{l.debit ? fmt(l.debit) : ''}</td><td className="text-right">{l.credit ? fmt(l.credit) : ''}</td><td className="text-right">{fmt(l.balance)}</td></tr>)}</tbody></table>);
  if (rep === 'ar' || rep === 'ap') return <AgedReport d={d} sales={rep === 'ar'} go={go} />;
  if (rep === 'gstr1') return (
    <div className="space-y-4 text-sm">
      <Gstr1Json org={org} />
      {(['b2b', 'b2cl', 'exp', 'cdnr', 'cdnur'] as const).map((s) => (
        <div key={s}><h3 className="font-semibold uppercase">{s} ({d[s].length})</h3>
          {d[s].length > 0 && <table className="w-full"><tbody>{d[s].map((x: any) => <tr key={x.number} className="border-t border-slate-100"><td>{go && x.id ? <button type="button" className="link" onClick={() => go(`invoices/open-${x.id}`)}>{x.number}</button> : x.number}</td><td>{x.date}</td><td>{x.gstin ?? x.party}</td><td>POS {x.placeOfSupply}</td><td className="text-right">{fmt(x.taxable)}</td><td className="text-right">IGST {fmt(x.igst)} · CGST {fmt(x.cgst)} · SGST {fmt(x.sgst)}{x.cess ? ` · Cess ${fmt(x.cess)}` : ''}</td></tr>)}</tbody></table>}</div>))}
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
  if (rep === 'gstr3b') return <Gstr3bView d={d} />;
  return null;
}

/** GSTR-1 for one month as a JSON file for the GST portal's offline tool. */
function Gstr1Json({ org }: { org: Org }) {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const { error, busy, run } = useAction();
  return (
    <div className="rounded-lg border border-brand-200 bg-brand-50/40 p-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="block text-sm"><span className="mb-1 block font-medium text-slate-600">Return month</span>
          <input type="month" aria-label="GSTR-1 month" value={month} onChange={(e) => setMonth(e.target.value)} className="rounded-md border border-slate-300 px-3 py-2" /></label>
        <Button disabled={busy || !month} onClick={() => run(() => download(`/orgs/${org.id}/reports/gstr1-json?month=${month}`, `GSTR1-${month}.json`))}>Download JSON for the GST portal</Button>
      </div>
      <p className="mt-2 text-xs text-slate-600">B2B, B2CL, B2CS, credit notes, exports and the HSN summary in the layout the GST offline tool reads. Check it there before you upload; amendments are not included.</p>
      <div className="mt-2"><ErrorMsg msg={error} /></div>
    </div>
  );
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
function TableReport({ d, org, reload, selectable, onLink }: { d: any; org: Org; reload: () => void; selectable: boolean; onLink?: (l: any) => void }) {
  const links: (any | null)[] = d.links ?? [];
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [ok, setOk] = useState('');
  const { error, busy, run } = useAction();
  const ids: (number | null)[] = d.rowIds ?? [];
  const bold = new Set<number>(d.boldRows ?? []);
  const toggle = (id: number) => setPicked((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const act = (what: 'archive' | 'delete') => run(async () => {
    const list = [...picked]; if (!list.length) return;
    if (what === 'delete') {
      if (!await ask(`Delete ${list.length} document(s)? Each is cancelled with a reversing entry. Ones with payments or credit/debit notes are skipped.`)) return;
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
      <div className="mb-2 space-y-2"><ErrorMsg msg={error} /><Ok msg={ok} /></div>
      <div className="overflow-x-auto">
        <table className="w-full" data-testid="table-report"><thead><tr className="text-left text-slate-500">{selectable && <th className="w-8" />}{d.columns.map((c: any, i: number) => <th key={i} className={c.type === 'money' ? 'text-right' : ''}>{c.header}</th>)}</tr></thead>
          <tbody>{d.rows.map((r: (string | number)[], ri: number) => (
            <tr key={ri} className={`border-t border-slate-100 ${bold.has(ri) ? 'font-semibold' : ''}`}>
              {selectable && <td>{ids[ri] != null && <input type="checkbox" aria-label={`Select ${r[0]}`} checked={picked.has(ids[ri] as number)} onChange={() => toggle(ids[ri] as number)} />}</td>}
              {r.map((v, ci) => {
                const text = d.columns[ci].type === 'money' ? (typeof v === 'number' ? fmt(v) : '') : String(v);
                const link = onLink && links[ri] && text && (links[ri].kind === 'account' ? ci === 1 : ci === 1 || d.columns[ci].type === 'money');
                return <td key={ci} className={d.columns[ci].type === 'money' ? 'text-right' : ''}>{link
                  ? <button type="button" className="text-left text-brand-700 hover:underline" title={links[ri].kind === 'account' ? 'Only this ledger' : links[ri].kind === 'journal' ? 'Open the journal entry' : 'Open the document'} onClick={() => onLink!(links[ri])}>{text}</button> : text}</td>;
              })}
            </tr>))}</tbody></table>
        {d.rows.length === 0 && <p className="py-6 text-center text-slate-500">Nothing to show for these dates.</p>}
      </div>
    </div>
  );
}

/** Aged receivables or payables: each amount opens the invoices or bills behind it; a name opens the contact and its statement. */
function AgedReport({ d, sales, go }: { d: any; sales: boolean; go?: (p: string) => void }) {
  const [pick, setPick] = useState<{ contact: string; contactId?: number; bucket: string; label: string } | null>(null);
  const B: [string, string, (days: number) => boolean][] = [['notDue', 'Not due', (x) => x <= 0], ['days1to30', '1-30', (x) => x >= 1 && x <= 30], ['days31to60', '31-60', (x) => x > 30 && x <= 60],
    ['days61to90', '61-90', (x) => x > 60 && x <= 90], ['over90', '90+', (x) => x > 90], ['total', 'Total', () => true]];
  const rows = [...d.contacts, { contact: 'Total', ...d.totals }];
  const docs = pick ? d.contacts.filter((c: any) => pick.contact === 'Total' || c.contact === pick.contact)
    .flatMap((c: any) => c.documents.map((x: any) => ({ ...x, contact: c.contact, contactId: c.contactId }))).filter((x: any) => B.find((b) => b[0] === pick.bucket)![2](x.daysOverdue)) : [];
  const page = sales ? 'invoices' : 'bills', contactPage = sales ? 'customers' : 'suppliers';
  return (
    <div className="space-y-4">
      <table className="w-full text-sm"><thead><tr className="text-left"><th>Contact</th>{B.map((b) => <th key={b[0]} className="text-right">{b[1]}</th>)}</tr></thead>
        <tbody>{rows.map((c: any) => <tr key={c.contact} className={c.contact === 'Total' ? 'total-row' : 'border-t border-slate-100'}>
          <td>{c.contact !== 'Total' && go && c.contactId ? <button type="button" className="link" title="Open the contact and its statement" onClick={() => go(`${contactPage}/${c.contactId}`)}>{c.contact}</button> : c.contact}</td>
          {B.map(([k, label]) => <td key={k} className="text-right tabular-nums">{c[k] ? <button type="button" className="link" aria-label={`${c.contact} ${label}: ${fmt(c[k])}`} onClick={() => setPick({ contact: c.contact, contactId: c.contactId, bucket: k, label })}>{fmt(c[k])}</button> : fmt(c[k])}</td>)}</tr>)}</tbody></table>
      {pick && (
        <div role="region" aria-label="Documents behind the amount" className="rounded-lg border border-brand-100 bg-brand-50/30 p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="font-semibold text-brand-900">{pick.contact === 'Total' ? 'All contacts' : pick.contact} · {pick.label}: {docs.length} {sales ? 'invoice' : 'bill'}{docs.length === 1 ? '' : 's'}</p>
            <span className="flex gap-2">{go && pick.contactId && <Button variant="ghost" onClick={() => go(`${contactPage}/${pick.contactId}`)}>Statement of {pick.contact}</Button>}<Button variant="ghost" onClick={() => setPick(null)}>Close</Button></span>
          </div>
          <table className="w-full text-sm"><thead><tr className="text-left"><th>Number</th><th>Contact</th><th>Due date</th><th className="text-right">Days overdue</th><th className="text-right">Outstanding</th></tr></thead>
            <tbody>{docs.map((x: any) => <tr key={x.id}><td>{go ? <button type="button" className="link" onClick={() => go(`${page}/open-${x.id}`)}>{x.number}</button> : x.number}</td><td>{x.contact}</td><td>{x.dueDate}</td>
              <td className="text-right">{x.daysOverdue || '—'}</td><td className="text-right tabular-nums">{fmt(x.outstanding)}</td></tr>)}</tbody>
            <tfoot><tr><td colSpan={4}>Total</td><td className="text-right tabular-nums">{fmt(docs.reduce((s: number, x: any) => s + x.outstanding, 0))}</td></tr></tfoot></table>
        </div>)}
    </div>
  );
}

/**
 * The ledger, account by account: a heading per account that folds away, then date, counter-ledger, narration, reference,
 * debit, credit and running balance, and the period total with the closing balance. Columns can be hidden; search finds lines.
 */
function LedgerView({ d, onLink }: { d: any; onLink?: (l: any) => void }) {
  const links: (any | null)[] = d.links ?? [];
  const cols: { header: string; type: string }[] = d.columns;
  const [hidden, setHidden] = useState<Set<number>>(() => { try { return new Set(JSON.parse(localStorage.getItem('ledger-hidden') ?? '[]')); } catch { return new Set(); } });
  const [closed, setClosed] = useState<Set<number>>(new Set());
  const [q, setQ] = useState('');
  const toggleCol = (i: number) => setHidden((h) => { const n = new Set(h); if (n.has(i)) n.delete(i); else n.add(i); try { localStorage.setItem('ledger-hidden', JSON.stringify([...n])); } catch { /* storage may be off */ } return n; });
  // Split the server's rows into one section per account.
  const sections: { head: number; rows: number[] }[] = [];
  d.rows.forEach((_: unknown, i: number) => { if (links[i]?.kind === 'account') sections.push({ head: i, rows: [] }); else if (sections.length) sections[sections.length - 1].rows.push(i); });
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const match = (i: number) => !words.length || words.every((w) => d.rows[i].join(' ').toLowerCase().includes(w));
  const show = cols.map((_, i) => i).filter((i) => i > 0 ? !hidden.has(i) : true);
  const cell = (i: number, ci: number) => {
    const v = d.rows[i][ci], money = cols[ci].type === 'money';
    const text = money ? (typeof v === 'number' && (v !== 0 || ci === cols.length - 1) ? fmt(v) : '—') : String(v ?? '') || '—';
    const link = onLink && links[i] && links[i].kind !== 'account' && text !== '—' && (cols[ci].header === 'Narration' || cols[ci].header === 'Reference' || (money && ci !== cols.length - 1));
    return <td key={ci} className={money ? 'whitespace-nowrap text-right tabular-nums' : ''}>{link
      ? <button type="button" className="link text-left" title={links[i].kind === 'journal' ? 'Open the journal entry' : 'Open the document'} onClick={() => onLink!(links[i])}>{text}</button> : text}</td>;
  };
  return (
    <div className="text-sm" data-testid="table-report">
      <p className="mb-2 text-slate-500">{d.subtitle}</p>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input type="search" aria-label="Search the ledger" placeholder="Search narration, counter-ledger, reference…" value={q} onChange={(e) => setQ(e.target.value)}
          className="w-72 max-w-full rounded-md border border-slate-300 px-3 py-1.5 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200" />
        <details className="relative"><summary className="cursor-pointer rounded-md border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700">Columns</summary>
          <div className="absolute z-30 mt-1 w-56 rounded-lg border border-brand-100 bg-white p-2 shadow-xl">{cols.map((c, i) => i > 0 && <label key={i} className="flex items-center gap-2 px-1 py-1">
            <input type="checkbox" aria-label={`Show ${c.header}`} checked={!hidden.has(i)} onChange={() => toggleCol(i)} />{c.header}</label>)}</div></details>
        {sections.length > 1 && <Button variant="ghost" onClick={() => setClosed(closed.size ? new Set() : new Set(sections.map((s) => s.head)))}>{closed.size ? 'Expand all' : 'Collapse all'}</Button>}
      </div>
      {sections.length === 0 && <p className="py-6 text-center text-slate-500">Nothing to show for these dates.</p>}
      <div className="space-y-3">{sections.map((s) => {
        const rows = s.rows.filter(match); if (words.length && !rows.length) return null;
        const open = !closed.has(s.head);
        return (
          <section key={s.head} className="overflow-hidden rounded-lg border border-brand-100">
            <button type="button" aria-expanded={open} onClick={() => setClosed((c) => { const n = new Set(c); if (n.has(s.head)) n.delete(s.head); else n.add(s.head); return n; })}
              className="flex w-full items-center gap-2 bg-white px-3 py-2 text-left font-semibold text-brand-900 hover:bg-brand-50/50">
              <span aria-hidden className="text-brand-600">{open ? '▾' : '▸'}</span>{String(d.rows[s.head][1])}</button>
            {open && <div className="overflow-x-auto px-2 pb-2"><table className="w-full">
              <thead><tr className="text-left">{show.map((ci) => <th key={ci} className={cols[ci].type === 'money' ? 'text-right' : ''}>{cols[ci].header}</th>)}</tr></thead>
              <tbody>{rows.map((i) => <tr key={i} className={(d.boldRows ?? []).includes(i) ? 'total-row' : ''}>{show.map((ci) => cell(i, ci))}</tr>)}</tbody></table></div>}
          </section>);
      })}</div>
    </div>
  );
}

/**
 * GSTR-3B laid out like the form on the GST portal: table 3.1 (outward and reverse-charge supplies), table 4 (eligible
 * ITC: available, reversed, net, ineligible) and 6.1 (tax payable), each head in its own column.
 */
function Gstr3bView({ d }: { d: any }) {
  const z = { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
  const h = (x: any) => ({ ...z, ...(x ?? {}) });
  const o = h(d.section31a_outwardTaxable), zr = h(d.section31b_zeroRated), nil = h(d.section31c_nilRatedExempt), rcm = h(d.section31d_inwardReverseCharge);
  const net = h(d.section4_itcAvailable), rv = h(d.section4b2_itcReversed), rc = h(d.section4a5_itcReclaimed), inel = h(d.section4d_ineligibleItc), pay = h(d.netTaxPayable);
  const heads = ['igst', 'cgst', 'sgst', 'cess'] as const;
  // 4(A)(5) all other ITC = net + reversed - reverse charge - reclaimed, so that A - B = C as on the portal.
  const other = Object.fromEntries(heads.map((k) => [k, net[k] + rv[k] - rcm[k] - rc[k]])) as Record<string, number>;
  const availTotal = Object.fromEntries(heads.map((k) => [k, other[k] + rcm[k] + rc[k]])) as Record<string, number>;
  const money = (v: number | null) => <td className="whitespace-nowrap text-right tabular-nums">{v == null ? '' : fmt(v)}</td>;
  const row = (label: string, x: Record<string, number> | null, taxable: number | null = null, cls = '') => (
    <tr className={cls}><td className="pl-6">{label}</td>{money(taxable)}{heads.map((k) => <Fragment key={k}>{money(x ? x[k] ?? 0 : null)}</Fragment>)}</tr>);
  const section = (no: string, title: string) => <tr><td colSpan={6} className="bg-brand-50 px-3 py-2 text-sm font-semibold text-brand-900"><span className="mr-2 rounded bg-brand-600 px-1.5 py-0.5 text-xs text-white">{no}</span>{title}</td></tr>;
  return (
    <div className="text-sm">
      <table className="w-full" data-testid="gstr3b">
        <thead><tr className="text-left"><th>Nature of supplies / details</th><th className="text-right">Total taxable value</th><th className="text-right">Integrated tax</th><th className="text-right">Central tax</th><th className="text-right">State / UT tax</th><th className="text-right">Cess</th></tr></thead>
        <tbody>
          {section('3.1', 'Details of outward supplies and inward supplies liable to reverse charge')}
          {row('(a) Outward taxable supplies (other than zero rated, nil rated and exempted)', o, o.taxable)}
          {row('(b) Outward taxable supplies (zero rated)', { ...zr, cgst: 0, sgst: 0 }, zr.taxable)}
          {row('(c) Other outward supplies (nil rated, exempted)', null, nil.taxable)}
          {row('(d) Inward supplies (liable to reverse charge)', rcm, rcm.taxable)}
          {row('(e) Non-GST outward supplies', null, 0)}
          {section('4', 'Eligible ITC')}
          <tr><td className="pl-3 font-medium text-slate-700" colSpan={6}>(A) ITC available (whether in full or part)</td></tr>
          {row('(3) Inward supplies liable to reverse charge (other than 1 & 2 above)', rcm)}
          {rc.igst + rc.cgst + rc.sgst > 0 && row('(5) Credit claimed again after payment (Rule 37)', rc)}
          {row('(5) All other ITC', other)}
          {row('Total (A)', availTotal, null, 'total-row')}
          <tr><td className="pl-3 font-medium text-slate-700" colSpan={6}>(B) ITC reversed</td></tr>
          {row('(2) Others (Rule 37: not paid within 180 days)', rv)}
          {row('(C) Net ITC available (A) − (B)', net, null, 'total-row')}
          <tr><td className="pl-3 font-medium text-slate-700" colSpan={6}>(D) Ineligible ITC</td></tr>
          {row('(1) As per section 17(5)', inel)}
          {section('6.1', 'Payment of tax')}
          {row('Tax payable (3.1 a + b + d)', Object.fromEntries(heads.map((k) => [k, o[k] + zr[k] + rcm[k]])) as Record<string, number>)}
          {row('Paid through ITC (net ITC, 4C)', net)}
          <tr className="total-row" data-testid="gstr3b-net"><td className="pl-6">Net payable in cash (negative = credit carried forward)</td><td />{heads.map((k) => <Fragment key={k}>{money(pay[k] ?? 0)}</Fragment>)}</tr>
        </tbody>
      </table>
      <p className="mt-2 text-xs text-amber-700">{d.note}</p>
      <p className="mt-1 text-xs text-slate-500">Working paper in the GSTR-3B layout. Check it with your CA before filing on the GST portal.</p>
    </div>
  );
}
