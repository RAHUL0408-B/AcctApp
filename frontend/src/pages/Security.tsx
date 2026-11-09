import { useState } from 'react';
import { api, setToken } from '../api';
import type { Me } from '../App';
import { Button, Card, ErrorMsg, Field, Ok, useAction } from '../ui';

/** Change the password. Every other device is signed out; this one keeps working. */
function ChangePassword() {
  const [f, setF] = useState({ current: '', next: '', again: '' });
  const [ok, setOk] = useState('');
  const { error, busy, run } = useAction();
  const save = () => run(async () => {
    setOk('');
    if (f.next !== f.again) throw new Error('The two new passwords are different');
    const r = await api('/auth/change-password', { body: { currentPassword: f.current, newPassword: f.next } });
    setToken(r.token); setF({ current: '', next: '', again: '' });
    setOk('Password changed. Every other device has been signed out.');
  });
  return (
    <Card title="Password">
      <div className="grid max-w-3xl gap-3 md:grid-cols-3">
        <Field label="Current password" type="password" autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} />
        <Field label="New password" type="password" autoComplete="new-password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} />
        <Field label="New password again" type="password" autoComplete="new-password" value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} />
      </div>
      <p className="mt-2 text-xs text-slate-500">At least 10 characters. Forgotten it? Use "Forgot your password?" on the log-in page.</p>
      <div className="mt-3 flex items-center gap-3"><Button disabled={busy || !f.current || !f.next} onClick={save}>Change password</Button><ErrorMsg msg={error} /><Ok msg={ok} /></div>
    </Card>
  );
}

export function Security({ me, onChanged }: { me: Me; onChanged: () => void }) {
  return <div className="space-y-5"><ChangePassword /><TwoFactor me={me} onChanged={onChanged} /></div>;
}

function TwoFactor({ me, onChanged }: { me: Me; onChanged: () => void }) {
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
