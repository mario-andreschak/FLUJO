// Run against a local production build, with disposable data and no model calls:
// node scripts/calendar-browser-acceptance.mjs [applicationRoot] [port] [evidenceDir]
// Install the matching Playwright Chromium first; PLAYWRIGHT_BROWSERS_PATH is supported.
import { fork } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

const root = path.resolve(process.argv[2] ?? process.cwd());
const require = createRequire(path.join(root, 'package.json'));
const { chromium, expect } = require('@playwright/test');
const port = Number(process.argv[3] ?? 4392);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid calendar test port.');
const buildId = (await fs.readFile(path.join(root, '.next/BUILD_ID'), 'utf8')).trim();
const baseURL = `http://127.0.0.1:${port}`;
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-calendar-journey-'));
const secretDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-calendar-secret-'));
const secretPath = path.join(secretDir, 'operator-secret');
await fs.writeFile(secretPath, randomBytes(32).toString('base64url'), { flag: 'wx', mode: 0o600 });
const evidenceDir = process.argv[4] ? path.resolve(process.argv[4])
  : await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-calendar-evidence-'));
await fs.mkdir(evidenceDir, { recursive: true });
const log = createWriteStream(path.join(evidenceDir, 'app.log'));
const env = { ...process.env, FLUJO_DATA_DIR: dataDir, FLUJO_ENCRYPTION_SECRET_FILE: secretPath,
  NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', FLUJO_BASE_URL: baseURL };
for (const key of Object.keys(env)) {
  if (['FLUJO_PARENT_DATA_DIR', 'FLUJO_WORKSPACE', 'NEXT_MANUAL_SIG_HANDLE'].includes(key.toUpperCase())) delete env[key];
}
const child = fork(path.join(root, 'scripts/persona-browser-acceptance/next-process.cjs'), [String(port)], {
  cwd: root, env, silent: true, windowsHide: true,
});
child.stdout.pipe(log, { end: false });
child.stderr.pipe(log, { end: false });
console.log(JSON.stringify({ appPid: child.pid, dataDir, baseURL, evidenceDir }));
let browser;
const receipt = { startedAt: new Date().toISOString(), root, dataDir, appPid: child.pid,
  buildId, checks: [], pageErrors: [], mapRequests: 0 };
async function request(route, body) {
  const response = await fetch(baseURL + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`${route}: ${response.status}`);
  return response.json();
}
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('App IPC initialization timeout')), 60000);
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`App exited early: ${code}`)));
    child.on('message', message => {
      if (message?.type === 'journey-server-ready' && message.pid === child.pid) { clearTimeout(timer); resolve(); }
    });
  });
  // Next's listener starts before workspace migration finishes on a fresh root.
  const readyDeadline = Date.now() + 60000;
  for (;;) {
    try { await request('/api/workspaces'); break; }
    catch (error) {
      if (Date.now() >= readyDeadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  const configs = await request('/api/storage?key=mcp_servers');
  await request('/api/storage', { key: 'mcp_servers', value: Object.fromEntries(
    Object.entries(configs.value ?? {}).map(([key, value]) => [key, { ...value, disabled: true }])) });
  const settings = await request('/api/storage?key=speech_settings');
  await request('/api/storage', { key: 'speech_settings', value: { ...settings.value,
    telemetry: { enabled: false, notifyDaily: false }, onboarding: { completed: true } } });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', timezoneId: 'America/Bogota' });
  const page = await context.newPage();
  page.on('pageerror', error => receipt.pageErrors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/automation-map') receipt.mapRequests++; });
  await page.clock.setFixedTime(new Date('2026-10-09T17:00:00Z'));
  await page.goto(baseURL + '/waves');
  await page.getByRole('button', { name: 'Day', exact: true }).click();
  const day = page.getByTestId('waves-day-view');
  let grid = day.getByRole('grid');
  await expect(grid).toHaveAccessibleName('October 2026');
  await expect(grid.getByRole('row')).toHaveCount(7);
  await expect(grid.locator('button[tabindex="0"]')).toHaveCount(1);
  receipt.checks.push('desktop one date Tab stop and seven calendar rows');
  const selectedLabel = await grid.getByRole('gridcell', { selected: true }).getByRole('button').getAttribute('aria-label');
  await grid.getByRole('button', { name: 'Friday, October 9, 2026', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(grid.getByRole('button', { name: 'Saturday, October 10, 2026', exact: true })).toBeFocused();
  await expect(grid.getByRole('gridcell', { selected: true }).getByRole('button')).toHaveAttribute('aria-label', selectedLabel);
  await page.keyboard.press('Enter');
  await expect(grid.getByRole('gridcell', { selected: true }).getByRole('button')).toHaveAttribute('aria-label', 'Saturday, October 10, 2026');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Space');
  await expect(grid.getByRole('gridcell', { selected: true }).getByRole('button')).toHaveAttribute('aria-label', 'Sunday, October 11, 2026');
  await expect(grid.getByRole('gridcell', { selected: true }).getByRole('button')).toBeFocused();
  await expect(grid.locator('button[tabindex="0"]')).toHaveCount(1);
  receipt.checks.push('native arrows browse; Enter and Space select and retain focus');
  receipt.beforeTab = await grid.evaluate(element => ({ active: document.activeElement?.getAttribute('aria-label'),
    stops: [...element.querySelectorAll('[tabindex="0"]')].map(button => button.getAttribute('aria-label')) }));
  await page.keyboard.press('Tab');
  receipt.afterTab = await grid.evaluate(element => ({ active: document.activeElement?.getAttribute('aria-label'),
    stops: [...element.querySelectorAll('[tabindex="0"]')].map(button => button.getAttribute('aria-label')) }));
  expect(await grid.evaluate(element => element.contains(document.activeElement))).toBe(false);
  await page.keyboard.press('Shift+Tab');
  await expect(grid.getByRole('button', { name: 'Sunday, October 11, 2026', exact: true })).toBeFocused();
  receipt.checks.push('Tab exits the date grid; Shift+Tab restores its single date stop');
  receipt.rapidTabChecks = [];
  for (let index = 0; index < 20; index++) {
    await grid.getByRole('gridcell', { selected: true }).getByRole('button').focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Space');
    await page.keyboard.press('Tab');
    const returned = await grid.evaluate(element => element.contains(document.activeElement));
    receipt.rapidTabChecks.push({ index, returned });
  }
  expect(receipt.rapidTabChecks.filter(check => check.returned)).toHaveLength(0);
  receipt.checks.push('20 rapid native selection-and-Tab cycles leave the date grid');
  await grid.getByRole('gridcell', { selected: true }).getByRole('button').focus();
  await page.keyboard.press('PageDown'); await page.keyboard.press('PageDown'); await page.keyboard.press('PageDown');
  await expect(grid).toHaveAccessibleName('January 2027');
  await grid.getByRole('button', { name: 'Sunday, January 31, 2027', exact: true }).click();
  await page.keyboard.press('PageDown');
  await expect(grid.getByRole('button', { name: 'Sunday, February 28, 2027', exact: true })).toBeFocused();
  await expect(grid).toHaveAccessibleName('February 2027');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Shift+PageDown');
  await expect(grid).toHaveAccessibleName('February 2028');
  await page.keyboard.press('ArrowRight');
  await expect(grid.getByRole('button', { name: 'Tuesday, February 29, 2028', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+PageDown');
  await expect(grid.getByRole('button', { name: 'Wednesday, February 28, 2029', exact: true })).toBeFocused();
  receipt.checks.push('month and year navigation clamps short months and leap days');
  await page.screenshot({ path: path.join(evidenceDir, 'desktop-focus.png'), fullPage: true });
  const nextMonth = day.getByRole('button', { name: 'Next month', exact: true });
  await nextMonth.click();
  await expect(grid).toHaveAccessibleName('March 2029');
  await expect(nextMonth).toBeFocused();
  const requestsBeforeRefresh = receipt.mapRequests;
  await page.waitForTimeout(31000);
  expect(receipt.mapRequests).toBeGreaterThan(requestsBeforeRefresh);
  await expect(grid).toHaveAccessibleName('March 2029');
  await expect(grid.locator('button[tabindex="0"]')).toHaveCount(1);
  receipt.checks.push('month button keeps focus and browsing survives actual 30-second map refresh');
  // Test the same production component inside the mobile expanding month area.
  await page.setViewportSize({ width: 390, height: 844 });
  await day.getByRole('button', { name: 'Choose date', exact: true }).click();
  grid = day.getByRole('grid');
  await expect(grid).toHaveAccessibleName('February 2027');
  await expect(grid.locator('button[tabindex="0"]')).toHaveCount(1);
  await grid.getByRole('button', { name: 'Sunday, February 28, 2027', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(grid).toHaveAccessibleName('March 2027');
  await page.keyboard.press('Enter');
  await expect(day.getByText('Monday, March 1, 2027', { exact: true })).toBeVisible();
  await expect(day.getByRole('button', { name: 'Choose date', exact: true })).toBeFocused();
  await expect(grid).toHaveCount(0);
  await page.screenshot({ path: path.join(evidenceDir, 'mobile-focus.png'), fullPage: true });
  receipt.checks.push('mobile expanded calendar supports native keyboard selection across months');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  receipt.mobileDocumentOverflow = overflow;
  expect(overflow).toBe(false);
  expect(receipt.pageErrors).toEqual([]);
  receipt.completedAt = new Date().toISOString();
  console.log(JSON.stringify(receipt));
} catch (error) {
  receipt.error = String(error.stack ?? error); console.error(receipt.error); process.exitCode = 1;
} finally {
  receipt.cleanupErrors = [];
  const failedCleanup = error => {
    receipt.cleanupErrors.push(String(error));
    process.exitCode = 1;
  };
  try { await browser?.close(); } catch (error) { failedCleanup(error); }
  try {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve, reject) => {
        let forcedExitTimer;
        const timer = setTimeout(() => {
          failedCleanup(new Error('App graceful stop timeout'));
          // Only our own fork; keep waiting for its exit after forced termination.
          forcedExitTimer = setTimeout(() => reject(new Error('Owned app termination timeout')), 5000);
          try { child.kill('SIGKILL'); } catch (error) { failedCleanup(error); }
        }, 30000);
        child.once('exit', () => { clearTimeout(timer); clearTimeout(forcedExitTimer); resolve(); });
        child.send('stop', error => { if (error) failedCleanup(error); });
      });
    }
    receipt.appExitCode = child.exitCode;
    receipt.appSignalCode = child.signalCode;
    if (![0, 143].includes(child.exitCode)) throw new Error(`Unexpected app exit: ${child.exitCode}/${child.signalCode}`);
  } catch (error) {
    failedCleanup(error);
  } finally {
    await new Promise(resolve => log.end(resolve));
    receipt.appExitCode = child.exitCode;
    receipt.appSignalCode = child.signalCode;
    receipt.stoppedAt = new Date().toISOString();
    await fs.writeFile(path.join(evidenceDir, 'receipt.json'), JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify({ stopped: child.exitCode !== null || child.signalCode !== null,
      appPid: child.pid, appExitCode: child.exitCode, cleanupErrors: receipt.cleanupErrors }));
  }
}
