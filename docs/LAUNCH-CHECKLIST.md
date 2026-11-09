# Launch checklist

Everything below needs a person to check or decide before real customers use the product.

Last reviewed 9 November 2026. Items ticked `[x]` are built and tested; the rest need a person, an outside account, or a decision.

## Chartered Accountant must verify
- [ ] **TDS rates and thresholds** in `db/migrations/002_core_accounting.sql` (`tds_sections`). Seeded values: 194C 1%/2% (Rs 30,000 per payment / Rs 1,00,000 per year), 194J 10% (Rs 50,000), 194H 2% (Rs 20,000), 194I(a) 2% / 194I(b) 10% (Rs 6,00,000), 194A 10% (Rs 50,000), 194Q 0.1% (Rs 50 lakh). These change with Finance Acts. 194J(a), technical services at 2%, is now a separate section; confirm its rate and threshold too.
- [ ] **TDS on threshold crossing**: when the yearly limit is first crossed, TDS is charged on the full year-to-date amount. Confirm this matches your practice for each section.
- [ ] **GST rules**: place of supply defaults to the customer's state for sales and the organization's state for purchases, and can be overridden with a warning. Reverse charge, exports and SEZ supplies, and composition dealers are built; please check them against your practice. Not handled: e-invoicing (IRN/QR), e-way bills, cess, blocked credits (17(5)), ITC reversals, and cross-head ITC set-off order. GSTR-1/3B screens are working papers, not filing-ready JSON.
- [ ] **Compliance due dates** (`compliance_rules`): GSTR-1 on the 11th, GSTR-3B on the 20th, TDS payment on the 7th, quarterly TDS returns on the 31st (Q4 on 31 May). Not covered: QRMP filers, state-wise staggered 3B dates, the March TDS payment due on 30 April, and advance tax.
- [ ] **Chart of accounts templates** (`backend/src/coa/templates.ts`) and the Schedule III grouping.
- [ ] **Subscription GST** (18%) and invoice format for your own SaaS billing.
- [ ] **Year-end close**: closing entries move the year's profit to Reserves and Surplus and lock the year. Confirm the account names and treatment suit your clients. Fixed asset rates by group (Income Tax Act and Companies Act) are seeded in `backend/src/extras/assetgroups.ts`; please verify them.

## Lawyer must review
- [ ] Terms of Service and Privacy Policy. The app records consent version `2025-01`, but the documents themselves still need to be written and linked.
- [ ] DPDP Act 2023 and its Rules: consent notice wording, how a Data Principal raises grievances, Data Protection Officer or contact details, breach notification process, processing of children's data (not supported), cross-border transfer (host in India).
- [ ] Retention: erased users' ledger entries are kept (anonymised) because of Companies Act / GST record-keeping. Confirm the retention period, and when whole client books may be deleted.
- [ ] Your role versus the CA firm's role (processor or fiduciary) for client data, and data processing agreements.

## Security auditor must check
- [ ] Penetration test (OWASP Top 10 and API Top 10). See [SECURITY.md](SECURITY.md) for what is already in place.
- [ ] Secrets management: `JWT_SECRET`, `BACKUP_KEY`, database credentials, SMTP. Use a secrets manager, and keep a copy of `BACKUP_KEY` off the server.
- [ ] Production database roles: run the app as a non-superuser that owns no tables so row-level security always applies. Run migrations and backups as a separate role with `BYPASSRLS`.
- [ ] TLS everywhere: load balancer, database and SMTP. Encryption at rest on the disk/volume and object storage.
- [ ] Rate limiting is in-memory per process. Use Redis or the load balancer if you run more than one API instance.
- [x] Token revocation on password change or reset (built: tokens carry a version that is checked on every request; another API instance notices within 5 seconds).
- [ ] Session tokens are stored in sessionStorage. Consider httpOnly cookies with CSRF protection.
- [ ] The email links put a one-time token in the address (`#/reset?token=...`). It is never sent to the server in a page request, but check your analytics and error tools do not record the address bar.

## Engineering items before launch
- [ ] Real payment gateway: implement `PaymentProvider` in `backend/src/ops/billing.ts` (for example Razorpay) with webhook verification, renewals and failed-payment handling (`past_due`).
- [ ] Email: set `SMTP_URL` and `MAIL_FROM` (SES, Postmark, etc.) and configure SPF/DKIM. **Also set `APP_URL` to the web app's public address**, or the links in emails point at `http://localhost:5173`. Without `SMTP_URL`, emails are only written to the log, so nobody can reset a password or accept an invitation by email.
- [x] Email confirmation on sign-up, forgot-password and reset by email link, and change password (built; one-time links expire, only a hash is stored, every other session ends on a password change).
- [x] Invitations by email, a People and access page, and Sales and Employee roles (built and tested).
- [ ] Decide whether to **require** a confirmed email before login. Today it is a reminder bar only; nothing is blocked.
- [ ] Uploaded files are on local disk (`DATA_DIR`). Use encrypted object storage (S3 in ap-south-1) and add virus scanning.
- [ ] Copy backups off-site (a different region or account) and run a manual restore drill every quarter.
- [ ] Uptime monitor on `/api/health` (for example UptimeRobot or Better Stack), plus a log shipper.
- [x] Docker images: built and run on 9 Nov 2026 with `docker compose -f docker/docker-compose.yml up`. All 13 migrations applied to an empty database, health passed through the web proxy, and every browser test script passed against it. Still replace every `change-me` value in the compose file before real use.
- [x] A GitHub Actions workflow (`.github/workflows/ci.yml`) type-checks, builds and runs the backend tests and all browser tests on every push. It also builds both Docker images. It was **written but not yet run on GitHub**: check the first run.
- [x] The web app has a manifest and icons, so it can be added to a phone's home screen.
