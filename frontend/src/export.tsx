// Choosing several reports to put into one PDF or one Excel workbook.
// How the files look is not chosen here: it comes from the template the owner picked under Export templates.
import { useState } from 'react';
import { Button, Card } from './ui';

export interface CombinePanelProps {
  title: string;
  /** What can be ticked. A choice can be disabled with a reason. */
  choices: { key: string; label: string; disabled?: string }[];
  /** Pre-ticked choices. */
  chosen?: string[];
  busy?: boolean;
  /** Called with the file type and the ticked choices. Return the download promise. */
  onExport: (format: 'pdf' | 'xlsx', chosen: string[]) => Promise<unknown> | void;
  onClose: () => void;
}

export function CombinePanel({ title, choices, chosen: initial, busy, onExport, onClose }: CombinePanelProps) {
  const [chosen, setChosen] = useState<string[]>(initial ?? []);
  const selectable = choices.filter((c) => !c.disabled);
  return (
    <Card title={title} actions={<Button variant="ghost" onClick={onClose}>Close</Button>}>
      <fieldset>
        <legend className="mb-1 text-sm font-medium text-slate-600">Reports to include <span className="font-normal text-slate-500">({chosen.length} chosen; each starts on its own page, or its own sheet in Excel)</span></legend>
        <div className="mb-2 flex gap-2"><Button variant="ghost" onClick={() => setChosen(selectable.map((c) => c.key))}>Select all</Button><Button variant="ghost" onClick={() => setChosen([])}>Clear</Button></div>
        <div className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
          {choices.map((c) => (
            <label key={c.key} className={`flex items-center gap-2 ${c.disabled ? 'text-slate-400' : ''}`} title={c.disabled}>
              <input type="checkbox" disabled={!!c.disabled} checked={chosen.includes(c.key)} onChange={(e) => setChosen(e.target.checked ? [...chosen, c.key] : chosen.filter((x) => x !== c.key))} />{c.label}{c.disabled && <span className="text-xs">({c.disabled})</span>}
            </label>))}
        </div>
      </fieldset>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button disabled={busy || !chosen.length} onClick={() => onExport('pdf', chosen)}>Download PDF</Button>
        <Button variant="ghost" disabled={busy || !chosen.length} onClick={() => onExport('xlsx', chosen)}>Download Excel</Button>
        <p className="text-xs text-slate-500">The look of the files comes from your organisation&apos;s report template (set by the owner under Accounting, Export templates).</p>
      </div>
    </Card>
  );
}
