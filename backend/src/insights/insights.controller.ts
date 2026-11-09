// Read-only views over the books: sales and purchases overviews, search, notifications, the setup guide,
// short-term cash flow, the business snapshot with its health scorecard, and the TDS deducted report.
import { fyOfDate, itc180Report, msmeReport } from '../compliance/checks';
import { BadRequestException, Controller, Get, Param, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
import { PoolClient } from 'pg';
import { withOrg } from '../db/db';
import { AuthGuard, UserId } from '../common/guard';
import { requireOrg } from '../tenancy/acl';
import { financialYearOf } from '../ledger/ledger';
import { aged } from '../accounting/reports';
import { cashWeeks, depositBy, fyQuarter, grade, round1 } from './calc';

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);
const isDate = (d?: string) => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d);

/** Invoices and bills with money still owed on them, in rupees. */
const OPEN_DOCS = `
  SELECT * FROM (
    SELECT d.id, d.doc_type, d.number, ct.name AS contact, d.issue_date::text AS issue_date, COALESCE(d.due_date, d.issue_date)::text AS due,
           d.net_payable - COALESCE((SELECT SUM(amount) FROM payments p WHERE p.doc_id=d.id),0)
                         - COALESCE((SELECT SUM(total) FROM documents x WHERE x.original_doc_id=d.id AND x.status='posted'),0) AS outstanding
      FROM documents d JOIN contacts ct ON ct.id=d.contact_id
     WHERE d.status='posted' AND d.doc_type IN ('invoice','bill')) o
   WHERE outstanding > 0`;

async function openDocs(c: PoolClient) {
  return (await c.query(`${OPEN_DOCS} ORDER BY due, id`)).rows.map((r) => ({ id: Number(r.id), docType: r.doc_type as string, number: r.number as string, contact: r.contact as string, issueDate: r.issue_date as string, due: r.due as string, outstanding: Number(r.outstanding) }));
}

/** Cash and bank balance: every bank account's ledger account plus Cash in Hand (1000). */
async function cashBalance(c: PoolClient, asOf?: string) {
  return Number((await c.query(
    `SELECT COALESCE(SUM(l.debit-l.credit),0) AS s FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id JOIN accounts a ON a.id=l.account_id
      WHERE (a.id IN (SELECT account_id FROM bank_accounts) OR a.code='1000') AND ($1::date IS NULL OR e.entry_date <= $1::date)`, [asOf ?? null])).rows[0].s);
}

@Controller('orgs/:orgId')
@UseGuards(AuthGuard)
export class InsightsController {
  /** Sales or purchases overview: what is waiting, what is overdue, the last six months and the biggest contacts. */
  @Get('overview/:side')
  async overview(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('side') side: string) {
    await requireOrg(uid, orgId, 'read');
    if (side !== 'sales' && side !== 'purchases') throw new BadRequestException('side must be sales or purchases');
    const docType = side === 'sales' ? 'invoice' : 'bill', preKind = side === 'sales' ? 'quote' : 'purchase_order';
    return withOrg(orgId, async (c) => {
      const t = today(), soon = addDays(t, 7), fy = financialYearOf(t);
      const open = (await openDocs(c)).filter((d) => d.docType === docType);
      const sum = (xs: typeof open) => ({ count: xs.length, total: xs.reduce((s, d) => s + d.outstanding, 0) });
      const drafts = (await c.query("SELECT COUNT(*)::int AS count, COALESCE(SUM(total),0) AS total FROM document_drafts WHERE status='submitted' AND doc_type=$1", [docType])).rows[0];
      const pre = (await c.query(
        `SELECT COUNT(*) FILTER (WHERE status IN ('draft','sent'))::int AS open, COALESCE(SUM(total) FILTER (WHERE status IN ('draft','sent')),0) AS open_total,
                COUNT(*) FILTER (WHERE status='accepted')::int AS accepted FROM pre_documents WHERE kind=$1`, [preKind])).rows[0];
      const months = (await c.query(
        `WITH m AS (SELECT to_char(date_trunc('month', $2::date) - (n || ' month')::interval, 'YYYY-MM') AS ym FROM generate_series(0,5) n)
         SELECT m.ym,
                COALESCE((SELECT SUM(total) FROM documents d WHERE d.doc_type=$1 AND d.status='posted' AND to_char(d.issue_date,'YYYY-MM')=m.ym),0) AS billed,
                COALESCE((SELECT SUM(p.amount) FROM payments p JOIN documents d ON d.id=p.doc_id WHERE d.doc_type=$1 AND to_char(p.pay_date,'YYYY-MM')=m.ym),0) AS paid
           FROM m ORDER BY m.ym`, [docType, t])).rows.map((r) => ({ month: r.ym, billed: Number(r.billed), paid: Number(r.paid) }));
      const top = (await c.query(
        `SELECT ct.name, SUM(d.total) AS total FROM documents d JOIN contacts ct ON ct.id=d.contact_id
          WHERE d.doc_type=$1 AND d.status='posted' AND d.issue_date BETWEEN $2 AND $3 GROUP BY ct.name ORDER BY 2 DESC LIMIT 5`, [docType, fy.start, fy.end])).rows
        .map((r) => ({ contact: r.name, total: Number(r.total) }));
      return {
        side, fyLabel: fy.label,
        awaitingApproval: { count: drafts.count, total: Number(drafts.total) },
        awaitingPayment: sum(open),
        overdue: sum(open.filter((d) => d.due < t)),
        dueThisWeek: sum(open.filter((d) => d.due >= t && d.due <= soon)),
        [side === 'sales' ? 'quotes' : 'purchaseOrders']: { open: pre.open, openTotal: Number(pre.open_total), accepted: pre.accepted },
        months, top,
        oldestOverdue: open.filter((d) => d.due < t).slice(0, 5),
      };
    });
  }

  /** Search contacts, invoices and bills, quotes and orders, items, projects and journal entries. */
  @Get('search')
  async search(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Query('q') q?: string) {
    await requireOrg(uid, orgId, 'read');
    const text = (q ?? '').trim();
    if (text.length < 2) return { results: [] };
    const like = `%${text.slice(0, 100).replace(/[\\%_]/g, (m) => '\\' + m)}%`;
    return withOrg(orgId, async (c) => {
      const results: { type: string; id: number; title: string; subtitle: string; page: string }[] = [];
      for (const r of (await c.query('SELECT id,name,kind,gstin FROM contacts WHERE name ILIKE $1 OR gstin ILIKE $1 ORDER BY name LIMIT 8', [like])).rows)
        results.push({ type: 'Contact', id: Number(r.id), title: r.name, subtitle: [r.kind, r.gstin].filter(Boolean).join(' · '), page: r.kind === 'supplier' ? 'suppliers' : 'customers' });
      for (const r of (await c.query(
        `SELECT d.id,d.number,d.doc_type,ct.name,d.total,d.issue_date::text AS date FROM documents d JOIN contacts ct ON ct.id=d.contact_id
          WHERE d.number ILIKE $1 OR ct.name ILIKE $1 OR d.supplier_ref ILIKE $1 ORDER BY d.id DESC LIMIT 8`, [like])).rows)
        results.push({ type: r.doc_type.replace('_', ' '), id: Number(r.id), title: `${r.number} · ${r.name}`, subtitle: `${r.date} · ₹${(Number(r.total) / 100).toFixed(2)}`, page: ['invoice', 'credit_note'].includes(r.doc_type) ? 'invoices' : 'bills' });
      for (const r of (await c.query(
        `SELECT p.id,p.number,p.kind,ct.name FROM pre_documents p JOIN contacts ct ON ct.id=p.contact_id WHERE p.number ILIKE $1 OR ct.name ILIKE $1 ORDER BY p.id DESC LIMIT 5`, [like])).rows)
        results.push({ type: r.kind === 'quote' ? 'Quote' : 'Purchase order', id: Number(r.id), title: `${r.number} · ${r.name}`, subtitle: '', page: r.kind === 'quote' ? 'quotes' : 'purchase-orders' });
      for (const r of (await c.query('SELECT id,code,name FROM items WHERE active AND (code ILIKE $1 OR name ILIKE $1) ORDER BY name LIMIT 5', [like])).rows)
        results.push({ type: 'Item', id: Number(r.id), title: `${r.code} · ${r.name}`, subtitle: '', page: 'items' });
      for (const r of (await c.query('SELECT id,name,status FROM projects WHERE name ILIKE $1 ORDER BY name LIMIT 5', [like])).rows)
        results.push({ type: 'Project', id: Number(r.id), title: r.name, subtitle: r.status.replace('_', ' '), page: 'projects' });
      for (const r of (await c.query('SELECT id,entry_date::text AS date,narration FROM journal_entries WHERE narration ILIKE $1 OR reference ILIKE $1 ORDER BY id DESC LIMIT 5', [like])).rows)
        results.push({ type: 'Journal', id: Number(r.id), title: `#${r.id} · ${r.narration}`, subtitle: r.date, page: 'journal' });
      return { results };
    });
  }

  /** Things that need attention, newest problems first. */
  @Get('notifications')
  async notifications(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number) {
    await requireOrg(uid, orgId, 'read');
    return withOrg(orgId, async (c) => {
      const t = today(), soon = addDays(t, 7);
      const open = await openDocs(c);
      const items: { key: string; text: string; page: string; tone: 'bad' | 'warn' | 'info' }[] = [];
      const rupees = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      const add = (key: string, n: number, text: string, page: string, tone: 'bad' | 'warn' | 'info') => { if (n > 0) items.push({ key, text, page, tone }); };
      const lateInv = open.filter((d) => d.docType === 'invoice' && d.due < t), lateBill = open.filter((d) => d.docType === 'bill' && d.due < t);
      const billSoon = open.filter((d) => d.docType === 'bill' && d.due >= t && d.due <= soon);
      add('overdue-invoices', lateInv.length, `${lateInv.length} overdue invoice(s), ${rupees(lateInv.reduce((s, d) => s + d.outstanding, 0))} to collect`, 'invoices', 'bad');
      add('overdue-bills', lateBill.length, `${lateBill.length} overdue bill(s), ${rupees(lateBill.reduce((s, d) => s + d.outstanding, 0))} to pay`, 'bills', 'bad');
      add('bills-due', billSoon.length, `${billSoon.length} bill(s) due in the next 7 days`, 'bills', 'warn');
      const one = async (sql: string, p: unknown[] = []) => Number((await c.query(sql, p)).rows[0].n);
      const drafts = await one("SELECT COUNT(*) AS n FROM document_drafts WHERE status='submitted'");
      add('approvals', drafts, `${drafts} invoice(s) or bill(s) awaiting approval`, 'approvals', 'warn');
      const claims = await one("SELECT COUNT(*) AS n FROM expense_claims WHERE status='submitted'");
      add('claims', claims, `${claims} expense claim(s) to approve`, 'expenses', 'warn');
      const repay = await one("SELECT COUNT(*) AS n FROM expense_claims WHERE status='approved'");
      add('claims-repay', repay, `${repay} approved expense claim(s) to repay`, 'expenses', 'info');
      const unrec = await one("SELECT COUNT(*) AS n FROM bank_transactions WHERE status='unreconciled'");
      add('reconcile', unrec, `${unrec} bank statement line(s) to reconcile`, 'bank', 'info');
      const lateTasks = await one("SELECT COUNT(*) AS n FROM tasks WHERE status='open' AND due_date < $1::date", [t]);
      add('tasks-overdue', lateTasks, `${lateTasks} task(s) or filing deadline(s) overdue`, 'tasks', 'bad');
      const tasksSoon = await one("SELECT COUNT(*) AS n FROM tasks WHERE status='open' AND due_date BETWEEN $1::date AND $2::date", [t, soon]);
      add('tasks-soon', tasksSoon, `${tasksSoon} task(s) or filing deadline(s) due this week`, 'tasks', 'warn');
      const quotes = await one("SELECT COUNT(*) AS n FROM pre_documents WHERE kind='quote' AND status IN ('draft','sent') AND expiry_date BETWEEN $1::date AND $2::date", [t, soon]);
      add('quotes', quotes, `${quotes} quote(s) expiring this week`, 'quotes', 'info');
      // Compliance: MSME suppliers to pay before the 43B(h) limit, and input tax credit to reverse after 180 days unpaid.
      const msme = await msmeReport(c, fyOfDate(t).start, t);
      const msmeLate = msme.rows.filter((r) => r.status === 'overdue'), msmeSoon = msme.rows.filter((r) => r.status === 'due' && (r.daysLeft ?? 99) <= 7);
      add('msme-overdue', msmeLate.length, `${msmeLate.length} MSME bill(s) past the 43B(h) limit, ${rupees(msmeLate.reduce((s, r) => s + r.unpaid, 0))} unpaid: the expense is not allowed until paid`, 'compliance/msme', 'bad');
      add('msme-soon', msmeSoon.length, `${msmeSoon.length} MSME bill(s) to pay within 7 days to keep the expense allowed`, 'compliance/msme', 'warn');
      const itc = await itc180Report(c, t);
      const rev = itc.rows.filter((r) => r.status === 'reverse');
      add('itc-180', rev.length, `${rev.length} bill(s) unpaid for over 180 days: ${rupees(itc.totals.reverseNow)} input tax credit to reverse`, 'compliance/itc180', 'bad');
      return { count: items.length, items };
    });
  }

  /** First steps for a new organisation; each is done when the data shows it. */
  @Get('setup-guide')
  async setupGuide(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number) {
    await requireOrg(uid, orgId, 'read');
    return withOrg(orgId, async (c) => {
      const has = async (sql: string) => !!(await c.query(sql)).rowCount;
      const steps = [
        { key: 'details', label: 'Add business details', text: 'GSTIN or PAN, printed on invoices and used to work out GST.', page: 'settings',
          done: await has('SELECT 1 FROM organizations WHERE id = current_org() AND (gstin IS NOT NULL OR pan IS NOT NULL)') },
        { key: 'bank', label: 'Add your bank account', text: 'Then import statements and reconcile them.', page: 'bank', done: await has('SELECT 1 FROM bank_accounts LIMIT 1') },
        { key: 'contacts', label: 'Add customers and suppliers', text: 'Their GSTIN decides CGST + SGST or IGST.', page: 'customers', done: await has('SELECT 1 FROM contacts LIMIT 1') },
        { key: 'invoice', label: 'Send an invoice', text: 'Create, email and track what customers owe you.', page: 'invoices', done: await has("SELECT 1 FROM documents WHERE doc_type='invoice' LIMIT 1") },
        { key: 'bill', label: 'Enter a bill', text: 'Track what you owe and when it is due.', page: 'bills', done: await has("SELECT 1 FROM documents WHERE doc_type='bill' LIMIT 1") },
        { key: 'statement', label: 'Import a bank statement', text: 'Match each line to your books.', page: 'bank', done: await has('SELECT 1 FROM bank_transactions LIMIT 1') },
      ];
      return { completed: steps.filter((s) => s.done).length, total: steps.length, steps };
    });
  }

  /** Cash now, plus money due in from invoices and out on bills, week by week for the next 7 to 90 days. */
  @Get('reports/short-term-cash-flow')
  async shortTermCashFlow(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Query('days') days?: string) {
    await requireOrg(uid, orgId, 'read');
    const n = Math.min(90, Math.max(7, Number(days) || 30));
    return withOrg(orgId, async (c) => {
      const t = today();
      const opening = await cashBalance(c);
      const items = (await openDocs(c)).map((d) => ({ date: d.due, number: d.number, contact: d.contact, direction: d.docType === 'invoice' ? 'in' as const : 'out' as const, amount: d.outstanding, overdue: d.due < t }));
      return { asOf: t, days: n, ...cashWeeks(opening, t, n, items), items: items.filter((i) => i.date <= addDays(t, n - 1)) };
    });
  }

  /** Key figures for a period, with a simple health scorecard. Ratios are guidance, not advice. */
  @Get('reports/business-snapshot')
  async snapshot(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Query('from') from?: string, @Query('to') to?: string) {
    await requireOrg(uid, orgId, 'read');
    const fy = financialYearOf(today());
    const f = from ?? fy.start, e = to ?? today();
    if (!isDate(f) || !isDate(e) || f > e) throw new BadRequestException('Give from and to as YYYY-MM-DD, from first');
    return withOrg(orgId, async (c) => {
      const pl = (await c.query(
        `SELECT a.type, a.group_name, SUM(l.credit - l.debit) AS cr FROM journal_lines l JOIN journal_entries en ON en.id=l.entry_id JOIN accounts a ON a.id=l.account_id
          WHERE en.entry_date BETWEEN $1 AND $2 AND en.kind='normal' AND a.type IN ('income','expense') GROUP BY 1,2`, [f, e])).rows;
      const income = pl.filter((r) => r.type === 'income').reduce((s, r) => s + Number(r.cr), 0);
      const expenses = -pl.filter((r) => r.type === 'expense').reduce((s, r) => s + Number(r.cr), 0);
      const costOfSales = -pl.filter((r) => r.type === 'expense' && ['Cost of Goods Sold', 'Direct Costs'].includes(r.group_name)).reduce((s, r) => s + Number(r.cr), 0);
      const bal = (await c.query(
        `SELECT a.type, a.group_name, (a.id IN (SELECT account_id FROM bank_accounts)) AS is_bank, SUM(l.debit - l.credit) AS dr
           FROM journal_lines l JOIN journal_entries en ON en.id=l.entry_id JOIN accounts a ON a.id=l.account_id
          WHERE en.entry_date <= $1 AND a.type IN ('asset','liability') GROUP BY 1,2,3`, [e])).rows;
      const currentAssets = bal.filter((r) => r.type === 'asset' && (r.is_bank || ['Cash and Bank', 'Current Assets', 'GST Input Credit'].includes(r.group_name))).reduce((s, r) => s + Number(r.dr), 0);
      const currentLiabilities = -bal.filter((r) => r.type === 'liability' && ['Current Liabilities', 'GST Payable', 'Statutory Dues'].includes(r.group_name)).reduce((s, r) => s + Number(r.dr), 0);
      const cash = await cashBalance(c, e);
      const receivables = (await aged(c, 'receivables', e)).totals.total, payables = (await aged(c, 'payables', e)).totals.total;
      const days = Math.round((Date.parse(e) - Date.parse(f)) / 86400000) + 1;
      const avgDays = async (docType: string) => {
        const r = (await c.query(
          `SELECT SUM(p.amount * (p.pay_date - d.issue_date))::float8 / NULLIF(SUM(p.amount),0) AS d FROM payments p JOIN documents d ON d.id=p.doc_id
            WHERE d.doc_type=$1 AND p.pay_date BETWEEN $2 AND $3`, [docType, f, e])).rows[0].d;
        return r == null ? null : Math.round(Number(r));
      };
      const profit = income - expenses, grossProfit = income - costOfSales;
      const monthlyExpenses = expenses / (days / 30.4375);
      const m = {
        grossMarginPct: income ? round1((grossProfit / income) * 100) : null,
        netMarginPct: income ? round1((profit / income) * 100) : null,
        currentRatio: currentLiabilities > 0 ? round1(currentAssets / currentLiabilities) : null,
        debtorDays: income > 0 ? Math.round((receivables / income) * days) : null,
        creditorDays: expenses > 0 ? Math.round((payables / expenses) * days) : null,
        daysToGetPaid: await avgDays('invoice'),
        daysToPaySuppliers: await avgDays('bill'),
        cashCoverMonths: monthlyExpenses > 0 ? round1(cash / monthlyExpenses) : null,
      };
      const scorecard = [
        { metric: 'Current ratio', value: m.currentRatio, unit: '×', status: grade(m.currentRatio, 1.5, 1), help: 'Current assets ÷ current liabilities. Above 1.5 means what falls due soon is well covered.' },
        { metric: 'Net profit margin', value: m.netMarginPct, unit: '%', status: grade(m.netMarginPct, 10, 0), help: 'Profit as a share of income for the period.' },
        { metric: 'Days to get paid', value: m.daysToGetPaid ?? m.debtorDays, unit: 'days', status: grade(m.daysToGetPaid ?? m.debtorDays, 30, 60, true), help: 'Average days from invoice to payment. Under 30 is healthy.' },
        { metric: 'Cash cover', value: m.cashCoverMonths, unit: 'months', status: grade(m.cashCoverMonths, 3, 1), help: 'How many months of expenses the cash in the bank would pay for.' },
      ];
      return { from: f, to: e, days, income, costOfSales, grossProfit, expenses, profit, cash, receivables, payables, currentAssets, currentLiabilities, ...m, scorecard };
    });
  }

  /** TDS deducted on bills: what to deposit by when, and the rows for the quarterly 26Q return. */
  @Get('reports/tds')
  async tds(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Query('from') from?: string, @Query('to') to?: string) {
    await requireOrg(uid, orgId, 'read');
    const fy = financialYearOf(today());
    const f = from ?? fy.start, e = to ?? today();
    if (!isDate(f) || !isDate(e) || f > e) throw new BadRequestException('Give from and to as YYYY-MM-DD, from first');
    return withOrg(orgId, async (c) => {
      const rows = (await c.query(
        `SELECT d.id, d.number, d.issue_date::text AS date, ct.name, COALESCE(ct.pan, substring(ct.gstin from 3 for 10)) AS pan, d.tds_section, d.subtotal, d.tds_amount
           FROM documents d JOIN contacts ct ON ct.id=d.contact_id
          WHERE d.doc_type='bill' AND d.status='posted' AND d.tds_amount > 0 AND d.issue_date BETWEEN $1 AND $2 ORDER BY d.issue_date, d.id`, [f, e])).rows
        .map((r) => ({ id: Number(r.id), number: r.number, date: r.date, party: r.name, pan: r.pan, section: r.tds_section, amount: Number(r.subtotal), tds: Number(r.tds_amount), quarter: fyQuarter(r.date) }));
      const group = <K extends string>(key: (r: (typeof rows)[number]) => K) => {
        const m = new Map<K, { count: number; amount: number; tds: number }>();
        for (const r of rows) { const g = m.get(key(r)) ?? { count: 0, amount: 0, tds: 0 }; g.count++; g.amount += r.amount; g.tds += r.tds; m.set(key(r), g); }
        return m;
      };
      return {
        from: f, to: e, rows,
        bySection: [...group((r) => r.section).entries()].map(([section, g]) => ({ section, ...g })),
        byMonth: [...group((r) => r.date.slice(0, 7)).entries()].map(([month, g]) => ({ month, tds: g.tds, depositBy: depositBy(month) })),
        totalTds: rows.reduce((s, r) => s + r.tds, 0),
        note: 'Working paper. Debit notes against bills are not deducted here; check challans and 26Q with your CA.',
      };
    });
  }
}
