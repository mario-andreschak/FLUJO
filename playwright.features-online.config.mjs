import { defineConfig } from '@playwright/test';

// Explicit opt-in: unlike the synthetic suite, this connects a public endpoint.
export default defineConfig({
  testDir: './e2e/features-online', fullyParallel: false, workers: 1, retries: 0,
  timeout: 180000, expect: { timeout: 20000 },
  outputDir: 'test-results/features-online',
  reporter: [['list'], ['json', { outputFile: 'feature-browser-artifacts/firecrawl-report.json' }]],
  use: { browserName: 'chromium', locale: 'en-US', actionTimeout: 20000,
    navigationTimeout: 30000, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 720 } } },
    { name: '360px', use: { viewport: { width: 360, height: 800 } } },
  ],
});
