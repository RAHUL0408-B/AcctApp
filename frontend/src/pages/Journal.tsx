// Manual journals: post an entry (with documents attached), set rules that post it automatically, and reverse entries one at a time or many at once.
import { useCallback, useEffect, useState } from 'react';
import { AccountCombo } from '../ledgerdialog';
import { api, download, fileToBase64, fmt, toPaise } from '../api';
import type { Org } from '../App';
import { Badge, Empty, Select } from '../kit';
import { DataTable, Icon, RowMenu, type Column } from '../table';
import { Button, Callout, Card, ErrorMsg, Field, Ok, useAction , ask } from '../ui';
import type { Account, TrackingCategory } from './Lines';

interface Entry { id: number; date: string; narration: string; reference?: string | null; reversesId: number | null; voucherNo?: string | null; createdBy?: string | null; reversed?: boolean; lines: { accountId: number; debit: number; credit: number }[] }
interface Rule { id: number; name: string; narration: string; frequency: string; nextDate: string; endDate: string | null; active: boolean; runs: number; lastRun: string | null; isArchived?: boolean; lines: { accountId: number; debit: number; credit: number; trackingOptionId?: number }[] }
interface Attachment { id: number; name: string }

const safe = (s: string) => { try { return toPaise(s); } catch { return 0; } };
const blankRows = () => [{ accountId: '', debit: '', credit: '', cc: '' }, { accountId: '', debit: '', credit: '', cc: '' }];
const FREQ = [['monthly', 'Every month'], ['weekly', 'Every week'], ['quarterly', 'Every quarter'], ['yearly', 'Every year']];

/** Account box: type the number or the name, or pick from the list. */
export function Journal({ org, accounts, canPost, role = 'owner', go, focusId }: { org: Org; accounts: Account[]; canPost: boolean; role?: string; go?: (p: string) => void; /** show only this entry (opened from a ledger) */ focusId?: number }) {
  const [focus, setFocus] = useState<number | undefined>(focusId);
  useEffect(() => { setFocus(focusId); }, [focusId]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today), [narration, setNarration] = useState('');
  const [reference, setReference] = useState(''), [voucher, setVoucher] = useState(''), [voucherTouched, setVoucherTouched] = useState(false), [nextVoucher, setNextVoucher] = useState('');
  const [needsReview, setNeedsReview] = useState(false);
  useEffect(() => { api(`/orgs/${org.id}/settings`).then((s) => setNeedsReview(!!s.requireApproval)).catch(() => undefined); }, [org.id]);
  const [rows, setRows] = useState(blankRows());
  const [files, setFiles] = useState<File[]>([]);
  const [rule, setRule] = useState({ on: false, name: '', frequency: 'monthly', endDate: '' });
  const [editingRule, setEditingRule] = useState<number | null>(null);
  const [showArchivedRules, setShowArchivedRules] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [open, setOpen] = useState<Record<number, Attachment[] | undefined>>({});
  const { error, busy, run, setError } = useAction();
  const [ok, setOk] = useState(''), [reason, setReason] = useState('Correction');
  const load = useCallback(() => api(`/orgs/${org.id}/journal`).then(setEntries), [org.id]);
  const loadRules = useCallback(() => api<Rule[]>(`/orgs/${org.id}/journal-rules`).then(setRules), [org.id]);
  const [centres, setCentres] = useState<{ id: number; label: string }[]>([]); // cost centres (tracking options) the entry can be tagged with
  useEffect(() => { api<TrackingCategory[]>(`/orgs/${org.id}/tracking`).then((c) => setCentres(c.flatMap((x) => x.options.map((o) => ({ id: o.id, label: `${x.name}: ${o.name}` }))))).catch(() => undefined); }, [org.id]);
  useEffect(() => { load(); loadRules(); }, [load, loadRules]);
  useEffect(() => { api(`/orgs/${org.id}/journal-next-number?date=${date || today}`).then((r) => setNextVoucher(r.number)).catch(() => setNextVoucher('')); }, [org.id, date, entries.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setSelected(new Set()); }, [entries]);

  const name = (id: number) => accounts.find((a) => a.id === id)?.name ?? `#${id}`;
  const totalD = rows.reduce((s, r) => s + (r.debit ? safe(r.debit) : 0), 0), totalC = rows.reduce((s, r) => s + (r.credit ? safe(r.credit) : 0), 0);
  const apiLines = () => rows.filter((r) => r.accountId).map((r) => ({ accountId: Number(r.accountId), ...(r.debit ? { debit: toPaise(r.debit) } : {}), ...(r.credit ? { credit: toPaise(r.credit) } : {}), ...(r.cc ? { trackingOptionId: Number(r.cc) } : {}) }));
  const clear = () => { setNarration(''); setReference(''); setVoucher(''); setVoucherTouched(false); setRows(blankRows()); setFiles([]); setRule({ on: false, name: '', frequency: 'monthly', endDate: '' }); setEditingRule(null); };
  /** Open a rule in the form above to change it. */
  const editRule = (r: Rule) => {
    setOk(''); setEditingRule(r.id); setDate(r.nextDate); setNarration(r.narration); setRule({ on: true, name: r.name, frequency: r.frequency, endDate: r.endDate ?? '' });
    setRows(r.lines.map((l) => ({ accountId: String(l.accountId), debit: l.debit ? String(l.debit / 100) : '', credit: l.credit ? String(l.credit / 100) : '', cc: l.trackingOptionId ? String(l.trackingOptionId) : '' })));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const archiveRule = (r: Rule) => run(async () => { await api(`/orgs/${org.id}/journal-rules/${r.id}/archive`, { body: { archived: !r.isArchived } }); setOk(r.isArchived ? 'Rule restored.' : 'Rule archived: it stops and is hidden.'); loadRules(); });
  const deleteRule = (r: Rule) => run(async () => {
    if (!await ask(`Delete the rule "${r.name}"? No more entries will be posted from it. The ${r.runs} entr${r.runs === 1 ? 'y' : 'ies'} it already posted stay in the books: they are NOT reversed.`)) return;
    await api(`/orgs/${org.id}/journal-rules/${r.id}`, { method: 'DELETE' }); setOk('Rule deleted. Entries posted earlier are still in the books.'); loadRules();
  });
  // Staff can send a journal to an accountant; when the organisation asks for approval, that is the only way.
  const staff = role === 'staff';
  const mustReview = staff && needsReview;
  const header = () => ({ date, narration, ...(reference.trim() ? { reference: reference.trim() } : {}), ...(voucherTouched && voucher.trim() ? { voucherNo: voucher.trim() } : {}) });
  const sendForReview = () => run(async () => {
    setOk('');
    const r = await api(`/orgs/${org.id}/journal-drafts`, { body: { ...header(), lines: apiLines() } });
    clear(); setOk(`Sent for review (₹${fmt(r.total)}). It reaches the books once an owner or accountant approves it under Purchases, Awaiting approval.`);
  });

  const submit = () => run(async () => {
    setOk('');
    if (rule.on) {
      // A rule posts this entry on its schedule, starting on the date above. Anything already due is posted straight away.
      const ruleBody = { name: rule.name || narration, narration, lines: apiLines(), frequency: rule.frequency, startDate: date, ...(rule.endDate ? { endDate: rule.endDate } : {}) };
      if (editingRule) await api(`/orgs/${org.id}/journal-rules/${editingRule}`, { method: 'PUT', body: ruleBody });
      else await api(`/orgs/${org.id}/journal-rules`, { body: ruleBody });
      const r = await api(`/orgs/${org.id}/journal-rules/run`, { body: {} });
      setOk(`Rule saved. ${r.created} entr${r.created === 1 ? 'y' : 'ies'} posted so far; the rest post automatically on their dates.`); clear(); load(); loadRules(); return;
    }
    const r = await api(`/orgs/${org.id}/journal`, { body: { ...header(), lines: apiLines() } });
    let note = '';
    for (const file of files) {
      try { await api(`/orgs/${org.id}/files`, { body: { name: file.name, mime: file.type || 'application/octet-stream', dataBase64: await fileToBase64(file), linkType: 'journal', linkId: r.id } }); }
      catch (e) { note = ` The entry was posted, but ${file.name} could not be attached: ${(e as Error).message}`; }
    }
    clear(); setOk(`Entry posted. Voucher ${r.voucherNo}.${note}`); load();
  });
  const reverse = (id: number) => run(async () => { await api(`/orgs/${org.id}/journal/${id}/reverse`, { body: { date: today, reason } }); setOk('Reversal posted.'); load(); });
  const bulkDelete = () => run(async () => {
    const ids = [...selected]; if (!ids.length) return;
    if (!await ask(`Delete ${ids.length} entr${ids.length === 1 ? 'y' : 'ies'}? Posted entries cannot be erased from the books, so each is cancelled by a reversing entry. Entries that belong to an invoice, bill or payment are skipped.`)) return;
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
          <div className="grid gap-3 md:grid-cols-4">
            <Field label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            <div><Field label="Voucher number" aria-label="Voucher number" value={voucherTouched ? voucher : nextVoucher} placeholder="Automatic" disabled={rule.on}
              onChange={(e) => { setVoucherTouched(true); setVoucher(e.target.value); }} />
              <p className="mt-1 text-xs text-slate-500">{rule.on ? 'Each posted entry gets the next number' : voucherTouched ? 'Your number' : 'Next in the series; type over it to change'}</p></div>
            <Field label="Reference number (optional)" aria-label="Reference number" placeholder="e.g. bank ref, agreement no." value={reference} onChange={(e) => setReference(e.target.value)} />
            <Field label="Narration" value={narration} onChange={(e) => setNarration(e.target.value)} />
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
                  <td className="pr-2"><AccountCombo orgId={org.id} ariaLabel={`Account ${i + 1}`} accounts={accounts} value={r.accountId} onChange={(id) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, accountId: id } : x)))} /></td>
                  <td className="pr-2"><input aria-label={`Debit ${i + 1}`} className="w-full rounded border border-slate-300 px-2 py-1 text-right" inputMode="decimal" value={r.debit}
                    onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, debit: e.target.value, credit: e.target.value ? '' : x.credit } : x)))} /></td>
                  <td className="pr-2"><input aria-label={`Credit ${i + 1}`} className="w-full rounded border border-slate-300 px-2 py-1 text-right" inputMode="decimal" value={r.credit}
                    onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, credit: e.target.value, debit: e.target.value ? '' : x.debit } : x)))} /></td>
                  {centres.length > 0 && <td><select aria-label={`Cost centre ${i + 1}`} className="w-full rounded border border-slate-300 px-2 py-1" value={r.cc} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, cc: e.target.value } : x)))}>
                    <option value="">—</option>{centres.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select></td>}
                  <td className="w-8">{rows.length > 2 && <button type="button" aria-label={`Remove line ${i + 1}`} className="text-slate-400 hover:text-red-600" onClick={() => setRows(rows.filter((_, j) => j !== i))}>✕</button>}</td>
                </tr>
              ))}
              <tr><td colSpan={centres.length > 0 ? 5 : 4} className="pt-1">
                <button type="button" className="text-sm text-brand-700 underline" onClick={() => setRows([...rows, { accountId: '', debit: '', credit: '', cc: rows.length && rows.every((x) => x.cc === rows[0].cc) ? rows[0].cc : '' }])}>+ Add line</button></td></tr>
            </tbody>

            <tfoot><tr className="font-medium"><td className="py-2 text-right">Totals {totalD === totalC && totalD > 0 ? '✓ balanced' : totalD !== totalC ? `· difference ${fmt(Math.abs(totalD - totalC))}` : ''}</td><td className="text-right">{fmt(totalD)}</td><td className="text-right">{fmt(totalC)}</td>{centres.length > 0 && <td />}<td /></tr></tfoot>
          </table>
          <div className="mt-3 grid gap-4 md:grid-cols-2">
            <div className="text-sm"><span className="mb-1 block font-medium text-slate-600">Attachments (policy, bill, working)</span>
              <label className={`inline-flex items-center gap-2 rounded-md border-2 border-dashed px-4 py-2 font-medium ${rule.on ? 'cursor-not-allowed border-slate-200 text-slate-400' : 'cursor-pointer border-brand-300 bg-brand-50/50 text-brand-700 hover:border-brand-500 hover:bg-brand-50'}`}>
                <Icon name="plus" className={rule.on ? 'text-slate-400' : 'text-brand-600'} />Upload documents
                <input aria-label="Attach documents" type="file" multiple disabled={rule.on} className="sr-only" onChange={(e) => { setFiles([...files, ...Array.from(e.target.files ?? [])]); e.target.value = ''; }} /></label>
              <ul className="mt-1 text-xs text-slate-600">{files.map((x, i) => <li key={i}>{x.name} <button className="text-red-700" onClick={() => setFiles(files.filter((_, j) => j !== i))}>remove</button></li>)}</ul></div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
              <label className="flex items-center gap-2 font-medium"><input type="checkbox" aria-label="Repeat automatically" checked={rule.on} onChange={(e) => setRule({ ...rule, on: e.target.checked })} />Post this entry automatically on a schedule (a rule)</label>
              {rule.on && (
                <div className="mt-2 grid gap-3 md:grid-cols-3">
                  <Field label="Rule name" placeholder="e.g. Insurance write-off" value={rule.name} onChange={(e) => setRule({ ...rule, name: e.target.value })} />
                  <Select label="Repeat" aria-label="Rule frequency" value={rule.frequency} onChange={(e) => setRule({ ...rule, frequency: e.target.value })}>{FREQ.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
                  <Field label="Stop after (optional)" type="date" value={rule.endDate} onChange={(e) => setRule({ ...rule, endDate: e.target.value })} />
                  <p className="col-span-full text-xs text-slate-500">The first entry is dated as the date above (a past date posts the runs already due), then it repeats. In the narration, {'{month}'}, {'{date}'}, {'{period}'}, {'{quarter}'} and {'{fy}'} are filled in on each run: "Being insurance for {'{month}'}" reads "Being insurance for Nov-26".</p>
                </div>)}
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {!mustReview && <Button onClick={submit} disabled={busy || !accounts.length}>{rule.on ? (editingRule ? 'Save changes to rule' : 'Save rule') : 'Post entry'}</Button>}
            {editingRule && <Button variant="ghost" onClick={clear}>Cancel editing the rule</Button>}
            {staff && !rule.on && <Button variant={mustReview ? 'primary' : 'ghost'} onClick={sendForReview} disabled={busy || !accounts.length}>Send for review</Button>}
            {!accounts.length && <p className="text-xs text-slate-500">Loading accounts…</p>}
            {mustReview && <p className="text-xs text-slate-500">Your organisation asks an accountant to review journals before they are posted.</p>}
          </div>
          <div className="mt-3 space-y-2"><ErrorMsg msg={error} /><Ok msg={ok} /></div>
        </Card>
      )}

      <Card title="Journal rules" actions={<label className="flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={showArchivedRules} onChange={(e) => setShowArchivedRules(e.target.checked)} />Show archived</label>}>
        {rules.filter((r) => showArchivedRules || !r.isArchived).length === 0 ? <Empty text="No rules yet. Tick “Post this entry automatically” above to make one." /> : (
          <table className="w-full text-sm"><thead><tr className="text-left text-slate-500"><th>Rule</th><th>Repeats</th><th>Next entry</th><th>Ends</th><th>Posted</th><th>Status</th><th /></tr></thead>
            <tbody>{rules.filter((r) => showArchivedRules || !r.isArchived).map((r) => (
              <tr key={r.id} className="border-t border-slate-100"><td className="py-2"><b>{r.name}</b><span className="block text-xs text-slate-500">{r.narration}: {r.lines.map((l) => `${l.debit ? 'Dr' : 'Cr'} ${name(l.accountId)} ${fmt(l.debit || l.credit)}`).join(' · ')}</span></td>
                <td>{r.frequency}</td><td>{r.active ? r.nextDate : '—'}</td><td>{r.endDate ?? '—'}</td><td>{r.runs}{r.lastRun ? ` (last ${r.lastRun})` : ''}</td><td><Badge text={r.isArchived ? 'archived' : r.active ? 'active' : 'done'} /></td>
                <td className="whitespace-nowrap text-right">{canPost && <RowMenu label={`Actions for rule ${r.name}`} actions={[
                  { label: 'Edit', icon: 'edit', onClick: () => editRule(r), hidden: !!r.isArchived },
                  { label: 'Stop', icon: 'lock', onClick: () => run(async () => { await api(`/orgs/${org.id}/journal-rules/${r.id}/stop`, { body: {} }); loadRules(); }), hidden: !r.active },
                  { label: r.isArchived ? 'Restore' : 'Archive', icon: r.isArchived ? 'restore' : 'archive', onClick: () => archiveRule(r) },
                  { label: 'Delete', icon: 'trash', onClick: () => deleteRule(r), danger: true },
                ]} />}</td></tr>))}</tbody></table>
        )}
        {canPost && rules.some((r) => r.active) && <div className="mt-3"><Button variant="ghost" disabled={busy} onClick={() => run(async () => { const r = await api(`/orgs/${org.id}/journal-rules/run`, { body: {} }); setOk(`${r.created} entr${r.created === 1 ? 'y' : 'ies'} posted.`); load(); loadRules(); })}>Post anything due now</Button></div>}
      </Card>

      <Card title="Posted entries">
        {canPost && <div className="mb-3 flex flex-wrap items-end gap-3"><div className="max-w-sm"><Field label="Reason used when reversing an entry" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
          {selected.size > 0 && <Button variant="danger" disabled={busy} onClick={bulkDelete}>Delete {selected.size} selected</Button>}</div>}
        {focus && <div className="mb-3"><Callout tone="info">Showing the entry opened from the ledger. <button type="button" className="font-medium underline" onClick={() => setFocus(undefined)}>Show all entries</button></Callout></div>}
        <DataTable id="journal" rows={focus ? entries.filter((e) => e.id === focus || e.reversesId === focus) : entries} rowKey={(e) => e.id} orgId={org.id} exportTitle="Journal entries" searchLabel="Search journal entries (voucher, reference, text, account)" empty="Nothing posted yet."
          columns={journalColumns(accounts)}
          leadingHead={canPost && selectable.length > 0 ? <input type="checkbox" aria-label="Select all entries" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(selectable.map((e) => e.id)))} /> : undefined}
          leading={canPost ? (e) => (!e.reversesId ? <input type="checkbox" aria-label={`Select entry ${e.id}`} checked={selected.has(e.id)} onChange={() => toggle(e.id)} /> : null) : undefined}
          trailing={(e) => <RowMenu label={`Actions for entry ${e.voucherNo ?? e.id}`} actions={[
            { label: 'Attached files', icon: 'note', onClick: () => toggleFiles(e.id) },
            { label: 'Reverse', icon: 'restore', onClick: () => { setError(''); reverse(e.id); }, hidden: !canPost || !!e.reversesId || !!e.reversed },
          ]} />} />
        {Object.entries(open).filter(([, v]) => v).map(([id, v]) => (
          <div key={id} className="mt-2 text-xs text-slate-600"><b>Files on entry #{id}:</b> {v!.length === 0 ? 'none attached.' : v!.map((a) => <button key={a.id} className="mr-3 underline" onClick={() => run(() => download(`/orgs/${org.id}/files/${a.id}/download`, a.name))}>{a.name}</button>)}
            <button className="ml-2 text-slate-400" onClick={() => setOpen({ ...open, [id]: undefined })}>✕</button></div>))}
      </Card>
    </>
  );
}

/** Columns of the posted entries list. */
function journalColumns(accounts: Account[]): Column<Entry>[] {
  const name = (id: number) => { const a = accounts.find((x) => x.id === id); return a ? `${a.code} ${a.name}` : `#${id}`; };
  const amount = (e: Entry) => e.lines.reduce((s, l) => s + l.debit, 0);
  return [
    { key: 'voucher', label: 'Voucher', value: (e) => e.voucherNo ?? `#${e.id}`, render: (e) => <b>{e.voucherNo ?? `#${e.id}`}</b> },
    { key: 'date', label: 'Date', value: (e) => e.date },
    { key: 'reference', label: 'Reference', value: (e) => e.reference ?? null },
    { key: 'narration', label: 'Narration', value: (e) => e.narration, render: (e) => <span>{e.narration}{e.reversesId && <em className="ml-2 text-amber-700">(reversal of #{e.reversesId})</em>}{e.reversed && <span className="ml-2"><Badge text="reversed" /></span>}</span> },
    { key: 'lines', label: 'Accounts', value: (e) => e.lines.map((l) => `${l.debit ? 'Dr' : 'Cr'} ${name(l.accountId)} ${fmt(l.debit || l.credit)}`).join('; '),
      render: (e) => <ul className="text-xs text-slate-600">{e.lines.map((l, i) => <li key={i}>{l.debit ? 'Dr' : 'Cr'} {name(l.accountId)} · {fmt(l.debit || l.credit)}</li>)}</ul> },
    { key: 'amount', label: 'Amount', value: amount, money: true, noSearch: true },
    { key: 'by', label: 'Entered by', value: (e) => e.createdBy ?? null, hidden: true },
  ];
}
