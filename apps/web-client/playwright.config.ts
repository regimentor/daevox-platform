import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testIgnore: 'transcription.spec.ts',
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5174',
    trace: 'off',
  },
  webServer: [
    {
      command: 'node e2e/support/backend.ts',
      url: 'http://127.0.0.1:3001/healthcheck',
      reuseExistingServer: false,
    },
    {
      command: 'npm run dev -- --host 127.0.0.1 --port 5174',
      env: { API_PROXY_TARGET: 'http://127.0.0.1:3001' },
      reuseExistingServer: false,
      url: 'http://127.0.0.1:5174',
    },
  ],
  projects: [
    {
      name: 'chromium',
      use: devices['Desktop Chrome'],
    },
  ],
});
