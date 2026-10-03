import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { assertInstalledIdentity, assertRestoredFlow, parseBaselineOptions } from './maintainer-installed-baseline.mjs';

const pin = ['--version=3.46.2', `--integrity=sha512-${Buffer.alloc(64, 7).toString('base64')}`,
  `--source-revision=${'a'.repeat(40)}`];

test('requires immutable package identity and rejects URL, shell, duplicate and malformed inputs', () => {
  assert.equal(parseBaselineOptions(pin).version, '3.46.2');
  for (const args of [[], pin.slice(0, 2), [...pin, '--url=https://example.com'], [...pin, pin[0]],
    [pin[0], '--integrity=sha512-Zm9v', pin[2]], [pin[0], pin[1], '--source-revision=main'],
    ['--version=3.46.2;echo-secret', ...pin.slice(1)], [...pin, '--npm-cli=npm.cmd']]) {
    assert.throws(() => parseBaselineOptions(args), /Usage/);
  }
});

test('refuses HTTP mutations when loopback readiness belongs to another install or data root', () => {
  const app = path.resolve('sandbox', 'consumer', 'node_modules', 'flujo-ai');
  const data = path.resolve('sandbox', 'data');
  assertInstalledIdentity({ cwd: app, mcpServersDir: path.join(data, 'workspaces', 'default', 'mcp-servers') }, app, data);
  for (const observed of [{ cwd: path.resolve('other-app'), mcpServersDir: path.join(data, 'mcp') },
    { cwd: app, mcpServersDir: `${data}-other${path.sep}mcp` }, { cwd: app, mcpServersDir: data },
    { cwd: app, mcpServersDir: path.resolve('sandbox', 'outside') }, {}]) {
    assert.throws(() => assertInstalledIdentity(observed, app, data), /no mutation allowed/);
  }
});

test('compares all stable synthetic flow fields and rejects partial recovery', () => {
  const expected = { id: 'fixture', name: 'Synthetic fixture', nodes: [{ id: 'node' }], edges: [] };
  assertRestoredFlow({ ...expected, updatedAt: 'later' }, expected);
  for (const field of ['id', 'name', 'nodes', 'edges']) {
    assert.throws(() => assertRestoredFlow({ ...expected, [field]: null }, expected), new RegExp(`Restored ${field}`));
  }
});
