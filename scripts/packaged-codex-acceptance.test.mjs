import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseOptions, runCodexAcceptance } from './packaged-codex-acceptance.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('runs every Codex check against the Codex this checkout installs', { timeout: 180000 }, async () => {
  const report = await runCodexAcceptance({ appRoot: repo });
  assert.equal(report.result, 'passed', report.failure);
  assert.deepEqual(report.checks.map(entry => entry.result), ['passed', 'passed', 'passed', 'passed']);
  assert.equal(report.codex.cliVersion, report.codex.declared);
});

test('fails plainly when the installed app has no Codex where FLUJO looks', async () => {
  const report = await runCodexAcceptance({ appRoot: path.join(repo, 'docs') });
  assert.equal(report.result, 'failed');
  assert.match(report.failure, /package\.json|Cannot find|codex/i);
});

test('needs an absolute app root', () => {
  assert.throws(() => parseOptions([]), /--app-root DIR is required/);
  assert.throws(() => parseOptions(['--app-root', 'relative']), /absolute path/);
  assert.deepEqual(parseOptions(['--app-root', repo]), { appRoot: repo, report: undefined });
});
