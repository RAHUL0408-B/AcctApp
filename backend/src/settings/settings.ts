// Helpers behind the organisation settings: number prefixes, email templates, invoice branding and payment details.
import { PoolClient } from 'pg';
import QRCode from 'qrcode';
import { formatPaise } from '../money';

/** Built-in number prefixes. An organisation can replace any of them in its invoice settings. */
export const DEFAULT_PREFIX = { invoice: 'INV', bill: 'BILL', credit_note: 'CN', debit_note: 'DN', quote: 'QU', purchase_order: 'PO', journal: 'JV' } as const;
export type PrefixType = keyof typeof DEFAULT_PREFIX;

/** The prefix this organisation uses for a document type. Call inside withOrg(). */
export async function prefixFor(c: PoolClient, type: PrefixType): Promise<string> {
  const p = (await c.query('SELECT doc_prefixes FROM organizations WHERE id = current_org()')).rows[0]?.doc_prefixes ?? {};
  return typeof p[type] === 'string' && p[type] ? p[type] : DEFAULT_PREFIX[type];
}

export const DEFAULT_TEMPLATES = {
  invoiceSubject: '{type} {number} from {org}',
  invoiceBody: 'Dear {contact},\n\nPlease find {number} attached.',
  reminderSubject: 'Reminder: invoice {number} is overdue',
  reminderBody: 'Dear {contact},\n\nInvoice {number} (due {due}) has Rs {amount} outstanding. Please arrange payment.',
};

/** Fill {placeholders}; unknown ones are left as they are. */
export function fillTemplate(t: string, vars: Record<string, string>) {
  return t.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

export interface MailPrefs { orgName: string; replyTo: string | null; fromName: string | null; invoiceSubject: string; invoiceBody: string; reminderSubject: string; reminderBody: string; remindEveryDays: number }
export async function mailPrefs(c: { query: PoolClient['query'] }, orgId: number): Promise<MailPrefs> {
  const o = (await c.query(`SELECT name,email_reply_to,email_sender_name,email_invoice_subject,email_invoice_body,email_reminder_subject,email_reminder_body,remind_every_days
                              FROM organizations WHERE id=$1`, [orgId])).rows[0];
  return {
    orgName: o.name, replyTo: o.email_reply_to, fromName: o.email_sender_name,
    invoiceSubject: o.email_invoice_subject || DEFAULT_TEMPLATES.invoiceSubject, invoiceBody: o.email_invoice_body || DEFAULT_TEMPLATES.invoiceBody,
    reminderSubject: o.email_reminder_subject || DEFAULT_TEMPLATES.reminderSubject, reminderBody: o.email_reminder_body || DEFAULT_TEMPLATES.reminderBody,
    remindEveryDays: Number(o.remind_every_days ?? 7),
  };
}

/** What a sales invoice should be paid to, as a upi:// link a phone camera understands. */
export function upiLink(upiId: string, payee: string, amountPaise: number, note: string) {
  const q = new URLSearchParams({ pa: upiId, pn: payee.slice(0, 50), cu: 'INR', tn: note.slice(0, 50) });
  if (amountPaise > 0) q.set('am', (amountPaise / 100).toFixed(2));
  return `upi://pay?${q.toString()}`;
}

export interface Branding {
  from?: { lines: string[]; logo?: Buffer };
  payment?: { lines: string[]; qr?: Buffer; qrCaption?: string };
}

const logoBuffer = (dataUrl: string | null) => {
  const m = dataUrl?.match(/^data:image\/(png|jpeg);base64,(.+)$/);
  return m ? Buffer.from(m[2], 'base64') : undefined;
};

/** Address, contact lines, logo and (for sales invoices) payment details with a UPI QR code. Call inside withOrg(). */
export async function brandingFor(c: PoolClient, doc: { type: string; number: string; total: number; tdsAmount: number; currency?: string }): Promise<Branding> {
  const o = (await c.query('SELECT * FROM organizations WHERE id = current_org()')).rows[0];
  if (!o) return {};
  const out: Branding = {};
  const address = [o.address_line1, o.address_line2, [o.city, o.pincode].filter(Boolean).join(' - ')].filter(Boolean).join(', ');
  const contact = [o.phone && `Phone ${o.phone}`, o.email, o.website].filter(Boolean).join('  ·  ');
  const legal = o.legal_name && o.legal_name !== o.name ? o.legal_name : null;
  const ids = [o.pan && `PAN ${o.pan}`, o.cin && `CIN ${o.cin}`].filter(Boolean).join('  ·  ');
  const fromLines = [legal, address, contact, ids].filter(Boolean) as string[];
  const logo = logoBuffer(o.logo);
  if (fromLines.length || logo) out.from = { lines: fromLines, logo };
  if (doc.type === 'invoice' && o.show_payment_on_invoice) {
    const lines = [
      o.bank_account_name && `Account name: ${o.bank_account_name}`, o.bank_name && `Bank: ${o.bank_name}`,
      o.bank_account_no && `Account no.: ${o.bank_account_no}`, o.bank_ifsc && `IFSC: ${o.bank_ifsc}`, o.upi_id && `UPI: ${o.upi_id}`,
    ].filter(Boolean) as string[];
    const due = doc.total - doc.tdsAmount;
    let qr: Buffer | undefined, qrCaption: string | undefined;
    if (o.show_upi_qr && o.upi_id && (doc.currency ?? 'INR') === 'INR') {
      qr = await QRCode.toBuffer(upiLink(o.upi_id, o.bank_account_name || o.name, due, doc.number), { type: 'png', margin: 1, width: 240, errorCorrectionLevel: 'M' });
      qrCaption = `Scan to pay Rs ${formatPaise(due)}`;
    }
    if (lines.length || qr) out.payment = { lines, qr, qrCaption };
  }
  return out;
}
