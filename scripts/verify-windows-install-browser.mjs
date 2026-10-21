import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';

const [installed, evidence] = process.argv.slice(2);
if (process.env.GITHUB_ACTIONS !== 'true' || !installed || !evidence) {
  throw new Error('This check requires the hosted Windows installer acceptance paths.');
}
const requireInstalled = createRequire(path.join(installed, 'mcp-servers/browser/package.json'));
const { chromium } = requireInstalled('patchright');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const response = await page.goto('http://localhost:4200', { waitUntil: 'networkidle', timeout: 60_000 });
  await page.screenshot({ path: path.join(evidence, 'first-launch.png'), fullPage: true });
  const text = await page.locator('body').innerText();
  const result = { url: page.url(), status: response?.status(), title: await page.title(), errors, text: text.slice(0, 6000) };
  await fs.writeFile(path.join(evidence, 'first-launch.json'), JSON.stringify(result, null, 2));
  if (!response?.ok() || errors.length || !/FLUJO/i.test(text) || /Application error|Internal Server Error/i.test(text)) {
    throw new Error('The fresh installed application did not render a healthy FLUJO screen.');
  }
} finally {
  await browser.close();
}
