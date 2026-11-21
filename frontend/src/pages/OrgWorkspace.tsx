import { useCallback, useEffect, useState } from 'react';
import { api, fmt, toPaise } from '../api';
import type { Org } from '../App';
import { Button, Card, ErrorMsg, Field, Ok, useAction } from '../ui';
import { Documents } from './Documents';
import { Contacts } from './Contacts';
import { ChartOfAccounts } from './ChartOfAccounts';
import { EditMode } from '../editmode';
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
import { Compliance } from './Compliance';
import { Overview } from './Overview';
import { Journal } from './Journal';
import { Money } from './Money';
import { Projects } from './Projects';
import { SettingsHub, SettingsSection } from './Settings';
import { BatchPayments } from './Batches';

interface Account { id: number; code: string; name: string; type: string; group: string; itcBlocked?: boolean }
interface Entry { id: number; date: string; narration: string; reversesId: number | null; lines: { accountId: number; debit: number; credit: number }[] }
interface TB { accounts: { code: string; name: string; debit: number; credit: number }[]; totalDebit: number; totalCredit: number; balanced: boolean }

export type PageKey = 'dashboard' | 'invoices' | 'quotes' | 'recurring' | 'customers' | 'bills' | 'purchase-orders' | 'suppliers' | 'bank' | 'journal' | 'coa' | 'assets' | 'items' | 'reports' | 'tasks' | 'files' | 'import' | 'schedules' | 'settings'
  | 'approvals' | 'expenses' | 'inventory' | 'budgets' | 'year-end' | 'tracking' | 'export-templates' | 'compliance'
  | 'sales-overview' | 'purchases-overview' | 'contacts' | 'bank-rules' | 'money' | 'projects' | 'sales-settings' | 'purchases-settings' | 'settings-hub' | 'setup' | 'recurring-bills' | 'batch-payments';

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
    { key: 'purchases-overview', label: 'Purchases overview' }, { key: 'bills', label: 'Bills' }, { key: 'recurring-bills', label: 'Repeating bills' }, { key: 'batch-payments', label: 'Batch payments' }, { key: 'purchase-orders', label: 'Purchase orders' },
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
    { key: 'compliance', sub: '2b', label: 'GSTR-2B match', heading: 'Checks', divider: true }, { key: 'compliance', sub: 'msme', label: 'MSME payments (43B(h))' },
    { key: 'compliance', sub: 'itc180', label: 'ITC 180-day rule' },
    { key: 'tasks', label: 'Tasks and deadlines', divider: true }] },
  { group: 'Contacts', items: [{ key: 'contacts', label: 'All contacts' }, { key: 'customers', label: 'Customers' }, { key: 'suppliers', label: 'Suppliers' }] },
  { group: 'Projects', items: [{ key: 'projects', label: 'Projects' }] },
  { group: 'Settings', items: [{ key: 'settings-hub', label: 'Settings' }] },
];

/** Which access area (see People and access) a menu entry belongs to; null = always shown. */
export function areaOfPage(i: { key: PageKey; sub?: string }): string | null {
  if (i.key === 'reports' && ['gstr1', 'gstr3b', 'tds'].includes(i.sub ?? '')) return 'tax';
  const map: Partial<Record<PageKey, string>> = {
    'sales-overview': 'sales', invoices: 'sales', quotes: 'sales', recurring: 'sales', items: 'sales',
    'purchases-overview': 'purchases', bills: 'purchases', 'recurring-bills': 'purchases', 'batch-payments': 'purchases', 'purchase-orders': 'purchases', expenses: 'purchases', approvals: 'purchases',
    reports: 'reports', compliance: 'tax', bank: 'bank', 'bank-rules': 'bank', money: 'bank',
    coa: 'accounting', journal: 'accounting', assets: 'accounting', inventory: 'accounting', budgets: 'accounting', tracking: 'accounting', 'year-end': 'accounting',
    contacts: 'contacts', customers: 'contacts', suppliers: 'contacts', projects: 'projects',
    import: 'settings', schedules: 'settings', 'export-templates': 'settings', settings: 'settings', 'sales-settings': 'settings', 'purchases-settings': 'settings',
  };
  return map[i.key] ?? null;
}


export function OrgPage({ org, role, page, sub, go, onOrgChanged, lastLogin, canTeam = false }: { org: Org; role: string; page: PageKey; sub?: string; go: (p: string) => void; onOrgChanged: () => void; lastLogin?: string | null; canTeam?: boolean }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  // Archived ledgers are kept out of the pickers on new entries.
  const reloadAccounts = () => api<(Account & { isActive?: boolean })[]>(`/orgs/${org.id}/accounts`).then((l) => setAccounts(l.filter((a) => a.isActive !== false)));
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
    case 'invoices': return <Documents org={org} kind="sales" canPost={canPost} accounts={accounts} startNew={isNew || !!sub?.startsWith('new-')} startType={sub?.startsWith('new-') ? sub.slice(4) : undefined} openId={sub?.startsWith('open-') ? Number(sub.slice(5)) : undefined} fromDueId={sub?.startsWith('new-from-due-') ? Number(sub.slice(13)) : undefined} restricted={narrow} role={role} go={go} />;
    case 'quotes': return <PreDocs org={org} kind="quote" canPost={canPost} accounts={accounts} startNew={isNew} />;
    case 'recurring': return <Recurring org={org} canPost={canPost} accounts={accounts} go={go} />;
    case 'recurring-bills': return <Recurring key="bill" org={org} canPost={canPost} accounts={accounts} kind="bill" go={go} />;
    case 'batch-payments': return <BatchPayments org={org} canPost={canPost} go={go} focusId={sub && /^\d+$/.test(sub) ? Number(sub) : undefined} />;
    case 'customers': return <Contacts org={org} canPost={canPost} canManage={canManage} accounts={accounts} only="customer" sub={sub} go={go} page="customers" restricted={narrow} />;
    case 'contacts': return <Contacts org={org} canPost={canPost} canManage={canManage} accounts={accounts} sub={sub} go={go} page="contacts" />;
    case 'bills': return <Documents org={org} kind="purchases" canPost={canPost} accounts={accounts} startNew={isNew || !!sub?.startsWith('new-')} startType={sub?.startsWith('new-') ? sub.slice(4) : undefined} openId={sub?.startsWith('open-') ? Number(sub.slice(5)) : undefined} fromDueId={sub?.startsWith('new-from-due-') ? Number(sub.slice(13)) : undefined} role={role} go={go} />;
    case 'purchase-orders': return <PreDocs org={org} kind="purchase_order" canPost={canPost} accounts={accounts} startNew={isNew} />;
    case 'suppliers': return <Contacts org={org} canPost={canPost} canManage={canManage} accounts={accounts} only="supplier" sub={sub} go={go} page="suppliers" />;
    case 'bank': return <Bank org={org} canPost={canPost} canManage={canManage} accounts={accounts} section="reconcile" />;
    case 'bank-rules': return <Bank org={org} canPost={canPost} canManage={canManage} accounts={accounts} section="rules" />;
    case 'money': return <Money org={org} canPost={canPost} accounts={accounts} tab={sub === 'receive' || sub === 'transfer' ? sub : 'spend'} go={go} />;
    case 'journal': return <><PageHeader title="Manual journals" subtitle="Double-entry adjustments. Posted entries are never edited; reverse them instead." /><Journal org={org} accounts={accounts} canPost={canPost} role={role} go={go} focusId={sub?.startsWith('open-') ? Number(sub.slice(5)) : undefined} /></>;
    case 'coa': return <><PageHeader title="Chart of accounts" subtitle="Financial statement line item › group › sub-group › ledger. Every account that transactions can post to." /><ChartOfAccounts org={org} canManage={canManage} reload={reloadAccounts} /></>;
    case 'assets': return <FixedAssets org={org} canManage={canManage} accounts={accounts} />;
    case 'items': return <Items org={org} canPost={canPost && !narrow} accounts={accounts} />;
    case 'reports': return <><PageHeader title="Reports" subtitle="Financial statements, analytics, ageing, GST and TDS. Star a report to add it to the Reporting menu." /><Reports org={org} accounts={accounts} initial={sub} go={go} /></>;
    case 'tasks': return <><PageHeader title="Tasks and deadlines" subtitle="Filing due dates and anything else the team needs to do for this client." /><Tasks org={org} canPost={canPost} /></>;
    case 'files': return <><PageHeader title="Documents" subtitle="Files shared between the firm and the client." /><Files org={org} canManage={canManage} /></>;
    case 'import': return canManage ? <><PageHeader title="Import data" subtitle="Bring in contacts, accounts and opening balances from other software." /><Import org={org} /></> : null;
    case 'schedules': return canManage ? <><PageHeader title="Scheduled emails" subtitle="Reports sent to you or your client automatically." /><Schedules org={org} /></> : null;
    case 'settings': return <EditMode canManage={canManage} what="organisation details"><OrgSettings org={org} canManage={canManage} onSaved={onOrgChanged} /></EditMode>;
    case 'sales-settings': return <EditMode canManage={canManage}><DocDefaults org={org} side="sales" canManage={canManage} /></EditMode>;
    case 'purchases-settings': return <EditMode canManage={canManage}><DocDefaults org={org} side="purchases" canManage={canManage} /></EditMode>;
    case 'approvals': return <Approvals org={org} canManage={canManage} />;
    case 'expenses': return <ExpenseClaims org={org} canPost={canPost} canManage={canManage} accounts={accounts} />;
    case 'inventory': return <Inventory org={org} canManage={canManage} />;
    case 'budgets': return <Budgets org={org} canManage={canManage} accounts={accounts} />;
    case 'year-end': return <YearEnd org={org} canManage={canManage} />;
    case 'tracking': return <Tracking org={org} canManage={canManage} />;
    case 'export-templates': return <ExportTemplates org={org} role={role} />;
    case 'compliance': return <Compliance org={org} canPost={canPost} sub={sub} go={go} />;
    case 'projects': return <Projects org={org} canPost={canPost} accounts={accounts} />;
    case 'settings-hub': return <SettingsHub org={org} role={role} canTeam={canTeam} go={go} />;
    case 'setup': return <SettingsSection org={org} role={role} sub={sub} go={go} />;
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

