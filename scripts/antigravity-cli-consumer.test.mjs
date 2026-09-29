import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertPackagedBinary } from './antigravity-cli-test-utils.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

async function runNpm(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(npm, args, {
      cwd, shell: process.platform === 'win32', windowsHide: true,
      env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false',
        npm_config_update_notifier: 'false', FLUJO_SKIP_PATCHRIGHT_DOWNLOAD: '1',
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1', AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-4 * 1024 * 1024); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
    const timer = setTimeout(() => { child.kill(); }, 8 * 60_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error('Packed consumer npm command failed (' + code + '): ' + stderr));
    });
  });
}

test('a packed production consumer installs and executes its own verified Antigravity runtime', { timeout: 600_000 }, async () => {
  await access(path.join(root, '.next', 'BUILD_ID'));
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'flujo-antigravity-consumer-'));
  const tarballs = path.join(sandbox, 'tarballs');
  const consumer = path.join(sandbox, 'consumer');
  await mkdir(tarballs);
  await mkdir(consumer);
  try {
    const packed = JSON.parse(await runNpm(['pack', '--json', '--ignore-scripts', '--pack-destination', tarballs, '.'], root))[0];
    const files = packed.files.map(entry => entry.path.replaceAll('\\', '/'));
    for (const required of ['package.json', 'index.cjs', 'install.cjs', 'bin.cjs', 'artifacts.json']) {
      assert.ok(files.includes('packages/antigravity-cli/' + required), 'Root tarball omitted ' + required);
    }
    assert.ok(!files.some(file => file.startsWith('packages/antigravity-cli/.cache/')), 'Published package contains a host native cache');
    const packages = [path.join(tarballs, packed.filename)];
    for (const name of ['filesystem', 'bash', 'browser', 'flujo']) {
      const result = JSON.parse(await runNpm(['pack', '--json', '--ignore-scripts', '--pack-destination', tarballs, './mcp-servers/' + name], root))[0];
      packages.push(path.join(tarballs, result.filename));
    }
    await writeFile(path.join(consumer, 'package.json'), '{"private":true}\n');
    await runNpm(['install', '--omit=dev', '--prefer-offline', '--no-audit', '--no-fund', '--package-lock=false', ...packages], consumer);
    const manifest = path.join(consumer, 'node_modules', 'flujo-ai', 'package.json');
    const installed = JSON.parse(await readFile(manifest, 'utf8'));
    assert.equal(installed.dependencies['@flujo-ai/antigravity-cli'], 'file:packages/antigravity-cli');
    assert.equal(installed.bin['flujo-agy'], 'packages/antigravity-cli/bin.cjs');
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
