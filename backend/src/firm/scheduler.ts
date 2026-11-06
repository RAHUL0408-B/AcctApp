// Background jobs: compliance reminders and scheduled report emails. Safe to run repeatedly.
import { getPool, withOrg } from '../db/db';
import { financialYearOf } from '../ledger/ledger';
import { buildTable, renderPdf, renderXlsx, ReportName } from './exporter';
import { templateConfigFor } from './templates';
import { processOutbox, queueMail } from './mailer';
import { createBackup, pruneBackups, verifyBackup } from '../ops/backup';
import { log, metrics } from '../ops/metrics';
import { join } from 'path';
import { runRecurring } from '../extras/extras.controller';
import { runJournalRules } from '../accounting/automation.controller';

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => iso(new Date(Date.parse(s) + n * 86400000));
const addMonth = (s: string) => { const d = new Date(Date.parse(s)); d.setUTCMonth(d.getUTCMonth() + 1); return iso(d); };

/** Emails the team about open tasks due within `daysAhead` days (once per task). */
export async function runReminders(today = iso(new Date()), daysAhead = 3) {
  const orgs = (await getPool().query('SELECT id, name, firm_id FROM organizations')).rows;
  let queued = 0;
  for (const o of orgs) {
    const tasks = await withOrg(Number(o.id), async (c) => (await c.query(
      "SELECT id,title,due_date::text AS due FROM tasks WHERE status='open' AND reminded_at IS NULL AND due_date <= $1::date + $2::int", [today, daysAhead])).rows);
    if (!tasks.length) continue;
    const people = (await getPool().query(
      `SELECT DISTINCT u.email FROM memberships m JOIN users u ON u.id=m.user_id
        WHERE m.firm_id=$1 AND (m.org_id IS NULL OR m.org_id=$2) AND m.role <> 'client'`, [o.firm_id, o.id])).rows;
    for (const t of tasks) {
      for (const p of people) {
        await queueMail({ orgId: Number(o.id), to: p.email, subject: `Reminder: ${t.title} due ${t.due}`, body: `Client: ${o.name}\nTask: ${t.title}\nDue: ${t.due}\n\nThis is an automated reminder.` });
        queued++;
      }
    }
    await withOrg(Number(o.id), (c) => c.query('UPDATE tasks SET reminded_at=now() WHERE id = ANY($1)', [tasks.map((t) => t.id)]));
  }
  return { queued };
}

/** Builds and queues every scheduled report that is due, then moves its next run date forward. */
export async function runScheduledReports(today = iso(new Date())) {
  const orgs = (await getPool().query('SELECT id, name FROM organizations')).rows;
  let sent = 0;
  for (const o of orgs) {
    await withOrg(Number(o.id), async (c) => {
      const due = (await c.query('SELECT * FROM scheduled_reports WHERE active AND next_run <= $1::date', [today])).rows;
      for (const s of due) {
        const fy = financialYearOf(today);
        const table = await buildTable(c, s.report as ReportName, { from: fy.start, to: today, asOf: today });
        const look = { ...(await templateConfigFor(c, 'report')), hide: [] as number[] }; // the organisation's chosen report template
        const data = s.format === 'pdf' ? await renderPdf(table, o.name, look) : await renderXlsx(table, o.name, look);
        const attachment = { name: `${s.report}-${today}.${s.format}`, mime: s.format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data };
        for (const to of s.recipients) { await queueMail({ orgId: Number(o.id), to, subject: `${table.title} - ${o.name}`, body: `Attached: ${table.title} (${table.subtitle}).`, attachment }); sent++; }
        const nextRun = s.frequency === 'weekly' ? addDays(today, 7) : addMonth(today);
        await c.query('UPDATE scheduled_reports SET last_run=now(), next_run=$2 WHERE id=$1', [s.id, nextRun]);
      }
    });
  }
  return { sent };
}

export async function tick() {
  const r = await runReminders(), s = await runScheduledReports(), rec = await runRecurring(), jr = await runJournalRules(), m = await processOutbox();
  return { reminders: r.queued, scheduled: s.sent, recurring: rec.created, journalRules: jr.created, ...m };
}

/** Daily encrypted backup; weekly restore test of the newest backup into a scratch database. */
export async function runBackupJobs(now = Date.now()) {
  if (process.env.BACKUPS === 'off') return { backedUp: false };
  const pool = getPool();
  const last = (await pool.query('SELECT max(created_at) AS t FROM backups')).rows[0].t;
  let backedUp = false;
  const dir = process.env.BACKUP_DIR ?? join(process.cwd(), 'backups');
  if (!last || now - new Date(last).getTime() > 24 * 3600_000) {
    const b = await createBackup(pool, dir);
    pruneBackups(dir, Number(process.env.BACKUP_KEEP_DAYS ?? 30));
    backedUp = true;
    log('info', 'backup created', { file: b.filename, size: b.size });
  }
  const unverified = (await pool.query(
    "SELECT id, filename FROM backups WHERE verified_at IS NULL OR verified_at < now() - interval '7 days' ORDER BY id DESC LIMIT 1")).rows[0];
  if (unverified && process.env.DATABASE_URL) {
    const r = await verifyBackup(pool, join(dir, unverified.filename), process.env.DATABASE_URL).catch((e) => ({ ok: false, detail: (e as Error).message }));
    await pool.query('UPDATE backups SET verified_at=now(), verify_status=$2, verify_detail=$3 WHERE id=$1', [unverified.id, r.ok ? 'ok' : 'failed', r.detail]);
    log(r.ok ? 'info' : 'error', 'backup restore test', { file: unverified.filename, ok: r.ok, detail: r.detail });
  }
  return { backedUp };
}

/** Start the periodic worker (every 5 minutes). Disabled when WORKER=off. */
export function startWorker() {
  if (process.env.WORKER === 'off') return;
  const run = async () => {
    try { await tick(); await runBackupJobs(); metrics.workerLastTick = new Date().toISOString(); metrics.workerLastError = null; }
    catch (e) { metrics.workerLastError = (e as Error).message; log('error', 'worker error', { error: (e as Error).message }); }
  };
  setInterval(run, 5 * 60_000).unref();
  setTimeout(run, 10_000).unref();
}
