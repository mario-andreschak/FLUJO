import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

test('the pinned production Gemini CLI launches its packaged JavaScript bin without authentication', () => {
  const application = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const version = application.dependencies?.['@google/gemini-cli'];
  assert.match(version ?? '', /^\d+\.\d+\.\d+$/, 'Gemini CLI must be an exact production dependency');
  const packageRoot = path.join(root, 'node_modules', '@google', 'gemini-cli');
  const cli = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(cli.version, version, 'Installed CLI differs from the production pin');
  const bin = typeof cli.bin === 'string' ? cli.bin : cli.bin?.gemini;
  assert.equal(typeof bin, 'string', 'The installed CLI must declare its Gemini entry point');
  assert.match(bin, /\.m?js$/, 'Invoke the JavaScript entry, avoiding platform-specific shell shims');
  const entryPoint = realpathSync(path.resolve(packageRoot, bin));
  const relativeEntry = path.relative(realpathSync(packageRoot), entryPoint);
  assert.ok(relativeEntry && relativeEntry !== '..' && !relativeEntry.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relativeEntry), 'The CLI entry must remain within its installed package');

  const temporary = path.resolve(os.tmpdir());
  const home = mkdtempSync(path.join(temporary, 'flujo-gemini-artifact-'));
  try {
    const settingsPath = path.join(home, 'isolated-system-settings.json');
    writeFileSync(settingsPath, '{}');
    const env = { ...process.env, HOME: home, USERPROFILE: home, GEMINI_CLI_HOME: home,
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: settingsPath, GEMINI_CLI_SYSTEM_DEFAULTS_PATH: settingsPath,
      NO_BROWSER: 'true', GEMINI_CLI_NO_RELAUNCH: 'true' };
    for (const key of Object.keys(env)) {
      if (/^(GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CLOUD_ACCESS_TOKEN|GOOGLE_GENAI_USE_VERTEXAI|GOOGLE_GENAI_USE_GCA)$/i.test(key)) {
        delete env[key];
      }
    }
    const result = spawnSync(process.execPath, [entryPoint, '--version'], {
      cwd: home, env, shell: false, windowsHide: true, encoding: 'utf8',
      timeout: 30_000, maxBuffer: 1024 * 1024,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `Packaged CLI failed to start: ${result.stderr}`);
    assert.equal(result.stdout.trim(), version);
  } finally {
    assert.equal(path.dirname(home), temporary);
    assert.ok(path.basename(home).startsWith('flujo-gemini-artifact-'));
    rmSync(home, { recursive: true, force: true });
  }
});
