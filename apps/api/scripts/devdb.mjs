// Starts a local PostgreSQL without Docker. Usage: node scripts/devdb.mjs <dataDir> <port> [fresh]
import EmbeddedPostgres from 'embedded-postgres';

const [dataDir = '.pgdata', port = '5432', fresh] = process.argv.slice(2);
const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password: 'postgres', port: Number(port), persistent: !fresh });
await pg.initialise();
await pg.start();
try { await pg.createDatabase('acctapp'); } catch { /* already exists */ }
console.log(`READY postgres://postgres:postgres@localhost:${port}/acctapp`);
const quit = async () => { await pg.stop(); process.exit(0); };
process.on('SIGINT', quit);
process.on('SIGTERM', quit);
if (fresh) process.stdin.resume();
if (fresh) process.stdin.on('end', quit); // test mode: parent closed the pipe -> shut down
