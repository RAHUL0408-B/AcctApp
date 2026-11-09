// Compliance checks a CA otherwise does by hand in spreadsheets: GSTR-2B matching, MSME payments under 43B(h), and the
// 180-day rule for input tax credit. Everything is worked out from the books; the results are working papers.
import { useCallback, useEffect, useState } from 'react';
import { api, download, fmt, today } from '../api';
import type { Org } from '../App';
import { Empty, PageHeader } from '../kit';
import { Button, Card, ErrorMsg, Field, Ok, useAction } from '../ui';

const TABS = [['2b', 'GSTR-2B match'], ['msme', 'MSME payments (43B(h))'], ['itc180', 'ITC 180-day rule']] as const;
const fyStartOf = (iso: string) => { const y = Number(iso.slice(0, 4)), m = Number(iso.slice(5, 7)); return m >= 4 ? y : y - 1; };
const Tile = ({ label, value, tone = 'slate', note }: { label: string; value: string; tone?: 'slate' | 'green' | 'amber' | 'red'; note?: string }) => {
  const c = { slate: 'border-slate-200', green: 'border-emerald-300 bg-emerald-50', amber: 'border-amber-300 bg-amber-50', red: 'border-red-300 bg-red-50' }[tone];
  return <div className={`rounded-xl border p-4 ${c}`}><p className="text-xs font-medium text-slate-600">{label}</p><p className="mt-1 text-xl font-bold text-slate-900">{value}</p>{note && <p className="mt-1 text-xs text-slate-600">{note}</p>}</div>;
};
const Pill = ({ text, tone }: { text: string; tone: 'green' | 'amber' | 'red' | 'slate' | 'blue' }) => (
  <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${{ green: 'bg-emerald-100 text-emerald-800', amber: 'bg-amber-100 text-amber-800', red: 'bg-red-100 text-red-800', slate: 'bg-slate-100 text-slate-700', blue: 'bg-sky-100 text-sky-800' }[tone]}`}>{text}</span>
);

export function Compliance({ org, canPost, sub, go }: { org: Org; canPost: boolean; sub?: string; go: (p: string) => void }) {
  const tab = TABS.some(([k]) => k === sub) ? sub! : '2b';
  return (
    <>
      <PageHeader title="Compliance checks" subtitle="Monthly and year-end checks worked out from your books: GSTR-2B matching, MSME payments under section 43B(h), and the 180-day rule for input tax credit. Working papers: confirm the results with your CA." />
      <div role="tablist" aria-label="Checks" className="flex flex-wrap gap-2">
        {TABS.map(([k, label]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => go(`compliance/${k}`)}
          className={`rounded-md px-4 py-2 text-sm font-medium ${tab === k ? 'bg-brand-600 text-white' : 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50'}`}>{label}</button>)}
      </div>
      {tab === '2b' && <TwoB org={org} canPost={canPost} />}
      {tab === 'msme' && <Msme org={org} go={go} />}
      {tab === 'itc180' && <Itc180 org={org} />}
    </>
  );
}

// ------------------------------------------------------------------ GSTR-2B
interface Upload { id: number; period: string; fileName: string; lines: number; uploadedAt: string; uploadedBy: string }
interface Row { status: 'matched' | 'mismatch' | 'only_2b' | 'only_books'; gstin: string; supplier: string; invoiceNo: string; date: string | null; billNumber: string | null; books: { taxable: number; tax: number } | null; portal: { taxable: number; tax: number; itcAvailable: boolean } | null; difference: number; note: string }
interface Match { import: { id: number; period: string; fileName: string }; counts: Record<Row['status'], number>; tax: { portal: number; matched: number; atRisk: number }; rows: Row[]; chase: { supplier: string; gstin: string; invoices: string[]; tax: number }[] }
const LABEL: Record<Row['status'], [string, 'green' | 'amber' | 'red' | 'blue']> = { matched: ['Matched', 'green'], mismatch: ['Tax differs', 'amber'], only_2b: ['Only in GSTR-2B', 'blue'], only_books: ['Only in your books', 'red'] };

function TwoB({ org, canPost }: { org: Org; canPost: boolean }) {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [period, setPeriod] = useState(today().slice(0, 7));
  const [match, setMatch] = useState<Match | null>(null);
  const [show, setShow] = useState<Row['status'] | 'all'>('all');
  const [ok, setOk] = useState('');
  const { error, busy, run } = useAction();
  const load = useCallback(() => api<Upload[]>(`/orgs/${org.id}/compliance/gstr2b`).then(setUploads), [org.id]);
  useEffect(() => { load(); }, [load]);
  const open = (id: number) => run(async () => { setMatch(await api(`/orgs/${org.id}/compliance/gstr2b/${id}`)); setShow('all'); });
  const upload = () => run(async () => {
    if (!file) return;
    const content = await file.text();
    const r = await api(`/orgs/${org.id}/compliance/gstr2b`, { body: { fileName: file.name, content, period } });
    setOk(`Read ${r.lines} invoice(s) for ${r.period}${r.skipped ? ` (${r.skipped} line(s) skipped: no GSTIN or invoice number)` : ''}.`);
    setFile(null); await load(); setMatch(await api(`/orgs/${org.id}/compliance/gstr2b/${r.id}`)); setShow('all');
  });
  const remove = (u: Upload) => run(async () => {
    if (!window.confirm(`Remove the GSTR-2B upload for ${u.period}?`)) return;
    await api(`/orgs/${org.id}/compliance/gstr2b/${u.id}`, { method: 'DELETE' }); if (match?.import.id === u.id) setMatch(null); load();
  });
  const message = (c: Match['chase'][number]) => `Dear ${c.supplier},\n\nOur GSTR-2B for ${match!.import.period} does not show the following invoice(s) from you, or shows less tax than invoiced: ${c.invoices.join(', ')} (GST of Rs ${fmt(c.tax)}).\nPlease report them correctly in your GSTR-1 so that we can claim the input tax credit.\n\nOur GSTIN: ${org.gstin ?? ''}\nYour GSTIN: ${c.gstin}\n\nThank you,\n${org.name}`;
  const copy = (c: Match['chase'][number]) => run(async () => { await navigator.clipboard.writeText(message(c)).catch(() => undefined); setOk(`Message for ${c.supplier} copied. Paste it into an email or WhatsApp.`); });
  const csv = () => {
    if (!match) return;
    const q = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = [['Status', 'Supplier', 'GSTIN', 'Invoice no.', 'Date', 'Your bill', 'Taxable (books)', 'Tax (books)', 'Taxable (GSTR-2B)', 'Tax (GSTR-2B)', 'Difference', 'Note'].join(',')]
      .concat(match.rows.map((r) => [LABEL[r.status][0], r.supplier, r.gstin, r.invoiceNo, r.date, r.billNumber, r.books ? r.books.taxable / 100 : '', r.books ? r.books.tax / 100 : '', r.portal ? r.portal.taxable / 100 : '', r.portal ? r.portal.tax / 100 : '', r.difference / 100, r.note].map(q).join(',')));
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\n')], { type: 'text/csv' })); a.download = `gstr2b-match-${match.import.period}.csv`; a.click();
  };
  const rows = match ? match.rows.filter((r) => show === 'all' || r.status === show) : [];

  return (
    <>
      <div className="space-y-2"><ErrorMsg msg={error} /><Ok msg={ok} /></div>
      {canPost && (
        <Card title="Upload GSTR-2B">
          <p className="mb-3 text-sm text-slate-600">On the GST portal: Returns dashboard, GSTR-2B, Download (JSON). A CSV saved from the portal's Excel (B2B sheet) also works. Bills are matched by the supplier's GSTIN and the supplier bill number, however it is written.</p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm"><span className="mb-1 block font-medium text-slate-600">Month</span><input type="month" aria-label="GSTR-2B month" className="rounded-md border border-slate-300 px-3 py-2" value={period} onChange={(e) => setPeriod(e.target.value)} /></label>
            <input aria-label="GSTR-2B file" type="file" accept=".json,.csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <Button disabled={busy || !file} onClick={upload}>Upload and match</Button>
          </div>
          <p className="mt-2 text-xs text-slate-500">The month in a portal JSON file is used when it has one. Uploading the same month again replaces the earlier upload.</p>
        </Card>
      )}
      <Card title="Uploads">
        {uploads.length === 0 ? <Empty text="No GSTR-2B uploaded yet." /> : (
          <table className="w-full text-sm"><thead><tr className="text-left text-slate-500"><th>Month</th><th>File</th><th>Invoices</th><th>Uploaded by</th><th /></tr></thead>
            <tbody>{uploads.map((u) => <tr key={u.id} className="border-t border-slate-100"><td className="py-2 font-medium">{u.period}</td><td>{u.fileName}</td><td>{u.lines}</td><td>{u.uploadedBy}</td>
              <td className="whitespace-nowrap text-right"><Button variant="ghost" onClick={() => open(u.id)}>Open match</Button> {canPost && <Button variant="ghost" className="text-red-700" aria-label={`Remove upload ${u.period}`} onClick={() => remove(u)}>Remove</Button>}</td></tr>)}</tbody></table>)}
      </Card>
      {match && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5" data-testid="twob-summary">
            <Tile label="Matched" value={String(match.counts.matched)} tone="green" />
            <Tile label="Tax differs" value={String(match.counts.mismatch)} tone={match.counts.mismatch ? 'amber' : 'slate'} />
            <Tile label="Only in GSTR-2B" value={String(match.counts.only_2b)} note="Reported by suppliers, no bill in your books" />
            <Tile label="Only in your books" value={String(match.counts.only_books)} tone={match.counts.only_books ? 'red' : 'slate'} note="Supplier has not reported it" />
            <Tile label="Credit at risk" value={`₹${fmt(match.tax.atRisk)}`} tone={match.tax.atRisk ? 'red' : 'green'} note={`Credit available in GSTR-2B: ₹${fmt(match.tax.portal)}`} />
          </div>
          {match.chase.length > 0 && (
            <Card title={`Suppliers to chase (${match.chase.length})`}>
              <p className="mb-3 text-sm text-slate-600">These suppliers have not reported your bills, or reported less tax. The credit cannot be claimed until they correct their GSTR-1.</p>
              <table className="w-full text-sm"><thead><tr className="text-left text-slate-500"><th>Supplier</th><th>GSTIN</th><th>Invoices</th><th className="text-right">GST at risk</th><th /></tr></thead>
                <tbody>{match.chase.map((c) => <tr key={c.gstin} className="border-t border-slate-100"><td className="py-2 font-medium">{c.supplier}</td><td className="font-mono text-xs">{c.gstin}</td><td>{c.invoices.join(', ')}</td><td className="text-right">{fmt(c.tax)}</td>
                  <td className="text-right"><Button variant="ghost" aria-label={`Copy reminder for ${c.supplier}`} onClick={() => copy(c)}>Copy reminder</Button></td></tr>)}</tbody></table>
            </Card>
          )}
          <Card title={`GSTR-2B ${match.import.period} against your bills`} actions={<Button variant="ghost" onClick={csv}>Download CSV</Button>}>
            <div className="mb-3 flex flex-wrap gap-2">
              {(['all', 'matched', 'mismatch', 'only_2b', 'only_books'] as const).map((k) => <button key={k} aria-pressed={show === k} onClick={() => setShow(k)}
                className={`rounded-full px-3 py-1 text-xs font-medium ${show === k ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-700'}`}>{k === 'all' ? `All (${match.rows.length})` : `${LABEL[k][0]} (${match.counts[k]})`}</button>)}
            </div>
            {rows.length === 0 ? <Empty text="Nothing here." /> : (
              <div className="overflow-x-auto"><table className="w-full text-sm" data-testid="twob-rows"><thead><tr className="text-left text-slate-500"><th>Status</th><th>Supplier</th><th>Invoice no.</th><th>Date</th><th>Your bill</th><th className="text-right">Tax in books</th><th className="text-right">Tax in GSTR-2B</th><th className="text-right">Difference</th><th>What to do</th></tr></thead>
                <tbody>{rows.map((r, i) => <tr key={i} className="border-t border-slate-100 align-top">
                  <td className="py-2"><Pill text={LABEL[r.status][0]} tone={LABEL[r.status][1]} /></td><td>{r.supplier}<span className="block font-mono text-[11px] text-slate-500">{r.gstin}</span></td>
                  <td>{r.invoiceNo}</td><td className="whitespace-nowrap">{r.date ?? ''}</td><td>{r.billNumber ?? '—'}</td>
                  <td className="text-right">{r.books ? fmt(r.books.tax) : '—'}</td><td className="text-right">{r.portal ? fmt(r.portal.tax) : '—'}</td>
                  <td className={`text-right ${r.status === 'matched' ? '' : 'font-medium text-red-700'}`}>{r.status === 'matched' ? '' : fmt(r.difference)}</td>
                  <td className="max-w-xs text-xs text-slate-600">{r.note}</td></tr>)}</tbody></table></div>)}
          </Card>
        </>
      )}
    </>
  );
}

// ------------------------------------------------------------------ MSME 43B(h)
interface MsmeRow { id: number; number: string; supplierRef: string | null; supplier: string; msmeType: string; date: string; limitDays: number; payBy: string; payable: number; paidOnTime: number; paidLate: number; unpaid: number; daysLeft: number | null; status: 'paid_on_time' | 'paid_late' | 'overdue' | 'due'; disallowed: number }
interface MsmeReport { fy: { start: string; end: string; label: string }; final: boolean; rows: MsmeRow[]; totals: { bills: number; payable: number; paidOnTime: number; overdue: number; dueSoon: number; disallowed: number }; suppliersWithoutStatus: { id: number; name: string }[] }
const MSME_STATUS: Record<MsmeRow['status'], [string, 'green' | 'amber' | 'red' | 'slate']> = { paid_on_time: ['Paid on time', 'green'], paid_late: ['Paid late', 'amber'], overdue: ['Overdue: pay now', 'red'], due: ['Not yet due', 'slate'] };

function Msme({ org, go }: { org: Org; go: (p: string) => void }) {
  const [asOf, setAsOf] = useState(today());
  const [fy, setFy] = useState(String(fyStartOf(today())));
  const [r, setR] = useState<MsmeReport | null>(null);
  const { error, busy, run } = useAction();
  const load = useCallback(() => run(async () => setR(await api(`/orgs/${org.id}/compliance/msme?fy=${fy}&asOf=${asOf}`))), [org.id, fy, asOf]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  const exp = (format: 'pdf' | 'xlsx') => run(() => download(`/orgs/${org.id}/export/msme-43bh?format=${format}&from=${fy}-04-01&asOf=${asOf}`, `msme-43bh-${fy}.${format}`));
  const years = [0, 1, 2].map((i) => fyStartOf(today()) - i);
  return (
    <>
      <Card>
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <label><span className="mb-1 block font-medium text-slate-600">Financial year</span>
            <select aria-label="Financial year" className="rounded-md border border-slate-300 bg-white px-3 py-2" value={fy} onChange={(e) => setFy(e.target.value)}>{years.map((y) => <option key={y} value={y}>FY {y}-{String((y + 1) % 100).padStart(2, '0')}</option>)}</select></label>
          <Field label="As at" type="date" aria-label="MSME as at" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          <Button variant="ghost" disabled={busy} onClick={() => exp('pdf')}>Export PDF</Button><Button variant="ghost" disabled={busy} onClick={() => exp('xlsx')}>Export Excel</Button>
        </div>
        <p className="mt-3 text-xs text-slate-500">Section 43B(h): a bill from a micro or small enterprise must be paid within 15 days, or within the days agreed in writing (at most 45). What is unpaid after that is not allowed as an expense for the year and is allowed when paid. Reported in Form 3CD clause 22. The bill date is used as the date of acceptance.</p>
        <div className="mt-2"><ErrorMsg msg={error} /></div>
      </Card>
      {r && (
        <>
          {r.suppliersWithoutStatus.length > 0 && (
            <p className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900" data-testid="msme-missing">
              {r.suppliersWithoutStatus.length} supplier(s) have no MSME status, so their bills are not checked: {r.suppliersWithoutStatus.slice(0, 6).map((s) => s.name).join(', ')}{r.suppliersWithoutStatus.length > 6 ? '…' : ''}. Ask them for their Udyam certificate and set it on the supplier. <button className="font-medium underline" onClick={() => go('suppliers')}>Open suppliers</button>
            </p>)}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="msme-summary">
            <Tile label="Bills from micro and small suppliers" value={String(r.totals.bills)} note={`₹${fmt(r.totals.paidOnTime)} of ₹${fmt(r.totals.payable)} paid on time`} />
            <Tile label="Overdue: pay now" value={`₹${fmt(r.totals.overdue)}`} tone={r.totals.overdue ? 'red' : 'green'} />
            <Tile label="Due within 7 days" value={`₹${fmt(r.totals.dueSoon)}`} tone={r.totals.dueSoon ? 'amber' : 'slate'} />
            <Tile label={`Expense not allowed, FY ${r.fy.label}`} value={`₹${fmt(r.totals.disallowed)}`} tone={r.totals.disallowed ? 'red' : 'green'} note={r.final ? 'Final for the year' : 'If nothing more is paid in time; allowed in the year it is paid'} />
          </div>
          <Card title="Bills">
            {r.rows.length === 0 ? <Empty text="No bills from micro or small suppliers in this year. Set the MSME status on your suppliers to check them." /> : (
              <div className="overflow-x-auto"><table className="w-full text-sm" data-testid="msme-rows"><thead><tr className="text-left text-slate-500"><th>Bill</th><th>Supplier</th><th>Bill date</th><th>Pay by</th><th className="text-right">Payable</th><th className="text-right">Paid on time</th><th className="text-right">Unpaid</th><th>Status</th><th className="text-right">Not allowed</th></tr></thead>
                <tbody>{r.rows.map((x) => <tr key={x.id} className="border-t border-slate-100">
                  <td className="py-2 font-medium">{x.number}{x.supplierRef && <span className="block text-xs font-normal text-slate-500">{x.supplierRef}</span>}</td>
                  <td>{x.supplier}<span className="block text-xs text-slate-500"><span className="capitalize">{x.msmeType}</span> · {x.limitDays} days</span></td>
                  <td className="whitespace-nowrap">{x.date}</td><td className="whitespace-nowrap">{x.payBy}{x.status === 'due' && x.daysLeft !== null && <span className="block text-xs text-slate-500">in {x.daysLeft} day(s)</span>}</td>
                  <td className="text-right">{fmt(x.payable)}</td><td className="text-right">{fmt(x.paidOnTime)}</td><td className="text-right">{x.unpaid ? fmt(x.unpaid) : ''}</td>
                  <td><Pill text={MSME_STATUS[x.status][0]} tone={MSME_STATUS[x.status][1]} /></td><td className={`text-right ${x.disallowed ? 'font-medium text-red-700' : ''}`}>{x.disallowed ? fmt(x.disallowed) : ''}</td></tr>)}</tbody></table></div>)}
          </Card>
        </>
      )}
    </>
  );
}

// ------------------------------------------------------------------ 180 days
interface ItcRow { id: number; number: string; supplierRef: string | null; supplier: string; date: string; day180: string; daysPast: number; unpaid: number; gst: number; reverse: number; status: 'reverse' | 'soon' }

function Itc180({ org }: { org: Org }) {
  const [asOf, setAsOf] = useState(today());
  const [r, setR] = useState<{ rows: ItcRow[]; totals: { reverseNow: number; soon: number } } | null>(null);
  const { error, busy, run } = useAction();
  useEffect(() => { run(async () => setR(await api(`/orgs/${org.id}/compliance/itc-180?asOf=${asOf}`))); }, [org.id, asOf]); // eslint-disable-line react-hooks/exhaustive-deps
  const exp = (format: 'pdf' | 'xlsx') => run(() => download(`/orgs/${org.id}/export/itc-180?format=${format}&asOf=${asOf}`, `itc-180-days-${asOf}.${format}`));
  return (
    <>
      <Card>
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <Field label="As at" type="date" aria-label="ITC as at" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          <Button variant="ghost" disabled={busy} onClick={() => exp('pdf')}>Export PDF</Button><Button variant="ghost" disabled={busy} onClick={() => exp('xlsx')}>Export Excel</Button>
        </div>
        <p className="mt-3 text-xs text-slate-500">If a supplier is not paid within 180 days of the invoice date, the input tax credit taken on the unpaid part must be reversed in GSTR-3B (with interest under section 50) and can be claimed again once paid. TDS deducted counts as paid.</p>
        <div className="mt-2"><ErrorMsg msg={error} /></div>
      </Card>
      {r && (
        <>
          <div className="grid gap-3 sm:grid-cols-2" data-testid="itc-summary">
            <Tile label="Credit to reverse now" value={`₹${fmt(r.totals.reverseNow)}`} tone={r.totals.reverseNow ? 'red' : 'green'} note="Unpaid for more than 180 days" />
            <Tile label="Reaching 180 days within 30 days" value={`₹${fmt(r.totals.soon)}`} tone={r.totals.soon ? 'amber' : 'slate'} note="Pay these suppliers to keep the credit" />
          </div>
          <Card title="Unpaid bills">
            {r.rows.length === 0 ? <Empty text="No bills are near 180 days unpaid." /> : (
              <table className="w-full text-sm" data-testid="itc-rows"><thead><tr className="text-left text-slate-500"><th>Bill</th><th>Supplier</th><th>Bill date</th><th>Day 180</th><th className="text-right">Unpaid</th><th className="text-right">GST on bill</th><th className="text-right">Credit to reverse</th><th /></tr></thead>
                <tbody>{r.rows.map((x) => <tr key={x.id} className="border-t border-slate-100"><td className="py-2 font-medium">{x.number}{x.supplierRef && <span className="block text-xs font-normal text-slate-500">{x.supplierRef}</span>}</td><td>{x.supplier}</td><td>{x.date}</td><td>{x.day180}</td>
                  <td className="text-right">{fmt(x.unpaid)}</td><td className="text-right">{fmt(x.gst)}</td><td className="text-right font-medium">{fmt(x.reverse)}</td>
                  <td>{x.status === 'reverse' ? <Pill text={`${x.daysPast} day(s) past`} tone="red" /> : <Pill text={`in ${-x.daysPast} day(s)`} tone="amber" />}</td></tr>)}</tbody></table>)}
          </Card>
        </>
      )}
    </>
  );
}
