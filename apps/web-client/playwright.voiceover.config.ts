import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  testMatch: 'voiceover.spec.ts',
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:5176', trace: 'off' },
  webServer: [
    {
      command:
        '../transcription-backend/.venv/bin/python ../transcription-backend/tests/support/voiceover_server.py',
      url: 'http://127.0.0.1:3003/trancription-api/health',
      reuseExistingServer: false,
    },
    {
      command: 'npm run dev -- --host 127.0.0.1 --port 5176',
      env: { TRANSCRIPTION_PROXY_TARGET: 'http://127.0.0.1:3003' },
      url: 'http://127.0.0.1:5176',
      reuseExistingServer: false,
    },
  ],
  projects: [{ name: 'chromium', use: devices['Desktop Chrome'] }],
});
