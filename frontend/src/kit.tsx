// Extra building blocks for the structured layout: headers, stat cards, badges, selects.
import type { ReactNode } from 'react';

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div><h1 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>{subtitle && <p className="text-sm text-slate-500">{subtitle}</p>}</div>
      <div className="flex gap-2">{actions}</div>
    </div>
  );
}

export function Stat({ label, value, sub, tone = 'default', testId }: { label: string; value: string; sub?: string; tone?: 'default' | 'bad' | 'good'; testId?: string }) {
  const color = tone === 'bad' ? 'text-red-700' : tone === 'good' ? 'text-green-700' : 'text-slate-900';
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-[0_1px_2px_rgba(16,24,40,0.05)]">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tracking-tight ${color}`} data-testid={testId}>{value}</p>
      {sub && <p className="text-xs text-slate-500">{sub}</p>}
    </div>
  );
}

const BADGE: Record<string, string> = {
  posted: 'bg-blue-100 text-blue-800', paid: 'bg-green-100 text-green-800', void: 'bg-slate-200 text-slate-600', draft: 'bg-slate-100 text-slate-700', sent: 'bg-blue-100 text-blue-800',
  accepted: 'bg-green-100 text-green-800', declined: 'bg-red-100 text-red-800', converted: 'bg-purple-100 text-purple-800', open: 'bg-amber-100 text-amber-800',
  done: 'bg-green-100 text-green-800', active: 'bg-green-100 text-green-800', disposed: 'bg-slate-200 text-slate-600',
};
export const Badge = ({ text }: { text: string }) => <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${BADGE[text] ?? 'bg-slate-100 text-slate-700'}`}>{text}</span>;

export const Select = ({ label, children, ...p }: { label: string } & React.SelectHTMLAttributes<HTMLSelectElement>) => (
  <label className="block text-sm"><span className="mb-1 block font-medium text-slate-600">{label}</span>
    <select {...p} aria-label={p['aria-label'] ?? label} className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200">{children}</select></label>
);

export const Empty = ({ text }: { text: string }) => <p className="py-6 text-center text-sm text-slate-500">{text}</p>;

/** Simple SVG bar chart for monthly figures. Each series is one colour; values are paise. */
export function BarChart({ data, series, height = 140 }: { data: { label: string; values: number[] }[]; series: { name: string; color: string }[]; height?: number }) {
  const max = Math.max(1, ...data.flatMap((d) => d.values.map((v) => Math.abs(v))));
  const w = 100 / data.length;
  return (
    <div>
      <svg viewBox={`0 0 100 ${height / 4}`} preserveAspectRatio="none" className="w-full" style={{ height }} role="img" aria-label="Monthly chart">
        {data.map((d, i) => d.values.map((v, j) => {
          const bw = (w * 0.7) / series.length, h = (Math.abs(v) / max) * (height / 4 - 2);
          return <rect key={`${i}-${j}`} x={i * w + w * 0.15 + j * bw} y={height / 4 - h} width={bw} height={Math.max(h, v ? 0.3 : 0)} fill={series[j].color} rx={0.4} />;
        }))}
      </svg>
      <div className="mt-1 flex text-xs text-slate-500">{data.map((d) => <span key={d.label} className="flex-1 text-center">{d.label}</span>)}</div>
      <div className="mt-2 flex gap-4 text-xs">{series.map((s) => <span key={s.name} className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm" style={{ background: s.color }} />{s.name}</span>)}</div>
    </div>
  );
}
