// Tracking categories, budgets, management reports (monthly P&L, P&L by category, budget vs actual) and year-end closing.
import { BadRequestException, Body, ConflictException, Controller, Get, NotFoundException, Param, ParseIntPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { PoolClient } from 'pg';
import { z } from 'zod';
import { withOrg } from '../db/db';
import { writeAudit } from '../audit/audit';
import { AuthGuard, Ip, UserId, parse } from '../common/guard';
import { requireOrg } from '../tenancy/acl';
import { ensureAccount, insertEntry } from '../ledger/post';
import { financialYearOf, naturalBalance, validateLines } from '../ledger/ledger';
import { months, plRows } from './calc';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const range = (from?: string, to?: string) => {
  const ok = (d?: string) => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d);
  if (!ok(from) || !ok(to)) throw new BadRequestException('Give from and to as YYYY-MM-DD');
  if (from! > to!) throw new BadRequestException('from is after to');
  return { from: from!, to: to! };
};

@Controller('orgs/:orgId')
@UseGuards(AuthGuard)
export class PlanningController {
  // ---------- tracking categories ----------
  @Get('tracking')
  async tracking(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number) {
    await requireOrg(uid, orgId, 'read');
    return withOrg(orgId, async (c) => {
      const cats = (await c.query('SELECT id,name FROM tracking_categories ORDER BY name')).rows;
      const opts = (await c.query('SELECT id,category_id,name FROM tracking_options WHERE active ORDER BY name')).rows;
      return cats.map((k) => ({ id: Number(k.id), name: k.name, options: opts.filter((o) => o.category_id === k.id).map((o) => ({ id: Number(o.id), name: o.name })) }));
    });
  }

  @Post('tracking')
  async addCategory(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'manage');
    const b = parse(z.object({ name: z.string().min(1).max(60), options: z.array(z.string().min(1).max(60)).max(100).default([]) }), body);
    return withOrg(orgId, async (c) => {
      if ((await c.query('SELECT 1 FROM tracking_categories WHERE name=$1', [b.name])).rowCount) throw new ConflictException('A category with that name exists');
      const id = Number((await c.query('INSERT INTO tracking_categories(org_id,name) VALUES ($1,$2) RETURNING id', [orgId, b.name])).rows[0].id);
      for (const o of new Set(b.options)) await c.query('INSERT INTO tracking_options(org_id,category_id,name) VALUES ($1,$2,$3)', [orgId, id, o]);
      await writeAudit(c, { orgId, userId: uid, action: 'create', entity: 'tracking_category', entityId: id, after: b, ip });
      return { id };
    });
  }

  @Post('tracking/:categoryId/options')
  async addOption(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('categoryId', ParseIntPipe) categoryId: number, @Body() body: unknown) {
    await requireOrg(uid, orgId, 'manage');
    const b = parse(z.object({ name: z.string().min(1).max(60) }), body);
    return withOrg(orgId, async (c) => {
      if (!(await c.query('SELECT 1 FROM tracking_categories WHERE id=$1', [categoryId])).rowCount) throw new NotFoundException('Category not found');
      if ((await c.query('SELECT 1 FROM tracking_options WHERE category_id=$1 AND name=$2', [categoryId, b.name])).rowCount) throw new ConflictException('That option exists');
      return { id: Number((await c.query('INSERT INTO tracking_options(org_id,category_id,name) VALUES ($1,$2,$3) RETURNING id', [orgId, categoryId, b.name])).rows[0].id) };
    });
  }

  // ---------- budgets ----------
  @Get('budgets')
  async budgets(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number) {
    await requireOrg(uid, orgId, 'read');
    return withOrg(orgId, async (c) => (await c.query(
      `SELECT b.id, b.name, b.fy_start::text AS "fyStart", COALESCE(SUM(l.amount),0) AS total FROM budgets b LEFT JOIN budget_lines l ON l.budget_id=b.id GROUP BY b.id ORDER BY b.fy_start DESC, b.name`)).rows
      .map((r) => ({ ...r, id: Number(r.id), total: Number(r.total) })));
  }

  @Post('budgets')
  async addBudget(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'manage');
    const b = parse(z.object({ name: z.string().min(1).max(100), fyStart: date }), body);
    return withOrg(orgId, async (c) => {
      const startMonth = Number((await c.query('SELECT fy_start_month FROM organizations WHERE id=$1', [orgId])).rows[0].fy_start_month);
      if (financialYearOf(b.fyStart, startMonth).start !== b.fyStart) throw new BadRequestException('fyStart must be the first day of a financial year');
      if ((await c.query('SELECT 1 FROM budgets WHERE name=$1', [b.name])).rowCount) throw new ConflictException('A budget with that name exists');
      const id = Number((await c.query('INSERT INTO budgets(org_id,name,fy_start) VALUES ($1,$2,$3) RETURNING id', [orgId, b.name, b.fyStart])).rows[0].id);
      await writeAudit(c, { orgId, userId: uid, action: 'create', entity: 'budget', entityId: id, after: b, ip });
      return { id };
    });
  }

  @Get('budgets/:id')
  async budget(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number) {
    await requireOrg(uid, orgId, 'read');
    return withOrg(orgId, async (c) => {
      const b = (await c.query('SELECT id,name,fy_start::text AS "fyStart" FROM budgets WHERE id=$1', [id])).rows[0];
      if (!b) throw new NotFoundException('Budget not found');
      const lines = (await c.query(`SELECT account_id AS "accountId", to_char(month,'YYYY-MM') AS month, amount FROM budget_lines WHERE budget_id=$1 ORDER BY account_id, month`, [id])).rows
        .map((r) => ({ accountId: Number(r.accountId), month: r.month, amount: Number(r.amount) }));
      return { id: Number(b.id), name: b.name, fyStart: b.fyStart, months: months(b.fyStart, financialYearOf(b.fyStart, Number(b.fyStart.slice(5, 7))).end), lines };
    });
  }

  /** Set budget amounts. Each line is one account for one month ('YYYY-MM'); an amount of 0 removes the line. */
  @Put('budgets/:id/lines')
  async setLines(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'manage');
    const b = parse(z.object({ lines: z.array(z.object({ accountId: z.number().int().positive(), month: z.string().regex(/^\d{4}-\d{2}$/), amount: z.number().int().min(0) })).min(1).max(2000) }), body);
    return withOrg(orgId, async (c) => {
      const bud = (await c.query('SELECT fy_start::text AS s FROM budgets WHERE id=$1', [id])).rows[0];
      if (!bud) throw new NotFoundException('Budget not found');
      const allowed = new Set(months(bud.s, financialYearOf(bud.s, Number(bud.s.slice(5, 7))).end));
      const ids = [...new Set(b.lines.map((l) => l.accountId))];
      if ((await c.query("SELECT id FROM accounts WHERE id = ANY($1) AND type IN ('income','expense')", [ids])).rowCount !== ids.length) throw new BadRequestException('Budgets are for income and expense accounts');
      for (const l of b.lines) {
        if (!allowed.has(l.month)) throw new BadRequestException(`${l.month} is outside this budget's financial year`);
        if (l.amount === 0) await c.query('DELETE FROM budget_lines WHERE budget_id=$1 AND account_id=$2 AND month=$3', [id, l.accountId, `${l.month}-01`]);
        else await c.query(`INSERT INTO budget_lines(org_id,budget_id,account_id,month,amount) VALUES ($1,$2,$3,$4,$5)
          ON CONFLICT (budget_id,account_id,month) DO UPDATE SET amount=EXCLUDED.amount`, [orgId, id, l.accountId, `${l.month}-01`, l.amount]);
      }
      await writeAudit(c, { orgId, userId: uid, action: 'update', entity: 'budget', entityId: id, after: { lines: b.lines.length }, ip });
      return { saved: b.lines.length };
    });
  }

  // ---------- management reports ----------
  /** Profit and loss with one column per month. */
  @Get('reports/pnl-by-month')
  async pnlByMonth(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Query('from') f?: string, @Query('to') t?: string) {
    await requireOrg(uid, orgId, 'read');
    const { from, to } = range(f, t);
    return withOrg(orgId, async (c) => {
      const cols = months(from, to);
      if (cols.length > 24) throw new BadRequestException('Choose at most 24 months');
      const rows = (await c.query(
        `SELECT a.id, a.code, a.name, a.type, to_char(e.entry_date,'YYYY-MM') AS col, SUM(l.debit) AS d, SUM(l.credit) AS cr
           FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id JOIN accounts a ON a.id=l.account_id
          WHERE a.type IN ('income','expense') AND e.kind='normal' AND e.entry_date BETWEEN $1 AND $2 GROUP BY a.id, col`, [from, to])).rows;
      return { from, to, columns: cols, ...plRows(rows, cols) };
    });
  }

  /** Profit and loss with one column per option of a tracking category, plus "Unassigned". */
  @Get('reports/pnl-by-tracking')
  async pnlByTracking(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Query('categoryId') cat?: string, @Query('from') f?: string, @Query('to') t?: string) {
    await requireOrg(uid, orgId, 'read');
    const { from, to } = range(f, t);
    return withOrg(orgId, async (c) => {
      const category = (await c.query('SELECT id,name FROM tracking_categories WHERE id=$1', [Number(cat)])).rows[0];
      if (!category) throw new NotFoundException('Tracking category not found');
      const opts = (await c.query('SELECT id,name FROM tracking_options WHERE category_id=$1 ORDER BY name', [category.id])).rows;
      const cols = [...opts.map((o) => o.name as string), 'Unassigned'];
      const rows = (await c.query(
        `SELECT a.id, a.code, a.name, a.type, COALESCE(o.name,'Unassigned') AS col, SUM(l.debit) AS d, SUM(l.credit) AS cr
           FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id JOIN accounts a ON a.id=l.account_id
           LEFT JOIN tracking_options o ON o.id=l.tracking_option_id AND o.category_id=$3
          WHERE a.type IN ('income','expense') AND e.kind='normal' AND e.entry_date BETWEEN $1 AND $2 GROUP BY a.id, col`, [from, to, category.id])).rows;
      return { from, to, category: category.name, columns: cols, ...plRows(rows, cols) };
    });
  }

  /** Budget against actual for each income and expense account, over the months of the budget that fall in the range. */
  @Get('reports/budget-vs-actual')
  async budgetVsActual(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Query('budgetId') bid?: string, @Query('from') f?: string, @Query('to') t?: string) {
    await requireOrg(uid, orgId, 'read');
    const { from, to } = range(f, t);
    return withOrg(orgId, async (c) => {
      const budget = (await c.query('SELECT id,name FROM budgets WHERE id=$1', [Number(bid)])).rows[0];
      if (!budget) throw new NotFoundException('Budget not found');
      const budgeted = (await c.query(`SELECT account_id, SUM(amount) AS amt FROM budget_lines WHERE budget_id=$1 AND month BETWEEN date_trunc('month',$2::date) AND $3 GROUP BY account_id`, [budget.id, from, to])).rows;
      const actual = await actuals(c, from, to);
      const accounts = (await c.query("SELECT id,code,name,type FROM accounts WHERE type IN ('income','expense') ORDER BY code")).rows;
      const lines = accounts.map((a) => {
        const b = Number(budgeted.find((x) => x.account_id === a.id)?.amt ?? 0), act = actual.get(Number(a.id)) ?? 0;
        // Favourable when income beats budget or spending is under budget.
        const variance = act - b;
        return { code: a.code, name: a.name, type: a.type, budget: b, actual: act, variance, favourable: a.type === 'income' ? variance >= 0 : variance <= 0 };
      }).filter((l) => l.budget || l.actual);
      const sum = (type: string, k: 'budget' | 'actual') => lines.filter((l) => l.type === type).reduce((s, l) => s + l[k], 0);
      return { budget: budget.name, from, to, lines,
        totals: { incomeBudget: sum('income', 'budget'), incomeActual: sum('income', 'actual'), expenseBudget: sum('expense', 'budget'), expenseActual: sum('expense', 'actual'),
          profitBudget: sum('income', 'budget') - sum('expense', 'budget'), profitActual: sum('income', 'actual') - sum('expense', 'actual') } };
    });
  }

  // ---------- year-end closing ----------
  /** What closing the year would post: each income and expense balance moved to Reserves and Surplus. */
  @Get('year-end')
  async preview(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Query('fyEnd') fyEnd?: string) {
    await requireOrg(uid, orgId, 'read');
    return withOrg(orgId, async (c) => {
      const fy = await yearOf(c, orgId, fyEnd);
      const closed = await closingEntry(c, fy.end);
      const bal = await actuals(c, fy.start, fy.end, true);
      const income = [...bal.entries()].filter(([, v]) => v.type === 'income').reduce((s, [, v]) => s + v.amount, 0);
      const expense = [...bal.entries()].filter(([, v]) => v.type === 'expense').reduce((s, [, v]) => s + v.amount, 0);
      return { year: fy.label, from: fy.start, to: fy.end, income, expense, netProfit: income - expense, closed: !!closed, closingEntryId: closed };
    });
  }

  /** Post the closing entry on the last day of the year, optionally locking the year so nothing else can be posted into it. */
  @Post('year-end/close')
  async close(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOrg(uid, orgId, 'manage');
    const b = parse(z.object({ fyEnd: date, lock: z.boolean().default(true) }), body);
    return withOrg(orgId, async (c) => {
      const fy = await yearOf(c, orgId, b.fyEnd);
      if (await closingEntry(c, fy.end)) throw new ConflictException(`${fy.label} is already closed`);
      const bal = await actuals(c, fy.start, fy.end, true);
      const reserves = await ensureAccount(c, orgId, '3100');
      const lines: { accountId: number; debit?: number; credit?: number }[] = [];
      let profit = 0;
      for (const [accountId, v] of bal) {
        if (!v.amount) continue;
        // Zero each account: income has a credit balance (debit it), expenses a debit balance (credit them).
        const debitSide = (v.type === 'income') === (v.amount > 0);
        lines.push(debitSide ? { accountId, debit: Math.abs(v.amount) } : { accountId, credit: Math.abs(v.amount) });
        profit += v.type === 'income' ? v.amount : -v.amount;
      }
      if (!lines.length) throw new BadRequestException(`Nothing to close: no income or expenses in ${fy.label}`);
      if (profit) lines.push(profit > 0 ? { accountId: reserves, credit: profit } : { accountId: reserves, debit: -profit });
      const eid = await insertEntry(c, orgId, uid, fy.end, `Year-end close ${fy.label}: profit to reserves`, `CLOSE-${fy.label}`, null, validateLines(lines), 'closing');
      if (b.lock) {
        await c.query(`INSERT INTO financial_years(org_id,label,starts_on,ends_on,locked_through) VALUES ($1,$2,$3,$4,$4)
          ON CONFLICT (org_id,starts_on) DO UPDATE SET locked_through=GREATEST(financial_years.locked_through, EXCLUDED.locked_through)`, [orgId, fy.label, fy.start, fy.end]);
      }
      await writeAudit(c, { orgId, userId: uid, action: 'year_end_close', entity: 'financial_year', after: { year: fy.label, profit, entryId: eid, locked: b.lock }, ip });
      return { year: fy.label, netProfit: profit, closingEntryId: eid, lockedThrough: b.lock ? fy.end : null };
    });
  }
}

/** The financial year ending on fyEnd, which must be a real year end for this organisation. */
async function yearOf(c: PoolClient, orgId: number, fyEnd?: string) {
  if (!fyEnd || !/^\d{4}-\d{2}-\d{2}$/.test(fyEnd)) throw new BadRequestException('Give fyEnd as YYYY-MM-DD');
  const startMonth = Number((await c.query('SELECT fy_start_month FROM organizations WHERE id=$1', [orgId])).rows[0].fy_start_month);
  const fy = financialYearOf(fyEnd, startMonth);
  if (fy.end !== fyEnd) throw new BadRequestException(`${fyEnd} is not a financial year end (${fy.label} ends on ${fy.end})`);
  return fy;
}

/** The closing entry posted on this date, unless it has been reversed. */
async function closingEntry(c: PoolClient, end: string): Promise<number | null> {
  const r = (await c.query(`SELECT id FROM journal_entries e WHERE kind='closing' AND entry_date=$1 AND reverses_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_id=e.id)`, [end])).rows[0];
  return r ? Number(r.id) : null;
}

/** Income/expense balances in their natural direction, ignoring closing entries. */
async function actuals(c: PoolClient, from: string, to: string): Promise<Map<number, number>>;
async function actuals(c: PoolClient, from: string, to: string, withType: true): Promise<Map<number, { type: string; amount: number }>>;
async function actuals(c: PoolClient, from: string, to: string, withType = false): Promise<Map<number, any>> {
  const rows = (await c.query(
    `SELECT a.id, a.type, SUM(l.debit) AS d, SUM(l.credit) AS cr FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id JOIN accounts a ON a.id=l.account_id
      WHERE a.type IN ('income','expense') AND e.kind='normal' AND e.entry_date BETWEEN $1 AND $2 GROUP BY a.id ORDER BY a.code`, [from, to])).rows;
  return new Map(rows.map((r) => {
    const amount = naturalBalance(r.type, Number(r.d), Number(r.cr));
    return [Number(r.id), withType ? { type: r.type, amount } : amount];
  }));
}
