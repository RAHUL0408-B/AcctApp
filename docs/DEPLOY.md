# Deploying

## Run everything locally with Docker
```bash
docker compose -f docker/docker-compose.yml up -d --build
```
Open **http://localhost:8080**. The API and database run inside Docker; only the web port is published.
Check it with `curl http://localhost:8080/api/health`. Stop with `docker compose -f docker/docker-compose.yml down` (add `-v` to also erase the database and backups).

This stack was built and tested here: the full browser test passes against it, and the daily encrypted backup and restore test run inside the container.

## Deploy: API on Render, web on Vercel (recommended)
The API needs a long-running server (background worker, scheduled emails, backups) and a disk, so it goes on Render. The React front end is static, so it goes on Vercel. `apps/web/vercel.json` forwards every `/api/*` request to the Render API, so the browser only ever talks to one address and no CORS setup is needed.

1. Create the database first (see **Database on Supabase** below).
2. **Render:** New, Blueprint, pick the repository (it must show the service as **Docker**). It creates the API service from `render.yaml`. When asked, enter:
   - `DATABASE_URL`: the Supabase string (the only value it asks for)
3. After the first deploy, open **acctapp-api**, Environment, and copy `BACKUP_KEY` into a password manager. Backups cannot be read without it.
4. Check `https://<your-api>.onrender.com/api/health` returns `"status":"ok"`. If the service URL is not `https://acctapp-api.onrender.com`, edit the destination in `apps/web/vercel.json` to match and commit.
5. **Vercel:** Add New, Project, import the repository, set **Root Directory** to `apps/web`. The Vite settings are detected. Deploy. Then set `WEB_ORIGIN` on the Render API to the real Vercel address and redeploy the API.
6. Open the Vercel address and register.

Things to know:
- `render.yaml` uses Render's **free** plan: the API sleeps after about 15 minutes idle (the next request takes ~50 seconds), the background worker only runs while awake, and there is no disk, so uploads and local backups are lost on restart. That is fine for a demo. For real client data, change `plan: free` to `starter` and add a disk:
  ```
  disk: { name: acctapp-data, mountPath: /var/acctapp, sizeGB: 5 }
  ```
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

## Why the API is not on Vercel
Vercel runs short-lived serverless functions. This API keeps a background worker running (reminders, repeating invoices, backups), holds a database connection pool, and writes files to disk, so it does not fit there. Only the static front end goes on Vercel.
