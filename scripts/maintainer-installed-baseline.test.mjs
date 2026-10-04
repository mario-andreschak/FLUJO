import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertInstalledIdentity, assertRestoredFlow, parseBaselineOptions, runInstalledBaseline } from './maintainer-installed-baseline.mjs';

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

test('the actual baseline orchestration refuses failed or wrong-policy provenance before consumer creation or launch', async context => {
  const privateDirectory = mkdtempSync(path.join(os.tmpdir(), 'flujo-provenance-orchestration-test-'));
  const npmCli = path.join(privateDirectory, 'npm-cli.js'); writeFileSync(npmCli, '// Never executed by this refusal fixture.\n');
  const tarball = Buffer.from('synthetic package bytes; not an installable artifact');
  const options = { version: '3.46.2', integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
    artifactSourceRevision: 'a'.repeat(40), npmCli };
  const directories = [];
  try {
    for (const mode of ['verifier-failure', 'wrong-certificate']) {
      let launches = 0; let verifications = 0; const fetches = [];
      context.mock.method(childProcess, 'spawn', () => { launches++; throw new Error('Unexpected consumer launch'); });
      context.mock.method(childProcess, 'execFileSync', (command, args) => {
        assert.equal(command, 'git'); return args.includes('rev-parse') ? options.artifactSourceRevision : '';
      });
      context.mock.method(childProcess, 'spawnSync', (command) => {
        assert.equal(command, 'gh'); verifications++;
        if (mode === 'verifier-failure') {
          return { status: 1, signal: null, stdout: '', stderr: 'Fixture cryptographic failure; no actual signature claim' };
        }
        return { status: 0, signal: null, stderr: 'Fixture diagnostic retained even on successful command exit',
          stdout: JSON.stringify([{ verificationResult: { signature: { certificate: { issuer: 'wrong' } } } }]) };
      });
      syncBuiltinESMExports();
      context.mock.method(globalThis, 'fetch', async url => {
        fetches.push(url);
        if (String(url).endsWith('.tgz')) return new Response(tarball);
        if (String(url).includes('/-/npm/v1/attestations/')) return new Response(JSON.stringify({ attestations: [{
          predicateType: 'https://slsa.dev/provenance/v1', bundle: { dsseEnvelope: {}, verificationMaterial: {} },
        }] }));
        return new Response(JSON.stringify({ name: 'flujo-ai', version: options.version, dist: {
          integrity: options.integrity, tarball: 'https://registry.npmjs.org/flujo-ai/-/flujo-ai-3.46.2.tgz',
          attestations: { url: 'https://registry.npmjs.org/-/npm/v1/attestations/flujo-ai@3.46.2',
            provenance: { predicateType: 'https://slsa.dev/provenance/v1' } },
        } }));
      });
      try {
        const result = await runInstalledBaseline(options); directories.push(result.directory);
        assert.equal(result.receipt.result, 'failed'); assert.equal(result.receipt.provenanceSignatureVerified, false);
        assert.match(result.receipt.failure, mode === 'verifier-failure' ? /verifier exited 1/ : /certificate.*policy/);
        assert.equal(launches, 0); assert.equal(verifications, 1); assert.equal(fetches.length, 3);
        assert.deepEqual(result.receipt.commands, []); assert.deepEqual(result.receipt.observations, []);
        assert.equal(existsSync(path.join(result.directory, 'consumer', 'package.json')), false);
        assert.equal(result.receipt.provenanceCommands[0].code, mode === 'verifier-failure' ? 1 : 0);
        assert.match(readFileSync(path.join(result.directory, 'provenance-1.stderr.txt'), 'utf8'),
          mode === 'verifier-failure' ? /cryptographic failure/ : /diagnostic retained/);
        for (const name of ['npm-version.json', 'npm-attestations.json', 'npm-provenance-bundles.jsonl', 'provenance-1.stdout.json', 'provenance-1.stderr.txt']) {
          const witness = result.receipt.evidence.find(item => item.path === name);
          assert.equal(witness.sha256, createHash('sha256').update(readFileSync(path.join(result.directory, name))).digest('hex'));
        }
      } finally { context.mock.restoreAll(); syncBuiltinESMExports(); }
    }
  } finally {
    context.mock.restoreAll(); syncBuiltinESMExports();
    for (const target of [...directories, privateDirectory]) {
      assert.equal(path.dirname(path.resolve(target)), path.resolve(os.tmpdir()));
      assert.match(path.basename(target), /^flujo-(maintainer-installed|provenance-orchestration-test)-/);
      rmSync(target, { recursive: true, force: true });
    }
  }
});
