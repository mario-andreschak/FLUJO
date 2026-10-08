import { defineConfig } from '@playwright/test';
import path from 'node:path';

const output = process.env.FEATURE_BROWSER_OUTPUT_DIR;
if (!output || !path.isAbsolute(output)) throw new Error('Set an owned absolute FEATURE_BROWSER_OUTPUT_DIR.');

export default defineConfig({
  testDir: './e2e/features-first-use-bound', fullyParallel: false, workers: 1, retries: 0,
  maxFailures: 1, globalTimeout: 1500000,
  globalSetup: './scripts/feature-first-use-browser-acceptance/global-setup.mjs',
  timeout: 300000, expect: { timeout: 20000 },
  outputDir: path.join(output, 'test-results'),
  reporter: [['list'], ['json', { outputFile: path.join(output, 'report.json') }]],
  use: { browserName: 'chromium', launchOptions: { executablePath: process.env.FEATURE_BROWSER_CHROMIUM_EXECUTABLE },
    locale: 'en-US', serviceWorkers: 'block', actionTimeout: 20000,
    navigationTimeout: 30000, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 720 } } },
    { name: '360px', use: { viewport: { width: 360, height: 800 } } },
  ],
});
