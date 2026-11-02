# Launch checklist

Everything below needs a person to check or decide before real customers use the product.

## Chartered Accountant must verify
- [ ] **TDS rates and thresholds** in `db/migrations/002_core_accounting.sql` (`tds_sections`). Seeded values: 194C 1%/2% (Rs 30,000 per payment / Rs 1,00,000 per year), 194J 10% (Rs 50,000), 194H 2% (Rs 20,000), 194I(a) 2% / 194I(b) 10% (Rs 6,00,000), 194A 10% (Rs 50,000), 194Q 0.1% (Rs 50 lakh). These change with Finance Acts. 194J technical services at 2% is not separated yet.
- [ ] **TDS on threshold crossing**: when the yearly limit is first crossed, TDS is charged on the full year-to-date amount. Confirm this matches your practice for each section.
- [ ] **GST rules**: place of supply defaults to the customer's state for sales and the organization's state for purchases. Not handled: reverse charge, exports/SEZ, composition dealers, e-invoicing (IRN/QR), e-way bills, cess, blocked credits (17(5)), ITC reversals, and cross-head ITC set-off order. GSTR-1/3B screens are working papers, not filing-ready JSON.
- [ ] **Compliance due dates** (`compliance_rules`): GSTR-1 on the 11th, GSTR-3B on the 20th, TDS payment on the 7th, quarterly TDS returns on the 31st (Q4 on 31 May). Not covered: QRMP filers, state-wise staggered 3B dates, the March TDS payment due on 30 April, and advance tax.
- [ ] **Chart of accounts templates** (`apps/api/src/coa/templates.ts`) and the Schedule III grouping.
- [ ] **Subscription GST** (18%) and invoice format for your own SaaS billing.
- [ ] **Balance sheet**: there are no year-end closing entries yet. Profit to date is shown inside equity.

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
- [ ] Session tokens are stored in sessionStorage. Consider httpOnly cookies with CSRF protection, and add token revocation on password change.

## Engineering items before launch
- [ ] Real payment gateway: implement `PaymentProvider` in `apps/api/src/ops/billing.ts` (for example Razorpay) with webhook verification, renewals and failed-payment handling (`past_due`).
- [ ] Email: set `SMTP_URL` (SES, Postmark, etc.), configure SPF/DKIM, add email verification on signup, and a password reset flow (not built yet).
- [ ] Invitations: adding a team member currently requires them to register first. Build email invitations.
- [ ] Uploaded files are on local disk (`DATA_DIR`). Use encrypted object storage (S3 in ap-south-1) and add virus scanning.
- [ ] Copy backups off-site (a different region or account) and run a manual restore drill every quarter.
- [ ] Uptime monitor on `/api/health` (for example UptimeRobot or Better Stack), plus a log shipper.
- [ ] Docker images were written but **not built or tested here**, because Docker was not running on the build machine.
- [ ] Browser end-to-end tests run against a dev server. Add them to CI.
