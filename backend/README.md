# Backend (API)

NestJS + TypeScript API with a built-in background worker. Talks to PostgreSQL with plain SQL (`pg`); request bodies are validated with `zod`.

## Run
From the repository root:
```bash
npm run devdb -w backend      # local PostgreSQL on :5432 (skip if you have your own)
npm run migrate               # apply db/migrations
npm run dev:api               # http://localhost:3000/api
```
Check it with `curl http://localhost:3000/api/health`.

## Folders
| Folder | Responsibility |
|---|---|
| `src/auth` | Register, login, 2FA and recovery codes |
| `src/security` | Password hashing (scrypt), TOTP, signed tokens |
| `src/tenancy` | Firms, clients, memberships, roles and access checks |
| `src/ledger` | Journal entries, reversals, period locks |
| `src/audit` | Append-only audit log |
| `src/coa` | Chart of accounts templates (trading, services, manufacturing) |
| `src/accounting` | Contacts, invoices, bills, notes, payments, bank, reports |
| `src/tax` | GST (CGST/SGST/IGST) and TDS calculations |
| `src/extras` | Quotes, purchase orders, repeating invoices, items, bank rules, fixed assets, dashboard |
| `src/inventory` | Stock on hand at weighted average cost, movement history, stock adjustments |
| `src/workflow` | Invoices and bills awaiting approval, expense claims |
| `src/planning` | Tracking categories, budgets, P&L by month / category, budget vs actual, year-end close |
| `src/practice` | Overview across every client the user can see |
| `src/insights` | Sales and purchases overviews, search, notifications, setup guide, short-term cash flow, business snapshot, TDS report |
| `src/banking` | Spend money, receive money, transfer money |
| `src/projects` | Projects: time, costs, invoicing unbilled work |
| `src/firm` | Tasks and due dates, files, CSV import, PDF/Excel export, email outbox, scheduler |
| `src/ops` | Backups and restore test, billing, privacy (DPDP), health and metrics, command line |
| `src/common` | Guards, CSV parsing, rate limiting |
| `src/db` | Connection pool (`DATABASE_URL`, `DATABASE_SSL`) and migration runner |

## How tenant isolation works
Every client-scoped query runs inside `withOrg()`: a transaction that switches to the restricted `app_user` role and sets `app.org_id`. Row-level security policies in the database then only show rows for that client, so a bug in a query cannot leak another client's data.

## Tests
```bash
npm test                      # from the root: 192 tests
```
The end-to-end tests start their own throwaway PostgreSQL, so nothing else needs to be running.

## Command line
```bash
npm run ops -w backend -- backup
npm run ops -w backend -- verify <file>
npm run ops -w backend -- restore <file>
```
Needs `DATABASE_URL` and `BACKUP_KEY`. See [../docs/OPERATIONS.md](../docs/OPERATIONS.md).
