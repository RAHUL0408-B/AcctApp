# Feature comparison with Xero-style accounting software

This compares what accountants and small businesses expect from a product like Xero with what AcctApp has today.
AcctApp is an original product. The comparison is about capabilities, not copying anyone's design or text.

Legend: **Done** = built and tested. **Partial** = works with limits. **Not built** = a known gap.

## Beyond Xero: problems Indian CAs have that it does not solve
Xero is built for other countries. These checks take hours of spreadsheet work every month or at year-end, and AcctApp does them from the books.

| Capability | Status | Notes |
|---|---|---|
| GSTR-2B matching against purchase bills | Done | Upload the portal JSON or a CSV. Matching uses the supplier GSTIN and the supplier bill number however it is written (INV/0042 = inv-42). Shows matched, tax differs, portal-only, books-only, credit at risk, and suppliers to chase with a reminder to send. Amended invoices (B2BA) and credit notes in GSTR-2B are not matched yet |
| MSME payments under section 43B(h) | Done | MSME type, Udyam number and agreed days on suppliers; per bill the pay-by date (15 days, or agreed up to 45), paid on time, paid late, unpaid, and the expense not allowed for the year, including bills near 31 March. The bill date stands in for the date of acceptance |
| Input tax credit 180-day rule (Rule 37) | Done | Credit to reverse on the unpaid part of bills older than 180 days, and bills reaching 180 days within 30 days. Interest under section 50 is not calculated |
| Duplicate supplier bill guard | Done | The same supplier bill number from the same supplier, or from another contact with the same GSTIN, is stopped as a likely double GST credit unless confirmed |
| Alerts for the above | Done | Notifications for MSME bills past or near their limit and for credit to reverse |

## What is still missing, in the order most people ask for it
Everything in the tables below that is marked **Not built** or **Partial**, grouped by why it is not built yet.

| Needs an outside account or provider | Needs a large module | Needs legal or tax sign-off |
|---|---|---|
| Live bank feeds (a bank-feed provider) | Payroll, PF, ESI, professional tax | GST return filing from the app and filing-ready JSON |
| Online payment links on invoices and a real subscription gateway (for example Razorpay) | Repeating bills and batch payments | e-Invoicing (IRN, QR) and e-way bills (GSTN and NIC access) |
| Automatic exchange-rate feed and period-end revaluation | Native mobile app and offline mode | Cess, blocked credits (17(5)) and ITC reversals |
| Encrypted object storage and virus scanning for uploads | Public API, API keys and an app marketplace | Terms, Privacy Policy and DPDP review |
| An email provider for reliable delivery (SPF, DKIM) | Ad-hoc custom report builder | Pooled block depreciation under the Income Tax Act |

The security and launch items are in [LAUNCH-CHECKLIST.md](LAUNCH-CHECKLIST.md).

## Dashboard and navigation
| Capability | Status | Notes |
|---|---|---|
| Home dashboard with cash, receivables, payables, profit | Done | Stat cards, two 6-month charts, last login, "Edit homepage" to hide cards |
| Setup guide for new organisations | Done | Six first steps, ticked off automatically from the data |
| Bank balances and "to reconcile" counts | Done | |
| Top bar with dropdown menus (Home, Sales, Purchases, Reporting, Accounting, Tax, Contacts, Projects) | Done | Accounting in three columns, hover to switch menus, arrow keys, breadcrumb, small-screen menu; role-aware (Sales and Employee see only their own pages) |
| Organisation menu (settings, billing, switch organisation, add organisation) | Done | |
| "+" create menu with Alt keyboard shortcuts | Done | Invoice, bill, contact, quote, purchase order, document upload, manual journal, spend / receive / transfer money |
| Global search | Done | Contacts, invoices and bills, quotes and orders, items, projects, journals |
| Notifications | Done | Overdue invoices and bills, bills due this week, approvals, expense claims, unreconciled lines, deadlines, expiring quotes |
| Multi-client switcher for accountants | Done | Firm sees all clients; clients see only their own |
| Landing page | Done | Headline, dashboard illustration, features, audiences, access levels, how to start |
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
| Bank statement import, matching, reconciliation | Done | CSV only. A line can be matched to an invoice or bill by amount (or searched for), exact single matches can be matched in one click, and a wrong match can be unlinked |
| Bank rules | Done | Auto-suggest an account by narration and direction; accept in one click |
| Spend money, receive money, transfer money | Done | Direct bank transactions, later suggested as matches during reconciliation. No GST on these; use a bill or invoice for GST |
| Live bank feeds | Not built | Needs a bank-feed provider |
| Fixed assets and depreciation | Done | Asset groups with Income Tax Act rates and Companies Act lives, straight line, written down value or useful life, whole months or actual days, editable asset codes, attachments, disposal with gain or loss. Not modelled: pooled blocks of assets and the 180-day half rate |
| Products and services catalogue | Done | Prefills lines on every document |
| Inventory stock tracking | Done | Weighted average cost, cost of goods sold on each sale, stock adjustments, movement history, check against the Inventory account. Single location; credit/debit notes do not move stock |
| Period locking | Done | Enforced in the database |
| Year-end closing entries | Done | Moves the year's profit to Reserves and Surplus and locks the year; that year's P&L is unchanged |
| Cost centres (Xero's tracking categories) | Done | Pick one for a whole invoice, bill or journal or per line; repeating journals keep it; P&L by cost centre |
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
| Custom report builder | Partial | Choose which reports go into one PDF or workbook, which columns to include, and how the files look (export templates). There is no ad-hoc builder that lets you pick any field or write a formula |
| Export templates for every PDF and Excel file | Done | Five ready-made templates plus up to 20 of the owner's own designs; one for reports and one for invoices and bills |
| All ledgers, invoice-wise, bill-wise, purchase register, fixed asset register | Done | With archive and delete from the report where it applies |

## Practice (firm) features
| Capability | Status | Notes |
|---|---|---|
| Multiple clients per firm with isolated data | Done | Database row-level security |
| Roles: owner, accountant, staff, client (view only) | Done | |
| Invoice-only role (Sales) | Done | Raises invoices and quotes and adds customers for one client; sees customers only and no buying prices; cannot take payments, cancel, or see reports |
| Expenses-only role (Employee) | Done | Submits and follows their own expense claims for one client and sees nothing else |
| Email invitations and a People page | Done | The owner invites by email, resends, cancels, changes roles and removes access; the last owner cannot be removed |
| Custom permissions per person, bank-only and payroll-admin roles | Not built | Access comes from the six fixed levels |
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
| TDS sections and the no-PAN higher rate | Done | 194J is split into 194J (10%, professional fees) and 194J(a) (2%, technical services); a CA should confirm the rates |
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
| Forgot password, change password, email confirmation | Done | Links are emailed (set `SMTP_URL` and `APP_URL`); a password change or reset signs out every other device |
| Audit log | Done | Append-only, with before/after values |
| Encrypted daily backups with restore test | Done | |
| DPDP consent, export and erasure | Done | Needs legal review |
| Subscription plans with GST invoices | Done | Test payment mode only |
| Mobile app | Partial | The web app works on a phone or tablet and can be added to the home screen with its own icon. No offline mode and no native app |
| Public API and app marketplace | Not built | |
