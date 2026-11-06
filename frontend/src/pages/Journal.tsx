// Manual journals: post an entry (with documents attached), set rules that post it automatically, and reverse entries one at a time or many at once.
import { useCallback, useEffect, useState } from 'react';
import { api, download, fileToBase64, fmt, toPaise } from '../api';
import type { Org } from '../App';
import { Badge, Empty, Select } from '../kit';
import { Button, Card, ErrorMsg, Field, Ok, useAction } from '../ui';
import type { Account, TrackingCategory } from './Lines';

interface Entry { id: number; date: string; narration: string; reference?: string | null; reversesId: number | null; lines: { accountId: number; debit: number; credit: number }[] }
interface Rule { id: number; name: string; narration: string; frequency: string; nextDate: string; endDate: string | null; active: boolean; runs: number; lastRun: string | null; lines: { accountId: number; debit: number; credit: number }[] }
interface Attachment { id: number; name: string }

const safe = (s: string) => { try { return toPaise(s); } catch { return 0; } };
const blankRows = () => [{ accountId: '', debit: '', credit: '', cc: '' }, { accountId: '', debit: '', credit: '', cc: '' }];
const FREQ = [['monthly', 'Every month'], ['weekly', 'Every week'], ['quarterly', 'Every quarter'], ['yearly', 'Every year']];

export function Journal({ org, accounts, canPost }: { org: Org; accounts: Account[]; canPost: boolean }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today), [narration, setNarration] = useState('');
  const [rows, setRows] = useState(blankRows());
  const [files, setFiles] = useState<File[]>([]);
  const [rule, setRule] = useState({ on: false, name: '', frequency: 'monthly', endDate: '' });
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [open, setOpen] = useState<Record<number, Attachment[] | undefined>>({});
  const { error, busy, run, setError } = useAction();
  const [ok, setOk] = useState(''), [reason, setReason] = useState('Correction');
  const load = useCallback(() => api(`/orgs/${org.id}/journal`).then(setEntries), [org.id]);
  const loadRules = useCallback(() => api<Rule[]>(`/orgs/${org.id}/journal-rules`).then(setRules), [org.id]);
  const [centres, setCentres] = useState<{ id: number; label: string }[]>([]); // cost centres (tracking options) the entry can be tagged with
  useEffect(() => { api<TrackingCategory[]>(`/orgs/${org.id}/tracking`).then((c) => setCentres(c.flatMap((x) => x.options.map((o) => ({ id: o.id, label: `${x.name}: ${o.name}` }))))).catch(() => undefined); }, [org.id]);
  useEffect(() => { load(); loadRules(); }, [load, loadRules]);
  useEffect(() => { setSelected(new Set()); }, [entries]);

  const name = (id: number) => accounts.find((a) => a.id === id)?.name ?? `#${id}`;
  const totalD = rows.reduce((s, r) => s + (r.debit ? safe(r.debit) : 0), 0), totalC = rows.reduce((s, r) => s + (r.credit ? safe(r.credit) : 0), 0);
  const apiLines = () => rows.filter((r) => r.accountId).map((r) => ({ accountId: Number(r.accountId), ...(r.debit ? { debit: toPaise(r.debit) } : {}), ...(r.credit ? { credit: toPaise(r.credit) } : {}), ...(r.cc ? { trackingOptionId: Number(r.cc) } : {}) }));
  const clear = () => { setNarration(''); setRows(blankRows()); setFiles([]); setRule({ on: false, name: '', frequency: 'monthly', endDate: '' }); };

  const submit = () => run(async () => {
    setOk('');
    if (rule.on) {
      // A rule posts this entry on its schedule, starting on the date above. Anything already due is posted straight away.
      await api(`/orgs/${org.id}/journal-rules`, { body: { name: rule.name || narration, narration, lines: apiLines(), frequency: rule.frequency, startDate: date, ...(rule.endDate ? { endDate: rule.endDate } : {}) } });
      const r = await api(`/orgs/${org.id}/journal-rules/run`, { body: {} });
      setOk(`Rule saved. ${r.created} entr${r.created === 1 ? 'y' : 'ies'} posted so far; the rest post automatically on their dates.`); clear(); load(); loadRules(); return;
    }
    const r = await api(`/orgs/${org.id}/journal`, { body: { date, narration, lines: apiLines() } });
    let note = '';
    for (const file of files) {
      try { await api(`/orgs/${org.id}/files`, { body: { name: file.name, mime: file.type || 'application/octet-stream', dataBase64: await fileToBase64(file), linkType: 'journal', linkId: r.id } }); }
      catch (e) { note = ` The entry was posted, but ${file.name} could not be attached: ${(e as Error).message}`; }
    }
    clear(); setOk(`Entry posted.${note}`); load();
  });
  const reverse = (id: number) => run(async () => { await api(`/orgs/${org.id}/journal/${id}/reverse`, { body: { date: today, reason } }); setOk('Reversal posted.'); load(); });
  const bulkDelete = () => run(async () => {
    const ids = [...selected]; if (!ids.length) return;
    if (!window.confirm(`Delete ${ids.length} entr${ids.length === 1 ? 'y' : 'ies'}? Posted entries cannot be erased from the books, so each is cancelled by a reversing entry. Entries that belong to an invoice, bill or payment are skipped.`)) return;
    const r = await api(`/orgs/${org.id}/journal/bulk-reverse`, { body: { ids, date: today, reason } });
    setOk(`${r.reversed.length} reversed.${r.failed.length ? ` ${r.failed.length} skipped: ${r.failed.map((x: any) => `#${x.id} (${x.reason})`).join('; ')}` : ''}`); load();
  });
  const toggleFiles = async (id: number) => {
    if (open[id]) { setOpen({ ...open, [id]: undefined }); return; }
    setOpen({ ...open, [id]: await api<Attachment[]>(`/orgs/${org.id}/files?linkType=journal&linkId=${id}`) });
  };
  const toggle = (id: number) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const selectable = entries.filter((e) => !e.reversesId);
  const allSelected = selectable.length > 0 && selected.size === selectable.length;

  return (
    <>
      {canPost && (
        <Card title="New journal entry">
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            <div className="md:col-span-2"><Field label="Narration" value={narration} onChange={(e) => setNarration(e.target.value)} /></div>
          </div>
          {centres.length > 0 && (
            <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
              <label className="font-medium text-slate-600" htmlFor="jcc-all">Cost centre for the whole entry</label>
              <select id="jcc-all" aria-label="Cost centre for all lines" className="rounded border border-slate-300 bg-white px-2 py-1" value={rows.every((r) => r.cc === rows[0].cc) ? rows[0].cc : 'mixed'}
                onChange={(e) => e.target.value !== 'mixed' && setRows(rows.map((r) => ({ ...r, cc: e.target.value })))}>
                <option value="">None</option>{!rows.every((r) => r.cc === rows[0].cc) && <option value="mixed">Different on each line</option>}
                {centres.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select>
              <span className="text-xs text-slate-500">Sets every line. You can still change one line.</span>
            </div>)}
          <table className="mt-4 w-full text-sm">
            <thead><tr className="text-left text-slate-500"><th>Account</th><th className="w-36">Debit (₹)</th><th className="w-36">Credit (₹)</th>{centres.length > 0 && <th className="w-52">Cost centre</th>}</tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td className="pr-2"><select aria-label={`Account ${i + 1}`} className="w-full rounded border border-slate-300 px-2 py-1" value={r.accountId}
                    onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, accountId: e.target.value } : x)))}>
                    <option value="">Select account…</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
                  </select></td>
                  <td className="pr-2"><input aria-label={`Debit ${i + 1}`} className="w-full rounded border border-slate-300 px-2 py-1 text-right" inputMode="decimal" value={r.debit}
                    onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, debit: e.target.value, credit: e.target.value ? '' : x.credit } : x)))} /></td>
                  <td className="pr-2"><input aria-label={`Credit ${i + 1}`} className="w-full rounded border border-slate-300 px-2 py-1 text-right" inputMode="decimal" value={r.credit}
                    onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, credit: e.target.value, debit: e.target.value ? '' : x.debit } : x)))} /></td>
                  {centres.length > 0 && <td><select aria-label={`Cost centre ${i + 1}`} className="w-full rounded border border-slate-300 px-2 py-1" value={r.cc} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, cc: e.target.value } : x)))}>
                    <option value="">—</option>{centres.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select></td>}
                </tr>
              ))}
            </tbody>
            <tfoot><tr className="font-medium"><td className="py-2 text-right">Totals {totalD === totalC && totalD > 0 ? '✓ balanced' : ''}</td><td className="text-right">{fmt(totalD)}</td><td className="text-right">{fmt(totalC)}</td>{centres.length > 0 && <td />}</tr></tfoot>
          </table>
          <div className="mt-3 grid gap-4 md:grid-cols-2">
            <div className="text-sm"><span className="mb-1 block font-medium text-slate-600">Attach documents (policy, bill, working)</span>
              <input aria-label="Attach documents" type="file" multiple disabled={rule.on} onChange={(e) => setFiles([...files, ...Array.from(e.target.files ?? [])])} />
              <ul className="mt-1 text-xs text-slate-600">{files.map((x, i) => <li key={i}>{x.name} <button className="text-red-700" onClick={() => setFiles(files.filter((_, j) => j !== i))}>remove</button></li>)}</ul></div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
              <label className="flex items-center gap-2 font-medium"><input type="checkbox" aria-label="Repeat automatically" checked={rule.on} onChange={(e) => setRule({ ...rule, on: e.target.checked })} />Post this entry automatically on a schedule (a rule)</label>
              {rule.on && (
                <div className="mt-2 grid gap-3 md:grid-cols-3">
                  <Field label="Rule name" placeholder="e.g. Insurance write-off" value={rule.name} onChange={(e) => setRule({ ...rule, name: e.target.value })} />
                  <Select label="Repeat" aria-label="Rule frequency" value={rule.frequency} onChange={(e) => setRule({ ...rule, frequency: e.target.value })}>{FREQ.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
                  <Field label="Stop after (optional)" type="date" value={rule.endDate} onChange={(e) => setRule({ ...rule, endDate: e.target.value })} />
                  <p className="col-span-full text-xs text-slate-500">The first entry is dated as the date above, then it repeats. Use it for things like monthly insurance or prepaid expense write-offs.</p>
                </div>)}
            </div>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <Button variant="ghost" onClick={() => setRows([...rows, { accountId: '', debit: '', credit: '', cc: rows.length && rows.every((x) => x.cc === rows[0].cc) ? rows[0].cc : '' }])}>Add line</Button>
            <Button onClick={submit} disabled={busy}>{rule.on ? 'Save rule' : 'Post entry'}</Button>
          </div>
          <div className="mt-3 space-y-2"><ErrorMsg msg={error} /><Ok msg={ok} /></div>
        </Card>
      )}

      <Card title="Journal rules">
        {rules.length === 0 ? <Empty text="No rules yet. Tick “Post this entry automatically” above to make one." /> : (
          <table className="w-full text-sm"><thead><tr className="text-left text-slate-500"><th>Rule</th><th>Repeats</th><th>Next entry</th><th>Ends</th><th>Posted</th><th>Status</th><th /></tr></thead>
            <tbody>{rules.map((r) => (
              <tr key={r.id} className="border-t border-slate-100"><td className="py-2"><b>{r.name}</b><span className="block text-xs text-slate-500">{r.narration}: {r.lines.map((l) => `${l.debit ? 'Dr' : 'Cr'} ${name(l.accountId)} ${fmt(l.debit || l.credit)}`).join(' · ')}</span></td>
                <td>{r.frequency}</td><td>{r.active ? r.nextDate : '—'}</td><td>{r.endDate ?? '—'}</td><td>{r.runs}{r.lastRun ? ` (last ${r.lastRun})` : ''}</td><td><Badge text={r.active ? 'active' : 'done'} /></td>
                <td className="whitespace-nowrap text-right">{canPost && r.active && <Button variant="ghost" onClick={() => run(async () => { await api(`/orgs/${org.id}/journal-rules/${r.id}/stop`, { body: {} }); loadRules(); })}>Stop</Button>}</td></tr>))}</tbody></table>
        )}
        {canPost && rules.some((r) => r.active) && <div className="mt-3"><Button variant="ghost" disabled={busy} onClick={() => run(async () => { const r = await api(`/orgs/${org.id}/journal-rules/run`, { body: {} }); setOk(`${r.created} entr${r.created === 1 ? 'y' : 'ies'} posted.`); load(); loadRules(); })}>Post anything due now</Button></div>}
      </Card>

      <Card title="Posted entries">
        {canPost && <div className="mb-3 flex flex-wrap items-end gap-3"><div className="max-w-sm"><Field label="Reason used when reversing an entry" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
          {selectable.length > 0 && <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" aria-label="Select all entries" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(selectable.map((e) => e.id)))} />Select all</label>}
          {selected.size > 0 && <Button variant="danger" disabled={busy} onClick={bulkDelete}>Delete {selected.size} selected</Button>}</div>}
        {entries.length === 0 ? <p className="text-sm text-slate-500">Nothing posted yet.</p> : entries.map((e) => (
          <div key={e.id} className="border-b border-slate-100 py-3 last:border-0">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="flex items-center gap-2">{canPost && !e.reversesId && <input type="checkbox" aria-label={`Select entry ${e.id}`} checked={selected.has(e.id)} onChange={() => toggle(e.id)} />}
                <span><b>#{e.id}</b> · {e.date} · {e.narration}{e.reversesId && <em className="ml-2 text-amber-700">(reversal of #{e.reversesId})</em>}</span></span>
              <span className="whitespace-nowrap"><Button variant="ghost" onClick={() => toggleFiles(e.id)}>Files</Button> {canPost && !e.reversesId && <Button variant="ghost" onClick={() => { setError(''); reverse(e.id); }}>Reverse</Button>}</span>
            </div>
            <ul className="mt-1 text-sm text-slate-600">{e.lines.map((l, i) => <li key={i} className="flex justify-between"><span>{name(l.accountId)}</span><span>{l.debit ? `Dr ${fmt(l.debit)}` : `Cr ${fmt(l.credit)}`}</span></li>)}</ul>
            {open[e.id] && <p className="mt-1 text-xs text-slate-600">{open[e.id]!.length === 0 ? 'No documents attached.' : open[e.id]!.map((a) => <button key={a.id} className="mr-3 underline" onClick={() => run(() => download(`/orgs/${org.id}/files/${a.id}/download`, a.name))}>{a.name}</button>)}</p>}
          </div>
        ))}
      </Card>
    </>
  );
}
