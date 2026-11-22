// Chart of accounts: Financial Statement Line Item -> Group -> Sub-group -> Ledger, with the next ledger number
// suggested from the group's range, new groups and sub-groups, edit, archive, delete, export and two views.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { Org } from '../App';
import { Badge, Select } from '../kit';
import { DataTable, ExportMenu, Icon, RowMenu, type Column } from '../table';
import { Button, Callout, Card, ErrorMsg, Field, Ok, useAction } from '../ui';
import type { Account } from './Lines';

interface Ledger extends Account { fsli: string; group: string; subGroup: string | null; isActive: boolean; itcBlocked: boolean; system: boolean }
interface Range { name: string; from: number | null; to: number | null; custom: boolean }
interface Fsli { key: string; name: string; type: string; from: number; to: number; groups: (Range & { sub: Range[] })[] }

const NEW = '__new__';
const blank = { fsli: 'ie', group: '', subGroup: '', name: '', code: '', itcBlocked: false };

export function ChartOfAccounts({ org, canManage, reload }: { org: Org; canManage: boolean; reload: () => void }) {
  const [list, setList] = useState<Ledger[]>([]);
  const [tree, setTree] = useState<Fsli[]>([]);
  const [view, setView] = useState<'tree' | 'list'>(() => { try { return (localStorage.getItem('coa-view') as 'tree' | 'list') || 'tree'; } catch { return 'tree'; } });
  const [showArchived, setShowArchived] = useState(false);
  const [f, setF] = useState(blank);
  const [codeTouched, setCodeTouched] = useState(false);
  const [range, setRange] = useState('');
  const [newGroup, setNewGroup] = useState<{ level: 'group' | 'sub'; name: string; from: string; to: string } | null>(null);
  const [editing, setEditing] = useState<Ledger | null>(null);
  const [ok, setOk] = useState('');
  const { error, busy, run, setError } = useAction();
  const load = useCallback(async () => {
    const [a, s] = await Promise.all([api<Ledger[]>(`/orgs/${org.id}/accounts`), api<Fsli[]>(`/orgs/${org.id}/account-structure`)]);
    setList(a); setTree(s);
  }, [org.id]);
  useEffect(() => { load(); }, [load]);
  const changeView = (v: 'tree' | 'list') => { setView(v); try { localStorage.setItem('coa-view', v); } catch { /* storage may be off */ } };

  const fsli = tree.find((x) => x.key === f.fsli);
  const groups = fsli?.groups ?? [];
  const group = groups.find((g) => g.name === f.group);
  // Suggest the next free number whenever the group or sub-group changes.
  useEffect(() => {
    if (!f.fsli || codeTouched) return;
    const q = new URLSearchParams({ fsli: f.fsli, ...(f.group ? { group: f.group } : {}), ...(f.subGroup ? { subGroup: f.subGroup } : {}) });
    api(`/orgs/${org.id}/accounts-next-code?${q}`).then((r) => { setF((x) => ({ ...x, code: r.code ?? '' })); setRange(`${r.from}–${r.to}`); }).catch(() => undefined);
  }, [org.id, f.fsli, f.group, f.subGroup, codeTouched, list.length]);

  const add = () => run(async () => {
    if (!f.group) throw new Error('Choose the group (or create one).');
    if (!f.name.trim()) throw new Error('Enter the ledger name.');
    const r = await api(`/orgs/${org.id}/accounts`, { body: { fsli: f.fsli, group: f.group, ...(f.subGroup ? { subGroup: f.subGroup } : {}), name: f.name.trim(), ...(f.code.trim() ? { code: f.code.trim() } : {}), ...(f.itcBlocked ? { itcBlocked: true } : {}) } });
    setOk(`Ledger ${r.code} · ${f.name.trim()} added under ${f.group}${f.subGroup ? ` › ${f.subGroup}` : ''}.`);
    setF({ ...f, name: '', code: '', itcBlocked: false }); setCodeTouched(false); await load(); reload();
  });
  const saveGroup = () => run(async () => {
    if (!newGroup?.name.trim()) throw new Error('Enter a name for the new group.');
    const from = newGroup.from.trim() ? Number(newGroup.from) : undefined, to = newGroup.to.trim() ? Number(newGroup.to) : undefined;
    await api(`/orgs/${org.id}/account-groups`, { body: { fsli: f.fsli, name: newGroup.name.trim(), ...(newGroup.level === 'sub' ? { parent: f.group } : {}), ...(from != null ? { codeFrom: from } : {}), ...(to != null ? { codeTo: to } : {}) } });
    await load();
    setF((x) => (newGroup.level === 'group' ? { ...x, group: newGroup.name.trim(), subGroup: '' } : { ...x, subGroup: newGroup.name.trim() }));
    setOk(`${newGroup.level === 'group' ? 'Group' : 'Sub-group'} "${newGroup.name.trim()}" created.`); setNewGroup(null);
  });
  const archive = (a: Ledger) => run(async () => { await api(`/orgs/${org.id}/accounts/${a.id}/archive`, { body: { archived: a.isActive } }); setOk(`${a.code} ${a.name} ${a.isActive ? 'archived' : 'restored'}.`); await load(); reload(); });
  const remove = (a: Ledger) => run(async () => {
    if (!window.confirm(`Delete ledger ${a.code} ${a.name}? Only a ledger with no entries can be deleted; otherwise archive it.`)) return;
    await api(`/orgs/${org.id}/accounts/${a.id}`, { method: 'DELETE' }); setOk(`${a.code} ${a.name} deleted.`); await load(); reload();
  });
  const block = (a: Ledger, v: boolean) => run(async () => { await api(`/orgs/${org.id}/accounts/${a.id}/itc-blocked`, { method: 'PUT', body: { blocked: v } }); await load(); reload(); });

  const fsliName = (k: string) => tree.find((x) => x.key === k)?.name ?? k;
  const shown = list.filter((a) => showArchived || a.isActive);
  const columns: Column<Ledger>[] = [
    { key: 'code', label: 'Code', value: (a) => a.code },
    { key: 'name', label: 'Ledger', value: (a) => a.name, render: (a) => <span className="font-medium">{a.name}{a.itcBlocked && <span className="ml-1 rounded bg-amber-50 px-1 text-[11px] text-amber-700">no ITC</span>}{!a.isActive && <span className="ml-1 text-xs text-slate-400">archived</span>}</span> },
    { key: 'fsli', label: 'Statement line', value: (a) => fsliName(a.fsli) },
    { key: 'group', label: 'Group', value: (a) => a.group },
    { key: 'sub', label: 'Sub-group', value: (a) => a.subGroup },
    { key: 'type', label: 'Type', value: (a) => a.type, hidden: true },
    { key: 'itc', label: '17(5) blocked', value: (a) => (a.itcBlocked ? 'Yes' : ''), hidden: true },
    { key: 'status', label: 'Status', value: (a) => (a.isActive ? 'Active' : 'Archived'), hidden: true },
  ];
  const actions = (a: Ledger) => (
    <span className="inline-flex items-center gap-2">
      {canManage && (a.type === 'expense' || a.type === 'asset') && <label className="flex items-center gap-1 text-[11px] text-slate-500" title="Section 17(5): GST on bills coded here is added to the cost, not claimed">
        <input type="checkbox" aria-label={`Blocked credit ${a.code}`} checked={!!a.itcBlocked} onChange={(e) => block(a, e.target.checked)} />17(5)</label>}
      {canManage && <RowMenu label={`Actions for ${a.code} ${a.name}`} actions={[
        { label: 'Edit', icon: 'edit', onClick: () => { setEditing(a); setError(''); } },
        { label: a.isActive ? 'Archive' : 'Restore', icon: a.isActive ? 'archive' : 'restore', onClick: () => archive(a), hidden: a.system && a.isActive },
        { label: 'Delete', icon: 'trash', onClick: () => remove(a), hidden: a.system, danger: true },
      ]} />}
    </span>);

  return (
    <>
      <div className="mb-3 space-y-2"><ErrorMsg msg={error} /><Ok msg={ok} /></div>
      {canManage && (
        <Card title="New ledger">
          <div className="grid gap-3 md:grid-cols-3">
            <Select label="Financial statement line item" aria-label="Statement line" value={f.fsli} onChange={(e) => { setF({ ...f, fsli: e.target.value, group: '', subGroup: '' }); setCodeTouched(false); setNewGroup(null); }}>
              {tree.map((x) => <option key={x.key} value={x.key}>{x.name}</option>)}</Select>
            <Select label="Group" aria-label="Group" value={f.group} onChange={(e) => { if (e.target.value === NEW) { setNewGroup({ level: 'group', name: '', from: '', to: '' }); return; } setF({ ...f, group: e.target.value, subGroup: '' }); setCodeTouched(false); }}>
              <option value="">Choose a group…</option>{groups.map((g) => <option key={g.name} value={g.name}>{g.name}{g.from != null ? ` (${g.from}–${g.to})` : ''}</option>)}
              <option value={NEW}>＋ New group…</option></Select>
            <Select label="Sub-group (optional)" aria-label="Sub-group" value={f.subGroup} disabled={!f.group} onChange={(e) => { if (e.target.value === NEW) { setNewGroup({ level: 'sub', name: '', from: '', to: '' }); return; } setF({ ...f, subGroup: e.target.value }); setCodeTouched(false); }}>
              <option value="">None</option>{(group?.sub ?? []).map((s) => <option key={s.name} value={s.name}>{s.name}{s.from != null ? ` (${s.from}–${s.to})` : ''}</option>)}
              {f.group && <option value={NEW}>＋ New sub-group…</option>}</Select>
          </div>
          {newGroup && (
            <div className="mt-3 rounded-lg border border-brand-200 bg-brand-50/40 p-3">
              <p className="mb-2 text-sm font-semibold">{newGroup.level === 'group' ? `New group under ${fsli?.name}` : `New sub-group under ${f.group}`}</p>
              <div className="grid gap-3 md:grid-cols-4">
                <Field label="Name" aria-label="New group name" value={newGroup.name} onChange={(e) => setNewGroup({ ...newGroup, name: e.target.value })} />
                <Field label="Numbers from (optional)" aria-label="Range from" inputMode="numeric" value={newGroup.from} onChange={(e) => setNewGroup({ ...newGroup, from: e.target.value.replace(/\D/g, '') })} />
                <Field label="Numbers to (optional)" aria-label="Range to" inputMode="numeric" value={newGroup.to} onChange={(e) => setNewGroup({ ...newGroup, to: e.target.value.replace(/\D/g, '') })} />
                <div className="flex items-end gap-2"><Button disabled={busy} onClick={saveGroup}>Create</Button><Button variant="ghost" onClick={() => setNewGroup(null)}>Cancel</Button></div>
              </div>
              <p className="mt-2 text-xs text-slate-500">A number range lets the next ledger number be suggested for this {newGroup.level === 'group' ? 'group' : 'sub-group'} (for example 5800–5899).</p>
            </div>)}
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            <Field label="Ledger name" aria-label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            <div><Field label="Account number" aria-label="Code" value={f.code} onChange={(e) => { setCodeTouched(true); setF({ ...f, code: e.target.value }); }} />
              <p className="mt-1 text-xs text-slate-500">{codeTouched ? 'Your number' : `Next free number${range ? ` in ${range}` : ''}; type over it to change`}</p></div>
            {(fsli?.type === 'expense' || fsli?.type === 'asset') && <label className="flex items-center gap-2 self-center text-sm"><input type="checkbox" checked={f.itcBlocked} onChange={(e) => setF({ ...f, itcBlocked: e.target.checked })} />ITC blocked (section 17(5))</label>}
          </div>
          <div className="mt-3"><Button disabled={busy} onClick={add}>Add ledger</Button></div>
        </Card>)}

      {editing && <EditLedger org={org} ledger={editing} tree={tree} onClose={() => setEditing(null)} onSaved={async (m) => { setEditing(null); setOk(m); await load(); reload(); }} />}
      {canManage && <Callout tone="info">Tick <b>17(5)</b> on an expense account (motor car, food, club fees, personal use…) and the GST on bills coded to it is added to the cost, not claimed as input credit. Accounts the software posts to (GST, TDS, debtors, creditors, stock) cannot be archived or deleted.</Callout>}

      <Card actions={<div className="flex flex-wrap items-center gap-3 text-sm">
        <div role="group" aria-label="View" className="inline-flex overflow-hidden rounded-md border border-slate-300">
          {(['tree', 'list'] as const).map((v) => <button key={v} type="button" aria-pressed={view === v} onClick={() => changeView(v)} className={`px-3 py-1.5 ${view === v ? 'bg-brand-600 text-white' : 'bg-white text-slate-700 hover:bg-slate-50'}`}>{v === 'tree' ? 'By statement line and group' : 'List'}</button>)}</div>
        <label className="flex items-center gap-2 text-slate-600"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />Show archived</label>
        {view === 'tree' && <ExportMenu orgId={org.id} disabled={!shown.length} build={() => ({ title: 'Chart of accounts', subtitle: 'By statement line, group and sub-group',
          columns: ['Code', 'Ledger', 'Statement line', 'Group', 'Sub-group', 'Type', '17(5) blocked', 'Status'].map((h) => ({ header: h })),
          rows: [...shown].sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true })).map((a) => [a.code, a.name, fsliName(a.fsli), a.group, a.subGroup, a.type, a.itcBlocked ? 'Yes' : '', a.isActive ? 'Active' : 'Archived']) })} />}</div>}>
        {view === 'list'
          ? <DataTable id="coa" rows={shown} columns={columns} rowKey={(a) => a.id} orgId={org.id} exportTitle="Chart of accounts" searchLabel="Search by number, name or group" trailing={actions} initialSort={{ key: 'code', dir: 1 }} />
          : <div className="space-y-5" data-testid="coa-tree">{tree.map((x) => {
              const mine = shown.filter((a) => a.fsli === x.key);
              if (!mine.length) return null;
              const byGroup = [...new Set(mine.map((a) => a.group))];
              return (
                <section key={x.key}>
                  <h3 className="mb-1 border-b-2 border-brand-200 pb-1 text-sm font-semibold uppercase tracking-wide text-brand-800">{x.name}</h3>
                  {byGroup.map((g) => {
                    const inG = mine.filter((a) => a.group === g), subs = [...new Set(inG.map((a) => a.subGroup ?? ''))].sort();
                    return (
                      <div key={g} className="ml-2 mt-2">
                        <p className="flex items-center gap-1 text-sm font-semibold text-slate-800"><Icon name="columns" size={14} className="text-slate-400" />{g}</p>
                        {subs.map((s) => (
                          <div key={s} className={s ? 'ml-4 mt-1' : 'ml-4'}>
                            {s && <p className="text-xs font-semibold uppercase text-slate-500">{s}</p>}
                            <ul className="grid gap-x-8 text-sm md:grid-cols-2">{inG.filter((a) => (a.subGroup ?? '') === s).map((a) => (
                              <li key={a.id} className={`flex items-center justify-between gap-2 border-b border-slate-100 py-1 ${a.isActive ? '' : 'text-slate-400'}`}>
                                <span>{a.code} · {a.name}{a.itcBlocked && <span className="ml-1 rounded bg-amber-50 px-1 text-[11px] text-amber-700">no ITC</span>}{!a.isActive && <Badge text="archived" />}</span>
                                {actions(a)}</li>))}</ul>
                          </div>))}
                      </div>);
                  })}
                </section>);
            })}</div>}
      </Card>
    </>
  );
}

function EditLedger({ org, ledger, tree, onClose, onSaved }: { org: Org; ledger: Ledger; tree: Fsli[]; onClose: () => void; onSaved: (m: string) => void }) {
  const [f, setF] = useState({ name: ledger.name, code: ledger.code, fsli: ledger.fsli, group: ledger.group, subGroup: ledger.subGroup ?? '' });
  const { error, busy, run } = useAction();
  const fsli = tree.find((x) => x.key === f.fsli), group = fsli?.groups.find((g) => g.name === f.group);
  const save = () => run(async () => {
    await api(`/orgs/${org.id}/accounts/${ledger.id}`, { method: 'PUT', body: { name: f.name, fsli: f.fsli, group: f.group, subGroup: f.subGroup || null, ...(f.code !== ledger.code ? { code: f.code } : {}) } });
    onSaved(`${f.code} · ${f.name} saved.`);
  });
  return (
    <Card title={`Edit ${ledger.code} · ${ledger.name}`}>
      <div className="grid gap-3 md:grid-cols-5">
        <Field label="Ledger name" aria-label="Edit ledger name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <Field label="Account number" aria-label="Edit account number" value={f.code} disabled={ledger.system} onChange={(e) => setF({ ...f, code: e.target.value })} />
        <Select label="Statement line" aria-label="Edit statement line" value={f.fsli} onChange={(e) => setF({ ...f, fsli: e.target.value, group: '', subGroup: '' })}>{tree.map((x) => <option key={x.key} value={x.key}>{x.name}</option>)}</Select>
        <Select label="Group" aria-label="Edit group" value={f.group} onChange={(e) => setF({ ...f, group: e.target.value, subGroup: '' })}><option value="">Choose…</option>{(fsli?.groups ?? []).map((g) => <option key={g.name} value={g.name}>{g.name}</option>)}</Select>
        <Select label="Sub-group" aria-label="Edit sub-group" value={f.subGroup} onChange={(e) => setF({ ...f, subGroup: e.target.value })}><option value="">None</option>{(group?.sub ?? []).map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}</Select>
      </div>
      <div className="mt-3 flex gap-3"><Button disabled={busy || !f.group} onClick={save}>Save ledger</Button><Button variant="ghost" onClick={onClose}>Cancel</Button></div>
      <div className="mt-2"><ErrorMsg msg={error} /></div>
    </Card>
  );
}
