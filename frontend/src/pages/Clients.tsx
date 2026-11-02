import { FormEvent, useState } from 'react';
import { api } from '../api';
import type { Me, Org } from '../App';
import { Button, Card, ErrorMsg, Field, useAction } from '../ui';

export function Clients({ me, orgs, firmRole, onOpen, onChanged }: { me: Me; orgs: Org[]; firmRole?: string; onOpen: (id: number) => void; onChanged: () => void }) {
  const firm = me.memberships.find((m) => m.orgId === null);
  const [f, setF] = useState({ name: '', gstin: '', pan: '', template: 'services' });
  const { error, busy, run } = useAction();
  const canAdd = firmRole === 'owner' || firmRole === 'accountant';

  const add = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      await api('/orgs', { body: { firmId: firm!.firmId, name: f.name, template: f.template, ...(f.gstin ? { gstin: f.gstin.toUpperCase() } : {}), ...(f.pan ? { pan: f.pan.toUpperCase() } : {}) } });
      setF({ name: '', gstin: '', pan: '', template: 'services' });
      onChanged();
    });
  };

  return (
    <>
      <Card title={firm ? `${firm.firmName} — clients` : 'Your organizations'}>
        {orgs.length === 0 ? (
          <div className="rounded bg-brand-50 p-4 text-sm" data-testid="onboarding">
            <p className="font-semibold">Welcome! Three steps to get going:</p>
            <ol className="mt-2 list-decimal pl-5"><li>Add your first client below (their GSTIN sets the GST state).</li><li>Open the client and add customers and suppliers under Contacts.</li><li>Raise an invoice under Sales, or import opening balances under Import.</li></ol>
            <p className="mt-2">Then turn on two-factor authentication under Security.</p>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {orgs.map((o) => (
              <li key={o.id} className="flex items-center justify-between py-3">
                <div className="flex items-center gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-100 text-sm font-bold text-brand-800">{o.name.slice(0, 1).toUpperCase()}</span>
                  <div><p className="font-medium text-slate-900">{o.name}</p><p className="text-xs text-slate-500">{o.gstin ?? 'No GSTIN'}</p></div></div>
                <Button variant="ghost" onClick={() => onOpen(o.id)}>Open books</Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {canAdd && (
        <Card title="Add a client">
          <form onSubmit={add} className="grid gap-3 md:grid-cols-2">
            <Field label="Business name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
            <label className="block text-sm"><span className="mb-1 block font-medium text-slate-600">Chart of accounts</span>
              <select className="w-full rounded-md border border-slate-300 bg-white px-3 py-2" value={f.template} onChange={(e) => setF({ ...f, template: e.target.value })}>
                <option value="services">Services</option><option value="trading">Trading</option><option value="manufacturing">Manufacturing</option>
              </select></label>
            <Field label="GSTIN (optional)" value={f.gstin} onChange={(e) => setF({ ...f, gstin: e.target.value })} placeholder="27AAPFU0939F1ZV" />
            <Field label="PAN (optional)" value={f.pan} onChange={(e) => setF({ ...f, pan: e.target.value })} placeholder="AAPFU0939F" />
            <div className="md:col-span-2 space-y-2"><ErrorMsg msg={error} /><Button disabled={busy}>Add client</Button></div>
          </form>
        </Card>
      )}
    </>
  );
}
