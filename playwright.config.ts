import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e', timeout: 30000, workers: 1,
  projects: (process.env.PMEM_BROWSERS === 'all' ? ['chromium', 'firefox', 'webkit'] as const : ['chromium'] as const).map(browserName => ({ name: browserName, use: { browserName } })),
  use: { baseURL: 'http://127.0.0.1:4173', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: { command: 'pnpm exec tsx tests/e2e/server.ts', url: 'http://127.0.0.1:4173/healthz', reuseExistingServer: false, timeout: 30000 },
});
