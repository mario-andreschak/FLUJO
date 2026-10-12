import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
test('a packed parent installs its pinned SDK without resolving a parent-local archive', async () => {
  const parent = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(parent.dependencies['@flujo-ai/avatar-sdk'], 'file:packages/avatar-sdk');
  const sandbox = await mkdtemp(join(tmpdir(), 'flujo-avatar-directory-'));
  const fixture = join(sandbox, 'fixture'), consumer = join(sandbox, 'consumer');
  const env = {};
  for (const key of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA']) if (process.env[key]) env[key] = process.env[key];
  let npmCli = process.env.npm_execpath;
  if (!npmCli) {
    const command = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [process.platform === 'win32' ? 'npm.cmd' : 'npm'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
    npmCli = process.platform === 'win32' ? resolve(dirname(command), 'node_modules/npm/bin/npm-cli.js') : realpathSync(command);
  }
  const config = join(sandbox, 'empty.npmrc');
  const run = (args, cwd) => execFileSync(process.execPath, [npmCli, ...args, '--userconfig', config], { cwd, env, encoding: 'utf8', windowsHide: true });
  try {
    await mkdir(join(fixture, 'packages'), { recursive: true });
    await mkdir(consumer);
    await cp(join(root, 'packages/avatar-sdk'), join(fixture, 'packages/avatar-sdk'), { recursive: true });
    await rm(join(fixture, 'packages/avatar-sdk/flujo-ai-avatar-sdk-0.1.0.tgz'));
    await writeFile(join(fixture, 'package.json'), JSON.stringify({ name: 'avatar-parent-fixture', version: '0.0.0',
      dependencies: { '@flujo-ai/avatar-sdk': parent.dependencies['@flujo-ai/avatar-sdk'] },
      files: ['packages/avatar-sdk/**'] }));
    await writeFile(join(consumer, 'package.json'), '{"private":true}');
    await writeFile(config, 'audit=false\nfund=false\n');
    const packed = JSON.parse(run(['pack', '--json', '--ignore-scripts', '--pack-destination', sandbox], fixture))[0];
    assert.ok(packed.files.some(file => file.path === 'packages/avatar-sdk/package.json'));
    // npm resolves a packed local directory after the parent has been extracted.
    run(['install', '--offline', '--legacy-peer-deps', '--ignore-scripts', '--no-audit', '--no-fund', join(sandbox, packed.filename)], consumer);
    const installed = dirname(createRequire(join(consumer, 'node_modules/avatar-parent-fixture/package.json')).resolve('@flujo-ai/avatar-sdk/package.json'));
    const metadata = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
    assert.equal(metadata.version, '0.1.0');
    const provenance = JSON.parse(await readFile(join(installed, 'PROVENANCE.json'), 'utf8'));
    assert.equal(provenance.sourceDirty, false);
    for (const [file, expected] of Object.entries(provenance.files)) {
      assert.equal(createHash('sha256').update(await readFile(join(installed, file))).digest('hex'), expected, file);
    }
  } finally {
    assert.equal(dirname(sandbox), resolve(tmpdir()));
    assert.ok(sandbox.startsWith(join(tmpdir(), 'flujo-avatar-directory-')));
    await rm(sandbox, { recursive: true, force: true });
  }
});
