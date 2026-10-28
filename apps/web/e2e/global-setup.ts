import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const ADMIN = 'postgres://tandem:tandem@localhost:5448/tandem';

export default async function setup(): Promise<void> {
  if (!existsSync(resolve(here, '../dist/index.html'))) {
    throw new Error('apps/web/dist is missing: run `pnpm e2e` (it builds first) or `pnpm build`.');
  }
  const ping = new pg.Client({ connectionString: ADMIN, connectionTimeoutMillis: 2000 });
  try {
    await ping.connect();
    await ping.end();
  } catch {
    execSync('docker compose up -d --wait', { cwd: resolve(here, '../../..'), stdio: 'inherit' });
  }
  const c = new pg.Client(ADMIN);
  await c.connect();
  const r = await c.query("select 1 from pg_database where datname = 'tandem_test'");
  if (r.rowCount === 0) await c.query('create database tandem_test');
  await c.end();
}
