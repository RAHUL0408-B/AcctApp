// Access per person: on top of the role, the firm owner can limit someone to some areas of a client's books
// ("bank only", "reports only", "no payroll of settings"...). Each area is 'none', 'view' or 'edit'.
// Checked in one place for every /orgs/:id/... request (see AuthGuard), from the address and the method.
import { ForbiddenException } from '@nestjs/common';
import { getPool, withOrg } from '../db/db';

export const AREAS = ['sales', 'purchases', 'bank', 'accounting', 'reports', 'tax', 'contacts', 'projects', 'settings'] as const;
export type Area = (typeof AREAS)[number];
export type Level = 'none' | 'view' | 'edit';
export type Access = Partial<Record<Area, Level>>;

export const AREA_TEXT: Record<Area, string> = {
  sales: 'Sales: invoices, quotes, repeating invoices, customer payments', purchases: 'Purchases: bills, purchase orders, expense claims, supplier payments',
  bank: 'Bank: bank accounts, reconciliation, spend, receive and transfer money, bank rules', accounting: 'Accounting: journals, fixed assets, stock, budgets, cost centres, year-end',
  reports: 'Reports and exports', tax: 'Tax: GST returns, TDS and compliance checks', contacts: 'Contacts: add and change customers and suppliers',
  projects: 'Projects: time, costs and project invoices', settings: 'Settings: organisation, invoice and email settings, templates, import, history',
};

// The person's membership for this client: a direct one wins over a firm-wide one (as for the role). Cached briefly.
const cache = new Map<string, { a: Access | null; role: string | null; at: number }>();
const CACHE_MS = 5_000;
export const forgetAccess = () => cache.clear();
export async function accessFor(uid: number, orgId: number): Promise<{ access: Access | null; role: string | null }> {
  const k = `${uid}:${orgId}`, hit = cache.get(k);
  if (hit && Date.now() - hit.at < CACHE_MS) return { access: hit.a, role: hit.role };
  const r = (await getPool().query(
    `SELECT m.role, m.access FROM memberships m JOIN organizations o ON o.firm_id = m.firm_id
      WHERE m.user_id=$1 AND o.id=$2 AND (m.org_id=$2 OR m.org_id IS NULL) ORDER BY (m.org_id IS NULL) ASC LIMIT 1`, [uid, orgId])).rows[0];
  const a = r?.role === 'owner' || r?.role === 'accountant' ? null : (r?.access ?? null); // owners and accountants always have full access
  cache.set(k, { a, role: r?.role ?? null, at: Date.now() });
  return { access: a, role: r?.role ?? null };
}
export const levelOf = (a: Access | null, area: Area): Level => (a ? a[area] ?? 'edit' : 'edit');

const SALES_DOCS = new Set(['invoice', 'credit_note', 'quote']);
const docArea = (t?: string | null): Area | null => (!t ? null : SALES_DOCS.has(t) ? 'sales' : ['bill', 'debit_note', 'purchase_order'].includes(t) ? 'purchases' : null);

/** Lookups for addresses that name a record, not its kind. */
async function kindOf(orgId: number, sql: string, id: number): Promise<string | null> {
  return withOrg(orgId, async (c) => (await c.query(sql, [id])).rows[0]?.k ?? null);
}

/**
 * Which area an /orgs/:id/<rest> request belongs to. null = not limited by area (the role still applies).
 * Reading lists every page needs (accounts, contacts, items, settings...) is never limited, so forms keep working.
 */
export async function areaOf(orgId: number, method: string, rest: string, body: any, query: any): Promise<Area | Area[] | null> {
  const read = method === 'GET' || method === 'HEAD';
  const p = rest.replace(/\/+$/, '');
  if (read && /^(settings|org-settings|accounts|contacts|items|currencies|tracking|notifications|search|setup-guide|dashboard|numbering|documents-next-number|documents-number-check|tds-preview|account-structure|accounts-next-code|upi-sample|portal|tasks|files(\/\d+\/download)?|doc-templates|export-settings|export-columns\/[\w-]+|asset-groups|fixed-assets-next-code)$/.test(p)) return null;
  if (/^(compliance\/|reports\/(gstr1|gstr3b|gstr1-json|tds)$)/.test(p)) return 'tax';
  if (/^reports\/|^export(\/|-multi)|^report-table\/|^trial-balance$/.test(p)) return 'reports';
  if (/^overview\/sales$/.test(p)) return 'sales';
  if (/^overview\/purchases$/.test(p)) return 'purchases';
  if (/^(bank-|bank-transfers)/.test(p)) return 'bank';
  if (/^contacts\/\d+\/statement$/.test(p) || /^contacts(\/|$)/.test(p)) return 'contacts';
  if (/^projects(\/|$)/.test(p)) return 'projects';
  if (/^(org-settings|settings|numbering\/next|lock-dates|lock|currencies|export-templates|export-defaults|export-preview|scheduled-reports|import|history|audit|email-preview)(\/|$)/.test(p)) return 'settings';
  if (/^(journal|journal-rules|fixed-assets|stock|tracking|budgets|year-end|accounts|account-groups|journal-drafts|journal-next-number)(\/|$)/.test(p)) return 'accounting';
  if (/^expense-claims(\/|$)/.test(p)) return 'purchases';
  if (/^(documents\/remind-overdue|reminders\/run)$/.test(p) || /^documents\/\d+\/send$/.test(p)) return 'sales';
  // Records whose area depends on their kind.
  let m: RegExpExecArray | null;
  if (p === 'documents' || p === 'drafts') {
    if (!read) return docArea(body?.docType) ?? 'sales';
    return query?.type ? docArea(query.type) : null; // a mixed list is filtered by area instead
  }
  if ((m = /^documents\/(\d+)(\/.*)?$/.exec(p))) return docArea(await kindOf(orgId, 'SELECT doc_type AS k FROM documents WHERE id=$1', Number(m[1])));
  if (/^documents\/(bulk-void|bulk-archive)$/.test(p) && Array.isArray(body?.ids) && body.ids.length) {
    const kinds = await withOrg(orgId, async (c) => (await c.query('SELECT DISTINCT doc_type AS k FROM documents WHERE id = ANY($1)', [body.ids.map(Number)])).rows.map((r) => r.k));
    return [...new Set(kinds.map(docArea).filter((x): x is Area => !!x))];
  }
  if (p === 'documents-pdf') {
    const ids = String(query?.ids ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
    const kinds = ids.length ? await withOrg(orgId, async (c) => (await c.query('SELECT DISTINCT doc_type AS k FROM documents WHERE id = ANY($1)', [ids])).rows.map((r) => r.k)) : [];
    return [...new Set(kinds.map(docArea).filter((x): x is Area => !!x))];
  }
  if ((m = /^payments\/(\d+)$/.exec(p))) return docArea(await kindOf(orgId, 'SELECT d.doc_type AS k FROM payments p JOIN documents d ON d.id=p.doc_id WHERE p.id=$1', Number(m[1])));
  if (p === 'payment-batches') {
    if (read) return query?.side === 'pay' ? 'purchases' : query?.side === 'receive' ? 'sales' : ['sales', 'purchases'];
    const first = Number(body?.items?.[0]?.documentId);
    return first ? docArea(await kindOf(orgId, 'SELECT doc_type AS k FROM documents WHERE id=$1', first)) : null;
  }
  if ((m = /^payment-batches\/(\d+)$/.exec(p))) return (await kindOf(orgId, 'SELECT side AS k FROM payment_batches WHERE id=$1', Number(m[1]))) === 'pay' ? 'purchases' : 'sales';
  if (p === 'pre-documents') return read ? (query?.kind ? docArea(query.kind) : null) : docArea(body?.kind) ?? 'sales';
  if ((m = /^pre-documents\/(\d+)(\/.*)?$/.exec(p))) return docArea(await kindOf(orgId, 'SELECT kind AS k FROM pre_documents WHERE id=$1', Number(m[1])));
  if (p === 'recurring') return read ? (query?.type === 'bill' ? 'purchases' : 'sales') : body?.docType === 'bill' ? 'purchases' : 'sales';
  if ((m = /^recurring\/(\d+)(\/.*)?$/.exec(p))) return docArea(await kindOf(orgId, 'SELECT doc_type AS k FROM recurring_invoices WHERE id=$1', Number(m[1])));
  if (p === 'recurring-due') return read ? null : 'purchases';
  if (p === 'recurring/run') return ['sales', 'purchases'];
  if ((m = /^recurring-due\/(\d+)$/.exec(p))) return docArea(await kindOf(orgId, 'SELECT r.doc_type AS k FROM recurring_due d JOIN recurring_invoices r ON r.id=d.recurring_id WHERE d.id=$1', Number(m[1])));
  if ((m = /^drafts\/(\d+)(\/.*)?$/.exec(p))) return docArea(await kindOf(orgId, 'SELECT doc_type AS k FROM document_drafts WHERE id=$1', Number(m[1]))) ?? 'sales';
  return null;
}

/** Throw 403 when the person's access does not allow this request. Called by AuthGuard for every /orgs/:id/... request. */
export async function checkAccess(uid: number, method: string, path: string, body: any, query: any) {
  const m = /^\/(?:api\/)?orgs\/(\d+)\/(.+)$/.exec(path.split('?')[0]);
  if (!m) return;
  const orgId = Number(m[1]);
  const { access } = await accessFor(uid, orgId);
  if (!access) return;
  const area = await areaOf(orgId, method.toUpperCase(), m[2], body, query);
  if (!area) return;
  const read = method === 'GET' || method === 'HEAD';
  for (const a of Array.isArray(area) ? area : [area]) {
    const lv = levelOf(access, a);
    if (lv === 'none') throw new ForbiddenException(`You do not have access to ${a} for this client. Ask the firm owner.`);
    if (lv === 'view' && !read) throw new ForbiddenException(`You can look at ${a} for this client but not change it. Ask the firm owner.`);
  }
}

/** For mixed lists (all documents): which document types this person may see. */
export async function visibleDocTypes(uid: number, orgId: number): Promise<string[] | null> {
  const { access } = await accessFor(uid, orgId);
  if (!access) return null;
  const out: string[] = [];
  if (levelOf(access, 'sales') !== 'none') out.push('invoice', 'credit_note');
  if (levelOf(access, 'purchases') !== 'none') out.push('bill', 'debit_note');
  return out;
}
