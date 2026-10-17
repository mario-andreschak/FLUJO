#!/usr/bin/env node
// #1093 APP-1 source production qualification. Invoke through flujo-bash MCP.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { createSmokeOperator } from './smoke-bundled-operator.mjs';
import { createAppsFixture, unusedPort } from './mcp-apps-browser-fixture.mjs';

assert.equal(process.argv[2], '--production');
assert.ok(process.argv[3], 'Usage: smoke-mcp-apps-browser.mjs --production <evidence-directory>');
const application = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidence = path.resolve(process.argv[3]);
const buildId = (await fs.readFile(path.join(application, '.next/BUILD_ID'), 'utf8')).trim();
await fs.mkdir(evidence, { recursive: true });
for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) {
  try { await fs.access(path.join(application, name)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  throw new Error('Refuse candidate dotenv configuration');
}
const receipt = { schemaVersion: 1, startedUtc: new Date().toISOString(), buildId,
  externalProviderCalls: 0, groups: [], pageErrors: [], unexpectedRequests: [],
  limitations: ['Source production localhost profile with SDK reference servers; not installed/public deployment acceptance',
    'Default restrictive sandbox and per-server Apps opt-in; permissive settings and optional per-resource click policy are not qualified',
    'Automated Chromium browser observation, not independent human accessibility acceptance'] };
let operator, fixture, child, closed, browser, base, failure, serverLog = '';
const password = randomBytes(32).toString('hex');
async function api(endpoint, body, method = body === undefined ? 'GET' : 'POST') {
  const url = new URL(endpoint, base); url.searchParams.set('workspace', 'default-workspace');
  const response = await fetch(url, { method,
    headers: { authorization: `Bearer ${operator.token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000) });
  assert.ok(response.ok, `API ${endpoint}: ${response.status}`); return response.json();
}
async function view(page) {
  let found;
  await expect.poll(async () => {
    found = undefined;
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      if (await frame.evaluate(() => !!window.appReceipt).catch(() => false)) { found = frame; break; }
    }
    return found ? found.locator('#status').textContent().catch(() => '') : '';
  }, { timeout: 20_000 }).toBe('Ready');
  return found;
}
async function click(frame, key) {
  const control = frame.locator(`#${key}`);
  await control.hover();
  await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await control.click();
  await expect.poll(() => frame.evaluate(key => window.appReceipt.results[key] ?? null, key)).not.toBeNull();
  return frame.evaluate(key => window.appReceipt.results[key], key);
}
function rpcError(result) { return !!(result.error || result.result?.isError); }
try {
  operator = await createSmokeOperator(); fixture = await createAppsFixture();
  const root = path.dirname(operator.env.FLUJO_OWNER_AUTH_FILE);
  for (const name of ['data', 'home', 'temp']) await fs.mkdir(path.join(root, name));
  const port = await unusedPort(), sandboxPort = await unusedPort(); base = `http://127.0.0.1:${port}`;
  const safe = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(path|systemroot|windir|comspec|pathext|systemdrive)$/i.test(name)));
  const ready = new Promise((resolve, reject) => {
    child = fork(path.join(application, 'scripts/persona-browser-acceptance/next-process.cjs'), [String(port)], {
      cwd: application, windowsHide: true, silent: true,
      env: { ...safe, ...operator.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
        USERPROFILE: path.join(root, 'home'), TEMP: path.join(root, 'temp'), TMP: path.join(root, 'temp'),
        FLUJO_DATA_DIR: path.join(root, 'data'), FLUJO_RUNTIME_ENV_DIR: path.join(root, 'data'), FLUJO_APP_ROOT: application,
        FLUJO_TELEMETRY_URL: base + '/disabled-telemetry',
        FLUJO_BASE_URL: base, FLUJO_EXPOSURE_MODE: 'localhost', FLUJO_PORT: String(port),
        FLUJO_MCP_APP_SANDBOX_HOST: '127.0.0.1', FLUJO_MCP_APP_SANDBOX_PORT: String(sandboxPort) },
    });
    child.once('error', reject); child.once('exit', () => reject(new Error('App exited before readiness')));
    child.once('message', message => message?.type === 'journey-server-ready' && message.pid === child.pid ? resolve() : reject(new Error('Invalid readiness receipt')));
  });
  closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { serverLog = (serverLog + bytes).slice(-64_000); });
  await Promise.race([ready, delay(60_000, undefined, { ref: false }).then(() => { throw new Error('App readiness timeout'); })]);
  for (const action of ['initialize', 'authenticate']) assert.equal((await api('/api/encryption/secure', { action, password })).success, true);
  await api('/api/init');
  for (const config of await api('/api/mcp/servers')) await api(`/api/mcp/servers/${encodeURIComponent(config.name)}`, { disabled: true }, 'PUT');
  await api('/api/mcp/servers', { name: 'apps-other', transport: 'streamable', serverUrl: fixture.origin + '/other', disabled: false, enableMcpApps: true });
  browser = await chromium.launch({ headless: true,
    ...(process.env.FLUJO_ACCEPTANCE_BROWSER_EXECUTABLE ? { executablePath: process.env.FLUJO_ACCEPTANCE_BROWSER_EXECUTABLE } : {}) });
  receipt.browserVersion = browser.version();
  const sandboxOrigins = new Set();
  for (const generation of ['legacy', 'modern']) {
    const serverName = `apps-${generation}`;
    await api('/api/storage', { key: 'speech_settings', value: {
      experimental: { mcpBetaProtocol: generation === 'modern' }, onboarding: { completed: true }, telemetry: { enabled: false } } });
    await api('/api/mcp/servers', { name: serverName, transport: 'streamable', serverUrl: `${fixture.origin}/${generation}`, disabled: false, enableMcpApps: true });
    const context = await browser.newContext({ viewport: { width: generation === 'legacy' ? 1440 : 390, height: 900 }, locale: 'en-US', acceptDownloads: true });
    await context.route('**/*', route => {
      const url = new URL(route.request().url()), headers = { ...route.request().headers() };
      if (url.origin === base) headers.authorization = `Bearer ${operator.token}`;
      const allowed = url.origin === base || url.origin === fixture.origin || url.origin === fixture.deniedOrigin
        || fixture.state.runtimeOrigins.includes(url.origin)
        || (url.hostname.endsWith('.localhost') && url.port === String(sandboxPort)) || ['data:', 'blob:', 'about:'].includes(url.protocol);
      if (!allowed) { receipt.unexpectedRequests.push(url.origin + url.pathname); return route.abort(); }
      return route.continue({ headers });
    });
    const page = await context.newPage();
    const proxyPolicies = new Map();
    page.on('response', response => {
      const url = new URL(response.url());
      if (url.hostname.endsWith('.localhost') && url.port === String(sandboxPort) && url.searchParams.has('csp')) {
        proxyPolicies.set(url.origin, { requested: JSON.parse(url.searchParams.get('csp')),
          header: response.headers()['content-security-policy'] });
      }
    });
    page.on('pageerror', error => receipt.pageErrors.push(error.message));
    const open = async () => {
      const before = fixture.state.calls.length;
      await page.goto(`${base}/mcp?server=${serverName}&tool=open_view&appToken=${randomUUID()}`);
      await expect(page.getByRole('button', { name: 'Test tool', exact: true })).toBeVisible();
      assert.equal(fixture.state.calls.length, before, 'Opening the tester must not invoke its tool');
      await page.getByRole('button', { name: 'Test tool', exact: true }).click();
    };
    await open();
    let frame = await view(page);
    await expect.poll(() => frame.evaluate(() => window.appReceipt.events)).toContain('ui/notifications/tool-result');
    let mounted = await frame.evaluate(() => window.appReceipt);
    assert.equal(mounted.initialize.protocolVersion, '2026-01-26');
    assert.deepEqual(fixture.state.calls.filter(call => call.generation === generation).map(call => call.name), ['open_view']);
    const initializedAt = mounted.events.indexOf('view/initialized'), inputAt = mounted.events.indexOf('ui/notifications/tool-input');
    assert.ok(initializedAt >= 0 && inputAt > initializedAt && mounted.events.indexOf('ui/notifications/tool-result') > inputAt,
      'Host must wait for View initialization, then deliver input before the result');
    assert.equal(mounted.events.filter(method => method.includes('sandbox-')).length, 0, 'Reserved readiness messages must stay outside the View');
    const outer = frame.parentFrame(); assert.ok(outer && outer !== page.mainFrame());
    const sandboxOrigin = new URL(outer.url()).origin;
    assert.notEqual(sandboxOrigin, base); sandboxOrigins.add(sandboxOrigin);
    // Browser permission is independent from the App's declared CSP. Resolve
    // Chromium's local-network prompt for this owned sandbox origin only.
    await context.grantPermissions(['local-network-access'], { origin: sandboxOrigin });
    assert.equal(await frame.evaluate(() => { try { void top.document; return false; } catch { return true; } }), true, 'View cannot read the host DOM');
    const outerIframe = await outer.frameElement();
    assert.equal(await outerIframe.getAttribute('sandbox'), 'allow-scripts allow-same-origin');
    const allowed = await click(frame, 'allowed'); assert.equal(allowed.result.structuredContent.marker, 'allowed');
    const beforeDenied = fixture.state.calls.length;
    await frame.locator('#hidden').click();
    await expect.poll(() => frame.isDetached()).toBe(true);
    assert.equal(fixture.state.calls.length, beforeDenied, 'A forbidden App call must stop before downstream effects');
    await open(); frame = await view(page);
    const next = await frame.evaluate(() => window.appReceipt);
    assert.notEqual(next.mount, mounted.mount, 'The ordinary tool tester must recover with a fresh View');
    mounted = next;
    assert.ok(rpcError(await click(frame, 'foreign')), 'A foreign tool must be rejected on the bound server');
    assert.equal(fixture.state.calls.filter(call => call.generation === 'other').length, 0, 'The separately connected server must receive no call');
    assert.deepEqual(fixture.state.calls.filter(call => call.generation === generation).map(call => call.name), ['open_view', 'app_echo', 'open_view']);
    const resource = await click(frame, 'resource'); assert.equal(resource.result.contents[0].text, 'Actual server resource');
    const checkCsp = async (currentFrame) => {
      const result = await click(currentFrame, 'csp');
      assert.equal(result.allowed, 'Declared connection works'); assert.equal(result.blocked, true);
      if (result.retired) assert.equal(result.retiredBlocked, true);
      await expect.poll(() => currentFrame.evaluate(() => window.appReceipt.violations)).toEqual(expect.arrayContaining(['connect-src', 'frame-src', 'img-src']));
      await expect.poll(() => currentFrame.locator('#runtime-image').evaluate(image => image.naturalWidth)).toBe(1);
      await expect.poll(() => page.frames().some(candidate => candidate.url() === fixture.runtimeOrigin + '/frame')).toBe(true);
      const declared = page.frames().find(candidate => candidate.url() === fixture.runtimeOrigin + '/frame');
      await expect(declared.locator('body')).toHaveText('Declared runtime frame works');
      const granted = await currentFrame.evaluate(() => window.appReceipt.initialize.hostCapabilities.sandbox.csp);
      assert.deepEqual(granted.connectDomains, [fixture.origin, fixture.runtimeOrigin]);
      assert.deepEqual(granted.resourceDomains, [fixture.runtimeOrigin]);
      assert.deepEqual(granted.frameDomains, [fixture.runtimeOrigin]);
      // The proxy intentionally scrubs its query parameters from location.href.
      // Observe the actual response and the inner meta, rather than that URL.
      const applied = proxyPolicies.get(sandboxOrigin);
      assert.deepEqual(applied?.requested, granted, 'Initialized policy must equal the proxy request');
      const inner = await currentFrame.locator('meta[http-equiv="Content-Security-Policy"]').first().getAttribute('content');
      for (const policy of [applied.header, inner]) {
        assert.ok(policy.includes(`connect-src ${fixture.origin} ${fixture.runtimeOrigin};`));
        assert.ok(policy.includes(fixture.runtimeOrigin));
        assert.ok(!policy.includes(fixture.deniedOrigin));
        if (result.retired) assert.ok(!policy.includes(result.retired));
        assert.ok(!policy.includes(':*'));
      }
      assert.ok(!JSON.stringify(granted).includes(':*'));
    };
    await checkCsp(frame);
    assert.equal(fixture.state.deniedRequests, 0, 'Undeclared network/frame requests must never reach their listener');
    const restarts = [];
    for (const failFirstRead of [false, true]) {
      const previousMount = await frame.evaluate(() => window.appReceipt.mount);
      await frame.locator('#pending').click();
      await expect.poll(() => fixture.activeWaits.size).toBe(1);
      const cancellations = fixture.state.cancelledWaits;
      const ports = await fixture.restartRuntime();
      fixture.state.resourceUnavailable = failFirstRead;
      const callsBeforeReload = fixture.state.calls.length;
      const reload = page.getByRole('button', { name: 'Reload app', exact: true });
      await expect(reload).toBeEnabled();
      const controlSize = await reload.boundingBox(); assert.ok(controlSize.height >= 44);
      await reload.click();
      await expect.poll(() => frame.isDetached()).toBe(true);
      await expect.poll(() => fixture.state.cancelledWaits).toBe(cancellations + 1);
      let readFailureMessage;
      if (failFirstRead) {
        const error = page.getByRole('alert').last();
        await expect(error).toBeVisible();
        readFailureMessage = await error.innerText(); assert.ok(readFailureMessage.trim());
        await expect(reload).toBeEnabled();
        assert.equal(page.frames().filter(candidate => candidate !== page.mainFrame()).length, 0, 'Failed reload must retire the stale View');
        fixture.state.resourceUnavailable = false;
        await reload.click();
      }
      frame = await view(page);
      const currentMount = await frame.evaluate(() => window.appReceipt.mount);
      assert.notEqual(currentMount, previousMount);
      assert.equal(new URL(frame.parentFrame().url()).origin, sandboxOrigin, 'Restart must preserve the App identity');
      await expect.poll(() => fixture.state.observations.some(item => item.mount === previousMount && item.event === 'teardown')).toBe(true);
      assert.equal(fixture.state.calls.length, callsBeforeReload, 'Reload must not rerun any tool');
      await checkCsp(frame);
      assert.equal(fixture.state.retiredRequests, 0, 'Fresh policy must block the healthy listener reusing the old port');
      assert.equal(fixture.state.deniedRequests, 0);
      restarts.push({ ...ports, readFailureRecovered: failFirstRead, readFailureMessage, oldViewRetired: true, pendingToolCancelled: true, toolNotRerun: true, exactPolicy: true });
    }
    mounted = await frame.evaluate(() => window.appReceipt);
    await click(frame, 'reserved');
    assert.equal((await click(frame, 'allowed')).result.structuredContent.marker, 'allowed', 'Reserved injection must not replace the bridge');
    assert.ok(rpcError(await click(frame, 'unsafe'))); assert.equal(context.pages().length, 1);
    const popupPromise = context.waitForEvent('page');
    const safe = await click(frame, 'safe'); const popup = await popupPromise;
    await popup.waitForLoadState('domcontentloaded'); assert.equal(new URL(popup.url()).origin, fixture.origin);
    assert.equal(await popup.evaluate(() => window.opener), null); await popup.close();
    receipt.safeLinkObservation = { generation, response: safe, destinationOpened: true, openerNull: true };
    assert.equal(safe.error, undefined);
    assert.notEqual(safe.result?.isError, true, 'An opened safe link must not be reported as a failure');
    const downloadPromise = page.waitForEvent('download');
    const downloadResult = await click(frame, 'download'); const download = await downloadPromise;
    assert.equal(downloadResult.error, undefined); assert.equal(download.suggestedFilename(), 'acceptance.txt');
    let downloaded = ''; for await (const bytes of await download.createReadStream()) downloaded += bytes;
    assert.equal(downloaded, 'Apps browser acceptance');
    const dimensions = await page.evaluate(() => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth }));
    assert.ok(dimensions.scroll <= dimensions.viewport + 1, 'Host page must fit the phone viewport');
    const controls = await frame.locator('button').evaluateAll(buttons => buttons.map(button => ({ height: button.getBoundingClientRect().height, width: button.getBoundingClientRect().width })));
    assert.ok(controls.every(control => control.height >= 44 && control.width > 0));
    await page.screenshot({ path: path.join(evidence, `${generation}-apps.png`), fullPage: true, animations: 'disabled' });
    const beforeRevoke = fixture.state.calls.length, teardownStart = Date.now();
    await api(`/api/mcp/servers/${serverName}`, { enableMcpApps: false }, 'PUT');
    await frame.locator('#allowed').click();
    await expect.poll(() => frame.isDetached()).toBe(true);
    assert.equal(fixture.state.calls.length, beforeRevoke, 'Revoked bridge calls must stop before server effects');
    await expect.poll(() => fixture.state.observations.some(item => item.mount === mounted.mount && item.event === 'teardown')).toBe(true);
    const teardownMs = Date.now() - teardownStart; assert.ok(teardownMs < 10_000);
    await api(`/api/mcp/servers/${serverName}`, { enableMcpApps: true }, 'PUT');
    await open(); frame = await view(page);
    const remounted = await frame.evaluate(() => window.appReceipt);
    assert.notEqual(remounted.mount, mounted.mount); assert.equal(new URL(frame.parentFrame().url()).origin, sandboxOrigin);
    assert.equal((await click(frame, 'allowed')).result.structuredContent.marker, 'allowed');
    await frame.locator('#pending').click();
    await expect.poll(() => fixture.activeWaits.size).toBe(1);
    const cancelledBefore = fixture.state.cancelledWaits;
    await page.getByRole('button', { name: 'Close', exact: true }).last().click();
    await expect.poll(() => frame.isDetached()).toBe(true);
    await expect.poll(() => fixture.state.cancelledWaits).toBe(cancelledBefore + 1);
    assert.equal(fixture.activeWaits.size, 0);
    await context.close();
    await api(`/api/mcp/servers/${serverName}`, { disabled: true }, 'PUT');
    receipt.groups.push({ generation, viewport: dimensions.viewport, sandboxOriginDistinct: true, initializedWithoutToolEffects: true,
      sameServerAppTool: true, modelOnlyAndForeignRefused: true, forbiddenViewRetiredAndRetryFresh: true, foreignErrorRecoverable: true, resourceRead: true, cspBlockedBeforeNetwork: true,
      reservedMessageRefused: true, unsafeLinkRefused: true, safeLink: safe, popupOpenerNull: true, downloadContentsVerified: true,
      consentRevokedBeforeEffects: true, remountFreshBridge: true, gracefulTeardownMs: teardownMs, pendingToolCancelled: true });
    receipt.groups.at(-1).exactPortRestarts = restarts;
    console.log(JSON.stringify({ appsGroup: receipt.groups.at(-1) }));
  }
  assert.equal(sandboxOrigins.size, 2, 'Different server identities must receive different sandbox origins');
  await api('/api/mcp/servers/apps-other', { disabled: true }, 'PUT');
  assert.deepEqual(receipt.pageErrors, []); assert.deepEqual(receipt.unexpectedRequests, []);
} catch (error) {
  failure = error;
  try {
    const page = browser?.contexts()[0]?.pages()[0];
    if (page) {
      receipt.failureText = await page.locator('body').innerText();
      receipt.viewDiagnostics = [];
      for (const frame of page.frames()) {
        const state = await frame.evaluate(() => window.appReceipt ?? null).catch(() => null);
        if (state) receipt.viewDiagnostics.push(state);
      }
      await page.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true });
    }
  } catch { /* Retain the original failure. */ }
  receipt.error = String(error.stack ?? error);
} finally {
  const errors = [];
  try { await browser?.close(); receipt.browserClosed = true; } catch (error) { errors.push(error); }
  if (child?.connected && child.exitCode === null && child.signalCode === null) child.send('stop');
  if (closed) try {
    const exit = await Promise.race([closed, delay(20_000, undefined, { ref: false }).then(() => { throw new Error('App closure timeout; private profile retained'); })]);
    assert.ok(exit.code === 0 || exit.code === 143 || exit.signal === 'SIGTERM'); receipt.appClosed = true;
  } catch (error) { errors.push(error); }
  try { await fixture?.close(); receipt.referenceServersClosed = true; } catch (error) { errors.push(error); }
  receipt.referenceState = fixture?.state;
  if (operator && receipt.appClosed) try { await operator.restore(); receipt.privateProfileRemoved = true; } catch (error) { errors.push(error); }
  for (const secret of [password, operator?.token]) if (secret) {
    serverLog = serverLog.split(secret).join('[redacted]');
    if (receipt.error) receipt.error = receipt.error.split(secret).join('[redacted]');
  }
  await fs.writeFile(path.join(evidence, 'application.log'), serverLog);
  receipt.cleanupErrors = errors.map(error => String(error));
  receipt.success = !failure && errors.length === 0;
  receipt.finishedUtc = new Date().toISOString(); receipt.node = process.version; receipt.platform = process.platform;
  await fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ appsReceipt: receipt }));
  if (!receipt.success) process.exitCode = 1;
}
