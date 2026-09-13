import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  testMatch: 'core.spec.ts',
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:5188', trace: 'retain-on-failure', actionTimeout: 5000 },
  webServer: [
    {
      command: 'node e2e/support/core.ts',
      url: 'http://127.0.0.1:3188/health',
      reuseExistingServer: false,
      timeout: 120000,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 15000 },
    },
    {
      command: 'npm run dev -- --host 127.0.0.1 --port 5188',
      env: { CORE_PROXY_TARGET: 'http://127.0.0.1:3188' },
      url: 'http://127.0.0.1:5188',
      reuseExistingServer: false,
    },
  ],
  projects: [{ name: 'chromium', use: devices['Desktop Chrome'] }],
});
