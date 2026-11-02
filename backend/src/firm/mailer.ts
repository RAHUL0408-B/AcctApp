// Email outbox: code queues messages, a worker sends them. With no SMTP_URL set, messages are only logged (safe default).
import nodemailer, { Transporter } from 'nodemailer';
import { getPool } from '../db/db';

let transport: Transporter | undefined;
function getTransport(): Transporter {
  transport ??= process.env.SMTP_URL ? nodemailer.createTransport(process.env.SMTP_URL) : nodemailer.createTransport({ jsonTransport: true });
  return transport;
}

export interface Mail { orgId?: number | null; to: string; subject: string; body: string; attachment?: { name: string; mime: string; data: Buffer }; }

export async function queueMail(m: Mail) {
  await getPool().query(
    'INSERT INTO email_outbox(org_id,to_addr,subject,body,attachment_name,attachment_mime,attachment) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [m.orgId ?? null, m.to, m.subject, m.body, m.attachment?.name ?? null, m.attachment?.mime ?? null, m.attachment?.data ?? null]);
}

/** Send pending mail; retry up to 3 times, then mark failed. Returns counts. */
export async function processOutbox(limit = 20) {
  const pool = getPool();
  const rows = (await pool.query("SELECT * FROM email_outbox WHERE status='pending' ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED", [limit])).rows;
  let sent = 0, failed = 0;
  for (const r of rows) {
    try {
      await getTransport().sendMail({
        from: process.env.MAIL_FROM ?? 'no-reply@example.com', to: r.to_addr, subject: r.subject, text: r.body,
        attachments: r.attachment ? [{ filename: r.attachment_name, contentType: r.attachment_mime, content: r.attachment }] : [],
      });
      await pool.query("UPDATE email_outbox SET status='sent', sent_at=now(), attempts=attempts+1 WHERE id=$1", [r.id]); sent++;
    } catch (e) {
      const last = r.attempts + 1 >= 3;
      await pool.query('UPDATE email_outbox SET status=$2, attempts=attempts+1, error=$3 WHERE id=$1', [r.id, last ? 'failed' : 'pending', (e as Error).message.slice(0, 500)]);
      if (last) failed++;
    }
  }
  return { sent, failed };
}
