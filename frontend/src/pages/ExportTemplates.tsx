// Export templates: how this organisation's PDF and Excel files look. The owner picks which template all reports use and
// which one all invoices and bills use, and can design their own (colours, typeface, heading, table style, page).
import { useCallback, useEffect, useState } from 'react';
import { api, previewPdf } from '../api';
import type { Org } from '../App';
import { Empty, PageHeader } from '../kit';
import { Button, Card, ErrorMsg, Field, Ok, useAction } from '../ui';

interface Config {
  accent: string; headColour?: string; textColour: string; font: 'sans' | 'serif' | 'mono'; fontSize: number;
  heading: 'plain' | 'band' | 'centered' | 'minimal'; tableHeader: 'solid' | 'tint' | 'none';
  zebra: boolean; grid: boolean; rowLines: boolean; orientation: 'auto' | 'portrait' | 'landscape'; paper: 'A4' | 'A3' | 'LETTER';
  pageNumbers: boolean; footer?: string; invoiceLabel?: string;
}
interface Preset { name: string; label: string; blurb: string; config: Config }
interface Custom { id: number; name: string; config: Config }
interface Settings { canEdit: boolean; presets: Preset[]; templates: Custom[]; defaults: { report: string; document: string }; limit: number }
interface Draft { id: number | null; name: string; cfg: Config }

const FONT_CSS = { sans: 'ui-sans-serif, system-ui, sans-serif', serif: 'Georgia, "Times New Roman", serif', mono: 'ui-monospace, "Courier New", monospace' } as const;
const FONTS: [Config['font'], string, string][] = [['sans', 'Clean', 'Modern sans-serif'], ['serif', 'Classic', 'Traditional serif'], ['mono', 'Typewriter', 'Fixed width']];
const HEADINGS: [Config['heading'], string][] = [['plain', 'Plain'], ['band', 'Coloured band'], ['centered', 'Centred'], ['minimal', 'Minimal']];
const TABLE_HEADERS: [Config['tableHeader'], string][] = [['solid', 'Solid colour'], ['tint', 'Light tint'], ['none', 'Line only']];

const tint = (hex: string, pct: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `#${[(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v + (255 - v) * pct).toString(16).padStart(2, '0')).join('')}`;
};

/** A small drawing of a template: heading, table heading row and a few rows. Used for the built-in cards and the live design. */
function Sketch({ cfg }: { cfg: Config }) {
  const head = cfg.headColour ?? cfg.accent;
  const hdr = cfg.tableHeader === 'solid' ? { background: head } : cfg.tableHeader === 'tint' ? { background: tint(head, 0.85) } : { borderBottom: `2px solid ${cfg.accent}` };
  return (
    <div aria-hidden className="h-28 overflow-hidden rounded border border-slate-200 bg-white" style={{ fontFamily: FONT_CSS[cfg.font], color: cfg.textColour }}>
      {cfg.heading === 'band' && <div className="h-7 px-2 pt-1 text-[9px] font-bold text-white" style={{ background: cfg.accent }}>Your business</div>}
      <div className="px-2 pt-1.5">
        {cfg.heading === 'centered' && <div className="text-center"><div className="text-[10px] font-bold" style={{ color: cfg.accent }}>Your business</div><div className="mt-0.5 border-y" style={{ borderColor: cfg.accent, height: 3 }} /></div>}
        {cfg.heading === 'minimal' && <><div className="text-[6px] uppercase tracking-widest text-slate-400">Your business</div><div className="text-[12px] font-bold leading-tight text-slate-900">Trial balance</div></>}
        {cfg.heading === 'plain' && <div className="text-[10px] font-bold" style={{ color: cfg.accent }}>Your business</div>}
        <div className="mt-1.5">
          <div className="h-2.5 rounded-sm" style={hdr} />
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-2" style={{ background: cfg.zebra && i % 2 ? tint(cfg.accent, 0.93) : undefined, borderBottom: cfg.rowLines || cfg.grid ? `1px solid ${cfg.grid ? '#cbd5e1' : '#e5e7eb'}` : undefined, borderLeft: cfg.grid ? '1px solid #cbd5e1' : undefined, borderRight: cfg.grid ? '1px solid #cbd5e1' : undefined }} />))}
        </div>
      </div>
    </div>
  );
}

const choice = (on: boolean) => `rounded-md border px-3 py-2 text-left text-sm transition ${on ? 'border-brand-600 bg-brand-50 ring-2 ring-brand-200' : 'border-slate-300 bg-white hover:border-slate-400'}`;

export function ExportTemplates({ org, role }: { org: Org; role: string }) {
  const [data, setData] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [use, setUse] = useState({ report: 'classic', document: 'classic' });
  const [pdf, setPdf] = useState<{ kind: 'report' | 'invoice'; url: string } | null>(null);
  const [ok, setOk] = useState('');
  const { error, busy, run } = useAction();
  const owner = role === 'owner';

  const load = useCallback(() => api<Settings>(`/orgs/${org.id}/export-settings`).then((d) => { setData(d); setUse(d.defaults); }), [org.id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => () => { if (pdf) URL.revokeObjectURL(pdf.url); }, [pdf]);

  if (!data) return <p className="text-sm text-slate-500">Loading…</p>;
  const nameOf = (ref: string) => data.presets.find((p) => p.name === ref)?.label ?? data.templates.find((t) => `custom:${t.id}` === ref)?.name ?? ref;
  const options = [...data.presets.map((p) => [p.name, p.label] as const), ...data.templates.map((t) => [`custom:${t.id}`, `${t.name} (yours)`] as const)];
  const cfg = draft?.cfg;
  const set = <K extends keyof Config>(k: K, v: Config[K]) => draft && setDraft({ ...draft, cfg: { ...draft.cfg, [k]: v } });

  const saveUse = () => run(async () => { await api(`/orgs/${org.id}/export-defaults`, { method: 'PUT', body: use }); setOk(`Saved. Reports now use ${nameOf(use.report)}; invoices and bills use ${nameOf(use.document)}.`); load(); });
  const save = () => run(async () => {
    if (!draft) return;
    if (draft.id) await api(`/orgs/${org.id}/export-templates/${draft.id}`, { method: 'PUT', body: { name: draft.name, config: draft.cfg } });
    else await api(`/orgs/${org.id}/export-templates`, { body: { name: draft.name, config: draft.cfg } });
    setOk(`Template "${draft.name}" saved. Choose it above to use it for reports or invoices.`); setDraft(null); setPdf(null); load();
  });
  const remove = (t: Custom) => run(async () => {
    if (!window.confirm(`Delete the template "${t.name}"? Anything using it goes back to Classic.`)) return;
    await api(`/orgs/${org.id}/export-templates/${t.id}`, { method: 'DELETE' }); setOk(`Deleted "${t.name}".`); load();
  });
  const show = (kind: 'report' | 'invoice') => run(async () => { if (cfg) setPdf({ kind, url: await previewPdf(`/orgs/${org.id}/export-preview`, { config: cfg, kind }) }); });
  const startFrom = (c: Config, name = '') => { setOk(''); setPdf(null); setDraft({ id: null, name, cfg: { ...c } }); window.scrollTo({ top: 0, behavior: 'smooth' }); };

  return (
    <>
      <PageHeader title="Export templates" subtitle="How every PDF and Excel file from this organisation looks: reports, invoices and bills. Choose one template for all reports and one for all invoices, or design your own."
        actions={owner && !draft && <Button onClick={() => startFrom(data.presets[0].config)}>New template</Button>} />
      <div className="mb-3 space-y-2"><ErrorMsg msg={error} /><Ok msg={ok} /></div>
      {!owner && <p className="mb-4 rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">Only the owner can change export templates. Everything you export uses the choices below.</p>}

      {draft && cfg && (
        <Card title={draft.id ? `Edit template: ${draft.name}` : 'Design a template'} actions={<Button variant="ghost" onClick={() => { setDraft(null); setPdf(null); }}>Cancel</Button>}>
          <div className="grid gap-6 lg:grid-cols-[1fr_16rem]">
            <div className="space-y-6">
              <Field label="Template name" value={draft.name} maxLength={60} placeholder="e.g. Our brand" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />

              <section aria-labelledby="t-start"><h3 id="t-start" className="mb-2 text-sm font-semibold text-slate-700">Start from</h3>
                <div className="flex flex-wrap gap-2">{data.presets.map((p) => <Button key={p.name} variant="ghost" aria-label={`Start from ${p.label}`} onClick={() => setDraft({ ...draft, cfg: { ...p.config } })}>{p.label}</Button>)}</div></section>

              <section aria-labelledby="t-colour"><h3 id="t-colour" className="mb-2 text-sm font-semibold text-slate-700">Colours</h3>
                <div className="flex flex-wrap items-end gap-6 text-sm">
                  <label className="block"><span className="mb-1 block text-slate-600">Main colour</span><input type="color" aria-label="Main colour" className="h-10 w-16 cursor-pointer rounded border border-slate-300" value={cfg.accent} onChange={(e) => set('accent', e.target.value)} /></label>
                  <div><span className="mb-1 block text-slate-600">Table heading colour</span>
                    <div className="flex items-center gap-2">
                      <input type="color" aria-label="Table heading colour" disabled={!cfg.headColour} className="h-10 w-16 cursor-pointer rounded border border-slate-300 disabled:opacity-40" value={cfg.headColour ?? cfg.accent} onChange={(e) => set('headColour', e.target.value)} />
                      <label className="flex items-center gap-1.5 text-xs text-slate-600"><input type="checkbox" aria-label="Table heading uses the main colour" checked={!cfg.headColour} onChange={(e) => set('headColour', e.target.checked ? undefined : cfg.accent)} />Same as main</label></div></div>
                  <label className="block"><span className="mb-1 block text-slate-600">Text colour</span><input type="color" aria-label="Text colour" className="h-10 w-16 cursor-pointer rounded border border-slate-300" value={cfg.textColour} onChange={(e) => set('textColour', e.target.value)} /></label>
                </div></section>

              <section aria-labelledby="t-font"><h3 id="t-font" className="mb-2 text-sm font-semibold text-slate-700">Typeface and size</h3>
                <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Typeface">
                  {FONTS.map(([v, label, blurb]) => (
                    <button key={v} type="button" role="radio" aria-checked={cfg.font === v} aria-label={`Typeface ${label}`} className={choice(cfg.font === v)} onClick={() => set('font', v)}>
                      <span className="block text-base font-semibold" style={{ fontFamily: FONT_CSS[v] }}>{label}: Aa 123</span><span className="text-xs text-slate-500">{blurb}</span></button>))}
                </div>
                <label className="mt-3 block max-w-xs text-sm"><span className="mb-1 block text-slate-600">Text size</span>
                  <select aria-label="Text size" className="w-full rounded-md border border-slate-300 bg-white px-3 py-2" value={cfg.fontSize} onChange={(e) => set('fontSize', Number(e.target.value))}>{[8, 9, 10, 11].map((n) => <option key={n} value={n}>{n} pt{n === 9 ? ' (standard)' : ''}</option>)}</select></label></section>

              <section aria-labelledby="t-head"><h3 id="t-head" className="mb-2 text-sm font-semibold text-slate-700">Structure</h3>
                <p className="mb-1 text-xs text-slate-500">Top of the page</p>
                <div className="grid gap-2 sm:grid-cols-4" role="radiogroup" aria-label="Heading layout">
                  {HEADINGS.map(([v, label]) => <button key={v} type="button" role="radio" aria-checked={cfg.heading === v} aria-label={`Heading ${label}`} className={choice(cfg.heading === v)} onClick={() => set('heading', v)}>{label}</button>)}</div>
                <p className="mb-1 mt-3 text-xs text-slate-500">Table heading row</p>
                <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Table heading style">
                  {TABLE_HEADERS.map(([v, label]) => <button key={v} type="button" role="radio" aria-checked={cfg.tableHeader === v} aria-label={`Table heading ${label}`} className={choice(cfg.tableHeader === v)} onClick={() => set('tableHeader', v)}>{label}</button>)}</div>
                <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
                  <label className="flex items-center gap-2"><input type="checkbox" aria-label="Striped rows" checked={cfg.zebra} onChange={(e) => set('zebra', e.target.checked)} />Striped rows</label>
                  <label className="flex items-center gap-2"><input type="checkbox" aria-label="Line under each row" checked={cfg.rowLines} onChange={(e) => set('rowLines', e.target.checked)} />Line under each row</label>
                  <label className="flex items-center gap-2"><input type="checkbox" aria-label="Border around every cell" checked={cfg.grid} onChange={(e) => set('grid', e.target.checked)} />Border around every cell</label>
                </div></section>

              <section aria-labelledby="t-page"><h3 id="t-page" className="mb-2 text-sm font-semibold text-slate-700">Page</h3>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 text-sm">
                  <label className="block"><span className="mb-1 block text-slate-600">Page direction</span>
                    <select aria-label="Page direction" className="w-full rounded-md border border-slate-300 bg-white px-3 py-2" value={cfg.orientation} onChange={(e) => set('orientation', e.target.value as Config['orientation'])}>
                      <option value="auto">Automatic (wide tables go sideways)</option><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select></label>
                  <label className="block"><span className="mb-1 block text-slate-600">Paper</span>
                    <select aria-label="Paper size" className="w-full rounded-md border border-slate-300 bg-white px-3 py-2" value={cfg.paper} onChange={(e) => set('paper', e.target.value as Config['paper'])}><option value="A4">A4</option><option value="A3">A3</option><option value="LETTER">Letter</option></select></label>
                  <label className="flex items-center gap-2 self-end pb-2"><input type="checkbox" aria-label="Page numbers" checked={cfg.pageNumbers} onChange={(e) => set('pageNumbers', e.target.checked)} />Show page numbers</label>
                  <Field label="Footer on every page" aria-label="Footer text" maxLength={150} placeholder="e.g. Confidential" value={cfg.footer ?? ''} onChange={(e) => set('footer', e.target.value)} />
                  <Field label="Invoice heading" aria-label="Invoice heading" maxLength={30} placeholder="TAX INVOICE" value={cfg.invoiceLabel ?? ''} onChange={(e) => set('invoiceLabel', e.target.value)} />
                </div></section>

              <div className="flex flex-wrap items-center gap-3">
                <Button disabled={busy || !draft.name.trim()} onClick={save}>{draft.id ? 'Save changes' : 'Save template'}</Button>
                <Button variant="ghost" disabled={busy} onClick={() => show('report')}>Preview report</Button>
                <Button variant="ghost" disabled={busy} onClick={() => show('invoice')}>Preview invoice</Button>
              </div>
            </div>
            <aside aria-label="Live sketch" className="lg:sticky lg:top-20 lg:self-start"><p className="mb-1 text-xs font-medium text-slate-500">Sketch</p><Sketch cfg={cfg} />
              <p className="mt-2 text-xs text-slate-500">A quick drawing that updates as you change things. Use the preview buttons to see a real PDF.</p></aside>
          </div>
          {pdf && <div className="mt-6"><p className="mb-1 text-sm font-medium text-slate-700">Preview: sample {pdf.kind}</p><iframe title="Template preview" src={pdf.url} className="h-[680px] w-full rounded border border-slate-300" /></div>}
        </Card>
      )}

      <Card title="Which template to use">
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {([['report', 'Template for reports'], ['document', 'Template for invoices and bills']] as const).map(([k, label]) => (
            <label key={k} className="block text-sm"><span className="mb-1 block font-medium text-slate-600">{label}</span>
              <select aria-label={label} disabled={!owner} className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 disabled:bg-slate-100" value={use[k]} onChange={(e) => setUse({ ...use, [k]: e.target.value })}>
                {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>))}
          {owner && <div className="self-end"><Button disabled={busy || (use.report === data.defaults.report && use.document === data.defaults.document)} onClick={saveUse}>Save choice</Button></div>}
        </div>
        <p className="mt-3 text-xs text-slate-500">This applies everywhere: report downloads, combined exports, scheduled report emails, invoice and bill PDFs, and invoices emailed to customers.</p>
      </Card>

      <Card title="Ready-made templates">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {data.presets.map((p) => (
            <div key={p.name} className="rounded-lg border border-slate-200 p-3">
              <Sketch cfg={p.config} />
              <p className="mt-2 font-semibold">{p.label}</p><p className="text-xs text-slate-500">{p.blurb}</p>
              <div className="mt-2 flex flex-wrap gap-1 text-[11px]">{data.defaults.report === p.name && <span className="rounded bg-violet-100 px-1.5 text-violet-800">reports</span>}{data.defaults.document === p.name && <span className="rounded bg-emerald-100 px-1.5 text-emerald-800">invoices</span>}</div>
              {owner && <Button variant="ghost" className="mt-2" aria-label={`Customise ${p.label}`} onClick={() => startFrom(p.config, `${p.label} copy`)}>Customise a copy</Button>}
            </div>))}
        </div>
      </Card>

      <Card title={`Your templates (${data.templates.length} of ${data.limit})`}>
        {data.templates.length === 0 ? <Empty text={owner ? 'You have not designed any yet. Use "New template", or customise a copy of a ready-made one above.' : 'The owner has not designed any templates.'} /> : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {data.templates.map((t) => (
              <div key={t.id} className="rounded-lg border border-slate-200 p-3">
                <Sketch cfg={t.config} />
                <p className="mt-2 font-semibold">{t.name}</p>
                <div className="mt-1 flex flex-wrap gap-1 text-[11px]">{data.defaults.report === `custom:${t.id}` && <span className="rounded bg-violet-100 px-1.5 text-violet-800">reports</span>}{data.defaults.document === `custom:${t.id}` && <span className="rounded bg-emerald-100 px-1.5 text-emerald-800">invoices</span>}</div>
                {owner && <div className="mt-2 flex flex-wrap gap-1">
                  <Button variant="ghost" aria-label={`Edit ${t.name}`} onClick={() => { setOk(''); setPdf(null); setDraft({ id: t.id, name: t.name, cfg: { ...t.config } }); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>Edit</Button>
                  <Button variant="ghost" aria-label={`Copy ${t.name}`} onClick={() => startFrom(t.config, `${t.name} copy`)}>Copy</Button>
                  <Button variant="ghost" className="text-red-700" aria-label={`Delete ${t.name}`} onClick={() => remove(t)}>Delete</Button></div>}
              </div>))}
          </div>)}
      </Card>
    </>
  );
}
