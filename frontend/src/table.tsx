// Shared list tools: coloured action icons, the "⋮" row menu, export to Excel / PDF / CSV / XML, and a table with search,
// sort, a column chooser (show, hide, reorder) and a saved view per person and page.
import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { postDownload } from './api';

// ------------------------------------------------------------------ icons
const P: Record<string, string> = {
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z',
  trash: 'M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14M10 11v6m4-6v6',
  archive: 'M3 4h18v4H3zM5 8v12h14V8M10 12h4',
  restore: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5',
  download: 'M12 3v12m0 0 4-4m-4 4-4-4M4 17v3h16v-3',
  pdf: 'M14 3H6v18h12V7Zm0 0v4h4M9 13h6M9 17h6',
  mail: 'M3 6h18v12H3zM3 7l9 6 9-6',
  bell: 'M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10 21h4',
  view: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  money: 'M3 7h18v10H3zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6M6 10v4m12-4v4',
  note: 'M5 3h10l4 4v14H5zM9 12h6M9 16h4',
  repeat: 'M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4m14-1v2a3 3 0 0 1-3 3H3',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  dots: 'M12 5h.01M12 12h.01M12 19h.01',
  columns: 'M3 4h18v16H3zM9 4v16m6-16v16',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm10 3-5-5',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  unlink: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7M4 4l16 16',
  up: 'M12 19V5m-6 6 6-6 6 6', down: 'M12 5v14m6-6-6 6-6-6',
  plus: 'M12 5v14M5 12h14', check: 'M20 6 9 17l-5-5', lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4',
  statement: 'M4 4h16v16H4zM8 9h8M8 13h8M8 17h5',
};
/** Colour of each action, so the same action looks the same everywhere: red for delete, amber for archive and so on. */
const TINT: Record<string, string> = {
  edit: 'text-brand-600', trash: 'text-red-600', archive: 'text-amber-600', restore: 'text-emerald-600', download: 'text-sky-600', pdf: 'text-rose-600',
  mail: 'text-sky-600', bell: 'text-amber-600', view: 'text-slate-600', money: 'text-emerald-600', note: 'text-violet-600', repeat: 'text-indigo-600',
  copy: 'text-slate-600', link: 'text-sky-600', unlink: 'text-red-600', statement: 'text-teal-600', lock: 'text-slate-600',
};
export type IconName = keyof typeof P;
export const Icon = ({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={className ?? TINT[name] ?? 'text-slate-600'}><path d={P[name]} /></svg>
);

/** A small button with only an icon (the label is read out by screen readers and shown as a tooltip). */
export const IconButton = ({ icon, label, onClick, disabled }: { icon: IconName; label: string; onClick: () => void; disabled?: boolean }) => (
  <button type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled}
    className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-slate-100 disabled:opacity-40"><Icon name={icon} /></button>
);

// ------------------------------------------------------------------ popovers
function useOutside(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', down); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [open, close]);
  return ref;
}

/**
 * Where to draw a pop-up menu: fixed to the screen under its button, so a list that scrolls sideways (inside a card)
 * does not cut it off. Closes when the page scrolls or resizes.
 */
function useAnchor(open: boolean, close: () => void, width: number) {
  const btn = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<React.CSSProperties>({});
  useEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8));
    const below = window.innerHeight - r.bottom;
    setPos(below < 260 && r.top > below ? { position: 'fixed', left, bottom: window.innerHeight - r.top + 4, width } : { position: 'fixed', left, top: r.bottom + 4, width });
    const shut = (e: Event) => { if (!(e.target instanceof Node) || !(e.target as HTMLElement).closest?.('[data-popover]')) close(); };
    window.addEventListener('scroll', shut, true); window.addEventListener('resize', close);
    return () => { window.removeEventListener('scroll', shut, true); window.removeEventListener('resize', close); };
  }, [open, close, width]);
  return { btn, pos };
}

export interface MenuAction { label: string; icon?: IconName; onClick: () => void; hidden?: boolean; danger?: boolean; disabled?: boolean }
/** The "⋮" menu at the end of a row: every less-used action for that row, each with its coloured icon. */
export function RowMenu({ label, actions }: { label: string; actions: MenuAction[] }) {
  const [open, setOpen] = useState(false);
  const shut = useCallback(() => setOpen(false), []);
  const ref = useOutside(open, shut);
  const { btn, pos } = useAnchor(open, shut, 224);
  const shown = actions.filter((a) => !a.hidden);
  if (!shown.length) return null;
  return (
    <div ref={ref} className="relative inline-block text-left">
      <button ref={btn} type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-600 hover:bg-slate-100"><Icon name="dots" size={18} className="text-slate-600" /></button>
      {open && (
        <div role="menu" data-popover style={pos} className="z-50 rounded-lg border border-slate-200 bg-white py-1 shadow-xl">
          {shown.map((a) => (
            <button key={a.label} type="button" role="menuitem" disabled={a.disabled} onClick={() => { setOpen(false); a.onClick(); }}
              className={`flex w-full items-center gap-2 whitespace-nowrap px-3 py-2 text-left text-sm hover:bg-slate-50 disabled:opacity-40 ${a.danger ? 'text-red-700' : 'text-slate-700'}`}>
              {a.icon && <Icon name={a.icon} />}{a.label}</button>))}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ export
export type Cell = string | number | null;
export interface ExportColumn { header: string; money?: boolean }
export interface ExportTable { title: string; subtitle?: string; columns: ExportColumn[]; rows: Cell[][]; boldRows?: number[] }
export const FORMATS = [['xlsx', 'Excel'], ['pdf', 'PDF'], ['csv', 'CSV'], ['xml', 'XML']] as const;
export type ExportFormat = (typeof FORMATS)[number][0];

export async function exportTable(orgId: number, t: ExportTable, format: ExportFormat) {
  const name = (t.title.replace(/[^\w -]+/g, '').trim().replace(/\s+/g, '-') || 'export') + '.' + format;
  await postDownload(`/orgs/${orgId}/export-table`, {
    title: t.title, subtitle: t.subtitle ?? '', format, boldRows: t.boldRows,
    columns: t.columns.map((c) => ({ header: c.header, type: c.money ? 'money' : 'text' })),
    rows: t.rows.map((r) => r.map((v) => (v == null ? null : typeof v === 'number' ? v : String(v)))),
  }, name);
}

/** "Export ▾": Excel, PDF, CSV or XML of whatever table the page builds when it is clicked. */
export function ExportMenu({ orgId, build, label = 'Export', disabled }: { orgId: number; build: () => ExportTable; label?: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [err, setErr] = useState('');
  const shut = useCallback(() => setOpen(false), []);
  const ref = useOutside(open, shut);
  const { btn, pos } = useAnchor(open, shut, 176);
  const go = async (f: ExportFormat) => {
    setOpen(false); setBusy(true); setErr('');
    try { await exportTable(orgId, build(), f); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div ref={ref} className="relative inline-block">
      <button ref={btn} type="button" aria-haspopup="menu" aria-expanded={open} disabled={disabled || busy} onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50">
        <Icon name="download" />{busy ? 'Exporting…' : label}<span aria-hidden className="text-xs">▾</span></button>
      {open && (
        <div role="menu" data-popover style={pos} className="z-50 rounded-lg border border-slate-200 bg-white py-1 shadow-xl">
          {FORMATS.map(([f, name]) => <button key={f} type="button" role="menuitem" onClick={() => go(f)} className="block w-full px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50">{name} (.{f})</button>)}
        </div>
      )}
      {err && <p role="alert" className="absolute right-0 z-30 mt-1 w-64 rounded bg-red-50 px-2 py-1 text-xs text-red-700">{err}</p>}
    </div>
  );
}

// ------------------------------------------------------------------ the list table
export interface Column<T> {
  key: string;
  label: string;
  /** The plain value: used to search, sort and export. Money is in paise. */
  value: (r: T) => string | number | null | undefined;
  /** How the cell looks on screen (defaults to the plain value). */
  render?: (r: T) => ReactNode;
  money?: boolean;
  /** Not shown until the person adds it from "Columns". */
  hidden?: boolean;
  /** Left out of search (for example amounts). */
  noSearch?: boolean;
  className?: string;
}
interface View { order: string[]; hidden: string[]; sort?: { key: string; dir: 1 | -1 } }
const readView = (id: string): View | null => { try { const v = localStorage.getItem(`view:${id}`); return v ? JSON.parse(v) : null; } catch { return null; } };
const writeView = (id: string, v: View | null) => { try { if (v) localStorage.setItem(`view:${id}`, JSON.stringify(v)); else localStorage.removeItem(`view:${id}`); } catch { /* storage may be off */ } };
const fmtMoney = (p: number) => { const neg = p < 0, a = Math.abs(p), r = Math.floor(a / 100).toString(), rest = r.slice(0, -3); return `${neg ? '-' : ''}${rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' : ''}${r.slice(-3)}.${String(a % 100).padStart(2, '0')}`; };

/**
 * A list with a search box, sortable headings, a column chooser (tick to show, arrows to move, "Save as my view",
 * "Back to default") and Export. Optional leading cell (tick boxes) and trailing cell (row actions).
 */
export function DataTable<T>({ id, rows, columns, rowKey, orgId, exportTitle, exportSubtitle, searchLabel = 'Search', empty = 'Nothing here yet.', toolbar,
  leading, leadingHead, trailing, rowClass, initialSort, testId }: {
  id: string; rows: T[]; columns: Column<T>[]; rowKey: (r: T) => string | number; orgId?: number; exportTitle?: string; exportSubtitle?: string;
  searchLabel?: string; empty?: string; toolbar?: ReactNode; leading?: (r: T) => ReactNode; leadingHead?: ReactNode; trailing?: (r: T) => ReactNode;
  rowClass?: (r: T) => string; initialSort?: { key: string; dir: 1 | -1 }; testId?: string;
}) {
  const defaults: View = useMemo(() => ({ order: columns.map((c) => c.key), hidden: columns.filter((c) => c.hidden).map((c) => c.key), sort: initialSort }), [columns, initialSort]);
  const [view, setView] = useState<View>(() => readView(id) ?? defaults);
  const [saved, setSaved] = useState(() => !!readView(id));
  const [q, setQ] = useState('');
  const [choosing, setChoosing] = useState(false);
  const stopChoosing = useCallback(() => setChoosing(false), []);
  const chooser = useOutside(choosing, stopChoosing);
  const { btn: chooserBtn, pos: chooserPos } = useAnchor(choosing, stopChoosing, 288);
  // Columns added to the page after a view was saved appear at the end.
  const order = [...view.order.filter((k) => columns.some((c) => c.key === k)), ...columns.map((c) => c.key).filter((k) => !view.order.includes(k))];
  const byKey = new Map(columns.map((c) => [c.key, c]));
  const visible = order.filter((k) => !view.hidden.includes(k)).map((k) => byKey.get(k)!).filter(Boolean);

  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const found = words.length ? rows.filter((r) => {
    const text = columns.filter((c) => !c.noSearch).map((c) => { const v = c.value(r); return v == null ? '' : c.money && typeof v === 'number' ? fmtMoney(v) : String(v); }).join(' ').toLowerCase();
    return words.every((w) => text.includes(w));
  }) : rows;
  const sortCol = view.sort ? byKey.get(view.sort.key) : undefined;
  const sorted = sortCol ? [...found].sort((a, b) => {
    const x = sortCol.value(a), y = sortCol.value(b);
    if (x == null || x === '') return 1; if (y == null || y === '') return -1;
    return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'en', { numeric: true, sensitivity: 'base' })) * view.sort!.dir;
  }) : found;

  const change = (v: View) => { setView(v); setSaved(false); };
  const sortBy = (k: string) => change({ ...view, sort: view.sort?.key === k ? { key: k, dir: view.sort.dir === 1 ? -1 : 1 } : { key: k, dir: 1 } });
  const move = (k: string, d: -1 | 1) => { const o = [...order], i = o.indexOf(k), j = i + d; if (j < 0 || j >= o.length) return; [o[i], o[j]] = [o[j], o[i]]; change({ ...view, order: o }); };
  const toggle = (k: string) => {
    const hidden = view.hidden.includes(k) ? view.hidden.filter((x) => x !== k) : [...view.hidden, k];
    if (hidden.length >= columns.length) return; // keep at least one column
    change({ ...view, hidden });
  };
  const build = (): ExportTable => ({
    title: exportTitle ?? 'Export', subtitle: [exportSubtitle, q ? `Search: "${q}"` : ''].filter(Boolean).join(' · '),
    columns: visible.map((c) => ({ header: c.label, money: c.money })),
    rows: sorted.map((r) => visible.map((c) => { const v = c.value(r); return v == null ? null : c.money ? (typeof v === 'number' ? v : null) : String(v); })),
  });

  return (
    <div data-testid={testId}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="relative min-w-48 flex-1 sm:max-w-xs">
          <span className="pointer-events-none absolute left-2.5 top-2.5"><Icon name="search" className="text-slate-400" /></span>
          <input type="search" aria-label={searchLabel} placeholder={searchLabel} value={q} onChange={(e) => setQ(e.target.value)}
            className="w-full rounded-md border border-slate-300 py-2 pl-8 pr-3 text-sm shadow-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200" /></label>
        {toolbar}
        <div className="ml-auto flex items-center gap-2">
          <div ref={chooser} className="relative">
            <button ref={chooserBtn} type="button" aria-haspopup="dialog" aria-expanded={choosing} onClick={() => setChoosing(!choosing)}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50"><Icon name="columns" />Columns</button>
            {choosing && (
              <div role="dialog" aria-label="Choose columns" data-popover style={chooserPos} className="z-50 rounded-lg border border-slate-200 bg-white p-3 shadow-xl">
                <p className="mb-2 text-xs text-slate-500">Tick to show, arrows to move. Your choice is kept on this browser.</p>
                <ul className="max-h-72 space-y-0.5 overflow-y-auto">{order.map((k, i) => { const c = byKey.get(k)!; return (
                  <li key={k} className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-slate-50">
                    <input type="checkbox" aria-label={`Show ${c.label}`} checked={!view.hidden.includes(k)} onChange={() => toggle(k)} />
                    <span className="flex-1">{c.label}</span>
                    <button type="button" aria-label={`Move ${c.label} left`} disabled={i === 0} onClick={() => move(k, -1)} className="rounded p-0.5 hover:bg-slate-200 disabled:opacity-30"><Icon name="up" size={14} /></button>
                    <button type="button" aria-label={`Move ${c.label} right`} disabled={i === order.length - 1} onClick={() => move(k, 1)} className="rounded p-0.5 hover:bg-slate-200 disabled:opacity-30"><Icon name="down" size={14} /></button>
                  </li>); })}</ul>
                <div className="mt-3 flex flex-wrap gap-2 border-t border-slate-100 pt-3">
                  <button type="button" className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white" onClick={() => { writeView(id, view); setSaved(true); setChoosing(false); }}>Save as my view</button>
                  <button type="button" className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700" onClick={() => { writeView(id, null); setView(defaults); setSaved(false); }}>Back to default</button>
                </div>
                {saved && <p className="mt-2 text-xs text-emerald-700">Saved view in use.</p>}
              </div>
            )}
          </div>
          {orgId && <ExportMenu orgId={orgId} build={build} disabled={!sorted.length} />}
        </div>
      </div>
      {sorted.length === 0 ? <p className="py-6 text-center text-sm text-slate-500">{q ? `Nothing matches "${q}".` : empty}</p> : (
        <table className="w-full text-sm">
          <thead><tr className="text-left">
            {leading && <th className="w-8">{leadingHead}</th>}
            {visible.map((c) => (
              <th key={c.key} className={c.money ? 'text-right' : ''} aria-sort={view.sort?.key === c.key ? (view.sort.dir === 1 ? 'ascending' : 'descending') : undefined}>
                <button type="button" onClick={() => sortBy(c.key)} className="inline-flex items-center gap-1 uppercase hover:text-slate-900">{c.label}
                  {view.sort?.key === c.key && <span aria-hidden>{view.sort.dir === 1 ? '▲' : '▼'}</span>}</button></th>))}
            {trailing && <th><span className="sr-only">Actions</span></th>}
          </tr></thead>
          <tbody>{sorted.map((r) => (
            <tr key={rowKey(r)} className={rowClass?.(r) ?? ''}>
              {leading && <td>{leading(r)}</td>}
              {visible.map((c) => <td key={c.key} className={`${c.money ? 'whitespace-nowrap text-right tabular-nums' : ''} ${c.className ?? ''}`}>{c.render ? c.render(r) : (() => { const v = c.value(r); return v == null || v === '' ? '—' : c.money && typeof v === 'number' ? fmtMoney(v) : String(v); })()}</td>)}
              {trailing && <td aria-label="Row actions" className="whitespace-nowrap text-right">{trailing(r)}</td>}
            </tr>))}</tbody>
        </table>
      )}
      {words.length > 0 && sorted.length > 0 && <p className="mt-2 text-xs text-slate-500">{sorted.length} of {rows.length} shown.</p>}
    </div>
  );
}
