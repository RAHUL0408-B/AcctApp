import { useState } from 'react';
import { api } from '../api';
import type { Me } from '../App';
import { Button, Card, ErrorMsg, Field, Ok, useAction } from '../ui';

export function Security({ me, onChanged }: { me: Me; onChanged: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState<string[]>([]);
  const { error, busy, run } = useAction();

  return (
    <Card title="Two-factor authentication">
      {me.twoFactorEnabled && recovery.length === 0 && <Ok msg="2FA is on for your account." />}
      {recovery.length > 0 && (
        <div className="space-y-2">
          <Ok msg="2FA enabled. Save these recovery codes now — each works once and they will not be shown again." />
          <pre className="rounded bg-slate-100 p-3 text-sm" data-testid="recovery-codes">{recovery.join('\n')}</pre>
        </div>
      )}
      {!me.twoFactorEnabled && !setup && <Button disabled={busy} onClick={() => run(async () => setSetup(await api('/auth/2fa/setup', { method: 'POST', body: {} })))}>Set up 2FA</Button>}
      {setup && (
        <div className="space-y-3">
          <p className="text-sm">Add this key to an authenticator app (Google Authenticator, Authy…), then enter the 6-digit code.</p>
          <p className="break-all rounded bg-slate-100 p-2 font-mono text-sm" data-testid="totp-secret">{setup.secret}</p>
          <Field label="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} maxLength={6} />
          <Button disabled={busy} onClick={() => run(async () => { const r = await api('/auth/2fa/enable', { body: { code } }); setRecovery(r.recoveryCodes); setSetup(null); onChanged(); })}>Turn on 2FA</Button>
        </div>
      )}
      <div className="mt-3"><ErrorMsg msg={error} /></div>
    </Card>
  );
}
