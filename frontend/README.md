# Frontend (web app)

React 18 + TypeScript, built with Vite and styled with Tailwind CSS v4.

## Run
From the repository root, with the backend running on port 3000:
```bash
npm run dev:web               # http://localhost:5173 (forwards /api to :3000)
```
Production build: `npm run build -w frontend` (output in `frontend/dist`).

## Structure
| Path | What it holds |
|---|---|
| `src/App.tsx` | Top bar with dropdown menus, client switcher, account menu, hash routing (`#/o/<client>/<page>`) |
| `src/pages/` | One file per area: `Dashboard`, `Documents` (invoices and bills), `Sales` (quotes, POs, repeating), `Contacts`, `Bank`, `Accounting` (items, fixed assets, settings), `Inventory`, `Approvals` (approvals, expense claims), `Planning` (tracking, budgets, year-end), `Reports`, `Practice` (tasks, files, import, schedules), `PracticeOverview`, `Account` (billing, privacy, help), `Security`, `Auth` |
| `src/pages/OrgWorkspace.tsx` | The menu structure (`NAV`) and which page each menu item opens |
| `src/ui.tsx`, `src/kit.tsx` | Shared components: logo, buttons, fields, cards, page headers, stat tiles, badges, bar chart |
| `src/api.ts` | Fetch wrapper with the login token, money formatting (paise to rupees) |
| `src/index.css` | Brand colours and base styles for tables and forms |
| `e2e/` | Browser tests driven by Playwright in Chrome |
| `vercel.json` | On Vercel, forwards `/api/*` to the backend on Render |

## Changing the look
All brand colours are the `--color-brand-*` values at the top of `src/index.css`; change them to re-colour the whole app. The top bar colour is `--color-nav`.

## Browser tests
```bash
node e2e/smoke.mjs            # quick check: register, journal, reversal, 2FA
node e2e/full.mjs             # full walk-through of every major feature
node e2e/more.mjs             # exports, stock, approvals, expense claims, tracking, budgets, year-end
```
Set `WEB_URL` to test another address (for example the live site) and `STEP_TIMEOUT=60000` for slow hosts.
