// Firm tools inside a client: tasks & deadlines, documents, import, scheduled reports, and the client dashboard.
import { useCallback, useEffect, useState } from 'react';
import { api, download, fileToBase64, fmt, today } from '../api';
import type { Org } from '../App';
import { Button, Card, ErrorMsg, Field, Ok, useAction } from '../ui';

export function Tasks({ org, canPost }: { org: Org; canPost: boolean }) {
  const [tasks, setTasks] = useState<any[]>([]);
  const [f, setF] = useState({ title: '', dueDate: today() });
  const [ok, setOk] = useState('');
  const { error, busy, run } = useAction();
  const load = useCallback(() => api(`/orgs/${org.id}/tasks`).then(setTasks), [org.id]);
  useEffect(() => { load(); }, [load]);
  return (
    <>
      {canPost && (
        <Card title="Tasks and deadlines" actions={<Button variant="ghost" disabled={busy} onClick={() => run(async () => { const r = await api(`/orgs/${org.id}/deadlines/generate`, { body: { months: 3 } }); setOk(`Added ${r.created} GST/TDS due dates.`); load(); })}>Add GST/TDS due dates</Button>}>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Task" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
            <Field label="Due" type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} />
            <Button disabled={busy} onClick={() => run(async () => { await api(`/orgs/${org.id}/tasks`, { body: f }); setF({ ...f, title: '' }); load(); })}>Add task</Button>
          </div>
          <div className="mt-3 space-y-2"><ErrorMsg msg={error} /><Ok msg={ok} /></div>
          <p className="mt-2 text-xs text-slate-500">The team gets an email reminder 3 days before each open task is due.</p>
        </Card>
      )}
      <Card>
        <table className="w-full text-sm"><thead><tr className="text-left text-slate-500"><th>Task</th><th>Due</th><th>Status</th><th /></tr></thead>
          <tbody>{tasks.map((t) => (
            <tr key={t.id} className="border-t border-slate-100"><td>{t.title}</td><td className={t.status === 'open' && t.dueDate < today() ? 'text-red-700' : ''}>{t.dueDate}</td><td>{t.status}</td>
              <td className="text-right">{canPost && t.status === 'open' && <Button variant="ghost" onClick={() => run(async () => { await api(`/orgs/${org.id}/tasks/${t.id}/complete`, { method: 'POST', body: {} }); load(); })}>Done</Button>}</td></tr>))}</tbody></table>
      </Card>
    </>
  );
}

export function Files({ org, canManage }: { org: Org; canManage: boolean }) {
  const [files, setFiles] = useState<any[]>([]);
  const [ok, setOk] = useState('');
  const { error, busy, run } = useAction();
  const load = useCallback(() => api(`/orgs/${org.id}/files`).then(setFiles), [org.id]);
  useEffect(() => { load(); }, [load]);
  const upload = (f: File) => run(async () => {
    await api(`/orgs/${org.id}/files`, { body: { name: f.name, mime: f.type || 'application/octet-stream', dataBase64: await fileToBase64(f) } });
    setOk(`Uploaded ${f.name}`); load();
  });
  return (
    <Card title="Documents">
      <label className="block text-sm">Upload (PDF, image, CSV, Excel, Word, text; max 10 MB): <input aria-label="Upload file" type="file" disabled={busy} onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} /></label>
      <div className="my-3 space-y-2"><ErrorMsg msg={error} /><Ok msg={ok} /></div>
      <ul className="divide-y divide-slate-100 text-sm">{files.map((f) => (
        <li key={f.id} className="flex items-center justify-between py-2"><span>{f.name} <span className="text-slate-400">({Math.ceil(f.size / 1024)} KB)</span></span>
          <span className="space-x-1"><Button variant="ghost" onClick={() => run(() => download(`/orgs/${org.id}/files/${f.id}/download`, f.name))}>Download</Button>
            {canManage && <Button variant="ghost" onClick={() => run(async () => { await api(`/orgs/${org.id}/files/${f.id}`, { method: 'DELETE' }); load(); })}>Delete</Button>}</span></li>))}</ul>
    </Card>
  );
}

const SAMPLES: Record<string, string> = {
  contacts: 'Party Name,Type,GSTIN,State,Email\nAcme Pvt Ltd,Customer,,27,accounts@acme.example',
  accounts: 'Code,Name,Type,Group\n5600,Software Subscriptions,Expense,Operating Expenses',
  vouchers: 'Voucher No,Date,Ledger,Debit,Credit,Narration\nOPEN-1,01/04/2025,1010,100000,,Opening balance\nOPEN-1,01/04/2025,3000,,100000,Opening balance',
};

export function Import({ org }: { org: Org }) {
  const [kind, setKind] = useState('vouchers');
  const [csv, setCsv] = useState(SAMPLES.vouchers);
  const [result, setResult] = useState<any>(null);
  const { error, busy, run } = useAction();
  const go = (dryRun: boolean) => run(async () => setResult(await api(`/orgs/${org.id}/import/${kind}`, { body: { csv, dryRun } })));
  return (
    <Card title="Import from other accounting software">
      <p className="mb-3 text-sm text-slate-600">Export a CSV from your old software, paste it or choose the file. Column names are matched automatically (for example "Ledger Name", "Party Name", "Dr"/"Cr"). Vouchers with the same number become one journal entry, and every voucher must balance.</p>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <select aria-label="Import type" className="rounded border border-slate-300 px-2 py-1" value={kind} onChange={(e) => { setKind(e.target.value); setCsv(SAMPLES[e.target.value]); setResult(null); }}>
          <option value="vouchers">Journal vouchers / opening balances</option><option value="contacts">Customers and suppliers</option><option value="accounts">Chart of accounts</option></select>
        <input aria-label="CSV file" type="file" accept=".csv" onChange={async (e) => e.target.files?.[0] && setCsv(await e.target.files[0].text())} />
        <Button variant="ghost" onClick={() => {
          const url = URL.createObjectURL(new Blob([SAMPLES[kind].split('\n')[0] + '\n'], { type: 'text/csv;charset=utf-8' }));
          const a = document.createElement('a'); a.href = url; a.download = `${kind}-import-template.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        }}>Download blank template</Button>
      </div>
      <textarea aria-label="CSV data" className="mt-3 h-40 w-full rounded border border-slate-300 p-2 font-mono text-xs" value={csv} onChange={(e) => setCsv(e.target.value)} />
      <div className="mt-3 flex gap-3"><Button variant="ghost" disabled={busy} onClick={() => go(true)}>Check (dry run)</Button><Button disabled={busy} onClick={() => go(false)}>Import</Button></div>
      <div className="mt-3"><ErrorMsg msg={error} /></div>
      {result && (
        <div className="mt-3 text-sm" data-testid="import-result">
          {result.ok ? <Ok msg={result.dryRun ? `Looks good: ${result.wouldImport} record(s) ready to import.` : `Imported ${result.imported} record(s).`} /> : <ErrorMsg msg="Nothing imported. Fix these rows and try again:" />}
          <ul className="mt-2 list-disc pl-5 text-slate-600">{result.errors.map((e: string, i: number) => <li key={i}>{e}</li>)}</ul>
        </div>
      )}
    </Card>
  );
}

export function Schedules({ org }: { org: Org }) {
  const [list, setList] = useState<any[]>([]);
  const [f, setF] = useState({ report: 'pnl', format: 'pdf', frequency: 'monthly', recipients: '' });
  const { error, busy, run } = useAction();
  const load = useCallback(() => api(`/orgs/${org.id}/scheduled-reports`).then(setList), [org.id]);
  useEffect(() => { load(); }, [load]);
  return (
    <Card title="Scheduled email reports">
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <select aria-label="Report" className="rounded border border-slate-300 px-2 py-1" value={f.report} onChange={(e) => setF({ ...f, report: e.target.value })}>
          {['pnl', 'balance-sheet', 'trial-balance', 'aged-receivables', 'aged-payables', 'gstr3b', 'gstr1-b2b'].map((r) => <option key={r}>{r}</option>)}</select>
        <select aria-label="Format" className="rounded border border-slate-300 px-2 py-1" value={f.format} onChange={(e) => setF({ ...f, format: e.target.value })}><option value="pdf">PDF</option><option value="xlsx">Excel</option></select>
        <select aria-label="Frequency" className="rounded border border-slate-300 px-2 py-1" value={f.frequency} onChange={(e) => setF({ ...f, frequency: e.target.value })}><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select>
        <Field label="Email to (comma separated)" value={f.recipients} onChange={(e) => setF({ ...f, recipients: e.target.value })} />
        <Button disabled={busy} onClick={() => run(async () => { await api(`/orgs/${org.id}/scheduled-reports`, { body: { ...f, recipients: f.recipients.split(',').map((s) => s.trim()).filter(Boolean) } }); load(); })}>Schedule</Button>
      </div>
      <div className="mt-3"><ErrorMsg msg={error} /></div>
      <ul className="mt-3 divide-y divide-slate-100 text-sm">{list.map((s) => (
        <li key={s.id} className="flex justify-between py-2"><span>{s.report} ({s.format}) {s.frequency} → {s.recipients.join(', ')} · next {s.nextRun}</span>
          <Button variant="ghost" onClick={() => run(async () => { await api(`/orgs/${org.id}/scheduled-reports/${s.id}`, { method: 'DELETE' }); load(); })}>Stop</Button></li>))}</ul>
    </Card>
  );
}
