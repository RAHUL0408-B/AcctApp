// Report queries. All amounts are integer paise. Call inside withOrg() so row-level security applies.
import { PoolClient } from 'pg';
import { naturalBalance } from '../ledger/ledger';

const n = (v: unknown) => Number(v);

export async function accountBalances(c: PoolClient, opts: { from?: string; to?: string; types?: string[]; excludeClosing?: boolean }) {
  const rows = (await c.query(
    `SELECT a.id, a.code, a.name, a.type, a.group_name AS "group", COALESCE(SUM(l.debit),0) AS debit, COALESCE(SUM(l.credit),0) AS credit
       FROM accounts a
       LEFT JOIN (SELECT jl.account_id, jl.debit, jl.credit FROM journal_lines jl JOIN journal_entries e ON e.id=jl.entry_id
                   WHERE ($1::date IS NULL OR e.entry_date >= $1::date) AND ($2::date IS NULL OR e.entry_date <= $2::date) AND (NOT $4 OR e.kind <> 'closing')) l ON l.account_id=a.id
      WHERE ($3::text[] IS NULL OR a.type = ANY($3))
      GROUP BY a.id ORDER BY a.code`, [opts.from ?? null, opts.to ?? null, opts.types ?? null, !!opts.excludeClosing])).rows;
  return rows.map((r) => ({ id: n(r.id), code: r.code, name: r.name, type: r.type as string, group: r.group as string,
    debit: n(r.debit), credit: n(r.credit), balance: naturalBalance(r.type, n(r.debit), n(r.credit)) }));
}

export async function profitAndLoss(c: PoolClient, from: string, to: string) {
  const rows = await accountBalances(c, { from, to, types: ['income', 'expense'], excludeClosing: true });
  const section = (type: string) => {
    const items = rows.filter((r) => r.type === type && (r.debit || r.credit));
    return { items: items.map(({ code, name, group, balance }) => ({ code, name, group, amount: balance })), total: items.reduce((s, r) => s + r.balance, 0) };
  };
  const income = section('income'), expenses = section('expense');
  return { from, to, income, expenses, netProfit: income.total - expenses.total };
}

export async function balanceSheet(c: PoolClient, asOf: string) {
  const rows = await accountBalances(c, { to: asOf });
  const section = (type: string) => {
    const items = rows.filter((r) => r.type === type && (r.debit || r.credit));
    return { items: items.map(({ code, name, group, balance }) => ({ code, name, group, amount: balance })), total: items.reduce((s, r) => s + r.balance, 0) };
  };
  const assets = section('asset'), liabilities = section('liability'), equity = section('equity');
  const income = rows.filter((r) => r.type === 'income').reduce((s, r) => s + r.balance, 0);
  const expense = rows.filter((r) => r.type === 'expense').reduce((s, r) => s + r.balance, 0);
  const profit = income - expense; // profit not yet moved to reserves by a year-end closing entry
  const equityTotal = equity.total + profit;
  return { asOf, assets, liabilities, equity: { ...equity, profitToDate: profit, total: equityTotal },
    balanced: assets.total === liabilities.total + equityTotal };
}

export async function ledgerStatement(c: PoolClient, accountId: number, from: string | null, to: string | null) {
  const acc = (await c.query('SELECT id,code,name,type FROM accounts WHERE id=$1', [accountId])).rows[0];
  if (!acc) return null;
  const sign = acc.type === 'asset' || acc.type === 'expense' ? 1 : -1;
  const open = (await c.query(
    `SELECT COALESCE(SUM(l.debit-l.credit),0) AS net FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id
      WHERE l.account_id=$1 AND $2::date IS NOT NULL AND e.entry_date < $2::date`, [accountId, from])).rows[0];
  let running = sign * n(open.net);
  const lines = (await c.query(
    `SELECT e.id AS entry_id, e.entry_date::text AS date, e.narration, e.reference, l.debit, l.credit
       FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id
      WHERE l.account_id=$1 AND ($2::date IS NULL OR e.entry_date >= $2::date) AND ($3::date IS NULL OR e.entry_date <= $3::date)
      ORDER BY e.entry_date, e.id, l.id`, [accountId, from, to])).rows.map((r) => {
    running += sign * (n(r.debit) - n(r.credit));
    return { entryId: n(r.entry_id), date: r.date, narration: r.narration, reference: r.reference, debit: n(r.debit), credit: n(r.credit), balance: running };
  });
  return { account: { id: n(acc.id), code: acc.code, name: acc.name, type: acc.type }, openingBalance: sign * n(open.net), lines, closingBalance: running };
}

const BUCKETS = ['notDue', 'days1to30', 'days31to60', 'days61to90', 'over90'] as const;

/** Outstanding invoices (receivables) or bills (payables) grouped by contact and age past due date. */
export async function aged(c: PoolClient, kind: 'receivables' | 'payables', asOf: string) {
  const rows = (await c.query(
    `SELECT * FROM (
       SELECT d.id, d.number, d.contact_id, ct.name AS contact, d.issue_date::text AS issue_date,
              COALESCE(d.due_date, d.issue_date) AS due,
              d.net_payable - COALESCE((SELECT SUM(amount) FROM payments p WHERE p.doc_id=d.id AND p.pay_date <= $2::date),0)
                            - COALESCE((SELECT SUM(total) FROM documents x WHERE x.original_doc_id=d.id AND x.status='posted' AND x.issue_date <= $2::date),0) AS outstanding
         FROM documents d JOIN contacts ct ON ct.id=d.contact_id
        WHERE d.status='posted' AND d.doc_type = $1 AND d.issue_date <= $2::date) t
      WHERE outstanding > 0 ORDER BY contact, due`, [kind === 'receivables' ? 'invoice' : 'bill', asOf])).rows;
  const asOfMs = Date.parse(asOf);
  const byContact = new Map<number, any>();
  for (const r of rows) {
    const days = Math.floor((asOfMs - Date.parse(new Date(r.due).toISOString().slice(0, 10))) / 86400000);
    const b = days <= 0 ? 'notDue' : days <= 30 ? 'days1to30' : days <= 60 ? 'days31to60' : days <= 90 ? 'days61to90' : 'over90';
    const cid = n(r.contact_id);
    const row = byContact.get(cid) ?? { contactId: cid, contact: r.contact, notDue: 0, days1to30: 0, days31to60: 0, days61to90: 0, over90: 0, total: 0, documents: [] };
    row[b] += n(r.outstanding); row.total += n(r.outstanding);
    row.documents.push({ id: n(r.id), number: r.number, dueDate: new Date(r.due).toISOString().slice(0, 10), outstanding: n(r.outstanding), daysOverdue: Math.max(days, 0) });
    byContact.set(cid, row);
  }
  const contacts = [...byContact.values()];
  const totals: Record<string, number> = { total: 0 };
  for (const b of BUCKETS) totals[b] = contacts.reduce((s, r) => s + r[b], 0);
  totals.total = contacts.reduce((s, r) => s + r.total, 0);
  return { asOf, kind, contacts, totals };
}

const B2CL_LIMIT = 25000000; // Rs 2,50,000 in paise: inter-state unregistered invoices above this are reported invoice-wise

export async function gstr1(c: PoolClient, from: string, to: string) {
  const docs = (await c.query(
    `SELECT d.*, ct.gstin AS party_gstin, ct.name AS party, o.state_code AS org_state
       FROM documents d JOIN contacts ct ON ct.id=d.contact_id JOIN organizations o ON o.id=d.org_id
      WHERE d.status='posted' AND d.doc_type IN ('invoice','credit_note') AND d.issue_date BETWEEN $1 AND $2 ORDER BY d.issue_date, d.id`, [from, to])).rows;
  const shape = (d: any) => ({ number: d.number, date: new Date(d.issue_date).toISOString().slice(0, 10), party: d.party, gstin: d.party_gstin, placeOfSupply: d.place_of_supply,
    value: n(d.total), taxable: n(d.subtotal), igst: n(d.igst), cgst: n(d.cgst), sgst: n(d.sgst) });
  const isExport = (d: any) => String(d.supply_type).startsWith('export');
  const inv = docs.filter((d) => d.doc_type === 'invoice' && !isExport(d)), cn = docs.filter((d) => d.doc_type === 'credit_note');
  const exp = docs.filter((d) => d.doc_type === 'invoice' && isExport(d)).map((d) => ({ ...shape(d), withPayment: d.supply_type === 'export_igst', currency: d.currency, foreignTotal: d.foreign_total == null ? null : n(d.foreign_total) }));
  const b2b = inv.filter((d) => d.party_gstin).map((d) => ({ ...shape(d), sez: String(d.supply_type).startsWith('sez') ? (d.supply_type === 'sez_igst' ? 'SEZWP' : 'SEZWOP') : null }));
  const unreg = inv.filter((d) => !d.party_gstin);
  const b2cl = unreg.filter((d) => d.place_of_supply !== d.org_state && n(d.total) > B2CL_LIMIT).map(shape);
  const b2csRows = unreg.filter((d) => !(d.place_of_supply !== d.org_state && n(d.total) > B2CL_LIMIT));
  const b2cs = (await c.query(
    `SELECT d.place_of_supply AS pos, l.gst_rate_bp AS "rateBp", SUM(l.taxable) AS taxable, SUM(l.igst) AS igst, SUM(l.cgst) AS cgst, SUM(l.sgst) AS sgst
       FROM document_lines l JOIN documents d ON d.id=l.doc_id LEFT JOIN contacts ct ON ct.id=d.contact_id
      WHERE d.id = ANY($1) GROUP BY d.place_of_supply, l.gst_rate_bp ORDER BY 1,2`, [b2csRows.map((d) => d.id)])).rows
    .map((r) => ({ pos: r.pos, rateBp: n(r.rateBp), taxable: n(r.taxable), igst: n(r.igst), cgst: n(r.cgst), sgst: n(r.sgst) }));
  const hsn = (await c.query(
    `SELECT COALESCE(l.hsn_sac,'(none)') AS hsn, l.gst_rate_bp AS "rateBp",
            SUM(CASE WHEN d.doc_type='credit_note' THEN -l.qty_milli ELSE l.qty_milli END) AS qty_milli,
            SUM(CASE WHEN d.doc_type='credit_note' THEN -l.taxable ELSE l.taxable END) AS taxable,
            SUM(CASE WHEN d.doc_type='credit_note' THEN -l.igst ELSE l.igst END) AS igst,
            SUM(CASE WHEN d.doc_type='credit_note' THEN -l.cgst ELSE l.cgst END) AS cgst,
            SUM(CASE WHEN d.doc_type='credit_note' THEN -l.sgst ELSE l.sgst END) AS sgst
       FROM document_lines l JOIN documents d ON d.id=l.doc_id
      WHERE d.status='posted' AND d.doc_type IN ('invoice','credit_note') AND d.issue_date BETWEEN $1 AND $2 GROUP BY 1,2 ORDER BY 1,2`, [from, to])).rows
    .map((r) => ({ hsn: r.hsn, rateBp: n(r.rateBp), quantity: n(r.qty_milli) / 1000, taxable: n(r.taxable), igst: n(r.igst), cgst: n(r.cgst), sgst: n(r.sgst) }));
  return { from, to, b2b, b2cl, b2cs, exp, cdnr: cn.filter((d) => d.party_gstin).map(shape), cdnur: cn.filter((d) => !d.party_gstin).map(shape), hsn,
    totals: { invoices: inv.length + exp.length, taxable: inv.reduce((s, d) => s + n(d.subtotal), 0) + exp.reduce((s, d) => s + d.taxable, 0) - cn.reduce((s, d) => s + n(d.subtotal), 0) } };
}

export async function gstr3b(c: PoolClient, from: string, to: string) {
  const sumBy = async (types: string[], zeroRate: boolean | null, zeroRated = false) => {
    const r = (await c.query(
      `SELECT d.doc_type, COALESCE(SUM(l.taxable),0) AS taxable, COALESCE(SUM(l.igst),0) AS igst, COALESCE(SUM(l.cgst),0) AS cgst, COALESCE(SUM(l.sgst),0) AS sgst
         FROM document_lines l JOIN documents d ON d.id=l.doc_id
        WHERE d.status='posted' AND d.doc_type = ANY($1) AND d.issue_date BETWEEN $2 AND $3 AND ($4::boolean IS NULL OR (l.gst_rate_bp = 0) = $4)
          AND (d.supply_type IN ('export_lut','export_igst','sez_lut','sez_igst')) = $5
        GROUP BY d.doc_type`, [types, from, to, zeroRated ? null : zeroRate, zeroRated])).rows;
    const acc = { taxable: 0, igst: 0, cgst: 0, sgst: 0 };
    for (const row of r) {
      const sign = row.doc_type === 'credit_note' || row.doc_type === 'debit_note' ? -1 : 1;
      for (const k of ['taxable', 'igst', 'cgst', 'sgst'] as const) acc[k] += sign * n(row[k]);
    }
    return acc;
  };
  const outwardTaxable = await sumBy(['invoice', 'credit_note'], false);
  const outwardNil = await sumBy(['invoice', 'credit_note'], true);
  const zeroRated = await sumBy(['invoice', 'credit_note'], null, true);
  const regularItc = await sumBy(['bill', 'debit_note'], false);
  const rcmRows = (await c.query(
    `SELECT COALESCE(SUM(CASE WHEN doc_type='debit_note' THEN -subtotal ELSE subtotal END),0) AS taxable, COALESCE(SUM(CASE WHEN doc_type='debit_note' THEN -rcm_igst ELSE rcm_igst END),0) AS igst,
            COALESCE(SUM(CASE WHEN doc_type='debit_note' THEN -rcm_cgst ELSE rcm_cgst END),0) AS cgst, COALESCE(SUM(CASE WHEN doc_type='debit_note' THEN -rcm_sgst ELSE rcm_sgst END),0) AS sgst
       FROM documents WHERE status='posted' AND supply_type='reverse_charge' AND doc_type IN ('bill','debit_note') AND issue_date BETWEEN $1 AND $2`, [from, to])).rows[0];
  const rcm = { taxable: n(rcmRows.taxable), igst: n(rcmRows.igst), cgst: n(rcmRows.cgst), sgst: n(rcmRows.sgst) };
  const composition = (await c.query('SELECT gst_scheme FROM organizations WHERE id = current_org()')).rows[0]?.gst_scheme === 'composition';
  const itc = composition ? { igst: 0, cgst: 0, sgst: 0 } : { igst: regularItc.igst + rcm.igst, cgst: regularItc.cgst + rcm.cgst, sgst: regularItc.sgst + rcm.sgst };
  const outward = { igst: outwardTaxable.igst + zeroRated.igst + rcm.igst, cgst: outwardTaxable.cgst + rcm.cgst, sgst: outwardTaxable.sgst + rcm.sgst };
  const payable = { igst: outward.igst - itc.igst, cgst: outward.cgst - itc.cgst, sgst: outward.sgst - itc.sgst };
  return {
    from, to,
    section31a_outwardTaxable: outwardTaxable, section31b_zeroRated: zeroRated, section31c_nilRatedExempt: { taxable: outwardNil.taxable },
    section31d_inwardReverseCharge: rcm,
    section4_itcAvailable: itc,
    netTaxPayable: payable,
    note: 'Per-head difference only. Reverse-charge tax must be paid in cash before it can be claimed as credit. Cross-head ITC set-off, blocked credits and ITC reversals are not computed; have a CA review before filing.',
  };
}
