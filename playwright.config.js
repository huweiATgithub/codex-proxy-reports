import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: 'http://127.0.0.1:4174', viewport: { width: 1560, height: 1080 },
    colorScheme: 'light',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {},
    screenshot: 'only-on-failure', trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node demo/server.js --host 127.0.0.1 --port 4174',
    env: { REPORTS_DEMO_NOW: '2026-10-17T12:34:56.000Z' },
    url: 'http://127.0.0.1:4174', reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 2000 },
  },
});
