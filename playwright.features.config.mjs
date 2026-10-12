import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/features', fullyParallel: false, workers: 1, retries: 0,
  timeout: 180000, expect: { timeout: 20000 },
  outputDir: process.env.FEATURE_BROWSER_OUTPUT_DIR ? `${process.env.FEATURE_BROWSER_OUTPUT_DIR}/results` : 'test-results/features',
  reporter: [['list'], ['json', { outputFile: process.env.FEATURE_BROWSER_OUTPUT_DIR ? `${process.env.FEATURE_BROWSER_OUTPUT_DIR}/report.json` : 'feature-browser-artifacts/report.json' }]],
  use: { browserName: 'chromium', launchOptions: { executablePath: process.env.FEATURE_BROWSER_CHROMIUM_EXECUTABLE }, locale: 'en-US', actionTimeout: 20000,
    navigationTimeout: 30000, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 720 } } },
    { name: '360px', use: { viewport: { width: 360, height: 800 } } },
  ],
});
