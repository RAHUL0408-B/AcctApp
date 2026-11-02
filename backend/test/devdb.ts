// Test helper: runs scripts/devdb.mjs as a child process and waits until Postgres is ready.
import { spawn } from 'child_process';
import { join } from 'path';

export function startDevDb(dir: string, port: number): Promise<{ url: string; stop: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(__dirname, '../scripts/devdb.mjs'), dir, String(port), 'fresh'], { stdio: ['pipe', 'pipe', 'inherit'] });
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      const m = /READY (\S+)/.exec(buf);
      if (m) resolve({ url: m[1], stop: () => new Promise((r) => { child.on('exit', () => r()); child.stdin.end(); setTimeout(() => child.kill(), 15000); }) });
    });
    child.on('exit', (code) => reject(new Error('devdb exited early: ' + code)));
  });
}
