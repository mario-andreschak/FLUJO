import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function verifyInstalledApplication(installed, evidence, baseUrl = 'http://localhost:4200', launchOptions = {}) {
  const requireInstalled = createRequire(path.join(installed, 'mcp-servers/browser/package.json'));
  const { chromium } = requireInstalled('patchright');
  const browser = await chromium.launch({ headless: true, ...launchOptions });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const response = await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 60_000 });
    // A quiet network can still leave the first-run migration screen visible.
    // Wait for the real UI transition, retaining diagnostics if it never ends.
    let readinessError;
    try {
      await page.getByRole('status').filter({ hasText: /Verifying and migrating workspace data/i })
        .waitFor({ state: 'hidden', timeout: 60_000 });
    } catch (error) {
      readinessError = error.message;
    }
    // First use must work without a custom encryption password. Exercise a real
    // gated API as well as the DOM so hiding a lock dialog cannot satisfy this.
    const encryption = await page.request.post(new URL('/api/encryption/secure', baseUrl).href, {
      headers: { Origin: baseUrl }, data: { action: 'status' },
    });
    const encryptionStatus = await encryption.json();
    const models = await page.request.get(new URL('/api/model', baseUrl).href);
    const dialogs = await page.getByRole('dialog').count();
    await page.screenshot({ path: path.join(evidence, 'first-launch.png'), fullPage: true });
    const text = await page.locator('body').innerText();
    const result = { url: page.url(), status: response?.status(), title: await page.title(), browserVersion: browser.version(), errors,
      optionalPassword: encryptionStatus.locked === false && dialogs === 0,
      workspaceReady: !readinessError, ...(readinessError ? { readinessError } : {}),
      encryptionStatus, modelsStatus: models.status(), dialogs, text: text.slice(0, 6000) };
    await fs.writeFile(path.join(evidence, 'first-launch.json'), JSON.stringify(result, null, 2));
    if (!encryption.ok() || encryptionStatus.locked !== false || encryptionStatus.protection === 'passphrase') {
      throw new Error('Fresh local installation unexpectedly requires an encryption password.');
    }
    if (!models.ok() || dialogs) {
      throw new Error('First use is blocked by a modal or inaccessible Models API.');
    }
    if (!response?.ok() || readinessError || errors.length || !/FLUJO/i.test(text) || /Application error|Internal Server Error/i.test(text)) {
      throw new Error('The fresh installed application did not render a healthy FLUJO screen.');
    }
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [installed, evidence] = process.argv.slice(2);
  if (process.env.GITHUB_ACTIONS !== 'true' || !installed || !evidence) {
    throw new Error('This check requires the hosted Windows installer acceptance paths.');
  }
  await verifyInstalledApplication(installed, evidence);
}
