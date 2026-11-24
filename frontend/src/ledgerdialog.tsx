// "+ Create new ledger" from any account dropdown: a small box with the statement line, group, sub-group, name and the
// next free number, so a missing ledger can be added without leaving the voucher, contact or product being filled in.
import { useEffect, useState } from 'react';
import { api } from './api';
import { ErrorMsg } from './ui';
import type { Account } from './pages/Lines';

interface Range { name: string; sub?: Range[] }
interface Fsli { key: string; name: string; type: string; groups: Range[] }

/** Tell every page that keeps a list of accounts to load it again. */
export const accountsChanged = () => window.dispatchEvent(new Event('accounts-changed'));

const inputCls = 'w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200';

export function NewLedgerDialog({ orgId, name: start = '', type, onDone }: { orgId: number; name?: string; /** asset, liability, equity, income or expense: picks the first matching statement line */ type?: string; onDone: (a: Account | null) => void }) {
  const [tree, setTree] = useState<Fsli[]>([]);
  const [f, setF] = useState({ fsli: '', group: '', subGroup: '', name: start.replace(/^\d+\s*·?\s*/, ''), code: '' });
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => {
    api<Fsli[]>(`/orgs/${orgId}/account-structure`).then((t) => {
      setTree(t);
      const first = t.find((x) => (type ? x.type === type : x.key === 'ie')) ?? t[0];
      if (first) setF((x) => ({ ...x, fsli: first.key, group: first.groups[0]?.name ?? '' }));
    }).catch((e) => setError((e as Error).message));
  }, [orgId, type]);
  const fsli = tree.find((x) => x.key === f.fsli);
  const group = fsli?.groups.find((g) => g.name === f.group);
  useEffect(() => {
    if (!f.fsli || touched) return;
    const q = new URLSearchParams({ fsli: f.fsli, ...(f.group ? { group: f.group } : {}), ...(f.subGroup ? { subGroup: f.subGroup } : {}) });
    api(`/orgs/${orgId}/accounts-next-code?${q}`).then((r) => setF((x) => ({ ...x, code: r.code ?? '' }))).catch(() => undefined);
  }, [orgId, f.fsli, f.group, f.subGroup, touched]);
  const save = async () => {
    setError('');
    if (!f.group) { setError('Choose the group.'); return; }
    if (!f.name.trim()) { setError('Enter the ledger name.'); return; }
    setBusy(true);
    try {
      const r = await api(`/orgs/${orgId}/accounts`, { body: { fsli: f.fsli, group: f.group, ...(f.subGroup ? { subGroup: f.subGroup } : {}), name: f.name.trim(), ...(f.code.trim() ? { code: f.code.trim() } : {}) } });
      accountsChanged();
      onDone({ id: r.id, code: r.code, name: f.name.trim(), type: fsli?.type ?? 'expense', group: f.group });
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-900/40 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onDone(null); }}>
      <div role="dialog" aria-modal="true" aria-label="New ledger" className="w-full max-w-lg rounded-xl border border-brand-100 bg-white p-5 shadow-2xl"
        onKeyDown={(e) => { if (e.key === 'Escape') onDone(null); }}>
        <h2 className="text-base font-semibold text-brand-900">New ledger</h2>
        <p className="mb-3 text-xs text-slate-500">It is added to the chart of accounts and chosen here straight away.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm"><span className="mb-1 block font-medium text-slate-600">Statement line</span>
            <select aria-label="Ledger statement line" className={inputCls} value={f.fsli} onChange={(e) => { const x = tree.find((t) => t.key === e.target.value); setF({ ...f, fsli: e.target.value, group: x?.groups[0]?.name ?? '', subGroup: '' }); setTouched(false); }}>
              {tree.map((x) => <option key={x.key} value={x.key}>{x.name}</option>)}</select></label>
          <label className="block text-sm"><span className="mb-1 block font-medium text-slate-600">Group</span>
            <select aria-label="Ledger group" className={inputCls} value={f.group} onChange={(e) => { setF({ ...f, group: e.target.value, subGroup: '' }); setTouched(false); }}>
              {fsli?.groups.map((g) => <option key={g.name} value={g.name}>{g.name}</option>)}</select></label>
          {!!group?.sub?.length && <label className="block text-sm"><span className="mb-1 block font-medium text-slate-600">Sub-group (optional)</span>
            <select aria-label="Ledger sub-group" className={inputCls} value={f.subGroup} onChange={(e) => { setF({ ...f, subGroup: e.target.value }); setTouched(false); }}>
              <option value="">—</option>{group.sub.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}</select></label>}
          <label className="block text-sm"><span className="mb-1 block font-medium text-slate-600">Ledger name</span>
            <input autoFocus aria-label="New ledger name" className={inputCls} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <label className="block text-sm"><span className="mb-1 block font-medium text-slate-600">Code</span>
            <input aria-label="New ledger code" className={inputCls} value={f.code} onChange={(e) => { setTouched(true); setF({ ...f, code: e.target.value }); }} />
            <span className="text-xs text-slate-500">Next free number in the group; type over it to change.</span></label>
        </div>
        <div className="mt-3"><ErrorMsg msg={error} /></div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={() => onDone(null)} className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
          <button type="button" disabled={busy} onClick={save} className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">{busy ? 'Saving…' : 'Create ledger'}</button>
        </div>
      </div>
    </div>
  );
}

/** Account dropdown with search, a "type to search" hint and "+ Create new ledger" at the bottom. Value is the account id. */
import { Combo } from './combo';
export function AccountCombo({ orgId, accounts, value, onChange, ariaLabel, placeholder = 'Search by account code or name', type, filter, allowNone, noneLabel = '—', className }: {
  orgId: number; accounts: Account[]; value: string; onChange: (id: string) => void; ariaLabel: string; placeholder?: string; type?: string;
  filter?: (a: Account) => boolean; allowNone?: boolean; noneLabel?: string; className?: string;
}) {
  const text = (a: Account) => `${a.code} · ${a.name}`;
  const list = filter ? accounts.filter(filter) : accounts;
  const chosen = accounts.find((a) => String(a.id) === value);
  const [typed, setTyped] = useState(chosen ? text(chosen) : '');
  const [creating, setCreating] = useState<string | null>(null);
  const [made, setMade] = useState<Account | null>(null);
  useEffect(() => { if (chosen) setTyped(text(chosen)); else if (!value) setTyped((t) => (find(t) ? '' : t)); }, [chosen?.id, value]); // eslint-disable-line react-hooks/exhaustive-deps
  const find = (v: string) => { const t = v.trim().toLowerCase(); const all = made ? [...list, made] : list; return all.find((a) => text(a).toLowerCase() === t) ?? all.find((a) => a.code.toLowerCase() === t) ?? all.find((a) => a.name.toLowerCase() === t); };
  const pick = (v: string) => { setTyped(v); const hit = find(v); if (hit) onChange(String(hit.id)); else if (!v.trim() && allowNone) onChange(''); else onChange(''); };
  // The list can arrive after something was typed: match it again when it does.
  useEffect(() => { if (typed && !chosen) { const hit = find(typed); if (hit) onChange(String(hit.id)); } }, [accounts]); // eslint-disable-line react-hooks/exhaustive-deps
  return (<>
    <Combo ariaLabel={ariaLabel} value={typed} onText={pick} placeholder={allowNone && !typed ? noneLabel : placeholder} searchFirst={list.length > 12}
      hint="Type an account code or name to search…" className={className}
      options={list.map((a) => ({ text: text(a), lead: a.code, label: a.name, sub: a.group, keywords: a.type }))}
      invalid={!!typed.trim() && !chosen} onBlur={() => { if (chosen) setTyped(text(chosen)); }}
      onCreate={(t) => setCreating(t)} createLabel="Create new ledger" />
    {creating != null && <NewLedgerDialog orgId={orgId} name={creating} type={type} onDone={(a) => { setCreating(null); if (a) { setMade(a); setTyped(text(a)); onChange(String(a.id)); } }} />}
  </>);
}
