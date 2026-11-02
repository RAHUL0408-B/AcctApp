# Deploying

## Run everything locally with Docker
```bash
docker compose -f docker/docker-compose.yml up -d --build
```
Open **http://localhost:8080**. The API and database run inside Docker; only the web port is published.
Check it with `curl http://localhost:8080/api/health`. Stop with `docker compose -f docker/docker-compose.yml down` (add `-v` to also erase the database and backups).

This stack was built and tested here: the full browser test passes against it, and the daily encrypted backup and restore test run inside the container.

## Deploy on Render (recommended: runs the whole product)
The product needs a long-running API (background worker, scheduled emails, backups), PostgreSQL and a disk, so it fits Render's Docker services.

1. Push this repository to GitHub.
2. Create the database first (see **Database on Supabase** below).
3. In Render: **New, Blueprint**, pick the repository. Render reads `render.yaml` and creates the API and the web app. When asked, paste the Supabase string as `DATABASE_URL`.
4. After the first deploy, open the **acctapp-api** service, **Environment**, and copy `BACKUP_KEY` into a password manager. Backups cannot be read without it.
5. Check the web service's real URL. If it is not `https://acctapp-web.onrender.com`, edit `WEB_ORIGIN` on the API service to match, then redeploy it.
6. Open the web URL and register. Check `https://<api-url>/api/health` returns `"status":"ok"`.

Things to know:
- The API needs a paid instance and a disk (uploaded documents and backups live on it). Free instances sleep, which stops the worker.
- Render has no India region. Pick the closest (Singapore is set). If your customers' data must stay in India, use an Indian host and the same Docker images.
- Payments run in **test mode** (`PAYMENT_PROVIDER=test`). Connect a real gateway before charging anyone.
- Email is only logged until you set `SMTP_URL` and `MAIL_FROM` on the API service.
- `docs/LAUNCH-CHECKLIST.md` lists what a CA, a lawyer and a security auditor must review before public launch.

## Database on Supabase
1. supabase.com, **New project**. Region: **South Asia (Mumbai)**. Save the database password.
2. Click **Connect** at the top, choose **Session pooler**, and copy the string (port 5432). Put your password in place of `[YOUR-PASSWORD]`. Do not add `sslmode` to it.
3. Set `DATABASE_URL` to that string and `DATABASE_SSL=true` on the API (Render dashboard, or your local `.env`). Migrations run automatically when the API starts.
4. Project Settings, **Data API**: turn it off. The app talks to Postgres directly and does not use it.
5. Do not use the transaction pooler (port 6543). The app sets a database role for each request, which that mode can break.

## Why not Vercel?
Vercel runs short-lived serverless functions. This API keeps a background worker running (reminders, repeating invoices, backups), holds a database connection pool, and writes files to disk, so it does not fit. The web front end alone could go on Vercel, but it calls the API with relative `/api` URLs, so it would also need an API address setting and CORS changes. Render runs both parts together without that work.
