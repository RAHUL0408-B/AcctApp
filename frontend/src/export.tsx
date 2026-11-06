// "Customize export": choose a template and options, then download a PDF or Excel file.
// Used by the reports, the invoice and bill lists, and anywhere else something can be exported.
import { useEffect, useState } from 'react';
import { Button, Card } from './ui';

export const TEMPLATES = [
  { name: 'classic', label: 'Classic', blurb: 'Black and white with ruled lines. Prints well anywhere.', accent: '#111111' },
  { name: 'modern', label: 'Modern', blurb: 'Coloured heading band and striped rows.', accent: '#4f46e5' },
  { name: 'minimal', label: 'Minimal', blurb: 'Light and airy, with plenty of white space.', accent: '#374151' },
  { name: 'corporate', label: 'Corporate', blurb: 'Navy header and a full bordered grid, like an audit pack.', accent: '#1e3a8a' },
  { name: 'elegant', label: 'Elegant', blurb: 'Serif type, centred heading and a soft tinted header row.', accent: '#0f766e' },
] as const;
export type TemplateName = (typeof TEMPLATES)[number]['name'];

export interface ExportPrefs { template: TemplateName; orientation: 'auto' | 'portrait' | 'landscape'; paper: 'A4' | 'A3' | 'LETTER'; accent: string; footer: string; pageNumbers: boolean; fontSize: string }
const DEFAULTS: ExportPrefs = { template: 'classic', orientation: 'auto', paper: 'A4', accent: '', footer: '', pageNumbers: true, fontSize: '9' };
const KEY = 'export-preferences';

/** Remembered in this browser, so every export uses the style last chosen. */
export function loadPrefs(): ExportPrefs {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; } catch { return DEFAULTS; }
}
const savePrefs = (p: ExportPrefs) => { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* storage may be off */ } };

/** The saved style as a query string, for the quick Export buttons that skip the panel. */
export const prefsQuery = (extra: Record<string, string> = {}) => styleQuery(loadPrefs(), extra);

function styleQuery(p: ExportPrefs, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams({ template: p.template, orientation: p.orientation, paper: p.paper, pageNumbers: p.pageNumbers ? '1' : '0', fontSize: p.fontSize });
  if (p.accent) q.set('accent', p.accent);
  if (p.footer.trim()) q.set('footer', p.footer.trim());
  for (const [k, v] of Object.entries(extra)) if (v) q.set(k, v);
  return q.toString();
}

/** A small drawing of what each template looks like. */
function Preview({ name, accent }: { name: TemplateName; accent: string }) {
  const rows = [0, 1, 2, 3];
  const line = <div className="h-1 rounded bg-slate-300" />;
  return (
    <div aria-hidden className="h-24 overflow-hidden rounded border border-slate-200 bg-white text-[0px]">
      {name === 'modern' && <div className="h-6" style={{ background: accent }} />}
      <div className={`px-2 pt-2 ${name === 'elegant' ? 'text-center' : ''}`}>
        {name === 'minimal' ? <><div className="h-1 w-8 rounded bg-slate-300" /><div className="mt-1 h-2.5 w-16 rounded bg-slate-800" /></>
          : name === 'elegant' ? <><div className="mx-auto h-2 w-16 rounded" style={{ background: accent }} /><div className="mx-auto mt-1 h-1 w-10 rounded bg-slate-300" /><div className="mt-1 border-y" style={{ borderColor: accent, height: 3 }} /></>
          : name === 'modern' ? null
          : <><div className="h-2 w-14 rounded" style={{ background: name === 'corporate' ? accent : '#111' }} /><div className="mt-1 h-1.5 w-10 rounded bg-slate-500" />{name === 'corporate' && <div className="mt-1 h-0.5" style={{ background: accent }} />}</>}
        <div className="mt-2 space-y-1">
          <div className={`h-2 rounded-sm ${name === 'minimal' ? 'border-b border-slate-700' : name === 'classic' ? 'border-b border-slate-800' : ''}`}
            style={name === 'modern' || name === 'corporate' ? { background: accent } : name === 'elegant' ? { background: `${accent}22` } : undefined} />
          {rows.map((r) => <div key={r} className={`h-1.5 ${name === 'modern' && r % 2 ? 'bg-indigo-50' : ''} ${name === 'corporate' ? 'border border-slate-300' : name === 'classic' || name === 'elegant' ? 'border-b border-slate-200' : ''}`}>{name === 'minimal' && line}</div>)}
        </div>
      </div>
    </div>
  );
}

export interface ExportPanelProps {
  title: string;
  /** Which downloads to offer. */
  formats: ('pdf' | 'xlsx')[];
  /** Column headings of the thing being exported, so some can be left out. Leave undefined to hide the column picker. */
  columns?: string[];
  /** A list to choose from when several items can go into one file. */
  choices?: { key: string; label: string; disabled?: string }[];
  /** Pre-ticked choices. */
  chosen?: string[];
  /** Lets the report or document title be replaced. */
  allowTitle?: boolean;
  busy?: boolean;
  /** Called with the file type, the query string describing the style, and the ticked choices. Return the download promise. */
  onExport: (format: 'pdf' | 'xlsx', query: string, chosen: string[]) => Promise<unknown> | void;
  onClose: () => void;
}

export function ExportPanel({ title, formats, columns, choices, chosen: initial, allowTitle = true, busy, onExport, onClose }: ExportPanelProps) {
  const [p, setP] = useState<ExportPrefs>(loadPrefs);
  const [docTitle, setDocTitle] = useState(''), [note, setNote] = useState('');
  const [hidden, setHidden] = useState<number[]>([]);
  const [chosen, setChosen] = useState<string[]>(initial ?? []);
  useEffect(() => savePrefs(p), [p]);
  const set = <K extends keyof ExportPrefs>(k: K, v: ExportPrefs[K]) => setP((x) => ({ ...x, [k]: v }));
  const tpl = TEMPLATES.find((t) => t.name === p.template)!;
  const colour = p.accent || tpl.accent;
  const selectable = (choices ?? []).filter((c) => !c.disabled);
  const go = (format: 'pdf' | 'xlsx') => onExport(format, styleQuery(p, { title: docTitle.trim(), note: note.trim(), hide: hidden.join(',') }), chosen);
  const input = 'w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm';
  const lbl = 'mb-1 block text-sm font-medium text-slate-600';

  return (
    <Card title={`Customize export: ${title}`} actions={<Button variant="ghost" onClick={onClose}>Close</Button>}>
      {choices && (
        <fieldset className="mb-5">
          <legend className={lbl}>Reports to include <span className="font-normal text-slate-500">({chosen.length} chosen; each starts on its own page{formats.includes('xlsx') ? ', or its own sheet in Excel' : ''})</span></legend>
          <div className="mb-2 flex gap-2"><Button variant="ghost" onClick={() => setChosen(selectable.map((c) => c.key))}>Select all</Button><Button variant="ghost" onClick={() => setChosen([])}>Clear</Button></div>
          <div className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
            {choices.map((c) => (
              <label key={c.key} className={`flex items-center gap-2 ${c.disabled ? 'text-slate-400' : ''}`} title={c.disabled}>
                <input type="checkbox" disabled={!!c.disabled} checked={chosen.includes(c.key)} onChange={(e) => setChosen(e.target.checked ? [...chosen, c.key] : chosen.filter((x) => x !== c.key))} />{c.label}{c.disabled && <span className="text-xs">({c.disabled})</span>}
              </label>))}
          </div>
        </fieldset>
      )}

      <p className={lbl}>Template</p>
      <div role="radiogroup" aria-label="Template" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {TEMPLATES.map((t) => (
          <button key={t.name} type="button" role="radio" aria-checked={p.template === t.name} aria-label={`${t.label} template`} onClick={() => set('template', t.name)}
            className={`h-full rounded-lg border p-2 text-left transition ${p.template === t.name ? 'border-brand-600 ring-2 ring-brand-200' : 'border-slate-200 hover:border-slate-400'}`}>
            <Preview name={t.name} accent={p.template === t.name && p.accent ? p.accent : t.accent} />
            <span className="mt-2 block text-sm font-semibold">{t.label}</span>
            <span className="block text-xs text-slate-500">{t.blurb}</span>
          </button>))}
      </div>

      <div className="mt-5 grid gap-4 md:grid-cols-3">
        {allowTitle && !choices && <div><label className={lbl} htmlFor="x-title">Title</label><input id="x-title" aria-label="Export title" className={input} placeholder={title} maxLength={80} value={docTitle} onChange={(e) => setDocTitle(e.target.value)} /></div>}
        <div><label className={lbl} htmlFor="x-note">Note under the heading</label><input id="x-note" aria-label="Export note" className={input} placeholder="e.g. Prepared for the board" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} /></div>
        <div><label className={lbl} htmlFor="x-footer">Footer on every page</label><input id="x-footer" aria-label="Export footer" className={input} placeholder="e.g. Confidential" maxLength={150} value={p.footer} onChange={(e) => set('footer', e.target.value)} /></div>
        <div><label className={lbl} htmlFor="x-orient">Page direction</label>
          <select id="x-orient" aria-label="Page direction" className={input} value={p.orientation} onChange={(e) => set('orientation', e.target.value as ExportPrefs['orientation'])}>
            <option value="auto">Automatic (wide tables go sideways)</option><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select></div>
        <div><label className={lbl} htmlFor="x-paper">Paper</label>
          <select id="x-paper" aria-label="Paper size" className={input} value={p.paper} onChange={(e) => set('paper', e.target.value as ExportPrefs['paper'])}><option value="A4">A4</option><option value="A3">A3</option><option value="LETTER">Letter</option></select></div>
        <div><label className={lbl} htmlFor="x-font">Text size</label>
          <select id="x-font" aria-label="Text size" className={input} value={p.fontSize} onChange={(e) => set('fontSize', e.target.value)}>{['8', '9', '10', '11'].map((s) => <option key={s} value={s}>{s} pt{s === '9' ? ' (standard)' : ''}</option>)}</select></div>
        <div>
          <span className={lbl}>Colour</span>
          <div className="flex items-center gap-2">
            <input type="color" aria-label="Accent colour" className="h-9 w-12 cursor-pointer rounded border border-slate-300" value={colour} onChange={(e) => set('accent', e.target.value)} />
            <span className="text-xs text-slate-500">{p.accent ? p.accent : `${tpl.label} default`}</span>
            {p.accent && <Button variant="ghost" onClick={() => set('accent', '')}>Reset</Button>}
          </div>
        </div>
        <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" aria-label="Page numbers" checked={p.pageNumbers} onChange={(e) => set('pageNumbers', e.target.checked)} />Show page numbers</label>
      </div>

      {columns && columns.length > 1 && (
        <fieldset className="mt-5">
          <legend className={lbl}>Columns to include</legend>
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
            {columns.map((c, i) => (
              <label key={i} className="flex items-center gap-2"><input type="checkbox" aria-label={`Include column ${c}`} checked={!hidden.includes(i)}
                onChange={(e) => setHidden(e.target.checked ? hidden.filter((x) => x !== i) : [...hidden, i])} />{c}</label>))}
          </div>
        </fieldset>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        {formats.includes('pdf') && <Button disabled={busy || (!!choices && !chosen.length)} onClick={() => go('pdf')}>Download PDF</Button>}
        {formats.includes('xlsx') && <Button variant="ghost" disabled={busy || (!!choices && !chosen.length)} onClick={() => go('xlsx')}>Download Excel</Button>}
        <p className="text-xs text-slate-500">Your choices are remembered for the next export. Excel files open ready to edit; the PDF is for sharing.</p>
      </div>
    </Card>
  );
}
