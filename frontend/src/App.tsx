import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { api, getToken, setToken } from './api';
import { APP_NAME, ErrorBoundary, Logo } from './ui';
import { AuthScreen } from './pages/Auth';
import { Clients } from './pages/Clients';
import { NAV, NavItem, OrgPage, PageKey } from './pages/OrgWorkspace';
import { Security } from './pages/Security';
import { Billing, Help, Privacy } from './pages/Account';
import { PracticeOverview } from './pages/PracticeOverview';
import { favouriteReports } from './pages/Reports';

export interface Me {
  id: number; email: string; fullName: string; twoFactorEnabled: boolean; lastLogin: { at: string; ip: string | null } | null;
  memberships: { firmId: number; firmName: string; orgId: number | null; role: string }[];
}
export interface Org { id: number; name: string; gstin: string | null; firmId: number }

/** Hash routes: #/clients, #/practice, #/security, #/billing, #/privacy, #/help, #/o/<orgId>/<page>[/<sub>]. Refresh and the back button keep working. */
function useRoute() {
  const read = () => location.hash.replace(/^#/, '') || '/clients';
  const [route, setRoute] = useState(read());
  useEffect(() => { const f = () => setRoute(read()); window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f); }, []);
  return route;
}
const navigate = (path: string) => { location.hash = path; };

/** The "+" menu. Alt + the letter works anywhere inside an organisation. */
const CREATE: [string, string, string][] = [
  ['Invoice', 'I', 'invoices/new'], ['Bill', 'B', 'bills/new'], ['Contact', 'C', 'contacts/new'], ['Quote', 'Q', 'quotes/new'], ['Purchase order', 'O', 'purchase-orders/new'],
  ['Document upload', 'U', 'files'], ['Manual journal', 'J', 'journal'], ['Spend money', 'S', 'money/spend'], ['Receive money', 'R', 'money/receive'], ['Transfer money', 'T', 'money/transfer'],
];

const initialsOf = (name: string) => name.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

const Icon = ({ d, size = 20 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={d} /></svg>
);
const ICONS = {
  plus: 'M12 5v14M5 12h14',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35',
  help: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-2.82 1.17V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-2.82-1.17l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 3 15.08H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.17-2.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 2.82 1.17l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 20.91 9H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
};

/**
 * A top-bar menu that opens on click and closes on outside click or Escape.
 * Pass open/onOpenChange to let the parent keep one menu open at a time, and onHover to switch menus by hovering
 * once one is open. Arrow keys move between entries.
 */
function Menu({ label, active, children, align = 'left', trigger, width = 'min-w-60', open: controlled, onOpenChange, onHover }: {
  label: string; active?: boolean; children: (close: () => void) => ReactNode; align?: 'left' | 'right'; trigger?: ReactNode; width?: string;
  open?: boolean; onOpenChange?: (open: boolean) => void; onHover?: () => void;
}) {
  const [inner, setInner] = useState(false);
  const open = controlled ?? inner;
  const setOpen = (v: boolean) => (onOpenChange ? onOpenChange(v) : setInner(v));
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); button.current?.focus(); } };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }); // eslint-disable-line react-hooks/exhaustive-deps
  const entries = () => Array.from(ref.current?.querySelectorAll<HTMLElement>('[data-menu-entry]') ?? []);
  const arrow = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const list = entries(); if (!list.length) return;
    e.preventDefault();
    const at = list.indexOf(document.activeElement as HTMLElement);
    list[e.key === 'ArrowDown' ? (at + 1) % list.length : (at <= 0 ? list.length - 1 : at - 1)].focus();
  };
  return (
    <div ref={ref} className="relative" onKeyDown={arrow} onMouseEnter={onHover}>
      <button ref={button} aria-haspopup="true" aria-expanded={open} aria-label={trigger ? label : undefined} title={trigger ? label : undefined} onClick={() => setOpen(!open)}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); e.stopPropagation(); setOpen(true); } }}
        className={trigger ? `flex h-10 min-w-10 items-center justify-center rounded-md px-2 text-white transition-colors focus-visible:outline-2 focus-visible:outline-white ${open ? 'bg-white/20' : 'hover:bg-white/15'}`
          : `relative flex h-14 items-center gap-1 px-3 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white ${active || open ? 'bg-white/10 text-white' : 'text-indigo-100 hover:bg-white/10 hover:text-white'} ${active ? 'after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-white' : ''}`}>
        {trigger ?? <>{label}<svg width="9" height="9" viewBox="0 0 10 10" aria-hidden className={`opacity-70 transition-transform ${open ? 'rotate-180' : ''}`}><path d="M1 3l4 4 4-4" fill="currentColor" /></svg></>}
      </button>
      {open && (
        <div className={`absolute top-full z-40 mt-1 max-w-[calc(100vw-1rem)] ${width} rounded-lg border border-slate-200 bg-white py-2 text-slate-800 shadow-xl ${align === 'right' ? 'right-0' : 'left-0'}`}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
const MenuItem = ({ active, onClick, children, right, shortcut }: { active?: boolean; onClick: () => void; children: ReactNode; right?: ReactNode; shortcut?: string }) => (
  <button data-menu-entry onClick={onClick} aria-current={active ? 'page' : undefined} aria-keyshortcuts={shortcut ? `Alt+${shortcut}` : undefined}
    className={`flex w-full items-center justify-between gap-6 px-5 py-2 text-left text-sm focus-visible:bg-slate-100 focus-visible:outline-none ${active ? 'bg-brand-50 font-medium text-brand-700' : 'text-slate-700 hover:bg-slate-100'}`}>
    {children}
    {right && <span aria-hidden>{right}</span>}
    {shortcut && <span aria-hidden className="flex gap-1 text-xs text-slate-500"><kbd className="rounded border border-slate-300 bg-slate-50 px-1.5">Alt</kbd><kbd className="rounded border border-slate-300 bg-slate-50 px-1.5">{shortcut}</kbd></span>}
  </button>
);
const MenuHeading = ({ children }: { children: ReactNode }) => <p className="px-5 pb-1 pt-2 text-xs font-semibold text-slate-500">{children}</p>;
const MenuDivider = () => <hr className="my-2 border-slate-200" />;

type Section = { heading?: string; items: NavItem[] };
/** Split a menu's entries into sections: a new one starts at every heading or divider. */
const sectionsOf = (items: NavItem[]): Section[] => {
  const out: Section[] = [];
  for (const i of items) { if (!out.length || i.heading || i.divider) out.push({ heading: i.heading, items: [i] }); else out[out.length - 1].items.push(i); }
  return out;
};
/** A menu with three or more headed sections is laid out in columns instead of one long list. */
const isWide = (items: NavItem[]) => sectionsOf(items).filter((x) => x.heading).length >= 3;
const hrefOf = (i: NavItem) => (i.sub ? `${i.key}/${i.sub}` : i.key);

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [loading, setLoading] = useState(!!getToken());
  const [openGroup, setOpenGroup] = useState<string | null>(null); // which top-bar section menu is open
  const [mobileOpen, setMobileOpen] = useState(false);
  const [mobileGroup, setMobileGroup] = useState<string | null>(null);
  const route = useRoute();
  useEffect(() => { setOpenGroup(null); setMobileOpen(false); }, [route]);

  const load = useCallback(async () => {
    const token = getToken(); // if the user logs out (or in as someone else) while this runs, drop the stale result
    try {
      const nextMe = await api<Me>('/auth/me'), nextOrgs = await api<Org[]>('/orgs');
      if (getToken() === token) { setMe(nextMe); setOrgs(nextOrgs); }
    } catch { if (getToken() === token) { setToken(null); setMe(null); } }
    setLoading(false);
  }, []);
  useEffect(() => { if (getToken()) load(); }, [load]);

  const m = /^\/o\/(\d+)\/([\w-]+)(?:\/([\w-]+))?$/.exec(route);
  const org = m && me ? orgs.find((o) => o.id === Number(m[1])) ?? null : null;
  const page = (m?.[2] ?? 'dashboard') as PageKey, sub = m?.[3];
  const roleOnOrg = (o: Org) => (me?.memberships.find((x) => x.orgId === o.id) ?? me?.memberships.find((x) => x.orgId === null && x.firmId === o.firmId))?.role ?? 'client';
  const role = org ? roleOnOrg(org) : '';
  const canManage = role === 'owner' || role === 'accountant', canPost = !!org && role !== 'client';
  const goOrg = (p: string) => org && navigate(`/o/${org.id}/${p}`);

  // Alt + letter shortcuts from the "+" menu.
  useEffect(() => {
    if (!org || !canPost) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const hit = CREATE.find(([, k]) => k === e.key.toUpperCase());
      if (hit) { e.preventDefault(); navigate(`/o/${org.id}/${hit[2]}`); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [org, canPost]);

  if (loading) return <p className="p-8 text-slate-500">Loading…</p>;
  if (!me) return <AuthScreen onDone={() => { navigate('/clients'); setLoading(true); load(); }} />;

  const firmRole = me.memberships.find((x) => x.orgId === null);
  const logout = () => { setToken(null); setMe(null); setOrgs([]); navigate('/clients'); };
  const isActive = (i: NavItem) => page === i.key && (!i.sub || i.sub === sub);
  /** "Sales › Invoices": where the current page lives in the menus. */
  const crumb: [string, string?] | null = (() => {
    if (!org) return null;
    const hit = (strict: boolean) => { for (const g of NAV) for (const i of g.items) if (i.key === page && (strict ? !i.sub || i.sub === sub : true)) return [g.group, g.items.length === 1 ? undefined : i.label] as [string, string?]; return null; };
    return hit(true) ?? hit(false);
  })();

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 bg-nav text-white shadow-md">
        <div className="flex h-14 items-center gap-1 px-3">
          {org && <button className="mr-1 flex h-10 w-10 items-center justify-center rounded-md hover:bg-white/15 xl:hidden" aria-label={mobileOpen ? 'Close menu' : 'Open menu'} aria-expanded={mobileOpen} onClick={() => setMobileOpen(!mobileOpen)}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d={mobileOpen ? 'M6 6l12 12M18 6L6 18' : 'M4 7h16M4 12h16M4 17h16'} /></svg></button>}
          <button className="mr-1 flex items-center gap-2 rounded-md px-2 py-1 text-lg font-bold tracking-tight hover:bg-white/10" onClick={() => navigate('/clients')} aria-label={`${APP_NAME} home`}><Logo /><span className="hidden 2xl:inline">{APP_NAME}</span></button>

          <Menu label="Organisation menu" width="w-80" trigger={
            <span className="flex max-w-24 items-center gap-2 text-sm font-semibold sm:max-w-56"><span className="truncate">{org?.name ?? 'All clients'}</span><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden><path d="M1 3l4 4 4-4" fill="currentColor" /></svg></span>}>
            {(close) => {
              const to = (p: string) => { close(); navigate(p); };
              return (<>
                {org && <>
                  <div className="flex items-center gap-3 px-5 py-2"><span className="flex h-9 w-9 items-center justify-center rounded bg-brand-100 text-xs font-bold text-brand-800">{initialsOf(org.name)}</span><span className="font-semibold">{org.name}</span></div>
                  <MenuItem onClick={() => to(`/o/${org.id}/settings`)}>Settings</MenuItem>
                  <MenuItem onClick={() => to('/billing')}>Subscription and billing</MenuItem>
                  <MenuDivider />
                </>}
                <MenuHeading>Switch organisation</MenuHeading>
                <div className="max-h-64 overflow-y-auto">
                  {orgs.length === 0 && <p className="px-5 py-2 text-sm text-slate-500">No clients yet.</p>}
                  {orgs.map((o) => <MenuItem key={o.id} active={o.id === org?.id} onClick={() => to(`/o/${o.id}/dashboard`)}>
                    <span className="flex items-center gap-2"><span className="flex h-6 w-6 items-center justify-center rounded bg-slate-100 text-[10px] font-bold text-slate-600">{initialsOf(o.name)}</span>{o.name}</span></MenuItem>)}
                </div>
                <MenuItem onClick={() => to('/clients')}>+ Add new organisation</MenuItem>
                <MenuDivider />
                <MenuItem active={route === '/practice'} onClick={() => to('/practice')}>Practice overview</MenuItem>
                <MenuItem active={route === '/clients'} onClick={() => to('/clients')}>All clients</MenuItem>
              </>);
            }}
          </Menu>

          {org && (
            <nav className="hidden items-center xl:flex" aria-label="Client sections">
              {NAV.map((g) => {
                const items = g.items.filter((i) => !i.manage || canManage);
                if (!items.length) return null;
                const groupActive = items.some(isActive);
                if (items.length === 1) {
                  const i = items[0];
                  return <button key={g.group} aria-current={groupActive ? 'page' : undefined} onClick={() => goOrg(hrefOf(i))} onMouseEnter={() => setOpenGroup(null)}
                    className={`relative flex h-14 items-center px-3 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white ${groupActive ? 'bg-white/10 text-white after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-white' : 'text-indigo-100 hover:bg-white/10 hover:text-white'}`}>{i.label}</button>;
                }
                const wide = isWide(items);
                return (
                  <Menu key={g.group} label={g.group} active={groupActive} width={wide ? 'w-[46rem]' : 'min-w-60'}
                    open={openGroup === g.group} onOpenChange={(v) => setOpenGroup(v ? g.group : null)} onHover={() => openGroup && openGroup !== g.group && setOpenGroup(g.group)}>
                    {(close) => {
                      const to = (p: string) => { close(); goOrg(p); };
                      const entry = (i: NavItem, n: number) => <MenuItem key={`${i.key}-${i.sub ?? ''}-${n}`} active={isActive(i)} onClick={() => to(hrefOf(i))} right={i.gear ? <Icon d={ICONS.gear} size={16} /> : undefined}>{i.label}</MenuItem>;
                      if (wide) {
                        // Columns: one per heading, so a long list stays on one screen and is easy to scan.
                        return (
                          <div className="grid grid-cols-3 divide-x divide-slate-100">
                            {sectionsOf(items).map((sec, n) => (
                              <div key={n}>{sec.heading && <MenuHeading>{sec.heading}</MenuHeading>}{sec.items.map(entry)}</div>))}
                          </div>);
                      }
                      const favs = g.group === 'Reporting' ? favouriteReports() : [];
                      return (<>
                        {items.map((i, n) => (
                          <div key={`${i.key}-${i.sub ?? ''}-${n}`}>
                            {i.divider && <MenuDivider />}
                            {i.heading && <MenuHeading>{i.heading}</MenuHeading>}
                            {entry(i, n)}
                          </div>))}
                        {g.group === 'Reporting' && <>
                          <MenuDivider /><MenuHeading>Favourite reports ★</MenuHeading>
                          {favs.length === 0 ? <p className="px-5 py-1 text-xs text-slate-500">Star a report to add it here.</p>
                            : favs.map((f) => <MenuItem key={f.key} active={page === 'reports' && sub === f.key} onClick={() => to(`reports/${f.key}`)}>{f.label}</MenuItem>)}
                        </>}
                      </>);
                    }}
                  </Menu>
                );
              })}
            </nav>
          )}

          <div className="ml-auto flex items-center gap-1">
            {org && canPost && (
              <Menu label="Create new" align="right" width="w-72" trigger={<Icon d={ICONS.plus} />}>
                {(close) => (<>
                  <MenuHeading>Create new</MenuHeading>
                  {CREATE.map(([l, k, p]) => <MenuItem key={l} shortcut={k} onClick={() => { close(); goOrg(p); }}>{l}</MenuItem>)}
                </>)}
              </Menu>
            )}
            {org && (
              <Menu label="Search" align="right" width="w-[28rem]" trigger={<Icon d={ICONS.search} />}>
                {(close) => <SearchPanel org={org} onPick={(p) => { close(); goOrg(p); }} />}
              </Menu>
            )}
            <button aria-label="Help" title="Help" onClick={() => navigate('/help')} className="hidden h-10 w-10 items-center justify-center rounded-md hover:bg-white/15 sm:flex"><Icon d={ICONS.help} /></button>
            {org && <Notifications org={org} onPick={(p) => goOrg(p)} />}
            <nav aria-label="Account" className="ml-1">
              <Menu label="Account menu" align="right" width="w-64" trigger={<span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-500 text-xs font-bold ring-2 ring-white/30">{initialsOf(me.fullName)}</span>}>
                {(close) => {
                  const to = (p: string) => { close(); navigate(p); };
                  return (<>
                    <div className="border-b border-slate-100 px-5 pb-2"><p className="text-sm font-semibold">{me.fullName}</p><p className="text-xs text-slate-500">{me.email}</p></div>
                    <MenuItem active={route === '/clients'} onClick={() => to('/clients')}>Clients</MenuItem>
                    <MenuItem active={route === '/practice'} onClick={() => to('/practice')}>Practice</MenuItem>
                    <MenuDivider />
                    {([['/security', 'Security'], ['/billing', 'Billing'], ['/privacy', 'Privacy'], ['/help', 'Help']] as const).map(([p, l]) => <MenuItem key={p} active={route === p} onClick={() => to(p)}>{l}</MenuItem>)}
                    <MenuDivider />
                    <MenuItem onClick={() => { close(); logout(); }}>Log out</MenuItem>
                  </>);
                }}
              </Menu>
            </nav>
          </div>
        </div>
        {org && mobileOpen && (
          <nav aria-label="Small-screen menu" className="max-h-[calc(100vh-3.5rem)] overflow-y-auto border-t border-white/10 bg-nav xl:hidden">
            {NAV.map((g) => {
              const items = g.items.filter((i) => !i.manage || canManage);
              if (!items.length) return null;
              const groupActive = items.some(isActive);
              if (items.length === 1) return <button key={g.group} onClick={() => goOrg(hrefOf(items[0]))} aria-current={groupActive ? 'page' : undefined}
                className={`flex w-full items-center px-5 py-3 text-left text-sm font-medium ${groupActive ? 'bg-white/10 text-white' : 'text-indigo-100 hover:bg-white/10'}`}>{items[0].label}</button>;
              const opened = mobileGroup === g.group;
              return (
                <div key={g.group}>
                  <button aria-expanded={opened} onClick={() => setMobileGroup(opened ? null : g.group)}
                    className={`flex w-full items-center justify-between px-5 py-3 text-left text-sm font-medium ${groupActive ? 'text-white' : 'text-indigo-100'} hover:bg-white/10`}>{g.group}
                    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className={`transition-transform ${opened ? 'rotate-180' : ''}`}><path d="M1 3l4 4 4-4" fill="currentColor" /></svg></button>
                  {opened && <div className="bg-white py-1 text-slate-800">
                    {sectionsOf(items).map((sec, n) => (
                      <div key={n}>{sec.heading && <MenuHeading>{sec.heading}</MenuHeading>}
                        {sec.items.map((i, k) => <MenuItem key={`${i.key}-${i.sub ?? ''}-${k}`} active={isActive(i)} onClick={() => goOrg(hrefOf(i))} right={i.gear ? <Icon d={ICONS.gear} size={16} /> : undefined}>{i.label}</MenuItem>)}</div>))}
                  </div>}
                </div>);
            })}
          </nav>
        )}
      </header>

      {org && (
        <div className="border-b border-slate-200 bg-white px-6">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
            <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-slate-500">
              <span className="truncate font-semibold text-slate-900">{org.name}</span>
              {crumb && <><span aria-hidden>›</span><span>{crumb[0]}</span>{crumb[1] && <><span aria-hidden>›</span><span aria-current="page" className="font-medium text-slate-800">{crumb[1]}</span></>}</>}
            </nav>
            {org.gstin && <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">GSTIN {org.gstin}</span>}
            <span className="ml-auto text-xs text-slate-500">Your role: <b className="capitalize text-slate-700">{role}</b></span>
          </div>
        </div>
      )}

      <main className="px-6 py-6">
        <div className="mx-auto max-w-7xl space-y-5">
          {route !== '/clients' && (
            <button onClick={() => (history.length > 1 ? history.back() : navigate(org ? `/o/${org.id}/dashboard` : '/clients'))} aria-label="Go back"
              className="flex items-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-slate-600 hover:bg-slate-200/60 hover:text-slate-900">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M15 18l-6-6 6-6" /></svg>Back
            </button>
          )}
          <ErrorBoundary key={route}>
            {route === '/clients' && <Clients me={me} orgs={orgs} firmRole={firmRole?.role} onOpen={(id) => navigate(`/o/${id}/dashboard`)} onChanged={load} />}
            {m && org && <OrgPage key={org.id} org={org} role={role} page={page} sub={sub} go={goOrg} onOrgChanged={load} lastLogin={me.lastLogin?.at} />}
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

/** Search box inside the top-bar search menu. Results come from the server as you type. */
function SearchPanel({ org, onPick }: { org: Org; onPick: (page: string) => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<{ type: string; id: number; title: string; subtitle: string; page: string }[]>([]);
  const latest = useRef(0);
  useEffect(() => {
    const mine = ++latest.current;
    if (q.trim().length < 2) { setResults([]); return; }
    const t = setTimeout(() => api(`/orgs/${org.id}/search?q=${encodeURIComponent(q.trim())}`).then((r) => mine === latest.current && setResults(r.results)).catch(() => undefined), 250);
    return () => clearTimeout(t);
  }, [q, org.id]);
  return (
    <div className="px-4">
      <input autoFocus aria-label="Search this organisation" placeholder="Search contacts, invoices, bills, items, projects…" className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="mt-2 max-h-80 overflow-y-auto">
        {q.trim().length >= 2 && results.length === 0 && <p className="py-3 text-sm text-slate-500">No matches.</p>}
        {results.map((r) => (
          <button key={`${r.type}-${r.id}`} onClick={() => onPick(r.page)} className="flex w-full items-center justify-between gap-3 rounded px-2 py-2 text-left text-sm hover:bg-slate-100">
            <span><span className="block font-medium text-slate-800">{r.title}</span>{r.subtitle && <span className="text-xs text-slate-500">{r.subtitle}</span>}</span>
            <span className="shrink-0 rounded bg-slate-100 px-2 py-0.5 text-xs capitalize text-slate-600">{r.type}</span>
          </button>))}
      </div>
    </div>
  );
}

/** Bell with a count of things needing attention; refreshed when the organisation changes and whenever it is opened. */
function Notifications({ org, onPick }: { org: Org; onPick: (page: string) => void }) {
  const [data, setData] = useState<{ count: number; items: { key: string; text: string; page: string; tone: string }[] } | null>(null);
  const refresh = useCallback(() => api(`/orgs/${org.id}/notifications`).then(setData).catch(() => undefined), [org.id]);
  useEffect(() => { refresh(); }, [refresh]);
  const dot: Record<string, string> = { bad: 'bg-red-500', warn: 'bg-amber-500', info: 'bg-blue-500' };
  return (
    <div onMouseDown={() => refresh()}>
      <Menu label="Notifications" align="right" width="w-96" trigger={
        <span className="relative"><Icon d={ICONS.bell} />{!!data?.count && <span data-testid="notification-count" className="absolute -right-2 -top-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold">{data.count}</span>}</span>}>
        {(close) => (<>
          <MenuHeading>Needs your attention</MenuHeading>
          {!data?.items.length ? <p className="px-5 py-3 text-sm text-slate-500">You are all caught up.</p>
            : data.items.map((n) => <MenuItem key={n.key} onClick={() => { close(); onPick(n.page); }}><span className="flex items-start gap-2"><span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dot[n.tone]}`} />{n.text}</span></MenuItem>)}
        </>)}
      </Menu>
    </div>
  );
}
