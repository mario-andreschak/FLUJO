import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/personas',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 600_000,
  expect: { timeout: 15_000 },
  outputDir: 'test-results/personas',
  reporter: [['list'], ['html', { outputFolder: 'playwright-report/personas', open: 'never' }],
    ['json', { outputFile: 'persona-browser-artifacts/report.json' }]],
  use: { browserName: 'chromium', locale: 'en-US', viewport: { width: 1280, height: 720 },
    trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
