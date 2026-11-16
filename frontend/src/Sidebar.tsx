// The client's sections as a left sidebar: each section opens to show its pages, the current page is highlighted, and the
// whole bar can shrink to icons. On small screens the same sidebar slides in as a drawer.
import { useEffect, useState } from 'react';
import type { Org } from './App';
import type { NavItem } from './pages/OrgWorkspace';

export interface NavGroup { group: string; items: NavItem[] }

/** One icon per section (24px stroke paths). */
const GROUP_ICON: Record<string, string> = {
  Home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  Sales: 'M7 3h8l4 4v14H7zM15 3v4h4M10 12h6M10 16h6',
  Purchases: 'M3 4h2l2.4 11h11.2L21 7H6.2M9 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM18 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  Reporting: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  Accounting: 'M4 5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-2zM4 17a2 2 0 0 1 2-2h12M9 7h6',
  Tax: 'M19 5L5 19M7.5 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM16.5 18a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
  Contacts: 'M16 11a4 4 0 1 0-8 0 4 4 0 0 0 8 0zM4 21c0-4 4-6 8-6s8 2 8 6',
  Projects: 'M4 7h16v12H4zM9 7V5h6v2',
  Settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
};
const Ico = ({ d, size = 18 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={d} /></svg>
);
const initialsOf = (name: string) => name.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const hrefOf = (i: NavItem) => (i.sub ? `${i.key}/${i.sub}` : i.key);
const OPEN_KEY = 'sidebar-open-sections';

function loadOpen(): string[] { try { return JSON.parse(localStorage.getItem(OPEN_KEY) ?? '[]'); } catch { return []; } }
function saveOpen(v: string[]) { try { localStorage.setItem(OPEN_KEY, JSON.stringify(v)); } catch { /* storage may be off */ } }

export function Sidebar({ org, groups, isActive, onGo, favourites, collapsed = false, onExpand, onToggleCollapse, showCollapse = true }: {
  org: Org; groups: NavGroup[]; isActive: (i: NavItem) => boolean; onGo: (path: string) => void;
  favourites: { key: string; label: string }[]; collapsed?: boolean;
  /** In the narrow icon bar: open the full bar again with this section open. */
  onExpand?: () => void; onToggleCollapse?: () => void; showCollapse?: boolean;
}) {
  const activeGroup = groups.find((g) => g.items.some(isActive))?.group;
  const [open, setOpen] = useState<string[]>(() => { const o = loadOpen(); return activeGroup && !o.includes(activeGroup) ? [...o, activeGroup] : o; });
  // The section holding the current page is always open.
  useEffect(() => { if (activeGroup && !open.includes(activeGroup)) setOpen((o) => [...o, activeGroup]); }, [activeGroup]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => saveOpen(open), [open]);
  const toggle = (g: string) => setOpen((o) => (o.includes(g) ? o.filter((x) => x !== g) : [...o, g]));

  const itemCls = (on: boolean) => `relative flex w-full items-center justify-between gap-2 rounded-md py-1.5 pl-3 pr-2 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-brand-500 ${on ? 'bg-brand-50 font-semibold text-brand-700 before:absolute before:inset-y-1 before:-left-[13px] before:w-[3px] before:rounded-full before:bg-brand-600' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'}`;

  return (
    <nav aria-label="Client sections" className="flex h-full flex-col">
      {/* The client this sidebar belongs to */}
      <div className={`flex items-center gap-3 border-b border-slate-100 ${collapsed ? 'justify-center px-2 py-3' : 'px-4 py-4'}`}>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-brand-500 to-brand-700 text-xs font-bold text-white" title={org.name}>{initialsOf(org.name)}</span>
        {!collapsed && <div className="min-w-0"><p className="truncate text-sm font-semibold text-slate-900">{org.name}</p><p className="truncate text-xs text-slate-500">{org.gstin ? `GSTIN ${org.gstin}` : 'No GSTIN'}</p></div>}
      </div>

      <div className={`flex-1 space-y-0.5 overflow-y-auto ${collapsed ? 'px-2 py-3' : 'px-3 py-3'}`}>
        {groups.map((g) => {
          const groupActive = g.items.some(isActive);
          const icon = GROUP_ICON[g.group] ?? GROUP_ICON.Home;
          const single = g.items.length === 1;
          const head = `flex w-full items-center gap-3 rounded-lg text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-brand-500 ${collapsed ? 'justify-center p-2.5' : 'px-3 py-2'}`;
          if (single) {
            const i = g.items[0];
            return <button key={g.group} title={collapsed ? i.label : undefined} aria-current={groupActive ? 'page' : undefined} onClick={() => onGo(hrefOf(i))}
              className={`${head} ${groupActive ? 'bg-brand-600 text-white shadow-sm' : 'text-slate-700 hover:bg-slate-100'}`}><Ico d={icon} />{!collapsed && <span>{i.label}</span>}</button>;
          }
          const isOpen = open.includes(g.group) && !collapsed;
          // Sections inside the group: a new one starts at each heading or divider.
          const sections: { heading?: string; items: NavItem[] }[] = [];
          for (const i of g.items) { if (!sections.length || i.heading || i.divider) sections.push({ heading: i.heading, items: [i] }); else sections[sections.length - 1].items.push(i); }
          return (
            <div key={g.group} role="group" aria-label={g.group}>
              <button title={collapsed ? g.group : undefined} aria-expanded={isOpen} onClick={() => { if (collapsed) { if (!open.includes(g.group)) toggle(g.group); onExpand?.(); } else toggle(g.group); }}
                className={`${head} ${groupActive ? (collapsed ? 'bg-brand-600 text-white' : 'text-brand-700') : 'text-slate-700 hover:bg-slate-100'}`}>
                <Ico d={icon} />
                {!collapsed && <><span className="flex-1 text-left">{g.group}</span>
                  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className={`text-slate-400 transition-transform ${isOpen ? 'rotate-90' : ''}`}><path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg></>}
              </button>
              {isOpen && (
                <div className="mb-1 ml-[22px] mt-0.5 border-l border-slate-200 pl-3">
                  {sections.map((sec, n) => (
                    <div key={n} className={n > 0 ? 'mt-1.5' : ''}>
                      {sec.heading && <p className="px-3 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{sec.heading}</p>}
                      {sec.items.map((i, k) => <button key={`${hrefOf(i)}-${k}`} aria-current={isActive(i) ? 'page' : undefined} onClick={() => onGo(hrefOf(i))} className={itemCls(isActive(i))}>
                        <span>{i.label}</span>{i.gear && <span aria-hidden className="text-slate-400"><Ico d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" size={14} /></span>}</button>)}
                    </div>))}
                  {g.group === 'Reporting' && (
                    <div className="mt-1.5">
                      <p className="px-3 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Favourite reports ★</p>
                      {favourites.length === 0 ? <p className="px-3 py-1 text-xs text-slate-400">Star a report to add it here.</p>
                        : favourites.map((f) => <button key={f.key} onClick={() => onGo(`reports/${f.key}`)} className={itemCls(false)}><span>{f.label}</span></button>)}
                    </div>)}
                </div>)}
            </div>);
        })}
      </div>

      {showCollapse && onToggleCollapse && (
        <div className="border-t border-slate-100 p-2">
          <button onClick={onToggleCollapse} aria-label={collapsed ? 'Expand the side menu' : 'Collapse the side menu'} title={collapsed ? 'Expand' : 'Collapse'}
            className={`flex w-full items-center gap-2 rounded-lg p-2 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800 ${collapsed ? 'justify-center' : ''}`}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={collapsed ? 'rotate-180' : ''}><path d="M15 18l-6-6 6-6M20 4v16" /></svg>
            {!collapsed && 'Collapse'}
          </button>
        </div>)}
    </nav>
  );
}
