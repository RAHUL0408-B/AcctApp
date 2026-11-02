# Security checklist

Status of each item in this codebase. "Done" means implemented and covered by a test where noted.

## OWASP Top 10 (2021)
| Risk | Status |
|---|---|
| A01 Broken access control | **Done.** Every org route calls `requireOrg(user, org, permission)`. Postgres row-level security on all tenant tables is a second layer. Tests cover cross-firm access (404), client read-only (403), staff vs accountant rights, and RLS hiding another org's rows. |
| A02 Cryptographic failures | **Partly done.** scrypt password hashes. AES-256-GCM backups (test: tamper and wrong-key detection). HSTS in production. **To do:** TLS and disk encryption in the hosting setup, and a secrets manager. |
| A03 Injection | **Done.** All SQL uses parameters. The only interpolated identifiers are fixed table names. Input is validated with zod schemas. CSV parsing is done in code. |
| A04 Insecure design | **Done.** Ledger is append-only and enforced by DB triggers. Balance check runs at commit. Period lock is enforced in the DB. Audit log is append-only. |
| A05 Security misconfiguration | **Done.** Production refuses to start without secrets (test). `x-powered-by` is off. CSP `default-src 'none'`, nosniff, frame-deny, no-referrer and `Cache-Control: no-store` on the API. Clean error bodies with no stack traces (test). |
| A06 Vulnerable components | **To do.** Run `npm audit` in CI and enable Dependabot or Renovate. |
| A07 Identification and authentication failures | **Done.** TOTP 2FA with recovery codes, lockout after 5 failures for 15 minutes, login/2FA rate limits, password strength rules, 8-hour tokens, a partial 2FA token can't reach the API (test). **To do:** password reset and token revocation. |
| A08 Software and data integrity | **Done.** Uploaded files get a SHA-256 checked on download. Backups are authenticated encryption. Lockfile committed. |
| A09 Logging and monitoring | **Done.** JSON request logs with request id, audit log of business actions, error log, metrics endpoint, alert webhook for bursts of server errors. |
| A10 SSRF | **N/A.** The server fetches no user-supplied URLs (the alert webhook comes from the environment only). |

## Other controls
- File uploads: allow-list of MIME types, magic-byte check, 10 MB cap, random storage names, `Content-Disposition: attachment` and nosniff on download.
- Request body limit 15 MB. Global rate limit (default 600 requests/min per IP).
- CORS is limited to `WEB_ORIGIN`.
- DPDP: consent history is append-only; data export and erasure are tested.
