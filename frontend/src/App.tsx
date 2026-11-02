import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { api, getToken, setToken } from './api';
import { APP_NAME, Button, ErrorBoundary, Logo } from './ui';
import { AuthScreen } from './pages/Auth';
import { Clients } from './pages/Clients';
import { NAV, OrgPage, PageKey } from './pages/OrgWorkspace';
import { Security } from './pages/Security';
import { Billing, Help, Privacy } from './pages/Account';
import { PracticeOverview } from './pages/PracticeOverview';

export interface Me {
  id: number; email: string; fullName: string; twoFactorEnabled: boolean;
  memberships: { firmId: number; firmName: string; orgId: number | null; role: string }[];
}
export interface Org { id: number; name: string; gstin: string | null; firmId: number }

/** Hash routes: #/clients, #/practice, #/security, #/billing, #/privacy, #/help, #/o/<orgId>/<page>. Refresh and the back button keep working. */
function useRoute() {
  const read = () => location.hash.replace(/^#/, '') || '/clients';
  const [route, setRoute] = useState(read());
  useEffect(() => { const f = () => setRoute(read()); window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f); }, []);
  return route;
}
const navigate = (path: string) => { location.hash = path; };

const ACCOUNT_LINKS: [string, string][] = [['/security', 'Security'], ['/billing', 'Billing'], ['/privacy', 'Privacy'], ['/help', 'Help']];

/** A top-bar menu that opens on click and closes on outside click or Escape. */
function Menu({ label, active, children, align = 'left', trigger }: { label: string; active?: boolean; children: (close: () => void) => ReactNode; align?: 'left' | 'right'; trigger?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button aria-haspopup="true" aria-expanded={open} aria-label={trigger ? label : undefined} onClick={() => setOpen(!open)}
        className={trigger ? 'flex items-center rounded-full' : `flex h-14 items-center gap-1 px-3 text-sm font-medium transition-colors ${active || open ? 'bg-white/10 text-white' : 'text-indigo-100 hover:bg-white/10 hover:text-white'}`}>
        {trigger ?? <>{label}<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className="opacity-70"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg></>}
      </button>
      {open && (
        <div className={`absolute top-full z-40 min-w-56 rounded-b-lg rounded-t-sm border border-slate-200 bg-white py-1 text-slate-800 shadow-xl ${align === 'right' ? 'right-0' : 'left-0'}`}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
const MenuItem = ({ active, onClick, children }: { active?: boolean; onClick: () => void; children: ReactNode }) => (
  <button onClick={onClick} className={`block w-full px-4 py-2 text-left text-sm ${active ? 'bg-brand-50 font-medium text-brand-700' : 'text-slate-700 hover:bg-slate-100'}`}>{children}</button>
);

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [loading, setLoading] = useState(!!getToken());
  const route = useRoute();

  const load = useCallback(async () => {
    const token = getToken(); // if the user logs out (or in as someone else) while this runs, drop the stale result
    try {
      const nextMe = await api<Me>('/auth/me'), nextOrgs = await api<Org[]>('/orgs');
      if (getToken() === token) { setMe(nextMe); setOrgs(nextOrgs); }
    } catch { if (getToken() === token) { setToken(null); setMe(null); } }
    setLoading(false);
  }, []);
  useEffect(() => { if (getToken()) load(); }, [load]);

  if (loading) return <p className="p-8 text-slate-500">Loading…</p>;
  if (!me) return <AuthScreen onDone={() => { navigate('/clients'); setLoading(true); load(); }} />;

  const m = /^\/o\/(\d+)\/([\w-]+)$/.exec(route);
  const org = m ? orgs.find((o) => o.id === Number(m[1])) ?? null : null;
  const page = (m?.[2] ?? 'dashboard') as PageKey;
  const firmRole = me.memberships.find((x) => x.orgId === null);
  const roleOnOrg = (o: Org) => (me.memberships.find((x) => x.orgId === o.id) ?? me.memberships.find((x) => x.orgId === null && x.firmId === o.firmId))?.role ?? 'client';
  const role = org ? roleOnOrg(org) : '';
  const canManage = role === 'owner' || role === 'accountant';
  const logout = () => { setToken(null); setMe(null); setOrgs([]); navigate('/clients'); };
  const initials = me.fullName.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 bg-nav text-white shadow-md">
        <div className="flex h-14 items-center gap-2 px-4">
          <button className="mr-2 flex items-center gap-2 text-lg font-bold tracking-tight" onClick={() => navigate('/clients')} aria-label={`${APP_NAME} home`}><Logo />{APP_NAME}</button>

          {org && (
            <nav className="flex items-center" aria-label="Client sections">
              {NAV.map((g) => {
                const items = g.items.filter((i) => !i.manage || canManage);
                if (!items.length) return null;
                const isActive = items.some((i) => i.key === page);
                if (items.length === 1) {
                  const i = items[0];
                  return <button key={g.group} aria-current={isActive ? 'page' : undefined} onClick={() => navigate(`/o/${org.id}/${i.key}`)}
                    className={`flex h-14 items-center px-3 text-sm font-medium transition-colors ${isActive ? 'bg-white/10 text-white' : 'text-indigo-100 hover:bg-white/10 hover:text-white'}`}>{i.label}</button>;
                }
                return (
                  <Menu key={g.group} label={g.group} active={isActive}>
                    {(close) => items.map((i) => <MenuItem key={i.key} active={page === i.key} onClick={() => { close(); navigate(`/o/${org.id}/${i.key}`); }}>{i.label}</MenuItem>)}
                  </Menu>
                );
              })}
            </nav>
          )}

          <div className="ml-auto flex items-center gap-3">
            <select aria-label="Switch client" className="max-w-56 rounded-md border border-white/20 bg-white/10 px-2 py-1.5 text-sm text-white outline-none hover:bg-white/15 focus:border-white/60" value={org?.id ?? ''}
              onChange={(e) => navigate(e.target.value ? `/o/${e.target.value}/dashboard` : '/clients')}>
              <option className="text-slate-900" value="">{orgs.length ? 'All clients' : 'No clients yet'}</option>
              {orgs.map((o) => <option className="text-slate-900" key={o.id} value={o.id}>{o.name}</option>)}
            </select>
            <nav aria-label="Account" className="flex items-center gap-1">
              <button className={`rounded px-3 py-1.5 text-sm font-medium ${route === '/clients' ? 'bg-white/15' : 'text-indigo-100 hover:bg-white/10'}`} onClick={() => navigate('/clients')}>Clients</button>
              <button className={`rounded px-3 py-1.5 text-sm font-medium ${route === '/practice' ? 'bg-white/15' : 'text-indigo-100 hover:bg-white/10'}`} onClick={() => navigate('/practice')}>Practice</button>
              <Menu label="Account menu" align="right" trigger={<span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-500 text-xs font-bold ring-2 ring-white/30">{initials}</span>}>
                {(close) => (
                  <>
                    <div className="border-b border-slate-100 px-4 py-2"><p className="text-sm font-semibold">{me.fullName}</p><p className="text-xs text-slate-500">{me.email}</p></div>
                    {ACCOUNT_LINKS.map(([path, label]) => <MenuItem key={path} active={route === path} onClick={() => { close(); navigate(path); }}>{label}</MenuItem>)}
                  </>
                )}
              </Menu>
            </nav>
            <Button variant="ghost" className="!border-white/30 !bg-transparent !px-3 !py-1.5 !text-white hover:!bg-white/10" onClick={logout}>Log out</Button>
          </div>
        </div>
      </header>

      {org && (
        <div className="border-b border-slate-200 bg-white px-6">
          <div className="mx-auto flex max-w-7xl items-center gap-3 py-2 text-sm">
            <span className="flex h-7 w-7 items-center justify-center rounded bg-brand-100 text-xs font-bold text-brand-800">{org.name.slice(0, 1).toUpperCase()}</span>
            <span className="font-semibold text-slate-900">{org.name}</span>
            {org.gstin && <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">GSTIN {org.gstin}</span>}
            <span className="ml-auto text-xs text-slate-500">Your role: <b className="capitalize text-slate-700">{role}</b></span>
          </div>
        </div>
      )}

      <main className="px-6 py-6">
        <div className="mx-auto max-w-7xl space-y-5">
          <ErrorBoundary key={route}>
            {route === '/clients' && <Clients me={me} orgs={orgs} firmRole={firmRole?.role} onOpen={(id) => navigate(`/o/${id}/dashboard`)} onChanged={load} />}
            {m && org && <OrgPage key={org.id} org={org} role={role} page={page} go={(p) => navigate(`/o/${org.id}/${p}`)} onOrgChanged={load} />}
            {m && !org && <p className="text-sm text-slate-600">That client was not found, or you do not have access.</p>}
            {route === '/practice' && <PracticeOverview onOpen={(id) => navigate(`/o/${id}/dashboard`)} />}
            {route === '/security' && <Security me={me} onChanged={load} />}
            {route === '/billing' && <Billing me={me} />}
            {route === '/privacy' && <Privacy onDeleted={() => { setMe(null); setOrgs([]); navigate('/clients'); }} />}
            {route === '/help' && <Help />}
          </ErrorBoundary>
        </div>
      </main>
    </div>
  );
}
