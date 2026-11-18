import fs from 'node:fs';
import { defineConfig } from '@playwright/test';

const E2E_PORT = process.env.E2E_PORT || '1421';
const BASE_URL = `http://127.0.0.1:${E2E_PORT}`;
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const launchOptions = fs.existsSync(CHROME_PATH) ? { executablePath: CHROME_PATH } : {};

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.e2e.ts',
  outputDir: '/tmp/mosaic-playwright-artifacts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  expect: {
    timeout: 8_000,
  },
  reporter: [
    ['list'],
    ['json', { outputFile: '/tmp/mosaic-playwright-results.json' }],
  ],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions,
  },
  projects: [
    {
      name: 'desktop-1280',
      use: {
        viewport: { width: 1280, height: 820 },
      },
    },
    {
      name: 'min-width-900',
      use: {
        viewport: { width: 900, height: 700 },
      },
    },
  ],
  webServer: {
    command: `pnpm exec vite --host 127.0.0.1 --port ${E2E_PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
