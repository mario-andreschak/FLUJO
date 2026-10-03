import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/features', fullyParallel: false, workers: 1, retries: 0,
  timeout: 180000, expect: { timeout: 20000 },
  outputDir: 'test-results/features',
  reporter: [['list'], ['json', { outputFile: 'feature-browser-artifacts/report.json' }]],
  use: { browserName: 'chromium', locale: 'en-US', actionTimeout: 20000,
    navigationTimeout: 30000, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 720 } } },
    { name: '360px', use: { viewport: { width: 360, height: 800 } } },
  ],
});
