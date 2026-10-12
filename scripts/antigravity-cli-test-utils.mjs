import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

export function isolatedNativeEnv(home) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) =>
    typeof value === 'string' && !/^(GOOGLE|GEMINI|GCLOUD|CLOUDSDK|AGY|ANTIGRAVITY|JETSKI|NODE_OPTIONS|NODE_PATH)/i.test(name)));
  return { ...env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'appdata'),
    LOCALAPPDATA: path.join(home, 'localappdata'), XDG_CONFIG_HOME: path.join(home, 'config'),
    XDG_CACHE_HOME: path.join(home, 'cache'), XDG_DATA_HOME: path.join(home, 'data'),
    NO_BROWSER: 'true', AGY_CLI_DISABLE_AUTO_UPDATE: 'true' };
}

export function assertPackagedBinary(applicationManifest) {
  const require = createRequire(applicationManifest);
  const entry = require.resolve('@flujo-ai/antigravity-cli');
  const wrapper = require(entry);
  const packageRoot = realpathSync(path.dirname(entry));
  const binary = realpathSync(wrapper.resolveBinary());
  const relative = path.relative(packageRoot, binary);
  assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep)
    && !path.isAbsolute(relative), 'Native runtime must belong to its installed package');
  const artifacts = JSON.parse(readFileSync(path.join(packageRoot, 'artifacts.json'), 'utf8'));
  assert.equal(wrapper.version, artifacts.version);
  const receipt = JSON.parse(readFileSync(wrapper.paths().receipt, 'utf8'));
  assert.equal(receipt.artifactSha512, artifacts.platforms[wrapper.platformKey()].sha512);
  assert.equal(wrapper.sha512(binary), receipt.binarySha512);
  const home = mkdtempSync(path.join(os.tmpdir(), 'flujo-antigravity-artifact-'));
  try {
    const result = spawnSync(binary, ['--version'], {
      cwd: home, env: isolatedNativeEnv(home), shell: false, windowsHide: true,
      encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, 'Pinned native CLI failed: ' + result.stderr);
    assert.match(result.stdout.trim(), new RegExp('^' + artifacts.version.replaceAll('.', '\\.') + '\\b'));
    assert.equal(wrapper.resolveBinary(), binary, 'Version check must not mutate the pinned runtime');
  } finally {
    assert.equal(path.dirname(home), path.resolve(os.tmpdir()));
    assert.ok(path.basename(home).startsWith('flujo-antigravity-artifact-'));
    rmSync(home, { recursive: true, force: true });
  }
  return { wrapper, packageRoot, binary };
}
