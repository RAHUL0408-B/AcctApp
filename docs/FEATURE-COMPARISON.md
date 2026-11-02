# Feature comparison with Xero-style accounting software

This compares what accountants and small businesses expect from a product like Xero with what AcctApp has today.
AcctApp is an original product. The comparison is about capabilities, not copying anyone's design or text.

Legend: **Done** = built and tested. **Partial** = works with limits. **Not built** = a known gap.

## Dashboard and navigation
| Capability | Status | Notes |
|---|---|---|
| Home dashboard with cash, receivables, payables, profit | Done | Stat cards, two 6-month charts, last login, "Edit homepage" to hide cards |
| Setup guide for new organisations | Done | Six first steps, ticked off automatically from the data |
| Bank balances and "to reconcile" counts | Done | |
| Top bar with dropdown menus (Home, Sales, Purchases, Reporting, Accounting, Tax, Contacts, Projects) | Done | Section headings and settings entries inside menus; role-aware |
| Organisation menu (settings, billing, switch organisation, add organisation) | Done | |
| "+" create menu with Alt keyboard shortcuts | Done | Invoice, bill, contact, quote, purchase order, document upload, manual journal, spend / receive / transfer money |
| Global search | Done | Contacts, invoices and bills, quotes and orders, items, projects, journals |
| Notifications | Done | Overdue invoices and bills, bills due this week, approvals, expense claims, unreconciled lines, deadlines, expiring quotes |
| Multi-client switcher for accountants | Done | Firm sees all clients; clients see only their own |
| URLs, refresh and back button | Done | Hash routes such as `#/o/12/invoices` |

## Sales
| Capability | Status | Notes |
|---|---|---|
| Invoices with GST (CGST+SGST / IGST), HSN/SAC | Done | PDF output, emailing, payments, voiding |
| Credit notes | Done | Against an invoice, capped at what is outstanding |
| Quotes, convert to invoice | Done | A quote never touches the ledger until converted |
| Repeating invoices | Done | Weekly, monthly, quarterly, yearly. Month-end day is kept (31 Jan, 28 Feb, 31 Mar). Optional auto-email |
| Overdue reminders | Done | One click, once per week per invoice |
| Customer statements | Done | Running balance with opening balance |
| Sales overview | Done | Awaiting approval / payment, overdue, due this week, 6-month chart, top customers, oldest overdue |
| Sales settings | Done | Default payment terms and terms printed on invoices |
| Online payment links on invoices | Not built | Needs a payment gateway |
| Multi-currency | Done | Invoices and bills in any currency at a rate you enter; the ledger stays in rupees; exchange gains and losses are booked on payment. No automatic rate feed or period-end revaluation |

## Purchases
| Capability | Status | Notes |
|---|---|---|
| Bills with input GST | Done | |
| TDS deduction on bills | Done | Section rates and thresholds come from a table |
| Debit notes | Done | |
| Purchase orders, convert to bill | Done | |
| Purchases overview and purchases settings | Done | Default payment terms for bills |
| Expense claims | Done | Submit, approve (books the expense), reject, repay from the bank |
| Invoice and bill approval workflow | Done | Optional per organisation: staff submit, owners and accountants approve or reject |

## Accounting
| Capability | Status | Notes |
|---|---|---|
| Chart of accounts (Indian templates) | Done | Trading, services, manufacturing |
| Manual journals and reversals | Done | Posted entries are immutable |
| Bank statement import, matching, reconciliation | Done | CSV only |
| Bank rules | Done | Auto-suggest an account by narration and direction; accept in one click |
| Spend money, receive money, transfer money | Done | Direct bank transactions, later suggested as matches during reconciliation. No GST on these; use a bill or invoice for GST |
| Live bank feeds | Not built | Needs a bank-feed provider |
| Fixed assets and depreciation | Done | Straight line and written-down value, monthly postings. Not modelled: Income Tax Act block depreciation |
| Products and services catalogue | Done | Prefills lines on every document |
| Inventory stock tracking | Done | Weighted average cost, cost of goods sold on each sale, stock adjustments, movement history, check against the Inventory account. Single location; credit/debit notes do not move stock |
| Period locking | Done | Enforced in the database |
| Year-end closing entries | Done | Moves the year's profit to Reserves and Surplus and locks the year; that year's P&L is unchanged |
| Tracking categories / departments | Done | Tag invoice, bill and journal lines; P&L by category |
| Budgets | Done | Monthly amounts per account; budget vs actual report |

## Reporting
| Capability | Status | Notes |
|---|---|---|
| Trial balance, P&L, balance sheet, ledger | Done | PDF and Excel export |
| Cash flow (cash and bank movement by month) | Done | Opening, in, out, closing |
| Aged receivables and payables | Done | |
| GSTR-1 and GSTR-3B working papers | Done | Not filing-ready JSON; CA review needed |
| Scheduled report emails | Done | |
| P&L by month and by tracking category | Done | |
| Short-term cash flow | Done | Cash today plus invoices and bills by due date, week by week for 30/60/90 days |
| Business snapshot and health scorecard | Done | Margins, current ratio, debtor/creditor days, days to get paid, cash cover |
| Favourite reports | Done | Starred reports appear in the Reporting menu |
| Custom report builder | Not built | |

## Practice (firm) features
| Capability | Status | Notes |
|---|---|---|
| Multiple clients per firm with isolated data | Done | Database row-level security |
| Roles: owner, accountant, staff, client (view only) | Done | |
| Client portal: books, reports, upload documents | Done | |
| Tasks and GST/TDS due-date reminders | Done | Due dates come from a table |
| Document storage | Done | Local disk; use object storage in production |
| Import from other software (CSV) | Done | Contacts, accounts, vouchers and opening balances, with dry run |
| Practice-wide dashboard across all clients | Done | Cash, receivables, payables, overdue, unreconciled lines, tasks and approvals per client |
| Projects (time and costs, invoice unbilled work) | Done | Estimate vs actual, profit per project. No staff cost rates or task budgets |

## India-specific
| Capability | Status | Notes |
|---|---|---|
| GSTIN validation with check digit | Done | |
| Place of supply, state codes | Done | |
| TDS sections and the no-PAN higher rate | Done | |
| TDS deducted report | Done | By section and month, deposit-by dates, 26Q rows. Not a 26Q return file |
| e-Invoicing (IRN, QR code) and e-way bills | Not built | Needs GSTN/NIC integration |
| Reverse charge (RCM) on purchases | Done | Buyer self-assesses GST: input credit plus RCM payable; shown in GSTR-3B 3.1(d) |
| Composition scheme | Done | No GST on sales; GST on purchases becomes part of the cost |
| Exports and SEZ supplies | Done | Under LUT (zero-rated, no GST) or with IGST; GSTR-1 export section and GSTR-3B 3.1(b) |
| GST return filing from the app | Not built | Working papers only |
| Payroll, PF, ESI, professional tax | Not built | A large separate module |

## Platform
| Capability | Status | Notes |
|---|---|---|
| Two-factor login, lockout, rate limits | Done | |
| Audit log | Done | Append-only, with before/after values |
| Encrypted daily backups with restore test | Done | |
| DPDP consent, export and erasure | Done | Needs legal review |
| Subscription plans with GST invoices | Done | Test payment mode only |
| Mobile app | Not built | The web app is usable on a tablet; no native app |
| Public API and app marketplace | Not built | |
