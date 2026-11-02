import { useCallback, useEffect, useState } from 'react';
import { api, fmt } from '../api';
import type { Org } from '../App';
import { Badge, Empty, PageHeader, Select } from '../kit';
import { Button, Card, ErrorMsg, Field, useAction } from '../ui';

export interface Contact { id: number; kind: string; name: string; gstin: string | null; pan: string | null; stateCode: string | null; email?: string | null }
interface Statement { contact: { name: string }; openingBalance: number; closingBalance: number; lines: { date: string; ref: string; type: string; amount: number; balance: number }[] }

/** Customers or suppliers (or both). Each row can open a running-balance statement. */
export function Contacts({ org, canPost, only }: { org: Org; canPost: boolean; only?: 'customer' | 'supplier' }) {
  const [list, setList] = useState<Contact[]>([]);
  const [states, setStates] = useState<{ code: string; name: string }[]>([]);
  const [show, setShow] = useState(false);
  const [stmt, setStmt] = useState<Statement | null>(null);
  const [f, setF] = useState({ kind: only ?? 'customer', name: '', gstin: '', pan: '', stateCode: '', email: '', isIndividual: false });
  const { error, busy, run } = useAction();
  const load = useCallback(() => api<Contact[]>(`/orgs/${org.id}/contacts`).then(setList), [org.id]);
  useEffect(() => { load(); api('/config/states').then(setStates); }, [load]);

  const shown = list.filter((c) => !only || c.kind === only || c.kind === 'both');
  const add = () => run(async () => {
    await api(`/orgs/${org.id}/contacts`, { body: { kind: f.kind, name: f.name, isIndividual: f.isIndividual,
      ...(f.gstin ? { gstin: f.gstin.toUpperCase() } : {}), ...(f.pan ? { pan: f.pan.toUpperCase() } : {}), ...(f.stateCode ? { stateCode: f.stateCode } : {}), ...(f.email ? { email: f.email } : {}) } });
    setF({ ...f, name: '', gstin: '', pan: '', email: '' }); setShow(false); load();
  });
  const openStatement = (c: Contact) => run(async () => setStmt(await api(`/orgs/${org.id}/contacts/${c.id}/statement`)));
  const label = only === 'customer' ? 'Customers' : only === 'supplier' ? 'Suppliers' : 'Contacts';

  return (
    <>
      <PageHeader title={label} subtitle="GSTIN sets the state for GST. A PAN is needed for the normal TDS rate." actions={canPost && <Button onClick={() => setShow(!show)}>{show ? 'Close' : `New ${only ?? 'contact'}`}</Button>} />
      <div className="mb-3"><ErrorMsg msg={error} /></div>
      {show && canPost && (
        <Card title={`Add ${only ?? 'customer or supplier'}`}>
          <div className="grid gap-3 md:grid-cols-3">
            {!only && <Select label="Type" aria-label="Contact type" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as any })}><option value="customer">Customer</option><option value="supplier">Supplier</option><option value="both">Both</option></Select>}
            <Field label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            <Field label="GSTIN" value={f.gstin} onChange={(e) => setF({ ...f, gstin: e.target.value })} />
            <Field label="PAN" value={f.pan} onChange={(e) => setF({ ...f, pan: e.target.value })} />
            <Select label="State (if no GSTIN)" aria-label="State" value={f.stateCode} onChange={(e) => setF({ ...f, stateCode: e.target.value })}><option value="">—</option>{states.map((s) => <option key={s.code} value={s.code}>{s.code} {s.name}</option>)}</Select>
            <Field label="Email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.isIndividual} onChange={(e) => setF({ ...f, isIndividual: e.target.checked })} /> Individual / HUF (lower TDS rate)</label>
          </div>
          <div className="mt-3"><Button disabled={busy} onClick={add}>Add contact</Button></div>
        </Card>
      )}
      <Card>
        {shown.length === 0 ? <Empty text={`No ${label.toLowerCase()} yet.`} /> : (
          <table className="w-full text-sm"><thead><tr className="text-left text-slate-500"><th>Name</th><th>Type</th><th>GSTIN</th><th>PAN</th><th>State</th><th /></tr></thead>
            <tbody>{shown.map((c) => (
              <tr key={c.id} className="border-t border-slate-100"><td className="py-2 font-medium">{c.name}</td><td><Badge text={c.kind} /></td><td>{c.gstin ?? '—'}</td><td>{c.pan ?? '—'}</td><td>{c.stateCode ?? '—'}</td>
                <td className="text-right"><Button variant="ghost" onClick={() => openStatement(c)}>Statement</Button></td></tr>))}</tbody></table>
        )}
      </Card>
      {stmt && (
        <Card title={`Statement: ${stmt.contact.name}`} actions={<Button variant="ghost" onClick={() => setStmt(null)}>Close</Button>}>
          <table className="w-full text-sm" data-testid="statement"><thead><tr className="text-left text-slate-500"><th>Date</th><th>Reference</th><th className="text-right">Amount</th><th className="text-right">Balance</th></tr></thead>
            <tbody>{stmt.openingBalance !== 0 && <tr><td /><td>Opening balance</td><td /><td className="text-right">{fmt(stmt.openingBalance)}</td></tr>}
              {stmt.lines.map((l, i) => <tr key={i} className="border-t border-slate-100"><td>{l.date}</td><td>{l.ref}</td><td className="text-right">{fmt(l.amount)}</td><td className="text-right">{fmt(l.balance)}</td></tr>)}
              <tr className="border-t-2 font-semibold"><td /><td>Balance</td><td /><td className="text-right" data-testid="statement-closing">{fmt(stmt.closingBalance)}</td></tr></tbody></table>
        </Card>
      )}
    </>
  );
}
