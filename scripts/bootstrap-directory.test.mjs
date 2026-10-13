import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bootstrapDirectory, loadBootstrapEnvironment } from './bootstrap-directory.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
test('defaults remain caller-selected and invalid explicit roots fail before any dotenv load', () => {
  const fallback = path.join(tmpdir(), 'flujo-default');
  assert.equal(bootstrapDirectory(fallback, {}), fallback);
  for (const value of ['', 'relative', ' ../profile', `${fallback} `, `${fallback}\0invalid`]) {
    let loaded = false;
    const env = { FLUJO_BOOTSTRAP_DIR: value };
    assert.throws(() => loadBootstrapEnvironment(fallback, false, () => { loaded = true; }, env), /absolute directory/);
    assert.equal(loaded, false);
    assert.equal(env.FLUJO_RUNTIME_ENV_DIR, undefined);
  }
});

for (const entry of ['native-bootstrap', 'next-launcher']) {
  test(`${entry} loads only the explicit private root with real Next dotenv handling`, () => {
    const root = mkdtempSync(path.join(tmpdir(), 'flujo-bootstrap-contract-'));
    try {
      const home = path.join(root, 'home');
      const host = path.join(home, '.flujo');
      const cwd = path.join(root, 'working');
      const selected = path.join(root, 'private');
      for (const dir of [host, cwd, selected]) mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(host, '.env.local'), 'FLUJO_HOST_CANARY=host\n');
      writeFileSync(path.join(cwd, '.env.local'), 'FLUJO_CWD_CANARY=cwd\n');
      writeFileSync(path.join(selected, '.env.local'), 'FLUJO_PRIVATE_CANARY=private\nFLUJO_RUNTIME_ENV_DIR=/wrong\n');
      const program = `
        import fs from 'node:fs';
        import os from 'node:os';
        import path from 'node:path';
        import { syncBuiltinESMExports } from 'node:module';
        const reads = [];
        const read = fs.readFileSync;
        fs.readFileSync = function(file, ...args) {
          if (typeof file === 'string' && path.basename(file).startsWith('.env')) reads.push(path.resolve(file));
          return read.call(this, file, ...args);
        };
        syncBuiltinESMExports();
        if (${JSON.stringify(entry)} === 'native-bootstrap') {
          const { loadBootstrapEnvironment } = await import(${JSON.stringify(pathToFileURL(path.join(repository, 'scripts/bootstrap-directory.mjs')).href)});
          const { default: nextEnv } = await import(${JSON.stringify(pathToFileURL(path.join(repository, 'node_modules/@next/env/dist/index.js')).href)});
          loadBootstrapEnvironment(path.join(os.homedir(), '.flujo'), false, nextEnv.loadEnvConfig);
        } else {
          const { loadLaunchEnvironment } = await import(${JSON.stringify(pathToFileURL(path.join(repository, 'scripts/launch-next.mjs')).href)});
          loadLaunchEnvironment(process.cwd(), false);
        }
        process.stdout.write(JSON.stringify({ reads, directory: process.env.FLUJO_RUNTIME_ENV_DIR,
          privateValue: process.env.FLUJO_PRIVATE_CANARY, hostValue: process.env.FLUJO_HOST_CANARY ?? null,
          cwdValue: process.env.FLUJO_CWD_CANARY ?? null }));
      `;
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        !key.startsWith('FLUJO_') && !key.startsWith('__NEXT_')));
      Object.assign(env, { HOME: home, USERPROFILE: home, NODE_ENV: 'production', FLUJO_BOOTSTRAP_DIR: selected });
      const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', program],
        { cwd, env, encoding: 'utf8', timeout: 10_000 }));
      assert.equal(result.directory, selected);
      assert.equal(result.privateValue, 'private');
      assert.equal(result.hostValue, null);
      assert.equal(result.cwdValue, null);
      assert.ok(result.reads.some(file => file === path.join(selected, '.env.local')));
      assert.ok(result.reads.every(file => path.dirname(file) === selected));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
