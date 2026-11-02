# AcctApp

Cloud accounting for Indian CA firms and their small-business clients. One firm keeps the books of many clients, each fully separated, with GST, TDS, bank reconciliation, reports, a client portal and scheduled reports.

> **AcctApp** is a placeholder name. To rename the product, change `APP_NAME` in `frontend/src/ui.tsx` and the `APP_NAME` environment variable on the API.

| | |
|---|---|
| **Live demo** | https://acct-app-psi.vercel.app (free hosting: the first request after a quiet spell takes about 50 seconds) |
| **API health** | https://acctapp-api.onrender.com/api/health |
| **Status** | All features below are built and tested. Read [docs/LAUNCH-CHECKLIST.md](docs/LAUNCH-CHECKLIST.md) before real client data goes in. |

---

## Contents
- [Features](#features)
- [How it fits together](#how-it-fits-together)
- [Project structure](#project-structure)
- [Run it locally](#run-it-locally)
- [Configuration](#configuration)
- [Tests](#tests)
- [Deploy](#deploy)
- [Design rules](#design-rules)
- [Further reading](#further-reading)

---

## Features

| Area | What it does |
|---|---|
| **Firms and clients** | One firm, many client organisations. Each client's data is isolated by PostgreSQL row-level security. |
| **Users and security** | Owner, Accountant, Staff and Client (view-only) roles. Optional authenticator-app 2FA with recovery codes, lockout after 5 failed logins, rate limits, password rules. |
| **Ledger** | Double entry in integer paise. Unbalanced entries are rejected by the API and by the database. Posted entries can never be edited or deleted, only reversed. Periods can be locked. |
| **Chart of accounts** | Indian templates for trading, services and manufacturing, including GST and TDS accounts. |
| **Contacts** | Customers and suppliers with statements. GSTIN is checked (format and check digit) and sets the state. |
| **Sales** | Quotes, invoices, credit notes, repeating invoices, payments, PDF invoices, email and overdue reminders. Numbering per financial year, e.g. `INV/25-26/0001`. |
| **Purchases** | Purchase orders, bills, debit notes, TDS deducted on bills. |
| **GST** | CGST + SGST within a state, IGST between states, by place of supply. HSN/SAC codes. Rates live in a table. |
| **TDS** | Sections, rates and single/annual thresholds live in a table. Higher rate when PAN is missing. |
| **Bank** | CSV statement import with duplicate detection, suggested matches, bank rules, reconciliation. |
| **Accounting extras** | Products and services, fixed assets with monthly depreciation, organisation settings. |
| **Reports** | Dashboard with charts, trial balance, P&L, balance sheet, ledger, cash flow, aged receivables and payables, GSTR-1 and GSTR-3B summaries. PDF and Excel export. |
| **Firm tools** | Tasks with GST/TDS due dates, document uploads, CSV import from other software, scheduled report emails. |
| **Platform** | Encrypted daily backups with an automatic restore test. DPDP consent, data export and erasure. Subscription plans with GST invoices. Health and metrics endpoints, JSON logs, error alerts. |

What is still missing compared with Xero-style software is listed in [docs/FEATURE-COMPARISON.md](docs/FEATURE-COMPARISON.md).

## How it fits together

```
 Browser
    │
    ▼
 frontend/  React + Tailwind (Vite)           Vercel, or nginx in Docker
    │  every /api/* request is forwarded
    ▼
 backend/   NestJS API + background worker    Render (Docker), or Docker locally
    │  reminders, repeating invoices, emails, backups
    ▼
 PostgreSQL  schema in db/migrations           Supabase, or Docker locally
```

The browser only ever talks to the frontend's address. The frontend host forwards `/api` to the backend, so no CORS setup is needed.

## Project structure

```
.
├── backend/                 NestJS API (TypeScript)        → see backend/README.md
│   ├── src/
│   │   ├── auth/            register, login, 2FA, recovery codes
│   │   ├── security/        password hashing, TOTP, tokens
│   │   ├── tenancy/         firms, clients, roles, access checks
│   │   ├── ledger/          journal entries, reversals, period locks
│   │   ├── audit/           append-only audit log
│   │   ├── coa/             chart of accounts templates
│   │   ├── accounting/      contacts, invoices and bills, payments, bank, reports
│   │   ├── tax/             GST and TDS calculations
│   │   ├── extras/          quotes, POs, repeating invoices, items, bank rules, fixed assets, dashboard
│   │   ├── firm/            tasks and deadlines, files, import, export, email, scheduler
│   │   ├── ops/             backups, billing, privacy, health and metrics, CLI
│   │   ├── common/          shared helpers (guards, CSV, rate limits)
│   │   ├── db/              connection pool and migration runner
│   │   └── main.ts          entry point
│   ├── test/                140 Jest tests (unit + end-to-end against real PostgreSQL)
│   └── scripts/devdb.mjs    starts a local PostgreSQL for development and tests
│
├── frontend/                React web app (Vite + Tailwind) → see frontend/README.md
│   ├── src/
│   │   ├── App.tsx          top bar, menus and routing
│   │   ├── pages/           one file per area (Sales, Bank, Reports, ...)
│   │   ├── ui.tsx, kit.tsx  shared components (buttons, cards, tables, charts)
│   │   ├── api.ts           fetch wrapper, money formatting
│   │   └── index.css        brand colours and base styles
│   ├── e2e/                 browser tests (Playwright driving Chrome)
│   └── vercel.json          forwards /api to the backend on Render
│
├── db/migrations/           SQL schema, 001 to 006 (tax rates and rules are seeded as data)
├── docker/                  Dockerfiles, nginx config, docker-compose.yml
├── docs/                    deploy, operations, security, ER diagram, feature comparison
└── render.yaml              Render blueprint for the backend
```

## Run it locally

Requires **Node 20+**. The browser tests also need **Google Chrome**.

### Option A: Docker (simplest)
```bash
docker compose -f docker/docker-compose.yml up -d --build
```
Open **http://localhost:8080**. Stop with `docker compose -f docker/docker-compose.yml down` (add `-v` to erase the data).

### Option B: development mode
```bash
npm install
npm run devdb -w backend      # terminal 1: local PostgreSQL on :5432
npm run migrate               # create or upgrade the tables
npm run dev:api               # terminal 2: API on http://localhost:3000/api
npm run dev:web               # terminal 3: web app on http://localhost:5173
```

## Configuration

The backend reads environment variables (there is no `.env` loader).

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string. **Required in production.** |
| `DATABASE_SSL` | `true` for hosted databases that need TLS, such as Supabase. |
| `JWT_SECRET` | 32+ random characters. **Required in production.** |
| `BACKUP_KEY` | Backup encryption passphrase. Keep a copy off the server. **Required in production.** |
| `WEB_ORIGIN` | The frontend's address, e.g. `https://acct-app-psi.vercel.app`. **Required in production.** |
| `DATA_DIR`, `BACKUP_DIR`, `BACKUP_KEEP_DAYS` | Where uploads and backups go, and how long backups are kept (default 30 days). |
| `SMTP_URL`, `MAIL_FROM` | Outgoing email. Without `SMTP_URL`, mail is only logged. |
| `PAYMENT_PROVIDER` | `test` until a real gateway is added (see `backend/src/ops/billing.ts`). |
| `METRICS_TOKEN`, `ALERT_WEBHOOK_URL` | Protects `/api/metrics`; the webhook receives an alert after 5+ server errors in a minute. |
| `RATE_LIMIT_PER_MIN`, `TRUST_PROXY`, `WORKER`, `LOG_REQUESTS`, `PORT` | Tuning switches. |

## Tests

```bash
npm test                         # 140 backend tests, with worked accounting examples
node frontend/e2e/smoke.mjs      # browser: register, journal, reversal, trial balance, 2FA
node frontend/e2e/full.mjs       # browser: quote to invoice, GST, TDS, bank rules, assets, reports, exports, billing, privacy
```
The browser tests need the app running. Point them at any address with `WEB_URL=https://...`; on slow hosts add `STEP_TIMEOUT=60000`.

Worked examples the tests check include:
- Rs 1,000 at 18% within a state = CGST 90 + SGST 90
- 194J TDS crossing the Rs 50,000 annual limit is charged on the full year-to-date amount
- Rs 100 split three ways = 33.34 + 33.33 + 33.33

## Deploy

Currently deployed as **frontend on Vercel**, **backend on Render** and **database on Supabase**, all on free plans. Step-by-step instructions, and what to change before real client data goes in, are in [docs/DEPLOY.md](docs/DEPLOY.md).

## Design rules
- Money is integer paise everywhere; no floating point.
- Posted entries are never edited or deleted; mistakes are reversed.
- Tax rates, TDS sections, compliance due dates and plan prices are rows in tables, not code.
- Every client's data is isolated in the database, not just in the application.
- No third-party branding or assets.

## Further reading
| Document | What it covers |
|---|---|
| [docs/DEPLOY.md](docs/DEPLOY.md) | Docker, Render, Vercel and Supabase setup |
| [docs/FEATURE-COMPARISON.md](docs/FEATURE-COMPARISON.md) | What is built and what is missing compared with Xero-style software |
| [docs/LAUNCH-CHECKLIST.md](docs/LAUNCH-CHECKLIST.md) | What a CA, a lawyer and a security auditor must review before launch |
| [docs/SECURITY.md](docs/SECURITY.md) | Security checklist (OWASP) |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Backups, restore and monitoring |
| [docs/ER-DIAGRAM.md](docs/ER-DIAGRAM.md) | Database design |
