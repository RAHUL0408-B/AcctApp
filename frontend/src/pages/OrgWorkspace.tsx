import { useCallback, useEffect, useState } from 'react';
import { api, fmt, toPaise } from '../api';
import type { Org } from '../App';
import { Button, Card, ErrorMsg, Field, Ok, useAction } from '../ui';
import { Documents } from './Documents';
import { Contacts } from './Contacts';
import { Bank } from './Bank';
import { Reports } from './Reports';
import { Files, Import, Schedules, Tasks } from './Practice';
import { PreDocs, Recurring } from './Sales';
import { DocDefaults, FixedAssets, Items, OrgSettings } from './Accounting';
import { Dashboard } from './Dashboard';
import { PageHeader } from '../kit';
import { Inventory } from './Inventory';
import { Approvals, ExpenseClaims } from './Approvals';
import { Budgets, Tracking, YearEnd } from './Planning';
import { ExportTemplates } from './ExportTemplates';
import { Overview } from './Overview';
import { Journal } from './Journal';
import { Money } from './Money';
import { Projects } from './Projects';

interface Account { id: number; code: string; name: string; type: string; group: string }
interface Entry { id: number; date: string; narration: string; reversesId: number | null; lines: { accountId: number; debit: number; credit: number }[] }
interface TB { accounts: { code: string; name: string; debit: number; credit: number }[]; totalDebit: number; totalCredit: number; balanced: boolean }

export type PageKey = 'dashboard' | 'invoices' | 'quotes' | 'recurring' | 'customers' | 'bills' | 'purchase-orders' | 'suppliers' | 'bank' | 'journal' | 'coa' | 'assets' | 'items' | 'reports' | 'tasks' | 'files' | 'import' | 'schedules' | 'settings'
  | 'approvals' | 'expenses' | 'inventory' | 'budgets' | 'year-end' | 'tracking' | 'export-templates'
  | 'sales-overview' | 'purchases-overview' | 'contacts' | 'bank-rules' | 'money' | 'projects' | 'sales-settings' | 'purchases-settings';

/** One menu entry. `sub` opens a page at a particular tab or report; heading, divider and gear only change how the menu looks. */
export interface NavItem { key: PageKey; label: string; sub?: string; manage?: boolean; owner?: boolean; for?: ('sales' | 'employee')[]; heading?: string; divider?: boolean; gear?: boolean }

/** Top-bar menus. Entries marked manage are only shown to owners and accountants. */
export const NAV: { group: string; items: NavItem[] }[] = [
  { group: 'Home', items: [{ key: 'dashboard', label: 'Home' }] },
  { group: 'Sales', items: [
    { key: 'sales-overview', label: 'Sales overview' }, { key: 'invoices', label: 'Invoices', for: ['sales'] }, { key: 'quotes', label: 'Quotes', for: ['sales'] }, { key: 'recurring', label: 'Repeating invoices' },
    { key: 'items', label: 'Products and services', for: ['sales'] }, { key: 'customers', label: 'Customers', for: ['sales'] },
    { key: 'sales-settings', label: 'Sales settings', divider: true, gear: true, manage: true }] },
  { group: 'Purchases', items: [
    { key: 'purchases-overview', label: 'Purchases overview' }, { key: 'bills', label: 'Bills' }, { key: 'purchase-orders', label: 'Purchase orders' },
    { key: 'expenses', label: 'Expense claims', for: ['employee'] }, { key: 'approvals', label: 'Awaiting approval' }, { key: 'suppliers', label: 'Suppliers' },
    { key: 'purchases-settings', label: 'Purchases settings', divider: true, gear: true, manage: true }] },
  { group: 'Reporting', items: [
    { key: 'reports', label: 'All reports' },
    { key: 'reports', sub: 'stcf', label: 'Short-term cash flow', heading: 'Analytics', divider: true }, { key: 'reports', sub: 'snap', label: 'Business snapshot' },
    { key: 'reports', sub: 'pnlm', label: 'P&L by month' }, { key: 'reports', sub: 'bva', label: 'Budget vs actual' }] },
  { group: 'Accounting', items: [
    { key: 'bank', label: 'Bank accounts', heading: 'Banking' }, { key: 'bank-rules', label: 'Bank rules' },
    { key: 'money', sub: 'spend', label: 'Spend money' }, { key: 'money', sub: 'receive', label: 'Receive money' }, { key: 'money', sub: 'transfer', label: 'Transfer money' },
    { key: 'coa', label: 'Chart of accounts', heading: 'Ledger' }, { key: 'journal', label: 'Manual journals' }, { key: 'assets', label: 'Fixed assets' },
    { key: 'inventory', label: 'Inventory' }, { key: 'budgets', label: 'Budgets' }, { key: 'tracking', label: 'Cost centres' },
    { key: 'files', label: 'Documents', heading: 'Records and setup' }, { key: 'year-end', label: 'Year-end close' },
    { key: 'import', label: 'Import data', manage: true }, { key: 'schedules', label: 'Scheduled emails', manage: true },
    { key: 'export-templates', label: 'Export templates', owner: true },
    { key: 'settings', label: 'Organisation settings', gear: true }] },
  { group: 'Tax', items: [
    { key: 'reports', sub: 'gstr1', label: 'GSTR-1', heading: 'GST' }, { key: 'reports', sub: 'gstr3b', label: 'GSTR-3B' },
    { key: 'reports', sub: 'tds', label: 'TDS deducted', heading: 'TDS', divider: true },
    { key: 'tasks', label: 'Tasks and deadlines', divider: true }] },
  { group: 'Contacts', items: [{ key: 'contacts', label: 'All contacts' }, { key: 'customers', label: 'Customers' }, { key: 'suppliers', label: 'Suppliers' }] },
  { group: 'Projects', items: [{ key: 'projects', label: 'Projects' }] },
];

const PLURAL: Record<string, string> = { asset: 'Assets', liability: 'Liabilities', equity: 'Equity', income: 'Income', expense: 'Expenses' };

export function OrgPage({ org, role, page, sub, go, onOrgChanged, lastLogin }: { org: Org; role: string; page: PageKey; sub?: string; go: (p: string) => void; onOrgChanged: () => void; lastLogin?: string | null }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const reloadAccounts = () => api<Account[]>(`/orgs/${org.id}/accounts`).then(setAccounts);
  useEffect(() => { reloadAccounts(); }, [org.id]);
  const canPost = role !== 'client';
  const canManage = role === 'owner' || role === 'accountant';
  const isNew = sub === 'new';
  // Sales people and employees get a few pages each; everything else is closed to them.
  const narrow = role === 'sales' || role === 'employee';
  const mayOpen = role === 'sales' ? ['invoices', 'quotes', 'customers', 'items'] : ['expenses'];
  if (narrow && !mayOpen.includes(page)) return <LimitedHome role={role} go={go} />;
  switch (page) {
    case 'dashboard': return <Dashboard org={org} go={go} lastLogin={lastLogin} />;
    case 'sales-overview': return <Overview org={org} side="sales" go={go} />;
    case 'purchases-overview': return <Overview org={org} side="purchases" go={go} />;
    case 'invoices': return <Documents org={org} kind="sales" canPost={canPost} accounts={accounts} startNew={isNew} restricted={narrow} />;
    case 'quotes': return <PreDocs org={org} kind="quote" canPost={canPost} accounts={accounts} startNew={isNew} />;
    case 'recurring': return <Recurring org={org} canPost={canPost} accounts={accounts} />;
    case 'customers': return <Contacts org={org} canPost={canPost} canManage={canManage} accounts={accounts} only="customer" startNew={isNew} restricted={narrow} />;
    case 'contacts': return <Contacts org={org} canPost={canPost} canManage={canManage} accounts={accounts} startNew={isNew} />;
    case 'bills': return <Documents org={org} kind="purchases" canPost={canPost} accounts={accounts} startNew={isNew} />;
    case 'purchase-orders': return <PreDocs org={org} kind="purchase_order" canPost={canPost} accounts={accounts} startNew={isNew} />;
    case 'suppliers': return <Contacts org={org} canPost={canPost} canManage={canManage} accounts={accounts} only="supplier" startNew={isNew} />;
    case 'bank': return <Bank org={org} canPost={canPost} canManage={canManage} accounts={accounts} section="reconcile" />;
    case 'bank-rules': return <Bank org={org} canPost={canPost} canManage={canManage} accounts={accounts} section="rules" />;
    case 'money': return <Money org={org} canPost={canPost} accounts={accounts} tab={sub === 'receive' || sub === 'transfer' ? sub : 'spend'} go={go} />;
    case 'journal': return <><PageHeader title="Manual journals" subtitle="Double-entry adjustments. Posted entries are never edited; reverse them instead." /><Journal org={org} accounts={accounts} canPost={canPost} /></>;
    case 'coa': return <><PageHeader title="Chart of accounts" subtitle="Every account that transactions can post to." /><Chart org={org} accounts={accounts} canManage={canManage} reload={reloadAccounts} /></>;
    case 'assets': return <FixedAssets org={org} canManage={canManage} accounts={accounts} />;
    case 'items': return <Items org={org} canPost={canPost && !narrow} accounts={accounts} />;
    case 'reports': return <><PageHeader title="Reports" subtitle="Financial statements, analytics, ageing, GST and TDS. Star a report to add it to the Reporting menu." /><Reports org={org} accounts={accounts} initial={sub} /></>;
    case 'tasks': return <><PageHeader title="Tasks and deadlines" subtitle="Filing due dates and anything else the team needs to do for this client." /><Tasks org={org} canPost={canPost} /></>;
    case 'files': return <><PageHeader title="Documents" subtitle="Files shared between the firm and the client." /><Files org={org} canManage={canManage} /></>;
    case 'import': return canManage ? <><PageHeader title="Import data" subtitle="Bring in contacts, accounts and opening balances from other software." /><Import org={org} /></> : null;
    case 'schedules': return canManage ? <><PageHeader title="Scheduled emails" subtitle="Reports sent to you or your client automatically." /><Schedules org={org} /></> : null;
    case 'settings': return <OrgSettings org={org} canManage={canManage} onSaved={onOrgChanged} />;
    case 'sales-settings': return <DocDefaults org={org} side="sales" canManage={canManage} />;
    case 'purchases-settings': return <DocDefaults org={org} side="purchases" canManage={canManage} />;
    case 'approvals': return <Approvals org={org} canManage={canManage} />;
    case 'expenses': return <ExpenseClaims org={org} canPost={canPost} canManage={canManage} accounts={accounts} />;
    case 'inventory': return <Inventory org={org} canManage={canManage} />;
    case 'budgets': return <Budgets org={org} canManage={canManage} accounts={accounts} />;
    case 'year-end': return <YearEnd org={org} canManage={canManage} />;
    case 'tracking': return <Tracking org={org} canManage={canManage} />;
    case 'export-templates': return <ExportTemplates org={org} role={role} />;
    case 'projects': return <Projects org={org} canPost={canPost} accounts={accounts} />;
  }
}

/** What a sales person or employee sees on opening a client: what they can do, and a way in. */
function LimitedHome({ role, go }: { role: string; go: (p: string) => void }) {
  const sales = role === 'sales';
  return (
    <>
      <PageHeader title={sales ? 'Sales' : 'Expense claims'} subtitle={sales ? 'You can raise invoices and quotes and add customers for this client.' : 'Claim back money you spent for the business.'} />
      <Card title={sales ? 'What would you like to do?' : 'Start here'}>
        <div className="flex flex-wrap gap-3">
          {sales ? <><Button onClick={() => go('invoices/new')}>New invoice</Button><Button variant="ghost" onClick={() => go('quotes/new')}>New quote</Button><Button variant="ghost" onClick={() => go('customers')}>Customers</Button><Button variant="ghost" onClick={() => go('invoices')}>Invoices</Button></>
            : <Button onClick={() => go('expenses')}>Open my expense claims</Button>}
        </div>
        <p className="mt-4 text-sm text-slate-500">{sales ? 'Payments, bills, reports and the rest of the books are handled by the accounting team.' : 'You see only your own claims. The accounting team approves them and pays you back.'}</p>
      </Card>
    </>
  );
}

function TrialBalance({ org }: { org: Org }) {
  const [tb, setTb] = useState<TB | null>(null);
  useEffect(() => { api(`/orgs/${org.id}/trial-balance`).then(setTb); }, [org.id]);
  if (!tb) return <p>Loading…</p>;
  return (
    <Card title="Trial balance">
      <table className="w-full text-sm">
        <thead><tr className="text-left text-slate-500"><th>Code</th><th>Account</th><th className="text-right">Debit (₹)</th><th className="text-right">Credit (₹)</th></tr></thead>
        <tbody>{tb.accounts.map((a) => <tr key={a.code} className="border-t border-slate-100"><td>{a.code}</td><td>{a.name}</td><td className="text-right">{a.debit ? fmt(a.debit) : ''}</td><td className="text-right">{a.credit ? fmt(a.credit) : ''}</td></tr>)}</tbody>
        <tfoot><tr className="border-t-2 border-slate-300 font-semibold"><td colSpan={2}>Total {tb.balanced ? '✓' : '✗ OUT OF BALANCE'}</td><td className="text-right" data-testid="tb-debit">{fmt(tb.totalDebit)}</td><td className="text-right" data-testid="tb-credit">{fmt(tb.totalCredit)}</td></tr></tfoot>
      </table>
    </Card>
  );
}

export function Chart({ org, accounts, canManage, reload }: { org: Org; accounts: Account[]; canManage: boolean; reload: () => void }) {
  const [f, setF] = useState({ code: '', name: '', type: 'expense', group: '' });
  const { error, busy, run } = useAction();
  const groups = accounts.reduce<Record<string, Account[]>>((m, a) => ((m[a.type] ??= []).push(a), m), {});
  return (
    <>
      {canManage && (
        <Card title="Add account">
          <div className="grid gap-3 md:grid-cols-4">
            <Field label="Code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />
            <Field label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            <label className="block text-sm"><span className="mb-1 block font-medium text-slate-600">Type</span>
              <select className="w-full rounded-md border border-slate-300 bg-white px-3 py-2" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
                {['asset', 'liability', 'equity', 'income', 'expense'].map((t) => <option key={t}>{t}</option>)}</select></label>
            <Field label="Group" value={f.group} onChange={(e) => setF({ ...f, group: e.target.value })} />
          </div>
          <div className="mt-3 space-y-2"><ErrorMsg msg={error} /><Button disabled={busy} onClick={() => run(async () => { await api(`/orgs/${org.id}/accounts`, { body: f }); setF({ ...f, code: '', name: '' }); reload(); })}>Add</Button></div>
        </Card>
      )}
      {['asset', 'liability', 'equity', 'income', 'expense'].map((t) => (
        <Card key={t} title={PLURAL[t]}>
          <ul className="grid gap-x-8 text-sm md:grid-cols-2">{(groups[t] ?? []).map((a) => <li key={a.id} className="flex justify-between border-b border-slate-100 py-1"><span>{a.code} · {a.name}</span><span className="text-slate-400">{a.group}</span></li>)}</ul>
        </Card>
      ))}
    </>
  );
}
