import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { createFeatureBrowserEnvironment } from '../../scripts/feature-first-use-browser-acceptance/browser-environment.mjs';

let environment;
const toolNames = Array.from({ length: 128 }, (_, index) => `fixture_tool_${String(index + 1).padStart(3, '0')}`);

test.beforeEach(async () => {
  environment = await createFeatureBrowserEnvironment({
    applicationRoot: process.env.FEATURE_BROWSER_APP_DIR, initialConnections: 'ui',
  });
});
test.afterEach(async ({}, testInfo) => {
  if (!environment) return;
  try { await environment.verifyServerSelection(); }
  finally {
    try { await environment.close(); }
    finally {
      await testInfo.attach('final-owned-environment', {
        body: JSON.stringify(environment.snapshot(), null, 2), contentType: 'application/json',
      });
      environment = undefined;
    }
  }
});

for (const [transport, title, endpoint] of [
  ['streamable', 'Streamable HTTP', '/mcp'], ['sse', 'SSE', '/sse'],
]) {
  test(`connects, tests and saves ${title} through the UI before inspecting tool128`, async ({ page, browser }, testInfo) => {
    const name = `UI ${title} fixture`;
    const url = `${environment.fixture.url}${endpoint}`;
    const errors = [];
    const browserNetworkViolations = [];
    const allowedOrigins = new Set([environment.baseURL, environment.fixture.url,
      `http://127.0.0.1:${environment.sandboxPort}`].map(value => new URL(value).origin));
    await page.route('**/*', async route => {
      const request = new URL(route.request().url());
      if (['http:', 'https:'].includes(request.protocol) && !allowedOrigins.has(request.origin)) {
        if (browserNetworkViolations.length < 64) browserNetworkViolations.push({ origin: request.origin, path: request.pathname });
        await route.abort('blockedbyclient');
      } else await route.continue();
    });
    page.on('pageerror', error => errors.push(error.message));
    const observations = {
      scope: 'automated UI-created synthetic MCP connection and explicit echo; not a real-model/human journey',
      declaredSourceSha: process.env.FEATURE_BROWSER_SOURCE_SHA ?? null,
      humanReview: 'not_evaluated', realModelAgent: 'not_evaluated',
      runtime: { platform: os.platform(), release: os.release(), architecture: os.arch(),
        browserVersion: browser.version(), project: testInfo.project.name, viewport: page.viewportSize() },
      steps: [],
    };
    const record = step => observations.steps.push({ step, completedAt: new Date().toISOString(),
      receipt: environment.fixture.state.snapshot() });
    try {
      expect(environment.snapshot().initialConnections).toBe('ui');
      const initialConfigs = await environment.request('/api/mcp/servers');
      expect(initialConfigs.filter(config => config.disabled !== true)).toEqual([]);
      expect(initialConfigs.some(config => config.name.startsWith('UI '))).toBe(false);
      expect(environment.fixture.state.snapshot().toolCalls).toBe(0);
      record('no selected fixture was seeded');

      await page.goto(`${environment.baseURL}/mcp`);
      await page.getByRole('button', { name: 'Connect App', exact: true }).click();
      await page.getByRole('button', { name: /^I have connection details/ }).click();
      await page.getByRole('button', { name: /^At a remote URL/ }).click();
      const remote = page.getByRole('dialog');
      const remoteUrl = remote.getByRole('textbox', { name: 'Server URL', exact: true });
      await remote.getByText('Server URL', { exact: true }).click();
      await expect(remoteUrl).toBeFocused();
      await remoteUrl.fill(url);
      // Local test endpoints use the supported manual route, preserving the
      // public-HTTPS-only automatic OAuth preview boundary.
      await remote.getByRole('button', { name: 'Configure manually', exact: true }).click();
      const configure = page.getByRole('dialog');
      const serverName = configure.getByRole('textbox', { name: 'Server name', exact: true });
      await configure.getByText('Server name', { exact: true }).click();
      await expect(serverName).toBeFocused();
      await serverName.fill(name);
      await configure.getByRole('tab', { name: title, exact: true }).click();
      const serverUrl = configure.getByRole('textbox', { name: 'Server URL', exact: true });
      await expect(serverUrl).toHaveValue(url);
      expect(environment.fixture.state.snapshot().toolCalls).toBe(0);
      record('connection details entered through associated labels; no tool call');

      const testRun = configure.getByRole('button', { name: '3) Test run', exact: true });
      await testRun.click();
      await expect(configure.getByRole('alert').filter({ hasText: 'Connection test passed. The server is reachable.' }))
        .toHaveText('Connection test passed. The server is reachable.');
      await expect(configure.getByText('Connection result: MCP handshake successful.', { exact: false })).toBeVisible();
      await expect(configure.getByText('Tools discovered: 128.', { exact: false })).toBeVisible();
      await expect.poll(() => environment.fixture.state.snapshot().listRequests).toBeGreaterThan(0);
      await expect(testRun).toBeEnabled();
      expect(environment.fixture.state.snapshot().toolCalls).toBe(0);
      record('actual connection handshake passed without a tool invocation');
      expect((await environment.request('/api/mcp/servers')).some(config => config.name === name)).toBe(false);
      // The manual handoff supplies a prefilled draft without an update callback;
      // saving creates its first persisted configuration.
      await configure.getByRole('button', { name: 'Add server', exact: true }).click();
      await expect(configure).not.toBeVisible();
      await expect.poll(async () => (await environment.request('/api/mcp/servers'))
        .some(config => config.name === name && config.disabled !== true)).toBe(true);
      await environment.verifyServerSelection([name]);
      const saved = (await environment.request('/api/mcp/servers')).find(config => config.name === name);
      expect(saved).toMatchObject({ name, transport, serverUrl: url });
      record('UI saved the intended enabled connection and transport');

      await page.reload();
      await environment.verifyServerSelection([name]);
      const guide = page.getByRole('button', { name: 'Your first AI + app agent', exact: true });
      if (await guide.getAttribute('aria-expanded') !== 'true') await guide.click();
      await page.getByRole('combobox', { name: /^Saved app to inspect(?: |$)/ }).click();
      await page.getByRole('option', { name, exact: true }).click();
      await page.getByRole('button', { name: 'Inspect and test tools', exact: true }).click();
      const selector = page.getByRole('combobox', { name: /^Select tool(?: |$)/ });
      await selector.click();
      const options = page.getByRole('option');
      await expect(options).toHaveCount(129);
      expect((await options.allTextContents()).slice(1)).toEqual(toolNames);
      await page.getByRole('listbox').press('End');
      await page.keyboard.press('Enter');
      await expect(selector).toHaveText('fixture_tool_128');
      expect(environment.fixture.state.snapshot().toolCalls).toBe(0);
      record('saved connection survived reload; all128 tools present; last tool reached by keyboard');

      await page.getByRole('textbox', { name: 'element *', exact: true }).fill('UI connection receipt');
      await page.getByRole('textbox', { name: 'ref *', exact: true }).fill('ui-marker');
      const enabled = page.getByRole('checkbox', { name: 'enabled', exact: true });
      await enabled.check();
      await enabled.uncheck();
      expect(environment.fixture.state.snapshot().toolCalls).toBe(0);
      await page.getByRole('button', { name: 'Test tool', exact: true }).click();
      await expect.poll(() => environment.fixture.state.snapshot().acceptedCalls).toBe(1);
      const expectedArgs = { element: 'UI connection receipt', ref: 'ui-marker', enabled: false };
      const receipt = environment.fixture.state.snapshot().recentCalls.at(-1);
      expect(receipt.toolName).toBe('fixture_tool_128');
      expect(receipt.argumentsSha256).toBe(createHash('sha256').update(JSON.stringify(expectedArgs)).digest('hex'));
      expect(environment.fixture.state.snapshot().toolCalls).toBe(1);
      await expect(page.getByText('UI connection receipt', { exact: false }).first()).toBeVisible();
      expect(errors).toEqual([]);
      expect(browserNetworkViolations).toEqual([]);
      record('one explicit echo with matching argument digest; no page errors');
      await page.screenshot({ path: testInfo.outputPath('ui-created-connection.png'), fullPage: true });
    } finally {
      await testInfo.attach('ui-connection-observations', {
        body: JSON.stringify({ ...observations, pageErrors: errors, browserNetworkViolations,
          environment: environment.snapshot() }, null, 2),
        contentType: 'application/json',
      });
    }
  });
}
