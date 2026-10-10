import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { assertPackagedBinary } from './antigravity-cli-test-utils.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const PACK_TIMEOUT_MS = 2 * 60_000;
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const TEST_TIMEOUT_MS = 20 * 60_000;
const CLEANUP_RESERVE_MS = 90_000;

function terminateOwnedNpmTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      shell: false, windowsHide: true, stdio: 'ignore',
    });
    killer.once('error', () => child.kill());
    killer.once('close', code => { if (code !== 0 && child.exitCode === null) child.kill(); });
    return;
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); }
  const escalation = setTimeout(() => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }, 5_000);
  escalation.unref();
  child.once('close', () => clearTimeout(escalation));
}

async function runNpm(phase, args, cwd, phaseTimeoutMs, deadlineAt) {
  const remainingMs = deadlineAt - Date.now();
  assert.ok(remainingMs > 0, `Packed consumer ${phase}: overall npm budget exhausted before the phase started.`);
  const timeoutMs = Math.min(phaseTimeoutMs, remainingMs);
  const startedAt = Date.now();
  console.log(`Packed consumer ${phase}: starting (phase limit ${phaseTimeoutMs}ms; allowed ${timeoutMs}ms).`);
  return new Promise((resolve, reject) => {
    const child = spawn(npm, args, {
      cwd, shell: process.platform === 'win32', windowsHide: true,
      detached: process.platform !== 'win32',
      env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false',
        npm_config_update_notifier: 'false', FLUJO_SKIP_PATCHRIGHT_DOWNLOAD: '1',
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1', AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;
    child.stdout.on('data', chunk => { stdoutBytes += chunk.length; stdout = (stdout + chunk).slice(-4 * 1024 * 1024); });
    child.stderr.on('data', chunk => { stderrBytes += chunk.length; stderr = (stderr + chunk).slice(-8192); });
    const receipt = (reason) => new Error(
      `Packed consumer ${phase} ${reason}; elapsed ${Date.now() - startedAt}ms, `
      + `allowed ${timeoutMs}ms (phase limit ${phaseTimeoutMs}ms), stdout ${stdoutBytes} bytes, stderr ${stderrBytes} bytes.\n`
      + `stdout tail: ${stdout.slice(-8192)}\nstderr tail: ${stderr}`,
    );
    const heartbeat = setInterval(() => {
      console.log(`Packed consumer ${phase}: ${Math.round((Date.now() - startedAt) / 1000)}s elapsed; `
        + `${stdoutBytes} stdout bytes, ${stderrBytes} stderr bytes.`);
    }, 60_000);
    const timer = setTimeout(() => {
      timedOut = true;
      terminateOwnedNpmTree(child);
    }, timeoutMs);
    const shutdownTimer = setTimeout(() => {
      if (!timedOut) return;
      child.kill('SIGKILL');
      settle(receipt('timed out and its owned process tree did not close within 15s'));
    }, timeoutMs + 15_000);
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(shutdownTimer);
      clearInterval(heartbeat);
      if (error) reject(error);
      else resolve(value);
    };
    child.once('error', error => settle(receipt(`failed to start: ${error.message}`)));
    child.once('close', (code, signal) => {
      if (settled) return;
      if (code === 0 && !timedOut) {
        console.log(`Packed consumer ${phase}: completed in ${Date.now() - startedAt}ms.`);
        settle(undefined, stdout);
      } else settle(receipt(timedOut ? 'timed out' : `exited with code ${code}, signal ${signal}`));
    });
  });
}

test('a packed production consumer installs and executes its own verified Antigravity runtime', { timeout: TEST_TIMEOUT_MS }, async () => {
  await access(path.join(root, '.next', 'BUILD_ID'));
  const deadlineAt = Date.now() + TEST_TIMEOUT_MS - CLEANUP_RESERVE_MS;
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'flujo-antigravity-consumer-'));
  const tarballs = path.join(sandbox, 'tarballs');
  const consumer = path.join(sandbox, 'consumer');
  await mkdir(tarballs);
  await mkdir(consumer);
  try {
    const packed = JSON.parse(await runNpm('root pack', ['pack', '--json', '--ignore-scripts', '--pack-destination', tarballs, '.'], root, PACK_TIMEOUT_MS, deadlineAt))[0];
    const files = packed.files.map(entry => entry.path.replaceAll('\\', '/'));
    assert.ok(files.includes('packages/avatar-sdk/flujo-ai-avatar-sdk-0.1.0.tgz'), 'Root tarball omitted the pinned Avatar SDK');
    assert.ok(files.includes('packages/avatar-sdk/package.json'), 'Root tarball omitted the SDK directory');
    for (const required of ['package.json', 'index.cjs', 'install.cjs', 'bin.cjs', 'artifacts.json']) {
      assert.ok(files.includes('packages/antigravity-cli/' + required), 'Root tarball omitted ' + required);
    }
    assert.ok(!files.some(file => file.startsWith('packages/antigravity-cli/.cache/')), 'Published package contains a host native cache');
    const packages = [path.join(tarballs, packed.filename)];
    for (const name of ['filesystem', 'bash', 'browser', 'flujo']) {
      const result = JSON.parse(await runNpm(`${name} pack`, ['pack', '--json', '--ignore-scripts', '--pack-destination', tarballs, './mcp-servers/' + name], root, PACK_TIMEOUT_MS, deadlineAt))[0];
      packages.push(path.join(tarballs, result.filename));
    }
    await writeFile(path.join(consumer, 'package.json'), '{"private":true}\n');
    await runNpm('production install', ['install', '--omit=dev', '--prefer-offline', '--no-audit', '--no-fund', '--package-lock=false', ...packages], consumer, INSTALL_TIMEOUT_MS, deadlineAt);
    const manifest = path.join(consumer, 'node_modules', 'flujo-ai', 'package.json');
    const installed = JSON.parse(await readFile(manifest, 'utf8'));
    assert.equal(installed.dependencies['@flujo-ai/antigravity-cli'], 'file:packages/antigravity-cli');
    assert.equal(installed.bin['flujo-agy'], 'packages/antigravity-cli/bin.cjs');
    const sdk = JSON.parse(await readFile(createRequire(manifest).resolve('@flujo-ai/avatar-sdk/package.json'), 'utf8'));
    assert.equal(sdk.name, '@flujo-ai/avatar-sdk');
    assert.equal(sdk.version, '0.1.0');
    const result = assertPackagedBinary(manifest);
    const relative = path.relative(consumer, result.binary);
    assert.ok(relative && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), 'Consumer resolved the source checkout binary');
    await assert.rejects(access(path.join(consumer, 'node_modules', 'typescript')), 'Production consumer installed root dev dependencies');
  } finally {
    assert.equal(path.dirname(sandbox), path.resolve(os.tmpdir()));
    assert.ok(path.basename(sandbox).startsWith('flujo-antigravity-consumer-'));
    await rm(sandbox, { recursive: true, force: true });
  }
});
