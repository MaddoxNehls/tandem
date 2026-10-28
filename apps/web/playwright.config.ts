import { defineConfig, devices } from '@playwright/test';

const PORT = 8791;

/**
 * End-to-end: the production web build served by the real sync server
 * (service worker, IndexedDB and Postgres included). `pnpm e2e` builds first.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    viewport: { width: 1360, height: 860 },
    deviceScaleFactor: 2,
  },
  webServer: {
    command: 'pnpm --filter @tandem/sync-server exec tsx --conditions=source src/main.ts',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      PORT: String(PORT),
      STATIC_DIR: new URL('./dist', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
      DATABASE_URL: 'postgres://tandem:tandem@localhost:5448/tandem_test',
      TANDEM_SECRET: 'e2e-secret',
    },
  },
});
