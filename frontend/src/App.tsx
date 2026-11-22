import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api, getToken, setToken, SessionEnded, wakeServer } from './api';
import { APP_NAME, Callout, ErrorBoundary, Logo } from './ui';
import { AuthScreen } from './pages/Auth';
import { Clients } from './pages/Clients';
import { areaOfPage, NAV, NavItem, OrgPage, PageKey } from './pages/OrgWorkspace';
import { Security } from './pages/Security';
import { TeamPage } from './pages/Team';
import { HUB, SETUP_SECTIONS } from './pages/Settings';
import { Billing, Help, Privacy } from './pages/Account';
import { PracticeOverview } from './pages/PracticeOverview';
import { favouriteReports } from './pages/Reports';
import { Sidebar } from './Sidebar';

export interface Me {
  id: number; email: string; fullName: string; twoFactorEnabled: boolean; emailVerified: boolean; lastLogin: { at: string; ip: string | null } | null;
  memberships: { firmId: number; firmName: string; orgId: number | null; role: string; access?: Record<string, string> | null }[];
}
export interface Org { id: number; name: string; gstin: string | null; firmId: number }

/** Hash routes: #/clients, #/practice, #/security, #/billing, #/privacy, #/help, #/o/<orgId>/<page>[/<sub>]. Refresh and the back button keep working. */
function useRoute() {
  const read = () => location.hash.replace(/^#/, '') || '/clients';
  const [route, setRoute] = useState(read());
  useEffect(() => { const f = () => { const r = read(); visited(r); setRoute(r); }; window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f); }, []);
  return route;
}
const navigate = (path: string) => { location.hash = path; };
/** Screens visited in this tab, so Back knows whether there is an earlier screen of the app to return to. */
const trail: string[] = [location.hash.replace(/^#/, '') || '/clients'];
const visited = (r: string) => { if (trail.length > 1 && trail[trail.length - 2] === r) trail.pop(); else if (trail[trail.length - 1] !== r) trail.push(r); };
const inAppSteps = { get current() { return trail.length - 1; } };

/** The bar uses one accent colour (the brand violet): a soft light tab for the current section, and the same violet tint inside every menu. */
interface Tone { pill: string; on: string; bar: string; item: string; itemOn: string; head: string }
const BAR: Tone = { pill: 'text-indigo-100 hover:bg-white/10 hover:text-white', on: 'bg-white/15 text-white', bar: 'border-brand-500', item: 'hover:bg-brand-50 focus-visible:bg-brand-50', itemOn: 'bg-brand-100 font-medium text-brand-800', head: 'text-brand-700' };
/** Menus that are not sections of the bar (create, search, notifications, account). */
const NEUTRAL: Tone = { ...BAR, pill: '', on: '', bar: 'border-slate-200', head: 'text-slate-500' };
const ToneCtx = createContext<Tone>(NEUTRAL);

/** The "+" menu. Alt + the letter works anywhere inside an organisation. */
const CREATE: [string, string, string][] = [
  ['Invoice', 'I', 'invoices/new'], ['Bill', 'B', 'bills/new'], ['Credit note', 'E', 'invoices/new-credit_note'], ['Debit note', 'D', 'bills/new-debit_note'], ['Contact', 'C', 'contacts/new'], ['Quote', 'Q', 'quotes/new'], ['Purchase order', 'O', 'purchase-orders/new'],
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
function Menu({ label, active, children, align = 'left', trigger, width = 'min-w-60', open: controlled, onOpenChange, onHover, tone }: {
  tone?: Tone; label: string; active?: boolean; children: (close: () => void) => ReactNode; align?: 'left' | 'right'; trigger?: ReactNode; width?: string;
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
          : `relative mx-0.5 flex h-9 items-center gap-1 rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-white ${tone ? (active || open ? `${tone.on}${active ? ' after:absolute after:inset-x-2 after:-bottom-[10px] after:h-0.5 after:rounded after:bg-white' : ''}` : tone.pill) : (active || open ? 'bg-white/10 text-white' : 'text-white hover:bg-white/10')}`}>
        {trigger ?? <>{label}<svg width="9" height="9" viewBox="0 0 10 10" aria-hidden className={`opacity-70 transition-transform ${open ? 'rotate-180' : ''}`}><path d="M1 3l4 4 4-4" fill="currentColor" /></svg></>}
      </button>
      {open && (
        <div className={`absolute top-full z-40 ${tone ? 'mt-3 border-t-4' : 'mt-1'} max-w-[calc(100vw-1rem)] ${width} rounded-lg border border-slate-200 ${tone?.bar ?? ''} bg-white py-2 text-slate-800 shadow-xl ${align === 'right' ? 'right-0' : 'left-0'}`}>
          <ToneCtx.Provider value={tone ?? NEUTRAL}>{children(() => setOpen(false))}</ToneCtx.Provider>
        </div>
      )}
    </div>
  );
}
const MenuItem = ({ active, onClick, children, right, shortcut }: { active?: boolean; onClick: () => void; children: ReactNode; right?: ReactNode; shortcut?: string }) => {
  const tone = useContext(ToneCtx);
  return (
    <button data-menu-entry onClick={onClick} aria-current={active ? 'page' : undefined} aria-keyshortcuts={shortcut ? `Alt+${shortcut}` : undefined}
      className={`flex w-full items-center justify-between gap-6 border-b-2 border-white px-5 py-2 text-left text-sm focus-visible:outline-none ${active ? tone.itemOn : `text-slate-700 ${tone.item}`}`}>
      {children}
      {right && <span aria-hidden>{right}</span>}
      {shortcut && <span aria-hidden className="flex gap-1 text-xs text-slate-500"><kbd className="rounded border border-slate-300 bg-slate-50 px-1.5">Alt</kbd><kbd className="rounded border border-slate-300 bg-slate-50 px-1.5">{shortcut}</kbd></span>}
    </button>
  );
};
const MenuHeading = ({ children }: { children: ReactNode }) => { const tone = useContext(ToneCtx); return <p className={`px-5 pb-1 pt-2 text-xs font-bold uppercase tracking-wide ${tone.head}`}>{children}</p>; };
const MenuDivider = () => <hr className="my-2 border-slate-200" />;


export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [loading, setLoading] = useState(!!getToken());
  const [waiting, setWaiting] = useState(false);
  const [startError, setStartError] = useState('');
  const [mobileOpen, setMobileOpen] = useState(false);
  // The side menu can shrink to icons; remembered in this browser.
  const [collapsed, setCollapsedState] = useState(() => { try { return localStorage.getItem('sidebar-collapsed') === '1'; } catch { return false; } });
  const setCollapsed = (v: boolean) => { setCollapsedState(v); try { localStorage.setItem('sidebar-collapsed', v ? '1' : '0'); } catch { /* storage may be off */ } };
  const route = useRoute();
  useEffect(() => { setMobileOpen(false); }, [route]);

  const load = useCallback(async () => {
    const token = getToken(); // if the user logs out (or in as someone else) while this runs, drop the stale result
    setStartError('');
    // Only a refused login logs the person out. A server that is slow, starting up or unreachable is waited for,
    // otherwise opening the page after a quiet spell threw away a perfectly good login.
    for (let attempt = 0; ; attempt++) {
      try {
        const nextMe = await api<Me>('/auth/me'), nextOrgs = await api<Org[]>('/orgs');
        if (getToken() === token) { setMe(nextMe); setOrgs(nextOrgs); }
        break;
      } catch (e) {
        if (getToken() !== token || e instanceof SessionEnded) { if (!getToken()) setMe(null); break; }
        if (attempt < 3) { setWaiting(true); await new Promise((r) => setTimeout(r, 3000)); await wakeServer(); continue; }
        setStartError((e as Error).message || 'Could not load your account.');
        break;
      }
    }
    setWaiting(false);
    setLoading(false);
  }, []);
  useEffect(() => { if (getToken()) load(); }, [load]);
  // A login that ends while the app is open (8 hours, or the password was changed elsewhere) goes back to the login page with the reason.
  useEffect(() => {
    const ended = (e: Event) => {
      setMe(null); setOrgs([]);
      setNotice((e as CustomEvent).detail === 'Your password was changed. Log in again.' ? 'Your password was changed. Log in again.' : 'You were logged out because the session ended. Log in again.');
    };
    window.addEventListener('session-ended', ended);
    return () => window.removeEventListener('session-ended', ended);
  }, []);

  const m = /^\/o\/(\d+)\/([\w-]+)(?:\/([\w-]+))?$/.exec(route);
  const org = m && me ? orgs.find((o) => o.id === Number(m[1])) ?? null : null;
  const page = (m?.[2] ?? 'dashboard') as PageKey, sub = m?.[3];
  const roleOnOrg = (o: Org) => (me?.memberships.find((x) => x.orgId === o.id) ?? me?.memberships.find((x) => x.orgId === null && x.firmId === o.firmId))?.role ?? 'client';
  const role = org ? roleOnOrg(org) : '';
  const canManage = role === 'owner' || role === 'accountant', canPost = !!org && role !== 'client';
  const goOrg = (p: string) => org && navigate(`/o/${org.id}/${p}`);

  // A link from a confirmation email (#/verify?token=...): confirm the address, then carry on at the client list.
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const v = /^#\/verify\?token=([0-9a-f]{20,200})$/.exec(location.hash);
    if (!v) return;
    history.replaceState(null, '', location.pathname + '#/clients');
    api('/auth/verify-email', { body: { token: v[1] } }).then(() => { setNotice('Thank you. Your email address is confirmed.'); load(); }).catch((e) => setNotice((e as Error).message));
  }, [load]);

  // Sales people and employees see a few pages only, so their "+" menu, search and notifications are narrower or absent.
  const narrow = role === 'sales' || role === 'employee';
  const createItems = narrow ? (role === 'sales' ? CREATE.filter(([, k]) => ['I', 'Q', 'C'].includes(k)) : []) : CREATE;
  // Access per person: sections the firm owner closed for this person are left out of the menu.
  const access = org ? (me?.memberships.find((x) => x.orgId === org.id) ?? me?.memberships.find((x) => x.orgId === null && x.firmId === org.firmId))?.access ?? null : null;
  const allowed = (i: NavItem) => { const a = areaOfPage(i); return !access || !a || access[a] !== 'none'; };
  const visible = (i: NavItem) => (!i.manage || canManage) && (!i.owner || role === 'owner') && (!narrow || !!i.for?.includes(role as 'sales' | 'employee')) && allowed(i);

  // Opening "new invoice" (or bill, contact...) while already on that address does nothing by itself, for example right
  // after saving one. Step to the list and back so a fresh blank form opens every time.
  const openNew = (p: string) => {
    if (!org) return;
    const target = `/o/${org.id}/${p}`;
    if (route === target && target.endsWith('/new')) { navigate(target.slice(0, -4)); setTimeout(() => navigate(target), 0); } else navigate(target);
  };

  const sideGroups = NAV.map((g) => ({ group: g.group, items: g.items.filter(visible) })).filter((g) => g.items.length > 0);

  // Alt + letter shortcuts from the "+" menu.
  useEffect(() => {
    if (!org || !canPost || !createItems.length) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const hit = createItems.find(([, k]) => k === e.key.toUpperCase());
      if (hit) { e.preventDefault(); openNew(hit[2]); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [org, canPost, role, route]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <p className="p-8 text-slate-500" role="status">{waiting ? 'The server is starting up. This can take up to 3 minutes after a quiet spell. You are still logged in…' : 'Loading…'}</p>;
  if (startError && !me && getToken()) return (
    <div className="p-8" role="alert">
      <p className="mb-3 text-slate-700">{startError}</p>
      <p className="mb-4 text-sm text-slate-500">You are still logged in. Nothing was lost.</p>
      <button type="button" className="mr-3 rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white" onClick={() => { setLoading(true); load(); }}>Try again</button>
      <button type="button" className="text-sm text-slate-600 underline" onClick={() => { setToken(null); setStartError(''); setMe(null); }}>Log out</button>
    </div>
  );
  if (!me) return <>{notice && <NoticeBar text={notice} onClose={() => setNotice('')} />}<AuthScreen onDone={() => { navigate('/clients'); setLoading(true); load(); }} /></>;

  const firmRole = me.memberships.find((x) => x.orgId === null);
  const canTeam = me.memberships.some((x) => x.orgId === null && (x.role === 'owner' || x.role === 'accountant'));
  const logout = () => { setToken(null); setMe(null); setOrgs([]); navigate('/clients'); };
  const isActive = (i: NavItem) => page === i.key && (!i.sub || i.sub === sub);
  /** "Sales › Invoices": where the current page lives in the menus. */
  const crumb: [string, string?] | null = (() => {
    if (!org) return null;
    const hit = (strict: boolean) => { for (const g of NAV) for (const i of g.items) if (i.key === page && (strict ? !i.sub || i.sub === sub : true)) return [g.group, g.items.length === 1 ? undefined : i.label] as [string, string?]; return null; };
    if (page === 'setup') return ['Settings', SETUP_SECTIONS[sub ?? '']] as [string, string?];
    return hit(true) ?? hit(false);
  })();

  // Back button: not on the start pages (client list, a client's dashboard), where there is nothing to go back to.
  // Elsewhere it returns to the previous screen; opened straight from a link, it goes to the page above this one.
  const back: string | null = (() => {
    if (route === '/clients' || route === '/' || route === '') return null;
    if (!m) return '/clients';
    if (!org || page === 'dashboard') return null;
    const base = `/o/${org.id}`;
    // A record or form under a list (customers/12, customers/edit-12, invoices/new) goes back to that list.
    if (sub && !['reports', 'compliance', 'money', 'setup'].includes(page)) return `${base}/${page}`;
    if (page === 'setup' || page === 'settings' || page === 'sales-settings' || page === 'purchases-settings') return `${base}/settings-hub`;
    return `${base}/dashboard`;
  })();
  const backLabel = !back ? '' : back === '/clients' ? 'Clients' : back.endsWith('/settings-hub') ? 'Settings' : back.endsWith('/dashboard') ? 'Home' : 'the list';

  const content = (
    <>
      {notice && <NoticeBar text={notice} onClose={() => setNotice('')} />}
      {!me.emailVerified && <VerifyBar email={me.email} />}
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
          {back && (
            <button onClick={() => (inAppSteps.current > 0 ? history.back() : navigate(back))} aria-label="Go back" title={`Back to ${backLabel}`}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-slate-600 hover:bg-slate-200/60 hover:text-slate-900">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M15 18l-6-6 6-6" /></svg>Back
            </button>
          )}
          <ErrorBoundary key={route}>
            {route === '/clients' && <Clients me={me} orgs={orgs} firmRole={firmRole?.role} onOpen={(id) => navigate(`/o/${id}/dashboard`)} onChanged={load} />}
            {m && org && (allowed({ key: page, sub, label: '' })
              ? <OrgPage key={org.id} org={org} role={role} page={page} sub={sub} go={goOrg} onOrgChanged={load} lastLogin={me.lastLogin?.at} canTeam={canTeam} />
              : <Callout tone="warning" role="alert" title={`You do not have access to this part of ${org.name}'s books.`}>The firm owner has limited what you can open here. Ask them if you need it.</Callout>)}
            {m && !org && <p className="text-sm text-slate-600">That client was not found, or you do not have access.</p>}
            {route === '/practice' && <PracticeOverview onOpen={(id) => navigate(`/o/${id}/dashboard`)} />}
            {route === '/security' && <Security me={me} onChanged={load} />}
            {route === '/team' && <TeamPage me={me} orgs={orgs} />}
            {route.startsWith('/invite?token=') && <InviteAccept me={me} token={route.slice('/invite?token='.length)} onDone={() => { setLoading(true); load().then(() => navigate('/clients')); }} />}
            {route === '/billing' && <Billing me={me} />}
            {route === '/privacy' && <Privacy onDeleted={() => { setMe(null); setOrgs([]); navigate('/clients'); }} />}
            {route === '/help' && <Help />}
          </ErrorBoundary>
        </div>
      </main>
    </>
  );

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 bg-nav text-white shadow-md">
        <div className="flex h-14 items-center gap-1 px-3">
          {org && <button className="mr-1 flex h-10 w-10 items-center justify-center rounded-md hover:bg-white/15 lg:hidden" aria-label={mobileOpen ? 'Close menu' : 'Open menu'} aria-expanded={mobileOpen} onClick={() => setMobileOpen(!mobileOpen)}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d={mobileOpen ? 'M6 6l12 12M18 6L6 18' : 'M4 7h16M4 12h16M4 17h16'} /></svg></button>}
          <button className={`mr-1 items-center gap-2 rounded-md px-2 py-1 text-lg font-bold tracking-tight hover:bg-white/10 ${org ? 'hidden sm:flex' : 'flex'}`} onClick={() => navigate('/clients')} aria-label={`${APP_NAME} home`}><Logo /><span className="hidden 2xl:inline">{APP_NAME}</span></button>

          <Menu label="Organisation menu" width="w-80" trigger={
            <span className="flex max-w-24 items-center gap-2 text-sm font-semibold sm:max-w-56"><span className="truncate">{org?.name ?? 'All clients'}</span><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden><path d="M1 3l4 4 4-4" fill="currentColor" /></svg></span>}>
            {(close) => {
              const to = (p: string) => { close(); navigate(p); };
              return (<>
                {org && <>
                  <div className="flex items-center gap-3 px-5 py-2"><span className="flex h-9 w-9 items-center justify-center rounded bg-brand-100 text-xs font-bold text-brand-800">{initialsOf(org.name)}</span><span className="font-semibold">{org.name}</span></div>
                  {!narrow && <MenuItem onClick={() => to(`/o/${org.id}/settings-hub`)}>Settings</MenuItem>}
                  {canTeam && <MenuItem active={route === '/team'} onClick={() => to('/team')}>People and access</MenuItem>}
                  {!narrow && <MenuItem onClick={() => to('/billing')}>Subscription and billing</MenuItem>}
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

          <div className="ml-auto flex items-center gap-1">
            {org && canPost && createItems.length > 0 && (
              <Menu label="Create new" align="right" width="w-72" trigger={<Icon d={ICONS.plus} />}>
                {(close) => (<>
                  <MenuHeading>Create new</MenuHeading>
                  {createItems.map(([l, k, p]) => <MenuItem key={l} shortcut={k} onClick={() => { close(); openNew(p); }}>{l}</MenuItem>)}
                </>)}
              </Menu>
            )}
            {org && !narrow && (
              <Menu label="Search" align="right" width="w-[28rem]" trigger={<Icon d={ICONS.search} />}>
                {(close) => <SearchPanel org={org} onPick={(p) => { close(); goOrg(p); }} />}
              </Menu>
            )}
            <button aria-label="Help" title="Help" onClick={() => navigate('/help')} className="hidden h-10 w-10 items-center justify-center rounded-md hover:bg-white/15 sm:flex"><Icon d={ICONS.help} /></button>
            {org && !narrow && <Notifications org={org} onPick={(p) => goOrg(p)} />}
            <nav aria-label="Account" className="ml-1">
              <Menu label="Account menu" align="right" width="w-64" trigger={<span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-500 text-xs font-bold ring-2 ring-white/30">{initialsOf(me.fullName)}</span>}>
                {(close) => {
                  const to = (p: string) => { close(); navigate(p); };
                  return (<>
                    <div className="border-b border-slate-100 px-5 pb-2"><p className="text-sm font-semibold">{me.fullName}</p><p className="text-xs text-slate-500">{me.email}</p></div>
                    <MenuItem active={route === '/clients'} onClick={() => to('/clients')}>Clients</MenuItem>
                    {canTeam && <MenuItem active={route === '/practice'} onClick={() => to('/practice')}>Practice</MenuItem>}
                    {canTeam && <MenuItem active={route === '/team'} onClick={() => to('/team')}>People and access</MenuItem>}
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
      </header>

      {org ? (
        <div className="flex">
          {/* Left side menu (wide screens); on small screens the same menu opens as a drawer */}
          <aside className={`sticky top-14 hidden h-[calc(100vh-3.5rem)] shrink-0 border-r border-slate-200 bg-white transition-[width] duration-200 lg:block ${collapsed ? 'w-16' : 'w-64'}`}>
            <Sidebar org={org} groups={sideGroups} isActive={isActive} onGo={goOrg} favourites={favouriteReports()} collapsed={collapsed}
              onExpand={() => setCollapsed(false)} onToggleCollapse={() => setCollapsed(!collapsed)} />
          </aside>
          {mobileOpen && (
            <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
              <button aria-label="Close menu" className="absolute inset-0 h-full w-full cursor-default bg-slate-900/40" onClick={() => setMobileOpen(false)} />
              <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] overflow-hidden bg-white shadow-2xl">
                <Sidebar org={org} groups={sideGroups} isActive={isActive} onGo={(p) => { setMobileOpen(false); goOrg(p); }} favourites={favouriteReports()} showCollapse={false} />
              </aside>
            </div>)}
          <div className="min-w-0 flex-1">{content}</div>
        </div>
      ) : content}
    </div>
  );
}

const NoticeBar = ({ text, onClose }: { text: string; onClose: () => void }) => (
  <div role="status" className="flex items-center justify-between gap-3 bg-green-50 px-6 py-2 text-sm text-green-900"><span>{text}</span><button className="font-medium underline" onClick={onClose}>Dismiss</button></div>
);

/** Shown until the email address is confirmed. Nothing is blocked; the link in the sign-up email does it. */
function VerifyBar({ email }: { email: string }) {
  const [msg, setMsg] = useState('');
  const send = () => api('/auth/resend-verification', { body: {} }).then(() => setMsg(`A new link was sent to ${email}.`)).catch((e) => setMsg((e as Error).message));
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-amber-50 px-6 py-2 text-sm text-amber-900">
      <span>Please confirm your email address. We sent a link to <b>{email}</b>.</span>
      <button className="font-medium underline" onClick={send}>Send it again</button>{msg && <span role="status">{msg}</span>}
    </div>
  );
}

/** Opened from an invitation email while logged in: accept it if it was meant for this login. */
function InviteAccept({ me, token, onDone }: { me: Me; token: string; onDone: () => void }) {
  const [info, setInfo] = useState<{ email: string; firmName: string; orgName: string | null; roleText: string } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { api(`/auth/invitations/${token}`).then(setInfo).catch((e) => setError((e as Error).message)); }, [token]);
  if (error) return <Callout tone="error">{error}</Callout>;
  if (!info) return <p className="text-sm text-slate-500">Checking your invitation…</p>;
  const mine = info.email.toLowerCase() === me.email.toLowerCase();
  return (
    <div className="max-w-xl rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h1 className="text-xl font-bold text-slate-900">You are invited to {info.firmName}</h1>
      <p className="mt-2 text-sm text-slate-600">{info.orgName ? `For ${info.orgName}. ` : ''}Your access: <b>{info.roleText}</b>.</p>
      {mine ? <button className="mt-4 rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700" onClick={() => api('/auth/invitations/accept', { body: { token } }).then(onDone).catch((e) => setError((e as Error).message))}>Accept invitation</button>
        : <p className="mt-3 text-sm text-amber-800">This invitation was sent to <b>{info.email}</b>, but you are logged in as {me.email}. Log out and log in with that address to accept it.</p>}
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
  // Screens and settings match by name or description too ("lock", "prefix", "upi", "ledger"…).
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const features = q.trim().length < 2 ? [] : [
    ...NAV.flatMap((g) => g.items.map((i) => ({ title: i.label, subtitle: g.group, page: i.sub ? `${i.key}/${i.sub}` : i.key }))),
    ...HUB.flatMap((g) => g.tiles.map((t) => ({ title: t.label, subtitle: `Settings · ${t.desc}`, page: t.to }))),
    { title: 'Lock dates', subtitle: 'Settings · Financial settings · lock the books', page: 'setup/financial' },
    { title: 'Number prefixes', subtitle: 'Settings · Invoice settings · invoice, bill, journal numbering', page: 'setup/invoice' },
    { title: 'Credit note', subtitle: 'Sales · new credit note against an invoice', page: 'invoices/new-credit_note' },
    { title: 'Debit note', subtitle: 'Purchases · new debit note against a bill', page: 'bills/new-debit_note' },
  ].filter((x, i, all) => all.findIndex((y) => y.page === x.page && y.title === x.title) === i)
   .filter((x) => words.every((w) => `${x.title} ${x.subtitle}`.toLowerCase().includes(w))).slice(0, 6);
  const pick = (page: string) => (page.startsWith('#/') ? (location.hash = page.slice(1)) : onPick(page));
  return (
    <div className="px-4">
      <input autoFocus aria-label="Search this organisation" placeholder="Search records, screens and settings…" className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="mt-2 max-h-80 overflow-y-auto">
        {q.trim().length >= 2 && results.length === 0 && features.length === 0 && <p className="py-3 text-sm text-slate-500">No matches.</p>}
        {features.map((r) => (
          <button key={`f-${r.page}-${r.title}`} onClick={() => pick(r.page)} className="flex w-full items-center justify-between gap-3 rounded px-2 py-2 text-left text-sm hover:bg-slate-100">
            <span><span className="block font-medium text-slate-800">{r.title}</span><span className="text-xs text-slate-500">{r.subtitle}</span></span>
            <span className="shrink-0 rounded bg-brand-50 px-2 py-0.5 text-xs text-brand-700">{r.subtitle.startsWith('Settings') ? 'Setting' : 'Screen'}</span>
          </button>))}
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
