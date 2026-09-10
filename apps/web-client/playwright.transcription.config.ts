import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  testMatch: 'transcription.spec.ts',
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:5175', trace: 'off' },
  webServer: [
    {
      command:
        '../transcription-backend/.venv/bin/python ../transcription-backend/tests/support/server.py',
      url: 'http://127.0.0.1:3002/trancription-api/health',
      reuseExistingServer: false,
    },
    {
      command: 'npm run dev -- --host 127.0.0.1 --port 5175',
      env: { TRANSCRIPTION_PROXY_TARGET: 'http://127.0.0.1:3002' },
      url: 'http://127.0.0.1:5175',
      reuseExistingServer: false,
    },
  ],
  projects: [{ name: 'chromium', use: devices['Desktop Chrome'] }],
});
