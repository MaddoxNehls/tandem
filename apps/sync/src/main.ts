/**
 * Entry point. Environment:
 *   PORT           (default 8790)
 *   DATABASE_URL   (default postgres://tandem:tandem@localhost:5448/tandem)
 *   TANDEM_SECRET  HMAC key for share tokens (a dev default is used if unset)
 *   STATIC_DIR     serve a built web app (default: ../web/dist when it exists)
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSyncServer } from './server.js';
import { PgStore } from './store.js';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 8790);
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://tandem:tandem@localhost:5448/tandem';
let secret = process.env.TANDEM_SECRET;
if (!secret) {
  secret = 'tandem-dev-secret-do-not-use-in-production';
  console.warn('TANDEM_SECRET is not set; using an insecure development secret.');
}
const defaultStatic = resolve(here, '../../web/dist');
const staticDir = process.env.STATIC_DIR ?? (existsSync(defaultStatic) ? defaultStatic : undefined);

const store = await PgStore.connect(databaseUrl);
const server = await startSyncServer({
  store,
  secret,
  port,
  host: process.env.HOST ?? '127.0.0.1',
  ...(staticDir ? { staticDir } : {}),
  log: (m) => console.log(m),
});
console.log(`tandem sync listening on http://127.0.0.1:${server.port} (ws ${server.url})${staticDir ? `, serving ${staticDir}` : ''}`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void server.close().then(() => store.close()).then(() => process.exit(0));
  });
}
