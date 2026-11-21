// Settings pages open read-only. "Edit" unlocks their fields; "Done" locks them again, so nothing changes by accident.
import { createContext, ReactNode, useContext, useState } from 'react';
import { Icon } from './table';
import { Button, Callout } from './ui';

const EditCtx = createContext<{ editing: boolean; done: () => void }>({ editing: true, done: () => undefined });
/** Whether the fields on this settings page are unlocked. Outside a settings page, always true. */
export const useEditing = () => useContext(EditCtx);

export function EditMode({ canManage, children, what = 'settings' }: { canManage: boolean; children: ReactNode; what?: string }) {
  const [editing, setEditing] = useState(false);
  return (
    <EditCtx.Provider value={{ editing: canManage && editing, done: () => setEditing(false) }}>
      {canManage && (
        <div className="mb-4" data-testid="edit-mode">
          {editing
            ? <Callout tone="warning" title={`Editing ${what}`}>Change what you need and save each part. <button type="button" className="ml-1 font-medium underline" onClick={() => setEditing(false)}>Done editing</button></Callout>
            : <div className="flex flex-wrap items-center gap-3"><Button onClick={() => setEditing(true)}><span className="inline-flex items-center gap-1.5"><Icon name="edit" className="text-white" />Edit {what}</span></Button>
                <span className="text-sm text-slate-500">The fields are locked so nothing changes by accident.</span></div>}
        </div>)}
      {children}
    </EditCtx.Provider>
  );
}
