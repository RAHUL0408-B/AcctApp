# Operations

## Backups
- The API's background worker takes an **encrypted backup every 24 hours** into `BACKUP_DIR` and deletes backups older than `BACKUP_KEEP_DAYS` (always keeping the newest).
- Every 7 days the worker runs a **restore test**: it creates a throw-away database, applies migrations, loads the newest backup, checks that every table loaded and the ledger balances (and matches exactly if nothing changed), then drops it. Results are in the `backups` table (`verify_status`, `verify_detail`) and in the logs.
- File format: `ACCTBK1` header, then AES-256-GCM (key derived from `BACKUP_KEY` with scrypt) over gzipped JSON of all tables. Losing `BACKUP_KEY` means losing the backups, so store it in a password manager or vault.
- Uploaded documents (`DATA_DIR`) are **not** inside the database backup. Back up that folder or bucket separately.

Manual commands (from `apps/api`, with `DATABASE_URL` and `BACKUP_KEY` set):
```bash
npm run ops -- backup                         # make a backup now
npm run ops -- verify backups/<file>.bak.enc  # restore test into a scratch database
npm run ops -- restore backups/<file>.bak.enc # restore into DATABASE_URL (must be freshly migrated and EMPTY)
```

### Disaster recovery steps
1. Create an empty database, then set `DATABASE_URL` to it.
2. Run `npm run migrate -w apps/api`.
3. Run `npm run ops -w apps/api -- restore <newest backup>`.
4. Restore `DATA_DIR` from its own backup.
5. Start the API and check `/api/health`. Then open a trial balance for a few clients.

## Monitoring
- `GET /api/health` is public. It returns DB status and latency, uptime and the worker's last run. Point an uptime monitor at it (alert if not 200 for 2 minutes).
- `GET /api/metrics` needs `Authorization: Bearer $METRICS_TOKEN`. It returns request counts by status, average latency, the 5xx count and worker status.
- Logs are one JSON object per line on stdout/stderr. Ship them to CloudWatch, Loki or similar. Every response has an `X-Request-Id` header that appears in the logs.
- Set `ALERT_WEBHOOK_URL` (a Slack or Teams incoming webhook) to get a message after 5+ server errors in a minute, at most every 10 minutes.

## Background worker
Runs inside the API process every 5 minutes (set `WORKER=off` to disable, e.g. on extra API replicas):
- compliance reminders for tasks due within 3 days
- repeating invoices that are due (a schedule that fails, for example because an account was removed, is paused and logged)
- due scheduled reports
- sending queued email (retried 3 times)
- daily backup and weekly restore test

## Changing tax rules
GST slabs, TDS sections and compliance due dates are rows in `gst_rates`, `tds_sections` and `compliance_rules`. When the law changes, set `valid_to` on the old row and insert a new one with `valid_from`, in a new numbered migration so every environment gets the same change.
