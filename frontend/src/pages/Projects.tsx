// Projects: time and costs against a customer job, progress against the estimate, and invoicing of what is unbilled.
import { useCallback, useEffect, useState } from 'react';
import { api, fmt, toPaise, today } from '../api';
import type { Org } from '../App';
import { Badge, Empty, PageHeader, Select } from '../kit';
import { Button, Card, ErrorMsg, Field, Ok, useAction } from '../ui';
import type { Contact } from './Contacts';
import type { Account } from './Lines';

interface Summary { id: number; name: string; contactName: string; estimate: number; deadline: string | null; status: string; minutes: number; timeValue: number; costs: number; invoiced: number; toInvoice: number; profit: number; estimateUsedPct: number | null }
interface Detail extends Summary {
  timeEntries: { id: number; date: string; description: string; minutes: number; rate: number; value: number; who: string; invoice: string | null }[];
  costEntries: { id: number; date: string; description: string; amount: number; chargeable: boolean; invoice: string | null }[];
}
const hm = (m: number) => `${Math.floor(m / 60)}h ${m % 60}m`;

export function Projects({ org, canPost, accounts }: { org: Org; canPost: boolean; accounts: Account[] }) {
  const [list, setList] = useState<Summary[]>([]);
  const [customers, setCustomers] = useState<Contact[]>([]);
  const [open, setOpen] = useState<Detail | null>(null);
  const [show, setShow] = useState(false);
  const [f, setF] = useState({ name: '', contactId: '', estimate: '', deadline: '' });
  const [tf, setTf] = useState({ date: today(), description: '', hours: '', rate: '' });
  const [cf, setCf] = useState({ date: today(), description: '', amount: '', chargeable: true });
  const [inv, setInv] = useState({ gstRateBp: '1800', accountId: '' });
  const [rates, setRates] = useState<{ rateBp: number; label: string }[]>([]);
  const [ok, setOk] = useState('');
  const { error, busy, run } = useAction();
  const load = useCallback(() => api<Summary[]>(`/orgs/${org.id}/projects`).then(setList), [org.id]);
  const openProject = (id: number) => api<Detail>(`/orgs/${org.id}/projects/${id}`).then(setOpen);
  useEffect(() => {
    load(); api('/config/gst-rates').then(setRates);
    api<Contact[]>(`/orgs/${org.id}/contacts`).then((c) => setCustomers(c.filter((x) => x.kind !== 'supplier')));
  }, [load, org.id]);
  const refresh = async () => { await load(); if (open) await openProject(open.id); };
  const minutes = () => { const h = Number(tf.hours); if (!(h > 0)) throw new Error('Enter hours worked, e.g. 1.5'); return Math.round(h * 60); };

  return (
    <>
      <PageHeader title="Projects" subtitle="Track time and costs for a customer job, see how much of the estimate is used, then invoice the unbilled work."
        actions={canPost && <Button onClick={() => setShow(!show)}>{show ? 'Close' : 'New project'}</Button>} />
      <div className="mb-3 space-y-2"><ErrorMsg msg={error} /><Ok msg={ok} /></div>
      {show && canPost && (
        <Card title="New project">
          <div className="grid gap-3 md:grid-cols-4">
            <Field label="Project name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            <Select label="Customer" aria-label="Project customer" value={f.contactId} onChange={(e) => setF({ ...f, contactId: e.target.value })}><option value="">Select…</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
            <Field label="Estimate (₹)" inputMode="decimal" value={f.estimate} onChange={(e) => setF({ ...f, estimate: e.target.value })} />
            <Field label="Deadline" type="date" value={f.deadline} onChange={(e) => setF({ ...f, deadline: e.target.value })} />
          </div>
          <div className="mt-3"><Button disabled={busy} onClick={() => run(async () => {
            const r = await api(`/orgs/${org.id}/projects`, { body: { name: f.name, contactId: Number(f.contactId), estimate: f.estimate ? toPaise(f.estimate) : 0, ...(f.deadline ? { deadline: f.deadline } : {}) } });
            setF({ name: '', contactId: '', estimate: '', deadline: '' }); setShow(false); await load(); await openProject(r.id);
          })}>Create project</Button></div>
        </Card>
      )}
      <Card>
        {list.length === 0 ? <Empty text="No projects yet." /> : (
          <table className="w-full text-sm"><thead><tr className="text-left"><th>Project</th><th>Customer</th><th>Status</th><th className="text-right">Time</th><th className="text-right">Estimate used</th><th className="text-right">To invoice</th><th className="text-right">Invoiced</th><th /></tr></thead>
            <tbody>{list.map((p) => (
              <tr key={p.id}><td className="font-medium">{p.name}</td><td>{p.contactName}</td><td><Badge text={p.status === 'closed' ? 'closed' : 'in progress'} /></td>
                <td className="text-right">{hm(p.minutes)}</td><td className="text-right">{p.estimateUsedPct == null ? '—' : `${p.estimateUsedPct}%`}</td>
                <td className="text-right">{fmt(p.toInvoice)}</td><td className="text-right">{fmt(p.invoiced)}</td>
                <td className="text-right"><Button variant="ghost" onClick={() => run(() => openProject(p.id))}>Open</Button></td></tr>))}</tbody></table>
        )}
      </Card>

      {open && (
        <Card title={`${open.name} · ${open.contactName}`} actions={<div className="flex gap-2">
          {canPost && <Button variant="ghost" onClick={() => run(async () => { await api(`/orgs/${org.id}/projects/${open.id}/status`, { body: { status: open.status === 'closed' ? 'in_progress' : 'closed' } }); await refresh(); })}>{open.status === 'closed' ? 'Reopen' : 'Close project'}</Button>}
          <Button variant="ghost" onClick={() => setOpen(null)}>Hide</Button></div>}>
          <div className="grid gap-3 text-sm md:grid-cols-5">
            {[['Estimate', `₹${fmt(open.estimate)}`], ['Time worked', `${hm(open.minutes)} · ₹${fmt(open.timeValue)}`], ['Costs', `₹${fmt(open.costs)}`], ['Invoiced (before GST)', `₹${fmt(open.invoiced)}`], ['Profit so far', `₹${fmt(open.profit)}`]].map(([k, v]) => (
              <div key={k} className="rounded bg-slate-50 p-3"><p className="text-slate-500">{k}</p><p className="font-semibold" data-testid={`project-${k.split(' ')[0].toLowerCase()}`}>{v}</p></div>))}
          </div>
          {open.estimate > 0 && <div className="mt-3 h-2 w-full overflow-hidden rounded bg-slate-200" title={`${open.estimateUsedPct}% of the estimate used`}><div className={`h-full ${(open.estimateUsedPct ?? 0) > 100 ? 'bg-red-500' : 'bg-brand-500'}`} style={{ width: `${Math.min(100, open.estimateUsedPct ?? 0)}%` }} /></div>}

          {canPost && open.status !== 'closed' && (
            <div className="mt-5 grid gap-4 md:grid-cols-2">
              <div className="rounded border border-slate-200 p-3">
                <p className="mb-2 font-medium">Add time</p>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Date" type="date" aria-label="Time date" value={tf.date} onChange={(e) => setTf({ ...tf, date: e.target.value })} />
                  <Field label="Hours" aria-label="Hours" inputMode="decimal" placeholder="1.5" value={tf.hours} onChange={(e) => setTf({ ...tf, hours: e.target.value })} />
                  <Field label="What was done" aria-label="Time description" value={tf.description} onChange={(e) => setTf({ ...tf, description: e.target.value })} />
                  <Field label="Rate per hour (₹)" aria-label="Hourly rate" inputMode="decimal" value={tf.rate} onChange={(e) => setTf({ ...tf, rate: e.target.value })} />
                </div>
                <Button className="mt-2" disabled={busy} onClick={() => run(async () => {
                  await api(`/orgs/${org.id}/projects/${open.id}/time`, { body: { date: tf.date, description: tf.description, minutes: minutes(), rate: tf.rate ? toPaise(tf.rate) : 0 } });
                  setTf({ ...tf, description: '', hours: '' }); setOk('Time added.'); await refresh();
                })}>Add time</Button>
              </div>
              <div className="rounded border border-slate-200 p-3">
                <p className="mb-2 font-medium">Add cost</p>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Date" type="date" aria-label="Cost date" value={cf.date} onChange={(e) => setCf({ ...cf, date: e.target.value })} />
                  <Field label="Amount (₹)" aria-label="Cost amount" inputMode="decimal" value={cf.amount} onChange={(e) => setCf({ ...cf, amount: e.target.value })} />
                  <Field label="Description" aria-label="Cost description" value={cf.description} onChange={(e) => setCf({ ...cf, description: e.target.value })} />
                  <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" checked={cf.chargeable} onChange={(e) => setCf({ ...cf, chargeable: e.target.checked })} />Charge to the customer</label>
                </div>
                <Button className="mt-2" disabled={busy} onClick={() => run(async () => {
                  await api(`/orgs/${org.id}/projects/${open.id}/costs`, { body: { date: cf.date, description: cf.description, amount: toPaise(cf.amount), chargeable: cf.chargeable } });
                  setCf({ ...cf, description: '', amount: '' }); setOk('Cost added.'); await refresh();
                })}>Add cost</Button>
              </div>
            </div>
          )}

          <h3 className="mt-5 font-semibold">Time</h3>
          {open.timeEntries.length === 0 ? <Empty text="No time yet." /> : (
            <table className="w-full text-sm"><thead><tr className="text-left"><th>Date</th><th>Who</th><th>Description</th><th className="text-right">Time</th><th className="text-right">Rate/h</th><th className="text-right">Value</th><th>Invoice</th></tr></thead>
              <tbody>{open.timeEntries.map((t) => <tr key={t.id}><td>{t.date}</td><td>{t.who}</td><td>{t.description}</td><td className="text-right">{hm(t.minutes)}</td><td className="text-right">{fmt(t.rate)}</td><td className="text-right">{fmt(t.value)}</td><td>{t.invoice ?? <span className="text-amber-700">unbilled</span>}</td></tr>)}</tbody></table>)}
          <h3 className="mt-5 font-semibold">Costs</h3>
          {open.costEntries.length === 0 ? <Empty text="No costs yet." /> : (
            <table className="w-full text-sm"><thead><tr className="text-left"><th>Date</th><th>Description</th><th className="text-right">Amount</th><th>Charge</th><th>Invoice</th></tr></thead>
              <tbody>{open.costEntries.map((k) => <tr key={k.id}><td>{k.date}</td><td>{k.description}</td><td className="text-right">{fmt(k.amount)}</td><td>{k.chargeable ? 'Yes' : 'No'}</td><td>{k.chargeable ? (k.invoice ?? <span className="text-amber-700">unbilled</span>) : '—'}</td></tr>)}</tbody></table>)}

          {canPost && open.toInvoice > 0 && (
            <div className="mt-5 flex flex-wrap items-end gap-3 rounded bg-brand-50 p-3">
              <p className="text-sm">Unbilled: <b data-testid="project-unbilled">₹{fmt(open.toInvoice)}</b> before GST</p>
              <Select label="GST rate" aria-label="Project GST rate" value={inv.gstRateBp} onChange={(e) => setInv({ ...inv, gstRateBp: e.target.value })}>{rates.map((r) => <option key={r.rateBp} value={r.rateBp}>{r.label}</option>)}</Select>
              <Select label="Income account" aria-label="Project income account" value={inv.accountId} onChange={(e) => setInv({ ...inv, accountId: e.target.value })}><option value="">Default (4000)</option>{accounts.filter((a) => a.type === 'income').map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</Select>
              <Button disabled={busy} onClick={() => run(async () => {
                const r = await api(`/orgs/${org.id}/projects/${open.id}/invoice`, { body: { issueDate: today(), gstRateBp: Number(inv.gstRateBp), ...(inv.accountId ? { accountId: Number(inv.accountId) } : {}) } });
                setOk(`Created ${r.number}: ₹${fmt(r.subtotal)} + GST = ₹${fmt(r.total)}. Find it under Sales → Invoices.`); await refresh();
              })}>Create invoice</Button>
            </div>
          )}
        </Card>
      )}
    </>
  );
}
