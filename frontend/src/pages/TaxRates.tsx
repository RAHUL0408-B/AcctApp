// Settings › Duties and taxes: the TDS sections with this organisation's own rates and thresholds (the statutory figures
// are kept and shown alongside; "Back to statutory" removes a change), its own TDS sections, and its own GST rates.
import { useCallback, useEffect, useState } from 'react';
import { api, toPaise } from '../api';
import type { Org } from '../App';
import { Badge } from '../kit';
import { DataTable, RowMenu, type Column } from '../table';
import { Button, Card, ErrorMsg, Field, Ok, ask, useAction } from '../ui';

interface Sec {
  code: string; description: string; rateIndividualBp: number; rateOtherBp: number; singleThreshold: number; annualThreshold: number;
  source: 'statutory' | 'changed' | 'custom'; statutory?: { rateIndividualBp: number; rateOtherBp: number; singleThreshold: number; annualThreshold: number };
}
type Form = { code: string; description: string; ind: string; other: string; single: string; annual: string; isNew: boolean };
const pct = (bp: number) => `${bp / 100}%`;

export function TdsSectionsCard({ org, editable }: { org: Org; editable: boolean }) {
  const [list, setList] = useState<Sec[]>([]);
  const [form, setForm] = useState<Form | null>(null);
  const [ok, setOk] = useState('');
  const { error, busy, run } = useAction();
  const load = useCallback(() => api<Sec[]>(`/orgs/${org.id}/tds-sections`).then(setList), [org.id]);
  useEffect(() => { load(); }, [load]);
  const edit = (s?: Sec) => setForm(s ? { code: s.code, description: s.description, ind: String(s.rateIndividualBp / 100), other: String(s.rateOtherBp / 100), single: String(s.singleThreshold / 100), annual: String(s.annualThreshold / 100), isNew: false }
    : { code: '', description: '', ind: '', other: '', single: '0', annual: '0', isNew: true });
  const save = () => run(async () => {
    if (!form) return;
    const rate = (v: string) => { const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > 50) throw new Error('Rates are percentages from 0 to 50.'); return Math.round(n * 100); };
    await api(`/orgs/${org.id}/tds-sections/${encodeURIComponent(form.code.trim())}`, { method: 'PUT', body: {
      ...(form.isNew || list.find((x) => x.code === form.code)?.source === 'custom' ? { description: form.description.trim() } : {}),
      rateIndividualBp: rate(form.ind), rateOtherBp: rate(form.other || form.ind), singleThreshold: toPaise(form.single || '0'), annualThreshold: toPaise(form.annual || '0') } });
    setOk(form.isNew ? `Section ${form.code.trim().toUpperCase()} added.` : `${form.code} saved for this organisation. The statutory figures are kept.`); setForm(null); load();
  });
  const reset = (s: Sec) => run(async () => {
    if (!await ask({ title: s.source === 'custom' ? `Remove section ${s.code}?` : `Back to the statutory figures for ${s.code}?`, confirmLabel: s.source === 'custom' ? 'Remove' : 'Back to statutory',
      message: s.source === 'custom' ? 'It is no longer offered on new documents. A section used on posted documents cannot be removed.' : `New documents use ${s.statutory ? `${pct(s.statutory.rateIndividualBp)} / ${pct(s.statutory.rateOtherBp)}` : 'the statutory rates'} again. Posted documents are not changed.` })) return;
    await api(`/orgs/${org.id}/tds-sections/${encodeURIComponent(s.code)}`, { method: 'DELETE' }); setOk(`${s.code}: ${s.source === 'custom' ? 'removed' : 'statutory figures restored'}.`); load();
  });
  const columns: Column<Sec>[] = [
    { key: 'code', label: 'Section', value: (s) => s.code, render: (s) => <b>{s.code}</b> },
    { key: 'description', label: 'Nature of payment', value: (s) => s.description },
    { key: 'ind', label: 'Rate: individual / HUF', value: (s) => pct(s.rateIndividualBp), render: (s) => <span>{pct(s.rateIndividualBp)}{s.statutory && s.statutory.rateIndividualBp !== s.rateIndividualBp && <span className="block text-xs text-slate-400 line-through">{pct(s.statutory.rateIndividualBp)}</span>}</span> },
    { key: 'other', label: 'Rate: others', value: (s) => pct(s.rateOtherBp), render: (s) => <span>{pct(s.rateOtherBp)}{s.statutory && s.statutory.rateOtherBp !== s.rateOtherBp && <span className="block text-xs text-slate-400 line-through">{pct(s.statutory.rateOtherBp)}</span>}</span> },
    { key: 'single', label: 'Single payment threshold', value: (s) => s.singleThreshold, money: true },
    { key: 'annual', label: 'Yearly threshold', value: (s) => s.annualThreshold, money: true },
    { key: 'source', label: 'Figures', value: (s) => (s.source === 'statutory' ? 'Statutory' : s.source === 'changed' ? 'Changed for this organisation' : 'Own section'),
      render: (s) => <Badge text={s.source === 'statutory' ? 'statutory' : s.source === 'changed' ? 'changed' : 'own'} /> },
  ];
  return (
    <Card title="TDS sections, rates and thresholds" actions={editable && <Button onClick={() => edit()}><span aria-hidden>＋ </span>New TDS section</Button>}>
      <div className="mb-3 space-y-2"><ErrorMsg msg={error} /><Ok msg={ok} /></div>
      {form && (
        <div role="region" aria-label="TDS section" className="mb-4 rounded-lg border border-brand-200 bg-brand-50/40 p-3">
          <p className="mb-2 text-sm font-semibold">{form.isNew ? 'New TDS section' : `Rates and thresholds for ${form.code}`}</p>
          <div className="grid gap-3 md:grid-cols-6">
            {form.isNew && <Field label="Section code" aria-label="Section code" placeholder="e.g. 194Q" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />}
            {(form.isNew || list.find((x) => x.code === form.code)?.source === 'custom') && <div className="md:col-span-2"><Field label="Nature of payment" aria-label="Section description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>}
            <Field label="Rate % (individual / HUF)" aria-label="Rate individual" inputMode="decimal" value={form.ind} onChange={(e) => setForm({ ...form, ind: e.target.value })} />
            <Field label="Rate % (others)" aria-label="Rate others" inputMode="decimal" value={form.other} onChange={(e) => setForm({ ...form, other: e.target.value })} />
            <Field label="Single payment threshold ₹" aria-label="Single threshold" inputMode="decimal" value={form.single} onChange={(e) => setForm({ ...form, single: e.target.value })} />
            <Field label="Yearly threshold ₹" aria-label="Yearly threshold" inputMode="decimal" value={form.annual} onChange={(e) => setForm({ ...form, annual: e.target.value })} />
          </div>
          <div className="mt-3 flex gap-2"><Button disabled={busy} onClick={save}>Save section</Button><Button variant="ghost" onClick={() => setForm(null)}>Cancel</Button></div>
          <p className="mt-2 text-xs text-slate-500">TDS applies once a single payment reaches the single threshold or the year's total crosses the yearly threshold (0 = no threshold). A document can still apply TDS below them with "Apply TDS irrespective of threshold".</p>
        </div>)}
      <DataTable id="tds-sections" rows={list} columns={columns} rowKey={(s) => s.code} orgId={org.id} exportTitle="TDS sections" searchLabel="Search sections" facets={['source']}
        trailing={editable ? (s) => <RowMenu label={`Actions for section ${s.code}`} actions={[
          { label: 'Change rates and thresholds', icon: 'edit', onClick: () => edit(s) },
          { label: s.source === 'custom' ? 'Remove' : 'Back to statutory', icon: s.source === 'custom' ? 'trash' : 'restore', onClick: () => reset(s), hidden: s.source === 'statutory', danger: s.source === 'custom' },
        ]} /> : undefined} />
      <p className="mt-2 text-xs text-slate-500">Changes apply to this organisation only and are recorded in the history. The statutory figures are never changed, so you can always go back to them. Thresholds are in rupees (e.g. 30,000).</p>
    </Card>
  );
}

export function GstRatesCard({ org, editable }: { org: Org; editable: boolean }) {
  const [rates, setRates] = useState<{ rateBp: number; label: string; custom: boolean }[]>([]);
  const [add, setAdd] = useState('');
  const [ok, setOk] = useState('');
  const { error, busy, run } = useAction();
  const load = useCallback(() => api(`/orgs/${org.id}/gst-rates`).then(setRates), [org.id]);
  useEffect(() => { load(); }, [load]);
  const own = rates.filter((r) => r.custom).map((r) => r.rateBp);
  const save = (list: number[], msg: string) => run(async () => { await api(`/orgs/${org.id}/gst-rates`, { method: 'PUT', body: { rates: list } }); setOk(msg); setAdd(''); load(); });
  return (
    <Card title="GST rates offered on lines">
      <div className="mb-3 space-y-2"><ErrorMsg msg={error} /><Ok msg={ok} /></div>
      <div className="flex flex-wrap gap-2" data-testid="gst-rate-list">{rates.map((r) => (
        <span key={r.rateBp} className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-sm ${r.custom ? 'bg-brand-100 text-brand-800' : 'bg-slate-100 text-slate-700'}`}>
          {r.label}{r.custom && <span className="text-[10px] uppercase">own</span>}
          {r.custom && editable && <button type="button" aria-label={`Remove ${r.label}`} className="ml-1 text-brand-700 hover:text-red-700" onClick={() => save(own.filter((x) => x !== r.rateBp), `${r.label} removed.`)}>✕</button>}
        </span>))}</div>
      {editable && <div className="mt-3 flex items-end gap-2">
        <div className="w-40"><Field label="Add a GST rate %" aria-label="New GST rate" inputMode="decimal" placeholder="e.g. 0.25" value={add} onChange={(e) => setAdd(e.target.value)} /></div>
        <Button disabled={busy || !add.trim()} onClick={() => { const n = Math.round(Number(add) * 100); if (!Number.isFinite(n) || n <= 0 || n > 5000) { setOk(''); return; } save([...own, n], `${Number(add)}% added: it is offered on every line.`); }}>Add rate</Button>
      </div>}
      <p className="mt-2 text-xs text-slate-500">The standard rates are always offered. Add the organisation's own (for example 0.25% on rough diamonds or 1.5% on cut stones) and they appear on every invoice, bill and quote line.</p>
    </Card>
  );
}
