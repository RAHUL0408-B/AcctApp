// People and access: who can open this firm's books and what they can do. The owner invites people by email,
// changes roles and removes access. Accountants can see the list.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { Me, Org } from '../App';
import { Badge, Empty, PageHeader } from '../kit';
import { Button, Card, ErrorMsg, Field, Ok, useAction } from '../ui';

interface Member { id: number; userId: number; name: string; email: string; emailVerified: boolean; twoFactor: boolean; role: string; orgId: number | null; orgName: string | null }
interface Invitation { id: number; email: string; role: string; orgId: number | null; orgName: string | null; expiresAt: string; expired: boolean; invitedBy: string }
interface Team { canEdit: boolean; you: number; roles: Record<string, string>; plan: { name: string; maxMembers: number; people: number }; members: Member[]; invitations: Invitation[] }

const ROLE_ORDER = ['owner', 'accountant', 'staff', 'sales', 'employee', 'client'];
const LABEL: Record<string, string> = { owner: 'Owner', accountant: 'Accountant', staff: 'Staff', client: 'Client', sales: 'Sales', employee: 'Employee' };
/** These roles always belong to one client; the others can cover the whole firm. */
const ONE_CLIENT = new Set(['client', 'sales', 'employee']);

export function TeamPage({ me, orgs }: { me: Me; orgs: Org[] }) {
  const firms = me.memberships.filter((m) => m.orgId === null && (m.role === 'owner' || m.role === 'accountant'));
  const [firmId, setFirmId] = useState<number | null>(firms[0]?.firmId ?? null);
  const [team, setTeam] = useState<Team | null>(null);
  const [f, setF] = useState({ email: '', role: 'staff', orgId: '' });
  const [link, setLink] = useState('');
  const [ok, setOk] = useState('');
  const { error, busy, run } = useAction();
  const load = useCallback(() => { if (firmId) api<Team>(`/firms/${firmId}/team`).then(setTeam); }, [firmId]);
  useEffect(() => { load(); }, [load]);

  if (!firmId) return <p className="text-sm text-slate-600">Only a firm owner or accountant can see the team.</p>;
  if (!team) return <p className="text-sm text-slate-500">Loading…</p>;
  const clients = orgs.filter((o) => o.firmId === firmId);
  const need = ONE_CLIENT.has(f.role);
  const edit = team.canEdit;

  const invite = () => run(async () => {
    const r = await api(`/firms/${firmId}/invitations`, { body: { email: f.email, role: f.role, ...(f.orgId ? { orgId: Number(f.orgId) } : {}) } });
    setOk(`Invitation sent to ${f.email}. It works for ${r.expiresInDays} days.`); setLink(r.link); setF({ ...f, email: '' }); load();
  });
  const resend = (i: Invitation) => run(async () => { const r = await api(`/firms/${firmId}/invitations/${i.id}/resend`, { body: {} }); setOk(`A new link was sent to ${i.email}.`); setLink(r.link); load(); });
  const cancel = (i: Invitation) => run(async () => { await api(`/firms/${firmId}/invitations/${i.id}`, { method: 'DELETE' }); setOk(`Invitation to ${i.email} cancelled.`); setLink(''); load(); });
  const setRole = (m: Member, role: string) => run(async () => {
    const orgId = ONE_CLIENT.has(role) ? (m.orgId ?? Number(clients[0]?.id)) : null;
    await api(`/firms/${firmId}/members/${m.id}`, { method: 'PUT', body: { role, orgId } }); setOk(`${m.name} is now ${LABEL[role]}${orgId && ONE_CLIENT.has(role) ? ` for ${clients.find((c) => c.id === orgId)?.name ?? 'the client'}` : ''}.`); load();
  });
  const remove = (m: Member) => run(async () => {
    if (!window.confirm(`Remove ${m.name}'s access${m.orgName ? ` to ${m.orgName}` : ''}? They can no longer open these books.`)) return;
    await api(`/firms/${firmId}/members/${m.id}`, { method: 'DELETE' }); setOk(`Removed ${m.name}.`); load();
  });

  return (
    <>
      <PageHeader title="People and access" subtitle={`${team.plan.people} of ${team.plan.maxMembers} people on your ${team.plan.name} plan. Each person has their own login and sees only what their role allows.`} />
      <div className="mb-3 space-y-2"><ErrorMsg msg={error} /><Ok msg={ok} />
        {link && <p className="rounded bg-slate-100 px-3 py-2 text-xs text-slate-700">The invitation was emailed. You can also share this link yourself: <span className="break-all font-mono" data-testid="invite-link">{link}</span></p>}</div>
      {firms.length > 1 && <label className="mb-3 block max-w-xs text-sm"><span className="mb-1 block font-medium text-slate-600">Firm</span>
        <select aria-label="Firm" className="w-full rounded-md border border-slate-300 bg-white px-3 py-2" value={firmId} onChange={(e) => { setTeam(null); setFirmId(Number(e.target.value)); }}>{firms.map((x) => <option key={x.firmId} value={x.firmId}>{x.firmName}</option>)}</select></label>}

      {edit && (
        <Card title="Invite someone">
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Email address" type="email" aria-label="Invite email" value={f.email} placeholder="name@example.com" onChange={(e) => setF({ ...f, email: e.target.value })} />
            <label className="block text-sm"><span className="mb-1 block font-medium text-slate-600">What can they do?</span>
              <select aria-label="Invite role" className="w-full rounded-md border border-slate-300 bg-white px-3 py-2" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value, orgId: ONE_CLIENT.has(e.target.value) ? f.orgId || String(clients[0]?.id ?? '') : f.orgId })}>
                {ROLE_ORDER.map((r) => <option key={r} value={r}>{team.roles[r]}</option>)}</select></label>
            <label className="block text-sm"><span className="mb-1 block font-medium text-slate-600">{need ? 'Which client?' : 'Which clients?'}</span>
              <select aria-label="Invite client" className="w-full rounded-md border border-slate-300 bg-white px-3 py-2" value={f.orgId} onChange={(e) => setF({ ...f, orgId: e.target.value })}>
                {!need && <option value="">All clients of the firm</option>}{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button disabled={busy || !f.email || (need && !f.orgId)} onClick={invite}>Send invitation</Button>
            <p className="text-xs text-slate-500">They get an email with a link. New people create their own login; people who already have one just log in to accept.</p>
          </div>
        </Card>
      )}

      <Card title={`People (${team.members.length})`}>
        <table className="w-full text-sm"><thead><tr className="text-left text-slate-500"><th>Name</th><th>Email</th><th>Access</th><th>Client</th><th>Sign-in</th><th /></tr></thead>
          <tbody>{team.members.map((m) => (
            <tr key={m.id} className="border-t border-slate-100">
              <td className="py-2 font-medium">{m.name}{m.userId === team.you && <span className="ml-2 rounded bg-brand-50 px-1.5 text-xs text-brand-700">you</span>}</td>
              <td>{m.email}</td>
              <td>{edit ? (
                <select aria-label={`Role for ${m.name}${m.orgName ? ` at ${m.orgName}` : ''}`} className="rounded border border-slate-300 bg-white px-2 py-1" value={m.role} disabled={busy} onChange={(e) => setRole(m, e.target.value)}>
                  {ROLE_ORDER.map((r) => <option key={r} value={r}>{LABEL[r]}</option>)}</select>) : <Badge text={m.role} />}</td>
              <td>{m.orgName ?? <span className="text-slate-500">All clients</span>}</td>
              <td className="whitespace-nowrap text-xs text-slate-600">{m.emailVerified ? 'Email confirmed' : 'Email not confirmed'}{m.twoFactor ? ' · 2-step on' : ''}</td>
              <td className="text-right">{edit && <Button variant="ghost" className="text-red-700" aria-label={`Remove ${m.name}${m.orgName ? ` at ${m.orgName}` : ''}`} onClick={() => remove(m)}>Remove</Button>}</td>
            </tr>))}</tbody></table>
      </Card>

      <Card title={`Waiting to join (${team.invitations.length})`}>
        {team.invitations.length === 0 ? <Empty text="No invitations waiting." /> : (
          <table className="w-full text-sm"><thead><tr className="text-left text-slate-500"><th>Email</th><th>Access</th><th>Client</th><th>Invited by</th><th>Link</th><th /></tr></thead>
            <tbody>{team.invitations.map((i) => (
              <tr key={i.id} className="border-t border-slate-100">
                <td className="py-2 font-medium">{i.email}</td><td>{LABEL[i.role]}</td><td>{i.orgName ?? <span className="text-slate-500">All clients</span>}</td><td>{i.invitedBy}</td>
                <td className={i.expired ? 'text-red-700' : 'text-slate-600'}>{i.expired ? 'Expired' : `Until ${i.expiresAt.slice(0, 10)}`}</td>
                <td className="whitespace-nowrap text-right">{edit && <><Button variant="ghost" aria-label={`Resend invitation to ${i.email}`} onClick={() => resend(i)}>Send again</Button> <Button variant="ghost" aria-label={`Cancel invitation to ${i.email}`} onClick={() => cancel(i)}>Cancel</Button></>}</td>
              </tr>))}</tbody></table>)}
      </Card>

      <Card title="What each access level can do">
        <dl className="grid gap-x-6 gap-y-2 text-sm md:grid-cols-2">{ROLE_ORDER.map((r) => <div key={r}><dt className="font-semibold text-slate-800">{LABEL[r]}</dt><dd className="text-slate-600">{team.roles[r].replace(/^[^(]*\(/, '').replace(/\)$/, '')}</dd></div>)}</dl>
      </Card>
    </>
  );
}
