# AcctApp (placeholder name)

Cloud accounting for Indian CA firms and their small-business clients. One firm manages many separate client books, with GST, TDS, bank reconciliation, reports, a client portal and scheduled reports.

To rename the product, change `APP_NAME` (API environment variable) and `APP_NAME` in `apps/web/src/ui.tsx`.

**Status:** Phases 1-4 are built and tested. Before going live, read [docs/LAUNCH-CHECKLIST.md](docs/LAUNCH-CHECKLIST.md). Several items need a CA, a lawyer or a security auditor.

## Features
| Area | What it does |
|---|---|
| Firms and clients | One firm, many client organizations. Each client's data is isolated by Postgres row-level security. |
| Users | Owner, Accountant, Staff and Client (view-only) roles. Login with optional TOTP 2FA and recovery codes, lockout after 5 failed logins, rate limiting, password strength rules. |
| Ledger | Double entry in integer paise. Unbalanced entries are rejected by the API and by the database. Posted entries cannot be edited or deleted; mistakes are fixed by reversal. Periods can be locked. |
| Chart of accounts | Indian templates for trading, services and manufacturing, including GST and TDS accounts. |
| Contacts | Customers and suppliers with statements. GSTIN is validated (format and check digit) and sets the state. |
| Sales and purchases | Invoices, bills, credit notes and debit notes with automatic numbering per financial year (e.g. INV/25-26/0001). Each document posts its own journal entry. Includes payments, voiding, PDF output, emailing invoices and overdue reminders. Quotes and purchase orders convert into invoices and bills. Repeating invoices run on a schedule. |
| GST | CGST+SGST within a state, IGST between states, by place of supply. HSN/SAC codes. Rates live in the `gst_rates` table. |
| TDS | Sections, rates and single/annual thresholds live in the `tds_sections` table. Higher rate when PAN is missing (206AA). TDS is deducted on bills and posted to TDS Payable. |
| Bank | Bank accounts, CSV statement import with duplicate detection, suggested matches, bank rules that classify routine lines, categorising unmatched lines, un-reconcile. |
| Accounting extras | Products and services catalogue, fixed assets with monthly depreciation, editable organisation settings, cash flow report, a dashboard with charts. |
| Reports | Trial balance, P&L, balance sheet, account ledger, aged receivables and payables, GSTR-1 (B2B/B2CL/B2CS/CDNR/HSN) and GSTR-3B summaries. Export to PDF or Excel. |
| Firm tools | Client dashboard and portal, document upload per client, tasks, GST/TDS due dates from the `compliance_rules` table, email reminders, CSV import from other software (contacts, chart of accounts, vouchers and opening balances), scheduled email reports. |
| Launch | Daily encrypted backups with an automatic restore test. DPDP features: consent records, data export, account erasure. Subscription plans with GST invoices and plan limits. Onboarding, help page, health and metrics endpoints, JSON logs, error alert webhook. |

## Setup (development, no Docker needed)
Requires Node 20+ and Google Chrome (for the browser tests).
```bash
npm install
npm run devdb -w apps/api          # terminal 1: local PostgreSQL on :5432 (data in apps/api/.pgdata)
npm run migrate -w apps/api        # create/upgrade tables
npm run dev:api                    # API on http://localhost:3000/api (also runs the background worker)
npm run dev:web                    # web app on http://localhost:5173
```
With Docker: `docker compose -f docker/docker-compose.yml up -d --build`, then open **http://localhost:8080**. Replace every "change-me" secret in that file before using it for real. Deploying to Render: see [docs/DEPLOY.md](docs/DEPLOY.md).

### Environment variables
| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection (required in production) |
| `JWT_SECRET` | 32+ random characters (required in production) |
| `BACKUP_KEY` | Passphrase for backup encryption. Keep a copy off the server (required in production) |
| `WEB_ORIGIN` | Allowed browser origin for CORS (required in production) |
| `BACKUP_DIR`, `BACKUP_KEEP_DAYS` | Where backups go (default `./backups`) and how long to keep them (default 30) |
| `DATA_DIR` | Where uploaded documents are stored (default `./data`) |
| `SMTP_URL`, `MAIL_FROM` | Outgoing email. Without `SMTP_URL`, mail is only logged |
| `PAYMENT_PROVIDER` | `test` in development. Production needs a real gateway (see `apps/api/src/ops/billing.ts`) |
| `METRICS_TOKEN`, `ALERT_WEBHOOK_URL` | Protects `/api/metrics`. The webhook receives an alert after 5+ server errors in a minute |
| `RATE_LIMIT_PER_MIN`, `TRUST_PROXY`, `WORKER`, `LOG_REQUESTS` | Tuning switches |

## Testing
```bash
npm test                           # 140 API tests: unit tests with worked examples + end-to-end against real PostgreSQL
node apps/web/e2e/smoke.mjs        # browser: register, journal, reversal, trial balance, 2FA
node apps/web/e2e/full.mjs         # browser: quote to invoice, GST invoice, TDS bill, bank rules and reconciliation, fixed assets, dashboard, reports/exports, tasks, uploads, import, settings, routing, billing, privacy
```
The browser tests need the API and web app running. Worked examples include:
- Rs 1,000 at 18% within a state = CGST 90 + SGST 90
- 194J TDS crossing the Rs 50,000 annual limit is charged on the full year-to-date amount
- Rs 100 split three ways = 33.34 + 33.33 + 33.33

## Operations
- What is and is not built compared with Xero-style software: [docs/FEATURE-COMPARISON.md](docs/FEATURE-COMPARISON.md)
- Backups, restore and monitoring: [docs/OPERATIONS.md](docs/OPERATIONS.md)
- Security checklist (OWASP): [docs/SECURITY.md](docs/SECURITY.md)
- Database design: [docs/ER-DIAGRAM.md](docs/ER-DIAGRAM.md)

## Layout
```
apps/api/src
  auth/ tenancy/ ledger/ audit/      Phase 1: login/2FA, firms/clients/roles, double entry, audit log
  accounting/ tax/                   Phase 2: contacts, documents, payments, bank, reports, GST, TDS
  xero/                              Quotes, POs, repeating invoices, items, bank rules, fixed assets, dashboard, statements
  firm/                              Phase 3: tasks/deadlines, files, import, exports, mail, scheduler
  ops/                               Phase 4: backups, billing, privacy, health/metrics
apps/web/src                         React + Tailwind app (pages/ per area)
db/migrations                        SQL schema 001-005 (tax rates and rules are seeded here as data)
```

## Rules followed
- Money is integer paise everywhere.
- Posted entries are never edited or deleted.
- Tax rates, TDS sections, compliance due dates and plan prices are rows in tables, not code.
- No third-party branding or assets.
