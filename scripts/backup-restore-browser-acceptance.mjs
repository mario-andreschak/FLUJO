// Focused source-build acceptance for #570. Run through flujo-bash so every
// owned cleanup (including helper cleanup) follows the project's tool rule.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { createSmokeOperator } from './smoke-bundled-operator.mjs';

const root = process.cwd();
const evidence = path.resolve(process.argv[2] ?? 'backup-restore-evidence');
const require = createRequire(import.meta.url);
const { chromium, expect } = require('@playwright/test');
const JSZip = require('jszip');
await fs.mkdir(evidence, { recursive: true });
const operator = await createSmokeOperator();
const ownedRoot = path.dirname(operator.env.FLUJO_OWNER_AUTH_FILE);
const receipt = { startedAtUTC: new Date().toISOString(),
  node: process.version, checks: [], pageErrors: [], providerRequests: 0 };
let child, closed, browser, portServer, base, serverLog = '', failure;
const headers = { authorization: `Bearer ${operator.token}` };
const check = name => { receipt.checks.push(name); console.log(`Passed: ${name}`); };
const api = (route, body) => fetch(base + route, { headers: { ...headers, 'content-type': 'application/json' },
  ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
async function json(route, body) {
  const response = await api(route, body);
  assert.equal(response.status, 200, route);
  return response.json();
}
async function archive(entries, metadata = {}) {
  const zip = new JSZip();
  zip.file('backup-info.json', JSON.stringify({ version: '1.0', ...metadata }));
  for (const [name, value] of Object.entries(entries)) zip.file(name, JSON.stringify(value));
  return zip.generateAsync({ type: 'nodebuffer' });
}
async function restore(buffer, selections, extraHeaders = headers) {
  const form = new FormData();
  form.append('file', new File([buffer], 'restore.zip', { type: 'application/zip' }));
  form.append('selections', JSON.stringify(selections));
  return fetch(base + '/api/restore', { method: 'POST', headers: extraHeaders, body: form, signal: AbortSignal.timeout(20000) });
}
try {
  // Every operation after creating the private operator belongs to this cleanup scope.
  const data = path.join(ownedRoot, 'data');
  const secret = path.join(ownedRoot, 'operator-secret');
  await fs.mkdir(data);
  await fs.writeFile(secret, randomBytes(32).toString('base64url'), { flag: 'wx', mode: 0o600 });
  portServer = net.createServer();
  await new Promise((resolve, reject) => {
    portServer.once('error', reject);
    portServer.listen(0, '127.0.0.1', resolve);
  });
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  base = `http://127.0.0.1:${port}`;
  const env = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LOCALAPPDATA']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  Object.assign(env, operator.env, { FLUJO_ENCRYPTION_SECRET_FILE: secret, FLUJO_DATA_DIR: data,
    FLUJO_APP_ROOT: root, FLUJO_BASE_URL: base, FLUJO_PORT: String(port), FLUJO_EXPOSURE_MODE: 'localhost',
    NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' });
  receipt.buildId = (await fs.readFile('.next/BUILD_ID', 'utf8')).trim();
  receipt.applicationInputs = Object.fromEntries(await Promise.all([
    'src/app/api/restore/route.ts', 'src/backend/services/workspace/backupRestoreFs.ts',
    'src/frontend/components/Settings/BackupSettings.tsx', 'src/frontend/i18n/catalogs/settings.ts',
    'src/shared/types/backup.ts',
  ].map(async file => [file, createHash('sha256').update(await fs.readFile(file)).digest('hex')])));
  const ready = new Promise((resolve, reject) => {
    child = fork(path.join(root, 'scripts/persona-browser-acceptance/next-process.cjs'), [String(port)], {
      cwd: root, env, silent: true, windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Owned server exited before readiness: ${code}`)));
    child.once('message', message => message?.type === 'journey-server-ready' && message.pid === child.pid
      ? resolve() : reject(new Error('Invalid owned-server readiness receipt')));
  });
  closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  child.stdout.on('data', bytes => { serverLog = (serverLog + bytes).slice(-100000); });
  child.stderr.on('data', bytes => { serverLog = (serverLog + bytes).slice(-100000); });
  receipt.appPid = child.pid;
  await Promise.race([ready, delay(60000, undefined, { ref: false }).then(() => { throw new Error('Owned server startup timeout'); })]);
  const password = randomBytes(32).toString('base64url');
  for (const action of ['initialize', 'authenticate']) {
    assert.equal((await json('/api/encryption/secure', { action, password })).success, true);
  }
  await json('/api/init');
  const servers = await json('/api/storage?key=mcp_servers');
  await json('/api/storage', { key: 'mcp_servers', value: Object.fromEntries(
    Object.entries(servers.value ?? {}).map(([key, value]) => [key, { ...value, disabled: true }])) });
  const settings = await json('/api/storage?key=speech_settings');
  await json('/api/storage', { key: 'speech_settings', value: { ...settings.value,
    telemetry: { enabled: false, notifyDaily: false }, onboarding: { completed: true } } });
  const workspace = path.join(data, 'workspaces', 'default-workspace');
  const db = path.join(workspace, 'db');
  const blocked = path.join(db, 'models.json');
  let originalModelFile = false;
  try { await fs.rename(blocked, blocked + '.held'); originalModelFile = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.mkdir(blocked);
  const modelZip = await archive({ 'storage/models.json': [] });
  const denied = await restore(modelZip, ['models'], {});
  assert.ok([401, 403].includes(denied.status));
  check('Unauthenticated restore refused');
  const failed = await restore(modelZip, ['models']);
  assert.equal(failed.status, 500);
  assert.deepEqual((await failed.json()).selectionResults.models, { restored: 0, failed: 1 });
  check('Actual non-file storage target reports failed write');
  const partial = await restore(await archive({ 'storage/models.json': [], 'storage/theme.json': 'dark' }), ['models', 'settings']);
  assert.equal(partial.status, 200);
  assert.equal((await partial.json()).status, 'partial');
  assert.equal((await json('/api/storage?key=theme')).value, 'dark');
  check('Actual partial restore preserves successful writes');
  const empty = await restore(await archive({}), ['models']);
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).status, 'empty');
  check('Metadata-only archive is not reported restored');
  browser = await chromium.launch({ headless: true,
    ...(process.env.FLUJO_ACCEPTANCE_BROWSER_EXECUTABLE
      ? { executablePath: process.env.FLUJO_ACCEPTANCE_BROWSER_EXECUTABLE } : {}),
  });
  receipt.browserVersion = browser.version();
  for (const locale of ['en', 'es']) {
    const width = locale === 'en' ? 1120 : 320;
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: locale === 'en' ? 'en-US' : 'es-CO',
      extraHTTPHeaders: headers });
    await context.addInitScript(value => localStorage.setItem('flujo.locale', value), locale);
    const page = await context.newPage();
    page.on('pageerror', error => receipt.pageErrors.push(error.message));
    await page.goto(base + '/settings');
    if (width > 600) await page.locator('#settings-nav-backup').click();
    else {
      await page.getByRole('combobox').click();
      await page.getByRole('option').filter({ hasText: /copia|backup/i }).click();
    }
    const upload = page.getByLabel(locale === 'en' ? 'Select backup file' : 'Seleccionar archivo de copia', { exact: true });
    const restoreName = locale === 'en' ? 'Restore from backup' : 'Restaurar desde una copia';
    const restoreButton = page.getByRole('button', { name: restoreName, exact: true });
    const restorePaper = restoreButton.locator('xpath=..');
    for (const checkbox of await restorePaper.locator('input[type="checkbox"]').all()) await checkbox.uncheck();
    await restorePaper.locator('input[name="models"]').check();
    const fileName = 'a-long-backup-file-name-that-must-wrap-on-a-phone-without-hiding-the-restore-control.zip';
    await upload.setInputFiles({ name: fileName, mimeType: 'application/zip', buffer: modelZip });
    const submit = async () => {
      await restoreButton.click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toHaveAccessibleName(locale === 'en' ? /confirm restore/i : /confirmar restauración/i);
      await dialog.getByRole('button', { name: locale === 'en' ? 'Restore' : 'Restaurar', exact: true }).click();
    };
    await submit();
    const alert = restorePaper.getByRole('alert');
    await expect(alert).toContainText(locale === 'en' ? 'Restore failed' : 'La restauración falló');
    await expect(alert).toBeFocused();
    await expect(restorePaper.getByText(fileName, { exact: false })).toBeVisible();
    assert.equal(await upload.evaluate(input => input.files.length), 1);
    const bounds = await restoreButton.boundingBox();
    assert.ok(bounds.height >= 44 && bounds.x >= 0 && bounds.x + bounds.width <= width);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: path.join(evidence, `restore-failed-${locale}-${width}.png`) });
    check(`${locale} ${width}px: visible focused failure, retained upload, large control and fit`);
    await fs.rmdir(blocked); // Owned empty obstruction; operation runs via flujo-bash.
    await submit();
    await expect(restorePaper.getByRole('status')).toContainText(locale === 'en' ? 'Restore completed successfully' : 'La restauración se completó');
    assert.equal(await upload.evaluate(input => input.files.length), 0);
    assert.deepEqual(JSON.parse(await fs.readFile(blocked, 'utf8')), []);
    check(`${locale} ${width}px: actual file retry succeeds and clears upload`);
    await fs.unlink(blocked);
    await fs.mkdir(blocked);
    await context.close();
  }
  assert.deepEqual(receipt.pageErrors, []);
  await fs.rmdir(blocked);
  if (originalModelFile) await fs.rename(blocked + '.held', blocked);
} catch (error) {
  failure = error;
  receipt.failure = error.message;
} finally {
  const cleanupErrors = [];
  try { await browser?.close(); } catch (error) { cleanupErrors.push(error); }
  if (portServer?.listening) await new Promise(resolve => portServer.close(resolve));
  let serverStopped = !child || child.exitCode !== null || child.signalCode !== null;
  try {
    if (child?.connected && !serverStopped) child.send('stop');
    if (closed) {
      try {
        receipt.exit = await Promise.race([closed, delay(15000, undefined, { ref: false })
          .then(() => { throw new Error('Owned server graceful shutdown timeout'); })]);
      } catch (error) {
        cleanupErrors.push(error);
        child.kill('SIGKILL');
        receipt.exit = await Promise.race([closed, delay(5000, undefined, { ref: false })
          .then(() => { throw new Error('Owned server forced shutdown timeout'); })]);
      }
      serverStopped = true;
      assert.ok([0, 143].includes(receipt.exit.code) || receipt.exit.signal === 'SIGTERM');
    }
  } catch (error) { cleanupErrors.push(error); }
  if (serverStopped) {
    try { await operator.restore(); } catch (error) { cleanupErrors.push(error); }
  } else {
    cleanupErrors.push(new Error(`Owned fixture retained while server PID ${child.pid} is still running`));
  }
  receipt.cleanupVerified = await fs.stat(ownedRoot).then(() => false, error => {
    if (error.code === 'ENOENT') return true;
    cleanupErrors.push(error);
    return false;
  });
  if (cleanupErrors.length) {
    receipt.cleanupErrors = cleanupErrors.map(error => error.message);
    failure ??= new AggregateError(cleanupErrors, 'Owned acceptance cleanup failed');
  }
  if (failure) receipt.failure = failure.message;
  receipt.endedAtUTC = new Date().toISOString();
  await fs.writeFile(path.join(evidence, 'server.log'), serverLog.replaceAll(operator.token, '[redacted]'), { mode: 0o600 });
  await fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2));
}
if (failure) throw failure;
console.log(JSON.stringify({ passed: receipt.checks.length, cleanupVerified: receipt.cleanupVerified, evidence }));
