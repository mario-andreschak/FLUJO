import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { createFeatureBrowserEnvironment } from '../../scripts/feature-surface-acceptance/browser-environment.mjs';

const serverName = 'Public Firecrawl form observation';
const endpoint = 'https://mcp.firecrawl.dev/v2/mcp';
let environment;
let tools;

test.beforeAll(async () => {
  environment = await createFeatureBrowserEnvironment({ applicationRoot: process.env.FEATURE_BROWSER_APP_DIR });
  const saved = await environment.request('/api/storage?key=mcp_servers');
  const configs = Object.fromEntries(Object.entries(saved.value ?? {}).map(([name, config]) => [name, { ...config, disabled: true }]));
  configs[serverName] = { name: serverName, transport: 'streamable', serverUrl: endpoint,
    headers: {}, env: {}, disabled: false, enableMcpApps: false, rootPath: '', _buildCommand: '', _installCommand: '' };
  await environment.request('/api/storage', { key: 'mcp_servers', value: configs });
  const discovered = await environment.request(`/api/mcp/servers/${encodeURIComponent(serverName)}/tools`);
  if (discovered.error || !Array.isArray(discovered.tools)) throw new Error('Candidate could not discover the public Firecrawl tools.');
  tools = discovered.tools;
  if (!tools.some(tool => tool.name === 'firecrawl_scrape')) throw new Error('Public endpoint no longer advertises firecrawl_scrape.');
});

test.afterAll(async ({}, testInfo) => {
  if (!environment) return;
  try { await environment.close(); }
  finally {
    await testInfo.attach('final-owned-environment', { body: JSON.stringify(environment.snapshot(), null, 2), contentType: 'application/json' });
  }
});

test('actual public scrape form stays mounted through the former 30-second boundary without Test', async ({ page, browser }, testInfo) => {
  const pageErrors = [];
  const consoleErrors = [];
  const blockedTesterDispatches = [];
  const observations = { scope: 'actual public schema in owned candidate form; discovery/form observation only',
    endpoint, credentialsSupplied: false, setup: 'seeded isolated saved config; not UI connection/save acceptance',
    tools, definitionSha256: createHash('sha256').update(JSON.stringify(tools)).digest('hex'),
    runtime: { platform: os.platform(), release: os.release(), architecture: os.arch(), browserVersion: browser.version(),
      project: testInfo.project.name, viewport: page.viewportSize() },
    declaredSourceSha: process.env.FEATURE_BROWSER_SOURCE_SHA ?? null, samples: [],
    upstreamToolCounter: 'not_observed', realScrapeResult: 'not_evaluated', humanReview: 'not_evaluated' };
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  // Block the browser's execution route before it reaches FLUJO. This is a
  // client-side guard, not an observation of every upstream server invocation.
  await page.route('**/api/mcp/servers/**/tools/**', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    blockedTesterDispatches.push(new URL(route.request().url()).pathname);
    await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Form-only observation refuses tool dispatch.' }) });
  });
  try {
    await page.addInitScript(() => localStorage.setItem('flujo.locale', 'en'));
    await page.goto(`${environment.baseURL}/mcp`);
    const guide = page.getByRole('button', { name: 'Your first AI + app agent', exact: true });
    if (await guide.getAttribute('aria-expanded') !== 'true') await guide.click();
    await page.getByRole('combobox', { name: 'Saved app to inspect', exact: true }).click();
    await page.getByRole('option', { name: serverName, exact: true }).click();
    await page.getByRole('button', { name: 'Inspect and test tools', exact: true }).click();
    await page.getByRole('combobox', { name: 'Select tool', exact: true }).click();
    await expect(page.getByRole('option')).toHaveCount(tools.length + 1);
    await page.getByRole('option', { name: 'firecrawl_scrape', exact: true }).click();
    const scrape = tools.find(tool => tool.name === 'firecrawl_scrape');
    const urlLabel = scrape.inputSchema.required?.includes('url') ? 'url *' : 'url';
    const url = page.getByRole('textbox', { name: urlLabel, exact: true });
    const formats = page.getByRole('textbox', { name: 'formats (JSON array)', exact: true });
    const options = page.getByRole('textbox', { name: 'jsonOptions (JSON object)', exact: true });
    await url.fill('https://example.invalid/feature-form-observation');
    await formats.fill('["markdown"]');
    await options.fill('{"prompt":');
    await expect(page.getByRole('button', { name: 'Test tool', exact: true })).toBeDisabled();
    const urlNode = await url.elementHandle();
    const optionsNode = await options.elementHandle();
    const openedAt = Date.now();
    observations.openedAtUtc = new Date(openedAt).toISOString();
    // An observation window deliberately crosses the old periodic refresh,
    // which the original report saw before any scrape invocation.
    for (let sample = 0; sample < 9; sample += 1) {
      await page.waitForTimeout(5000);
      await expect(url).toHaveText('https://example.invalid/feature-form-observation');
      await expect(formats).toHaveValue('["markdown"]');
      await expect(options).toHaveValue('{"prompt":');
      expect(await urlNode.evaluate(element => element.isConnected)).toBe(true);
      expect(await optionsNode.evaluate(element => element.isConnected)).toBe(true);
      expect(pageErrors).toEqual([]);
      await expect(page.getByText('The workspace hit a snag', { exact: true })).toHaveCount(0);
      expect(blockedTesterDispatches).toEqual([]);
      observations.samples.push({ elapsedMs: Date.now() - openedAt, completedAtUtc: new Date().toISOString() });
    }
    const refresh = page.getByRole('button', { name: 'Refresh tools', exact: true });
    const listPath = `/api/mcp/servers/${encodeURIComponent(serverName)}/tools`;
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === listPath
      && response.request().method() === 'GET');
    await refresh.click();
    await options.focus();
    const selection = await options.evaluate(input => ({ start: input.selectionStart, end: input.selectionEnd }));
    const refreshResponse = await refreshed;
    expect(refreshResponse.ok()).toBe(true);
    const refreshBody = await refreshResponse.json();
    expect(refreshBody.error).toBeUndefined();
    expect(refreshBody.tools.some(tool => tool.name === 'firecrawl_scrape')).toBe(true);
    await expect(refresh).toBeEnabled();
    await expect(options).toBeFocused();
    expect(await options.evaluate(input => ({ start: input.selectionStart, end: input.selectionEnd }))).toEqual(selection);
    await expect(options).toHaveValue('{"prompt":');
    await expect(formats).toHaveValue('["markdown"]');
    await expect(url).toHaveText('https://example.invalid/feature-form-observation');
    expect(await urlNode.evaluate(element => element.isConnected)).toBe(true);
    expect(await optionsNode.evaluate(element => element.isConnected)).toBe(true);
    expect(pageErrors).toEqual([]);
    expect(consoleErrors.some(error => /maximum update depth|Minified React error #185/i.test(error))).toBe(false);
    expect(blockedTesterDispatches).toEqual([]);
    observations.elapsedMs = Date.now() - openedAt;
    observations.explicitRefreshPassedAtUtc = new Date().toISOString();
    await page.screenshot({ path: testInfo.outputPath('firecrawl-form-final.png'), fullPage: true });
  } finally {
    await testInfo.attach('firecrawl-form-observations', { body: JSON.stringify({ ...observations, pageErrors, consoleErrors,
      blockedTesterDispatches, environment: environment.snapshot() }, null, 2), contentType: 'application/json' });
  }
});
