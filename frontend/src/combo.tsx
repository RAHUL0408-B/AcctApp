// A themed type-to-search dropdown used for accounts, contacts, products, countries and the like.
// Typing completes the rest of the best match (Tab or Enter takes it), the arrow keys move through the list,
// and an optional "+ Create new …" sits at the bottom of the list.
import { Fragment, ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

export interface ComboOption {
  /** The text put in the box when this option is chosen (and matched exactly by the page). */
  text: string;
  /** Short code shown in its own column (an account code, an item code). */
  lead?: string;
  /** Main label (defaults to text). */
  label?: string;
  /** Second line or column in grey (HSN, GSTIN, group). */
  sub?: string;
  /** Extra words that also find this option. */
  keywords?: string;
}

const norm = (s: string) => s.trim().toLowerCase();

export function Combo({ value, onText, options, ariaLabel, placeholder, onCreate, createLabel = 'Create new', searchFirst, hint, className, invalid, icon, max = 60, disabled, onBlur, columns }: {
  value: string; onText: (text: string) => void; options: ComboOption[]; ariaLabel: string; placeholder?: string;
  onCreate?: (typed: string) => void; createLabel?: string;
  /** Show a "type to search" hint instead of the whole list until something is typed. */
  searchFirst?: boolean; hint?: string; className?: string; invalid?: boolean; icon?: ReactNode; max?: number; disabled?: boolean; onBlur?: () => void;
  /** Column headings for a compact table (lead, label, sub). */
  columns?: [string, string, string?];
}) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const [pos, setPos] = useState<React.CSSProperties>({});
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const typedKey = useRef(false);
  const completion = useRef<{ typed: string; full: string } | null>(null);
  const id = useId();

  const exact = options.find((o) => norm(o.text) === norm(value));
  const q = exact ? '' : norm(value);
  const words = q.split(/\s+/).filter(Boolean);
  const hay = (o: ComboOption) => `${o.text} ${o.lead ?? ''} ${o.label ?? ''} ${o.sub ?? ''} ${o.keywords ?? ''}`.toLowerCase();
  const starts = (o: ComboOption) => [o.text, o.lead ?? '', o.label ?? ''].some((t) => t.toLowerCase().startsWith(q));
  const matched = words.length ? options.filter((o) => words.every((w) => hay(o).includes(w))).sort((a, b) => Number(starts(b)) - Number(starts(a))) : options;
  const showHint = searchFirst && !words.length && !exact;
  const shown = showHint ? [] : matched.slice(0, max);
  const createAt = onCreate ? shown.length : -1;
  const count = shown.length + (onCreate ? 1 : 0);

  useEffect(() => { if (exact) setHi(Math.max(0, shown.indexOf(exact))); else setHi(0); }, [value, open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fixed to the screen under the box, so a table that scrolls sideways does not cut the list off.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = input.current?.getBoundingClientRect(); if (!r) return;
      const below = window.innerHeight - r.bottom, above = r.top;
      const width = Math.max(r.width, columns ? 420 : 280);
      const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
      setPos(below < 240 && above > below
        ? { position: 'fixed', left, width, bottom: window.innerHeight - r.top + 4, maxHeight: Math.min(360, above - 12) }
        : { position: 'fixed', left, width, top: r.bottom + 4, maxHeight: Math.min(360, below - 12) });
    };
    place();
    window.addEventListener('scroll', place, true); window.addEventListener('resize', place);
    return () => { window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); };
  }, [open, columns]);
  useEffect(() => { list.current?.querySelector(`[data-index="${hi}"]`)?.scrollIntoView({ block: 'nearest' }); }, [hi, open]);

  // Complete the rest of the best match as the person types (only for real key presses, not pasted or filled text).
  useLayoutEffect(() => {
    const c = completion.current; if (!c || !input.current) return;
    if (input.current.value === c.full) input.current.setSelectionRange(c.typed.length, c.full.length);
    completion.current = null;
  });

  const pick = (o: ComboOption) => { onText(o.text); setOpen(false); };
  const change = (v: string, inputType?: string) => {
    setOpen(true);
    if (typedKey.current && inputType === 'insertText' && v.trim()) {
      const best = options.find((o) => o.text.toLowerCase().startsWith(v.toLowerCase()));
      if (best && best.text.length > v.length) { completion.current = { typed: v, full: v + best.text.slice(v.length) }; onText(completion.current.full); typedKey.current = false; return; }
    }
    typedKey.current = false;
    onText(v);
  };
  const key = (e: React.KeyboardEvent<HTMLInputElement>) => {
    typedKey.current = e.key.length === 1 && !e.ctrlKey && !e.metaKey;
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) setOpen(true); else setHi((h) => Math.min(count - 1, h + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); }
    else if (e.key === 'Escape') { if (open) { e.preventDefault(); setOpen(false); } }
    else if ((e.key === 'Enter' || e.key === 'Tab') && open && count) {
      if (hi === createAt) { if (e.key === 'Enter') { e.preventDefault(); setOpen(false); onCreate!(value); } return; }
      const o = shown[hi];
      if (o && (words.length || e.key === 'Enter')) { if (e.key === 'Enter') e.preventDefault(); pick(o); }
      else setOpen(false);
    }
  };

  return (
    <div className={`relative ${className ?? ''}`}>
      {icon && <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2">{icon}</span>}
      <input ref={input} role="combobox" aria-label={ariaLabel} data-count={options.length} aria-expanded={open} aria-controls={id} aria-autocomplete="both" autoComplete="off" disabled={disabled}
        placeholder={placeholder} value={value}
        onChange={(e) => change(e.target.value, (e.nativeEvent as InputEvent).inputType)}
        onKeyDown={key} onFocus={(e) => { e.target.select(); }} onClick={() => setOpen(true)}
        onBlur={() => { setTimeout(() => setOpen(false), 120); onBlur?.(); }}
        className={`w-full rounded-md border bg-white py-1.5 ${icon ? 'pl-8' : 'pl-2.5'} pr-7 text-sm shadow-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200 disabled:bg-slate-100 ${invalid ? 'border-amber-400 bg-amber-50' : 'border-slate-300'}`} />
      <button type="button" tabIndex={-1} aria-hidden onMouseDown={(e) => { e.preventDefault(); setOpen(!open); input.current?.focus(); }}
        className="absolute right-1 top-1/2 -translate-y-1/2 rounded px-1 text-[10px] text-brand-700">▼</button>
      {open && !disabled && (
        <div ref={list} id={id} role="listbox" aria-label="Suggestions" data-popover style={pos}
          className="z-[60] flex flex-col overflow-hidden rounded-lg border border-brand-100 bg-white text-sm shadow-xl" onMouseDown={(e) => e.preventDefault()}>
          {columns && shown.length > 0 && <div className="grid grid-cols-[6rem_1fr_7rem] gap-2 border-b border-brand-100 bg-brand-50 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-brand-800"><span>{columns[0]}</span><span>{columns[1]}</span><span>{columns[2] ?? ''}</span></div>}
          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            {showHint && <p className="px-3 py-2 text-slate-500">{hint ?? 'Type a code or name to search…'}</p>}
            {!showHint && !shown.length && <p className="px-3 py-2 text-slate-500">Nothing matches "{value}".</p>}
            {shown.map((o, i) => (
              <div key={`${o.text}-${i}`} role="option" aria-selected={i === hi} data-index={i} data-value={o.text} onMouseEnter={() => setHi(i)} onClick={() => pick(o)}
                className={`cursor-pointer px-3 py-1.5 ${i === hi ? 'bg-brand-50 text-brand-800' : 'text-slate-800'} ${columns ? 'grid grid-cols-[6rem_1fr_7rem] gap-2' : 'flex items-baseline gap-3'}`}>
                {o.lead != null && <span className={`${columns ? '' : 'w-14 shrink-0'} tabular-nums text-slate-500`}>{o.lead}</span>}
                <span className={`min-w-0 flex-1 truncate ${i === hi ? 'font-medium' : ''}`}>{o.label ?? o.text}</span>
                {o.sub && <span className="shrink-0 truncate text-xs text-slate-500">{o.sub}</span>}
              </div>))}
            {matched.length > shown.length && <p className="px-3 py-1 text-xs text-slate-400">Type more to narrow {matched.length - shown.length} more…</p>}
          </div>
          {onCreate && (
            <div className="border-t border-brand-100 p-1.5">
              <button type="button" role="option" aria-selected={hi === createAt} data-index={createAt} onClick={() => { setOpen(false); onCreate(value); }}
                className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 font-medium text-brand-700 ${hi === createAt ? 'bg-brand-100' : 'bg-brand-50 hover:bg-brand-100'}`}>
                <span aria-hidden>＋</span>{createLabel}</button>
            </div>)}
        </div>
      )}
    </div>
  );
}

/**
 * A themed single-choice dropdown (instead of the browser's own select): the choices in a list with an optional note on
 * the right (a number range) and an optional action at the bottom ("+ New group…").
 */
export function PickList({ value, onChange, options, ariaLabel, placeholder = 'Choose…', footer, disabled, className }: {
  value: string; onChange: (v: string) => void; options: { value: string; label: string; right?: string; group?: string }[]; ariaLabel: string; placeholder?: string;
  footer?: { label: string; onClick: () => void }; disabled?: boolean; className?: string;
}) {
  const [open, setOpen] = useState(false), [hi, setHi] = useState(0);
  const [pos, setPos] = useState<React.CSSProperties>({});
  const btn = useRef<HTMLButtonElement>(null), box = useRef<HTMLDivElement>(null);
  const id = useId();
  const chosen = options.find((o) => o.value === value);
  const n = options.length + (footer ? 1 : 0);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = btn.current?.getBoundingClientRect(); if (!r) return;
      const below = window.innerHeight - r.bottom, above = r.top, width = Math.max(r.width, 260);
      setPos(below < 220 && above > below ? { position: 'fixed', left: r.left, width, bottom: window.innerHeight - r.top + 4, maxHeight: Math.min(360, above - 12) }
        : { position: 'fixed', left: r.left, width, top: r.bottom + 4, maxHeight: Math.min(360, below - 12) });
    };
    place(); setHi(Math.max(0, options.findIndex((o) => o.value === value)));
    const down = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('scroll', place, true); window.addEventListener('resize', place); document.addEventListener('mousedown', down);
    return () => { window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); document.removeEventListener('mousedown', down); };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const choose = (i: number) => { setOpen(false); btn.current?.focus(); if (i === options.length) footer?.onClick(); else onChange(options[i].value); };
  const key = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) setOpen(true); else setHi((h) => Math.min(n - 1, h + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); }
    else if ((e.key === 'Enter' || e.key === ' ') && open) { e.preventDefault(); choose(hi); }
    else if (e.key === 'Escape' && open) { e.preventDefault(); setOpen(false); }
  };
  return (
    <div className={className}>
      <button ref={btn} type="button" role="combobox" aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} aria-controls={id} disabled={disabled}
        onClick={() => setOpen(!open)} onKeyDown={key}
        className={`flex w-full items-center justify-between gap-2 rounded-md border bg-white px-3 py-2 text-left text-sm shadow-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400 ${open ? 'border-brand-500 ring-2 ring-brand-200' : 'border-slate-300'}`}>
        <span className={`truncate ${chosen ? 'text-slate-900' : 'text-slate-500'}`}>{chosen?.label ?? placeholder}</span>
        <span aria-hidden className="text-xs text-brand-700">▾</span></button>
      {open && (
        <div ref={box} id={id} role="listbox" aria-label="Choices" data-popover style={pos} className="z-[60] flex flex-col overflow-hidden rounded-lg border border-brand-100 bg-white text-sm shadow-xl">
          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            {options.map((o, i) => (<Fragment key={o.value}>
              {o.group && o.group !== options[i - 1]?.group && <p role="presentation" className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-brand-700">{o.group}</p>}
              <div role="option" aria-selected={o.value === value} data-value={o.value} onMouseEnter={() => setHi(i)} onClick={() => choose(i)}
                className={`flex cursor-pointer items-center justify-between gap-3 px-3 py-2 ${i === hi ? 'bg-brand-50 text-brand-900' : 'text-slate-800'} ${o.value === value ? 'font-medium' : ''}`}>
                <span className="truncate">{o.label}</span>{o.right && <span className="shrink-0 text-xs tabular-nums text-slate-500">{o.right}</span>}</div></Fragment>))}
            {!options.length && <p className="px-3 py-2 text-slate-500">Nothing to choose yet.</p>}
          </div>
          {footer && <div className="border-t border-brand-100 p-1">
            <div role="option" aria-selected={false} onMouseEnter={() => setHi(options.length)} onClick={() => choose(options.length)}
              className={`cursor-pointer rounded-md px-3 py-2 font-medium text-brand-700 ${hi === options.length ? 'bg-brand-50' : ''}`}>＋ {footer.label}</div></div>}
        </div>)}
    </div>
  );
}
