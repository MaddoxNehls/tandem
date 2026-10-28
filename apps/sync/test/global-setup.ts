/**
 * Integration tests run against real Postgres (docker compose, port 5448).
 * Starts the container if it isn't reachable and creates the test database.
 */
import { execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { ADMIN_URL } from './env.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

async function reachable(): Promise<boolean> {
  const c = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 2000 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
}

export default async function setup(): Promise<void> {
  if (!(await reachable())) {
    execSync('docker compose up -d --wait', { cwd: repoRoot, stdio: 'inherit' });
  }
  const c = new pg.Client(ADMIN_URL);
  await c.connect();
  const r = await c.query("select 1 from pg_database where datname = 'tandem_test'");
  if (r.rowCount === 0) await c.query('create database tandem_test');
  await c.end();
}
