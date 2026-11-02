// Practice overview: one row per client the user can see, with the numbers an accountant checks every morning.
import { Controller, Get, UseGuards } from '@nestjs/common';
import { getPool, withOrg } from '../db/db';
import { AuthGuard, UserId } from '../common/guard';

interface ClientRow {
  id: number; name: string; gstin: string | null; cash: number; receivable: number; receivableOverdue: number; payable: number; payableOverdue: number;
  unreconciled: number; openTasks: number; overdueTasks: number; awaitingApproval: number; lastEntry: string | null; lockedThrough: string | null;
}

@Controller('practice')
@UseGuards(AuthGuard)
export class PracticeController {
  @Get('overview')
  async overview(@UserId() uid: number) {
    const orgs = (await getPool().query(
      `SELECT DISTINCT o.id, o.name, o.gstin FROM organizations o JOIN memberships m ON m.firm_id=o.firm_id
        WHERE m.user_id=$1 AND (m.org_id IS NULL OR m.org_id=o.id) ORDER BY o.name`, [uid])).rows;
    const clients: ClientRow[] = [];
    for (const o of orgs) {
      const orgId = Number(o.id);
      clients.push(await withOrg(orgId, async (c) => {
        const money = (await c.query(
          `SELECT
             COALESCE(SUM(x.outstanding) FILTER (WHERE x.doc_type='invoice'),0) AS receivable,
             COALESCE(SUM(x.outstanding) FILTER (WHERE x.doc_type='invoice' AND x.due_date < CURRENT_DATE),0) AS receivable_overdue,
             COALESCE(SUM(x.outstanding) FILTER (WHERE x.doc_type='bill'),0) AS payable,
             COALESCE(SUM(x.outstanding) FILTER (WHERE x.doc_type='bill' AND x.due_date < CURRENT_DATE),0) AS payable_overdue
           FROM (SELECT d.doc_type, d.due_date, d.net_payable - COALESCE((SELECT SUM(amount) FROM payments p WHERE p.doc_id=d.id),0)
                        - COALESCE((SELECT SUM(total) FROM documents n WHERE n.original_doc_id=d.id AND n.status='posted'),0) AS outstanding
                   FROM documents d WHERE d.status='posted' AND d.doc_type IN ('invoice','bill')) x`)).rows[0];
        const cash = (await c.query(
          `SELECT COALESCE(SUM(l.debit-l.credit),0) AS s FROM journal_lines l JOIN accounts a ON a.id=l.account_id
            WHERE a.code='1000' OR a.id IN (SELECT account_id FROM bank_accounts)`)).rows[0].s;
        const counts = (await c.query(
          `SELECT (SELECT count(*) FROM bank_transactions WHERE status='unreconciled')::int AS unreconciled,
                  (SELECT count(*) FROM tasks WHERE status='open')::int AS open_tasks,
                  (SELECT count(*) FROM tasks WHERE status='open' AND due_date < CURRENT_DATE)::int AS overdue_tasks,
                  (SELECT count(*) FROM document_drafts WHERE status='submitted')::int AS drafts,
                  (SELECT count(*) FROM expense_claims WHERE status='submitted')::int AS claims,
                  (SELECT MAX(entry_date)::text FROM journal_entries) AS last_entry,
                  (SELECT MAX(locked_through)::text FROM financial_years) AS locked_through`)).rows[0];
        return {
          id: orgId, name: o.name, gstin: o.gstin, cash: Number(cash),
          receivable: Number(money.receivable), receivableOverdue: Number(money.receivable_overdue),
          payable: Number(money.payable), payableOverdue: Number(money.payable_overdue),
          unreconciled: counts.unreconciled, openTasks: counts.open_tasks, overdueTasks: counts.overdue_tasks,
          awaitingApproval: counts.drafts + counts.claims, lastEntry: counts.last_entry, lockedThrough: counts.locked_through,
        };
      }));
    }
    const sum = (k: 'cash' | 'receivable' | 'receivableOverdue' | 'payable' | 'overdueTasks' | 'unreconciled' | 'awaitingApproval') => clients.reduce((s, x) => s + x[k], 0);
    return {
      clients,
      totals: { clients: clients.length, cash: sum('cash'), receivable: sum('receivable'), receivableOverdue: sum('receivableOverdue'), payable: sum('payable'),
        overdueTasks: sum('overdueTasks'), unreconciled: sum('unreconciled'), awaitingApproval: sum('awaitingApproval') },
    };
  }
}
