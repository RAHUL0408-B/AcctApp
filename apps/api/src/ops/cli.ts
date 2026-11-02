// Command line: backup | verify <file> | restore <file>.   Usage: npm run ops -w apps/api -- backup
import { readFileSync } from 'fs';
import { Pool } from 'pg';
import { createBackup, restoreInto, verifyBackup } from './backup';

const url = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/acctapp';
const [cmd, file] = process.argv.slice(2);

(async () => {
  const pool = new Pool({ connectionString: url });
  try {
    if (cmd === 'backup') console.log(await createBackup(pool));
    else if (cmd === 'verify' && file) console.log(await verifyBackup(pool, file, url));
    else if (cmd === 'restore' && file) {
      console.log('Restoring into', url, '- the target database must be freshly migrated and EMPTY.');
      console.log(await restoreInto(pool, readFileSync(file)));
    } else { console.log('Usage: backup | verify <file> | restore <file>'); process.exitCode = 1; }
  } finally { await pool.end(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
