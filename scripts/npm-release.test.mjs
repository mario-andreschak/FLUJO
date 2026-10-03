import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { diagnoseOidc, redactDiagnostic } from './npm-oidc-diagnostic.mjs';
import {
  PUBLIC_PACKAGES,
  assertCurrentMain,
  assertOidcOnly,
  assertReleaseContext,
  finalizeCandidate,
  prepareCandidate,
  publishCandidate,
  readPublishedIntegrity,
  validateCandidate,
} from './npm-release.mjs';

const SHA = 'a'.repeat(40);
const VERSION = '3.40.1';
const REPOSITORY = 'mario-andreschak/FLUJO';
const REGISTRY = 'https://registry.npmjs.org';
const removeFixture = (directory) => {
  const resolved = path.resolve(directory);
  assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
  assert.ok(path.basename(resolved).startsWith('flujo-npm-'));
  rmSync(resolved, { recursive: true, force: true });
};
const releaseEnvironment = () => ({
  GITHUB_REPOSITORY: REPOSITORY,
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: SHA,
  RELEASE_SHA: SHA,
  RELEASE_VERSION: VERSION,
});

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'flujo-npm-candidate-'));
  t.after(() => removeFixture(directory));
  const packages = PUBLIC_PACKAGES.map((name, index) => {
    const filename = `package-${index}.tgz`;
    const bytes = Buffer.from(`immutable candidate fixture for ${name}@${VERSION}`);
    writeFileSync(path.join(directory, filename), bytes);
    return { name, filename, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` };
  });
  const manifest = { schemaVersion: 1, revision: SHA, version: VERSION, packages };
  const save = () => writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  save();
  return { directory, manifest, save };
}

const missingPackage = () => Object.assign(new Error('package version does not exist'), {
  stdout: JSON.stringify({ error: { code: 'E404', summary: 'No matching version found' } }),
});

test('the release includes all four standalone MCP packages followed by the app', () => {
  assert.deepEqual(PUBLIC_PACKAGES, [
    '@mario.andreschak/mcp-flujo', '@mario.andreschak/mcp-filesystem',
    '@mario.andreschak/mcp-bash', '@mario.andreschak/mcp-browser', 'flujo-ai',
  ]);
});

function registryRunner(manifest, initial = new Map()) {
  const published = new Map(initial);
  const commands = [];
  const run = (command, args) => {
    commands.push({ command, args });
    assert.equal(command, 'npm', 'the publishing primitive must not execute git or shell commands');
    assert.ok(args.includes(REGISTRY), 'registry reads and writes must target the public npm registry');
    if (args[0] === 'view') {
      const key = args.find((argument) => argument.includes(`@${VERSION}`));
      assert.ok(key, 'registry lookups must use the exact release version');
      if (!published.has(key)) throw missingPackage();
      return JSON.stringify(published.get(key));
    }
    assert.equal(args[0], 'publish');
    assert.ok(args.includes('--ignore-scripts'), 'publishing may not rebuild a verified artifact');
    assert.ok(args.includes('--access') && args.includes('public'));
    const filename = args.find((argument) => argument.endsWith('.tgz'));
    const entry = manifest.packages.find((candidate) => candidate.filename === path.basename(filename));
    assert.ok(entry, 'only manifest artifacts may be published');
    published.set(`${entry.name}@${VERSION}`, entry.integrity);
    return '';
  };
  return { run, commands, published };
}

test('only an exact main checkout in the official Actions repository can publish', () => {
  const commands = [];
  assertReleaseContext({
    env: releaseEnvironment(), version: VERSION,
    run: (command, args) => { commands.push({ command, args }); return SHA; },
  });
  assert.ok(commands.some(({ command, args }) => command === 'git' && args.includes('HEAD')));
});

for (const [field, value] of [
  ['GITHUB_REPOSITORY', 'fork/FLUJO'],
  ['GITHUB_EVENT_NAME', 'pull_request'],
  ['GITHUB_EVENT_NAME', 'push'],
  ['GITHUB_REF', 'refs/pull/1/merge'],
  ['GITHUB_REF', 'refs/heads/hackathon'],
  ['GITHUB_SHA', 'b'.repeat(40)],
  ['RELEASE_SHA', 'b'.repeat(40)],
  ['RELEASE_SHA', 'not-a-commit'],
  ['RELEASE_VERSION', '3.40.2'],
  ['RELEASE_VERSION', '3.40.1-rc.1'],
]) {
  test(`publication rejects mismatched ${field} (${value})`, () => {
    assert.throws(() => assertReleaseContext({
      env: { ...releaseEnvironment(), [field]: value }, version: VERSION, run: () => SHA,
    }));
  });
}

test('publication rejects a checkout different from the workflow revision', () => {
  assert.throws(() => assertReleaseContext({ env: releaseEnvironment(), version: VERSION, run: () => 'b'.repeat(40) }));
});

const oidcEnvironment = () => ({
  GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
  GITHUB_WORKFLOW_REF: `${REPOSITORY}/.github/workflows/publish-npm.yml@refs/heads/main`,
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.example.invalid',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic-job-token',
});

test('publishing requires the dedicated GitHub-hosted OIDC workflow', () => {
  assertOidcOnly(oidcEnvironment());
  for (const [field, value] of [
    ['GITHUB_ACTIONS', 'false'],
    ['RUNNER_ENVIRONMENT', 'self-hosted'],
    ['GITHUB_WORKFLOW_REF', `${REPOSITORY}/.github/workflows/verify.yml@refs/heads/main`],
    ['GITHUB_WORKFLOW_REF', `${REPOSITORY}/.github/workflows/publish-npm.yml@refs/heads/hackathon`],
    ['ACTIONS_ID_TOKEN_REQUEST_URL', ''],
    ['ACTIONS_ID_TOKEN_REQUEST_TOKEN', ''],
    ['NODE_AUTH_TOKEN', 'synthetic-legacy-npm-token'],
    ['NPM_TOKEN', 'synthetic-legacy-npm-token'],
  ]) {
    assert.throws(() => assertOidcOnly({ ...oidcEnvironment(), [field]: value }), `invalid ${field} must stop publication`);
  }
});

test('OIDC diagnostics exchange fresh package-specific identities without publishing or exposing tokens', async () => {
  const identity = `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify({ repository: REPOSITORY, sha: SHA, workflow_ref: `${REPOSITORY}/.github/workflows/publish-npm.yml@refs/heads/main` })).toString('base64url')}.signature`;
  const requests = [];
  const report = await diagnoseOidc({ env: { ...oidcEnvironment(), CI: 'true' }, request: async (url, options) => {
    requests.push({ url: String(url), method: options.method ?? 'GET', headers: options.headers });
    if (!options.method) return { ok: true, status: 200, json: async () => ({ value: identity }) };
    assert.equal(options.method, 'POST');
    assert.ok(String(url).includes('/oidc/token/exchange/package/'));
    return { ok: true, status: 200, json: async () => ({ token: 'npm_sensitiveExchangeToken' }) };
  } });
  assert.equal(requests.length, PUBLIC_PACKAGES.length * 2);
  assert.equal(report.results.every(result => result.authenticated), true);
  assert.deepEqual(report.results.map(result => result.name), PUBLIC_PACKAGES);
  assert.ok(requests.filter(item => item.method === 'GET').every(item => new URL(item.url).searchParams.get('audience') === 'npm:registry.npmjs.org'));
  assert.equal(JSON.stringify(report).includes(identity), false);
  assert.equal(JSON.stringify(report).includes('npm_sensitiveExchangeToken'), false);
});

test('OIDC diagnostics expose rejected exchanges safely and do not treat a response without token as authentication', async () => {
  const identity = `eyJhbGciOiJSUzI1NiJ9.${Buffer.from('{}').toString('base64url')}.signature`;
  let exchange = 0;
  const report = await diagnoseOidc({ env: { ...oidcEnvironment(), CI: 'false', NPM_ID_TOKEN: 'unexpected-override' }, request: async (_url, options) => {
    if (!options.method) return { ok: true, status: 200, json: async () => ({ value: identity }) };
    exchange++;
    return { ok: exchange !== 1, status: exchange === 1 ? 403 : 200, json: async () => ({ message: `Rejected Bearer ${identity}; npm_sensitiveExchangeToken` }) };
  } });
  assert.equal(report.results.some(result => result.authenticated), false);
  assert.equal(report.context.ci, 'false');
  assert.equal(report.context.inheritedNpmIdToken, true);
  assert.equal(report.results[0].status, 403);
  assert.equal(JSON.stringify(report).includes(identity), false);
  assert.equal(JSON.stringify(report).includes('npm_sensitiveExchangeToken'), false);
  assert.equal(redactDiagnostic('x'.repeat(2000)).length, 1024);
});

test('OIDC identity rejection never reaches the npm exchange', async () => {
  const report = await diagnoseOidc({ env: oidcEnvironment(), request: async (_url, options) => {
    assert.equal(options.method, undefined);
    return { ok: false, status: 403, json: async () => ({ message: 'Permission denied' }) };
  } });
  assert.equal(report.results.length, PUBLIC_PACKAGES.length);
  assert.equal(report.results.every(result => result.stage === 'github-identity' && !result.authenticated), true);
});

test('OIDC diagnostics redact opaque credentials reflected by the issuer and exchange', async () => {
  const identity = `eyJhbGciOiJSUzI1NiJ9.${Buffer.from('{}').toString('base64url')}.signature`;
  const env = { ...oidcEnvironment(), NPM_ID_TOKEN: 'opaque-inherited-token' };
  const token = 'opaque-exchange-secret_XYZ';
  const report = await diagnoseOidc({ env, request: async (_url, options) => {
    if (!options.method) return { ok: true, status: 200, json: async () => ({ value: identity }) };
    return { ok: false, status: 403, json: async () => ({ token,
      message: [env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, env.NPM_ID_TOKEN, identity, token].join(' ') }) };
  } });
  for (const secret of [env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, env.NPM_ID_TOKEN, identity, token]) {
    assert.equal(JSON.stringify(report).includes(secret), false);
  }
  assert.equal(report.results.every(result => !result.authenticated && result.message.includes('[redacted credential]')), true);
  assert.equal(redactDiagnostic('opaque-token-long opaque-token', ['opaque-token', 'opaque-token-long']), '[redacted credential] [redacted credential]');
});

test('OIDC diagnostics retain successful results and continue after transport, JSON and identity failures', async () => {
  const identity = `eyJhbGciOiJSUzI1NiJ9.${Buffer.from('{}').toString('base64url')}.signature`;
  let packageIndex = -1;
  const report = await diagnoseOidc({ env: oidcEnvironment(), request: async (_url, options) => {
    if (!options.method) {
      packageIndex++;
      if (packageIndex === 2) return { ok: true, status: 200, json: async () => { throw new SyntaxError('Non-JSON issuer response synthetic-job-token'); } };
      return { ok: true, status: 200, json: async () => ({ value: packageIndex === 3 ? 'malformed-opaque-identity' : identity }) };
    }
    if (packageIndex === 1) throw new Error(`Exchange request timed out: ${identity}`);
    return { ok: true, status: 200, json: async () => ({ token: 'opaque-exchange-token' }) };
  } });
  assert.deepEqual(report.results.map(result => result.name), PUBLIC_PACKAGES);
  assert.deepEqual(report.results.map(result => result.authenticated), [true, false, false, false, true]);
  assert.equal(report.results[1].stage, 'npm-exchange');
  assert.equal(report.results[1].status, null);
  assert.equal(report.results[2].stage, 'github-identity');
  assert.equal(report.results[2].status, 200);
  for (const secret of ['synthetic-job-token', identity, 'malformed-opaque-identity', 'opaque-exchange-token']) {
    assert.equal(JSON.stringify(report).includes(secret), false);
  }
});

test('current-main verification queries the official repository and stops when main advances', () => {
  const run = (command, args) => {
    assert.equal(command, 'gh');
    assert.ok(args.some((argument) => argument.includes(`${REPOSITORY}/`) && argument.includes('main')));
    return SHA;
  };
  assertCurrentMain(run, SHA);
  assert.throws(() => assertCurrentMain(() => 'b'.repeat(40), SHA));
});

test('only an explicit npm E404 means an unpublished immutable version', () => {
  assert.equal(readPublishedIntegrity(() => { throw missingPackage(); }, PUBLIC_PACKAGES[0], VERSION), null);
  assert.equal(readPublishedIntegrity(() => {
    throw Object.assign(new Error('missing'), { stderr: 'npm error code E404\nnpm error missing version' });
  }, PUBLIC_PACKAGES[0], VERSION), null);
  for (const failure of [
    Object.assign(new Error('credentials expired'), { stdout: JSON.stringify({ error: { code: 'E401' } }) }),
    Object.assign(new Error('registry unavailable'), { stderr: 'npm error code E503' }),
    new Error('opaque failure mentioning E404 in an unrelated message'),
    Object.assign(new Error('malformed metadata'), { stdout: '{broken JSON' }),
  ]) {
    assert.throws(() => readPublishedIntegrity(() => { throw failure; }, PUBLIC_PACKAGES[0], VERSION), (error) => error === failure);
  }
});

test('a successful npm response without an integrity value is not evidence of an unpublished version', () => {
  for (const response of ['', 'null', '{}', '[]']) {
    assert.throws(() => readPublishedIntegrity(() => response, PUBLIC_PACKAGES[0], VERSION));
  }
});

test('registry integrity reads force online revalidation and bound a failed request', () => {
  const integrity = `sha512-${createHash('sha512').update('registry fixture').digest('base64')}`;
  const result = readPublishedIntegrity((command, args, options) => {
    assert.equal(command, 'npm');
    assert.equal(args[0], 'view');
    assert.ok(args.includes(`${PUBLIC_PACKAGES[0]}@${VERSION}`));
    for (const flag of ['--prefer-online', '--prefer-offline=false', '--offline=false', '--fetch-retries=0', '--fetch-timeout=10000']) {
      assert.ok(args.includes(flag), `${flag} must override inherited npm preferences`);
    }
    assert.equal(options.timeout, 15_000);
    return JSON.stringify(integrity);
  }, PUBLIC_PACKAGES[0], VERSION);
  assert.equal(result, integrity);
});

test('candidate identity and every artifact checksum are verified before publication', (t) => {
  const candidate = fixture(t);
  validateCandidate({ directory: candidate.directory, sha: SHA, version: VERSION });
  writeFileSync(path.join(candidate.directory, candidate.manifest.packages[2].filename), 'changed bytes after verification');
  assert.throws(() => validateCandidate({ directory: candidate.directory, sha: SHA, version: VERSION }));
});

test('packing checks every npm package name and version before producing a resumable candidate', (t) => {
  const candidate = fixture(t);
  const commands = [];
  let packageIndex = 0;
  const run = (command, args) => {
    commands.push({ command, args });
    assert.equal(command, 'npm');
    assert.equal(args[0], 'pack');
    assert.ok(args.includes('--ignore-scripts'));
    const entry = candidate.manifest.packages[packageIndex++];
    if (entry.name === 'flujo-ai') assert.ok(!args.includes('--workspace'));
    else assert.ok(args.includes('--workspace') && args.includes(entry.name));
    return JSON.stringify([{ ...entry, version: VERSION }]);
  };
  const result = prepareCandidate({ run, directory: candidate.directory, sha: SHA, version: VERSION });
  assert.deepEqual(result, candidate.manifest);
  assert.equal(commands.length, PUBLIC_PACKAGES.length);
});

for (const [field, value] of [['name', '@attacker/package'], ['version', '3.40.2']]) {
  test(`packing refuses an artifact with an unexpected ${field}`, (t) => {
    const directory = mkdtempSync(path.join(tmpdir(), 'flujo-npm-pack-'));
    t.after(() => removeFixture(directory));
    let commands = 0;
    assert.throws(() => prepareCandidate({
      directory, sha: SHA, version: VERSION,
      run: () => {
        commands += 1;
        return JSON.stringify([{ name: PUBLIC_PACKAGES[0], version: VERSION, filename: 'candidate.tgz', integrity: 'sha512-fake', [field]: value }]);
      },
    }));
    assert.equal(commands, 1);
    assert.equal(existsSync(path.join(directory, 'manifest.json')), false);
  });
}

for (const [label, mutate] of [
  ['revision', (manifest) => { manifest.revision = 'b'.repeat(40); }],
  ['version', (manifest) => { manifest.version = '3.40.2'; }],
  ['schema', (manifest) => { manifest.schemaVersion = 2; }],
  ['missing package', (manifest) => { manifest.packages.pop(); }],
  ['duplicate package', (manifest) => { manifest.packages[1].name = manifest.packages[0].name; }],
  ['unexpected package', (manifest) => { manifest.packages[0].name = '@attacker/package'; }],
  ['package order', (manifest) => { manifest.packages.reverse(); }],
  ['path traversal', (manifest) => { manifest.packages[0].filename = '../outside.tgz'; }],
  ['Windows path traversal', (manifest) => { manifest.packages[0].filename = '..\\outside.tgz'; }],
  ['absolute path', (manifest) => { manifest.packages[0].filename = path.resolve('outside.tgz'); }],
]) {
  test(`candidate rejects ${label} tampering`, (t) => {
    const candidate = fixture(t);
    mutate(candidate.manifest);
    candidate.save();
    assert.throws(() => validateCandidate({ directory: candidate.directory, sha: SHA, version: VERSION }));
  });
}

test('fresh publication uses each original artifact and publishes the app after all MCP packages', async (t) => {
  const candidate = fixture(t);
  const registry = registryRunner(candidate.manifest);
  let mainChecks = 0;
  const result = await publishCandidate({
    run: registry.run, directory: candidate.directory, sha: SHA, version: VERSION,
    assertCurrent: () => { mainChecks += 1; },
  });
  assert.deepEqual(result, PUBLIC_PACKAGES.map((name) => ({ name, published: true })));
  assert.ok(mainChecks >= PUBLIC_PACKAGES.length, 'main must be checked before every publish');
  const artifacts = registry.commands.filter(({ args }) => args[0] === 'publish').map(({ args }) => path.basename(args.find((argument) => argument.endsWith('.tgz'))));
  assert.deepEqual(artifacts, candidate.manifest.packages.map(({ filename }) => filename));
  assert.equal(PUBLIC_PACKAGES.at(-1), 'flujo-ai');
});

test('a partial release resumes only missing packages and skips identical published bytes', async (t) => {
  const candidate = fixture(t);
  const initial = new Map(candidate.manifest.packages.slice(0, 2).map(({ name, integrity }) => [`${name}@${VERSION}`, integrity]));
  const registry = registryRunner(candidate.manifest, initial);
  const result = await publishCandidate({
    run: registry.run, directory: candidate.directory, sha: SHA, version: VERSION, assertCurrent: () => {},
  });
  assert.deepEqual(result, PUBLIC_PACKAGES.map((name, index) => ({ name, published: index >= 2 })));
  assert.equal(registry.commands.filter(({ args }) => args[0] === 'publish').length, PUBLIC_PACKAGES.length - 2);
});

test('retry after a mid-release failure reuses the artifact set and does not republish earlier packages', async (t) => {
  const candidate = fixture(t);
  const registry = registryRunner(candidate.manifest);
  let failed = false;
  const run = (command, args, options) => {
    if (args[0] === 'publish' && args.some((argument) => path.basename(argument) === candidate.manifest.packages[2].filename) && !failed) {
      failed = true;
      throw new Error('temporary npm publishing failure');
    }
    return registry.run(command, args, options);
  };
  const options = { run, directory: candidate.directory, sha: SHA, version: VERSION, assertCurrent: () => {} };
  await assert.rejects(() => publishCandidate(options), /temporary npm publishing failure/);
  assert.deepEqual(await publishCandidate(options), PUBLIC_PACKAGES.map((name, index) => ({ name, published: index >= 2 })));
  const publishedArtifacts = registry.commands.filter(({ args }) => args[0] === 'publish').map(({ args }) => path.basename(args.find((argument) => argument.endsWith('.tgz'))));
  assert.deepEqual(publishedArtifacts, candidate.manifest.packages.map(({ filename }) => filename));
});

test('a published version with different bytes aborts before any further publication', async (t) => {
  const candidate = fixture(t);
  const first = candidate.manifest.packages[0];
  const registry = registryRunner(candidate.manifest, new Map([[`${first.name}@${VERSION}`, 'sha512-conflicting-immutable-content']]));
  await assert.rejects(() => publishCandidate({
    run: registry.run, directory: candidate.directory, sha: SHA, version: VERSION, assertCurrent: () => {},
  }));
  assert.equal(registry.commands.filter(({ args }) => args[0] === 'publish').length, 0);
});

test('a successful publish command cannot advance the release without matching registry readback', async (t) => {
  const candidate = fixture(t);
  const registry = registryRunner(candidate.manifest);
  const first = candidate.manifest.packages[0];
  const run = (command, args, options) => {
    const result = registry.run(command, args, options);
    if (args[0] === 'publish') registry.published.set(`${first.name}@${VERSION}`, `sha512-${createHash('sha512').update('different registry bytes').digest('base64')}`);
    return result;
  };
  await assert.rejects(() => publishCandidate({
    run, directory: candidate.directory, sha: SHA, version: VERSION, assertCurrent: () => {},
    wait: async () => assert.fail('a conflicting registry integrity must never be retried'),
  }));
  assert.equal(registry.commands.filter(({ args }) => args[0] === 'publish').length, 1);
});

test('a missing post-publish version becomes visible before any following package is published', async (t) => {
  const candidate = fixture(t);
  const registry = registryRunner(candidate.manifest);
  const firstKey = `${PUBLIC_PACKAGES[0]}@${VERSION}`;
  const waits = [];
  let missingReadbacks = 0;
  let elapsed = 0;
  const run = (command, args, options) => {
    if (args[0] === 'view' && args.includes(firstKey) && registry.published.has(firstKey) && missingReadbacks++ < 73) {
      // A fresh server response can still omit a successfully written version.
      assert.ok(args.includes('--prefer-online'));
      assert.ok(args.includes('--offline=false') && args.includes('--prefer-offline=false'));
      throw missingPackage();
    }
    return registry.run(command, args, options);
  };
  const result = await publishCandidate({
    run, directory: candidate.directory, sha: SHA, version: VERSION, assertCurrent: () => {},
    now: () => elapsed,
    wait: async (delay) => {
      assert.equal(registry.published.size, 1, 'later packages must wait for the first integrity confirmation');
      elapsed += delay;
      waits.push(delay);
    },
  });
  assert.deepEqual(waits, Array(73).fill(10_000));
  assert.equal(elapsed, 730_000);
  assert.deepEqual(result, PUBLIC_PACKAGES.map((name) => ({ name, published: true })));
  assert.equal(registry.commands.filter(({ args }) => args[0] === 'publish').length, PUBLIC_PACKAGES.length);
});

test('persistent missing readback stops after fifteen minutes and resumes the original artifacts without republishing', async (t) => {
  const candidate = fixture(t);
  const registry = registryRunner(candidate.manifest);
  const firstKey = `${PUBLIC_PACKAGES[0]}@${VERSION}`;
  let elapsed = 0;
  let readbacks = 0;
  let waits = 0;
  const run = (command, args, options) => {
    if (args[0] === 'view' && args.includes(firstKey) && registry.published.has(firstKey)) {
      readbacks += 1;
      throw missingPackage();
    }
    return registry.run(command, args, options);
  };
  await assert.rejects(() => publishCandidate({
    run, directory: candidate.directory, sha: SHA, version: VERSION, assertCurrent: () => {},
    now: () => elapsed, wait: async (delay) => { elapsed += delay; waits += 1; },
  }), /remains missing.*Resume the original release run's failed jobs/);
  assert.equal(readbacks, 91);
  assert.equal(waits, 90);
  assert.equal(elapsed, 900_000);
  assert.equal(registry.commands.filter(({ args }) => args[0] === 'publish').length, 1);
  assert.deepEqual(await publishCandidate({
    run: registry.run, directory: candidate.directory, sha: SHA, version: VERSION, assertCurrent: () => {},
  }), PUBLIC_PACKAGES.map((name, index) => ({ name, published: index !== 0 })));
  assert.deepEqual(registry.commands.filter(({ args }) => args[0] === 'publish').map(({ args }) => path.basename(args[1])),
    candidate.manifest.packages.map(({ filename }) => filename));
});

test('slow missing responses consume the readback deadline instead of extending every delay', async (t) => {
  const candidate = fixture(t);
  const registry = registryRunner(candidate.manifest);
  const firstKey = `${PUBLIC_PACKAGES[0]}@${VERSION}`;
  let elapsed = 0;
  const waits = [];
  let readbacks = 0;
  const run = (command, args, options) => {
    if (args[0] === 'view' && args.includes(firstKey) && registry.published.has(firstKey)) {
      elapsed += 449_000;
      readbacks += 1;
      throw missingPackage();
    }
    return registry.run(command, args, options);
  };
  await assert.rejects(() => publishCandidate({
    run, directory: candidate.directory, sha: SHA, version: VERSION, assertCurrent: () => {},
    now: () => elapsed, wait: async (delay) => { elapsed += delay; waits.push(delay); },
  }), /remains missing/);
  assert.equal(readbacks, 2);
  assert.deepEqual(waits, [10_000]);
  assert.equal(elapsed, 908_000);
});

for (const [label, failure, response] of [
  ['authentication', Object.assign(new Error('credentials rejected'), { stdout: JSON.stringify({ error: { code: 'E401' } }) })],
  ['registry service', Object.assign(new Error('registry unavailable'), { stderr: 'npm error code E503' })],
  ['transport', new Error('connection reset')],
  ['malformed JSON', null, '{broken JSON'],
  ['missing integrity metadata', null, 'null'],
]) {
  test(`post-publish ${label} errors fail immediately without retries or further writes`, async (t) => {
    const candidate = fixture(t);
    const registry = registryRunner(candidate.manifest);
    const firstKey = `${PUBLIC_PACKAGES[0]}@${VERSION}`;
    let readbacks = 0;
    const run = (command, args, options) => {
      if (args[0] === 'view' && args.includes(firstKey) && registry.published.has(firstKey)) {
        readbacks += 1;
        if (failure) throw failure;
        return response;
      }
      return registry.run(command, args, options);
    };
    await assert.rejects(() => publishCandidate({
      run, directory: candidate.directory, sha: SHA, version: VERSION, assertCurrent: () => {},
      wait: async () => assert.fail('only an explicit missing version can be retried'),
    }), (error) => failure ? error === failure : error instanceof Error);
    assert.equal(readbacks, 1);
    assert.equal(registry.commands.filter(({ args }) => args[0] === 'publish').length, 1);
  });
}

test('main moving during a readback delay prevents every remaining package write', async (t) => {
  const candidate = fixture(t);
  const registry = registryRunner(candidate.manifest);
  const firstKey = `${PUBLIC_PACKAGES[0]}@${VERSION}`;
  let firstReadback = true;
  let current = true;
  const run = (command, args, options) => {
    if (args[0] === 'view' && args.includes(firstKey) && registry.published.has(firstKey) && firstReadback) {
      firstReadback = false;
      throw missingPackage();
    }
    return registry.run(command, args, options);
  };
  await assert.rejects(() => publishCandidate({
    run, directory: candidate.directory, sha: SHA, version: VERSION,
    assertCurrent: () => { if (!current) throw new Error('main advanced during propagation'); },
    wait: async () => { current = false; },
  }), /main advanced during propagation/);
  assert.equal(registry.commands.filter(({ args }) => args[0] === 'publish').length, 1);
});

test('a main advance after the first package prevents publishing the remaining release', async (t) => {
  const candidate = fixture(t);
  const registry = registryRunner(candidate.manifest);
  let mainChecks = 0;
  await assert.rejects(() => publishCandidate({
    run: registry.run, directory: candidate.directory, sha: SHA, version: VERSION,
    assertCurrent: () => { if (++mainChecks > 1) throw new Error('main advanced'); },
  }), /main advanced/);
  assert.ok(registry.commands.filter(({ args }) => args[0] === 'publish').length <= 1);
});

test('candidate checksum failure never reaches a registry write', async (t) => {
  const candidate = fixture(t);
  const registry = registryRunner(candidate.manifest);
  const original = readFileSync(path.join(candidate.directory, candidate.manifest.packages.at(-1).filename));
  writeFileSync(path.join(candidate.directory, candidate.manifest.packages.at(-1).filename), Buffer.concat([original, Buffer.from(' changed')]));
  await assert.rejects(() => publishCandidate({
    run: registry.run, directory: candidate.directory, sha: SHA, version: VERSION, assertCurrent: () => {},
  }));
  assert.equal(registry.commands.length, 0);
});

function finalizationRunner(manifest, { missing = false, tag = null } = {}) {
  const commands = [];
  const dispatched = new Map();
  let nextRunId = 123;
  const run = (command, args) => {
    commands.push({ command, args });
    if (command === 'npm') {
      const item = manifest.packages.find(({ name }) => args.includes(`${name}@${VERSION}`));
      assert.ok(item);
      if (missing === true || missing === item.name) throw missingPackage();
      assert.equal(args[0], 'view');
      return JSON.stringify(item.integrity);
    }
    assert.equal(command, 'gh');
    if (args[0] === 'api') {
      if (args[1].endsWith('/git/ref/heads/main')) return SHA;
      if (args[1].includes('/git/ref/tags/')) {
        if (tag) return JSON.stringify({ object: tag });
        throw Object.assign(new Error('tag not found'), { stderr: 'HTTP 404' });
      }
      assert.ok(args.includes('POST'));
      return '';
    }
    if (args[0] === 'workflow' && args[1] === 'run') {
      dispatched.set(args[2], nextRunId++);
      return '';
    }
    if (args[0] === 'run' && args[1] === 'list') {
      const workflow = args[args.indexOf('--workflow') + 1];
      const id = dispatched.get(workflow);
      return JSON.stringify(id ? [{ databaseId: id, headSha: SHA, event: 'workflow_dispatch' }] : []);
    }
    assert.ok(args[0] === 'run' && args[1] === 'watch' && args.includes('--exit-status'));
    return '';
  };
  return { run, commands };
}

test('GitHub tags, installer and image runs begin only after all registry artifacts match', async (t) => {
  const candidate = fixture(t);
  const github = finalizationRunner(candidate.manifest);
  await finalizeCandidate({ run: github.run, directory: candidate.directory, sha: SHA, version: VERSION });
  const tagCreation = github.commands.findIndex(({ command, args }) => command === 'gh' && args.includes('POST'));
  assert.ok(tagCreation >= 0);
  assert.equal(github.commands.slice(0, tagCreation).filter(({ command }) => command === 'npm').length, PUBLIC_PACKAGES.length);
  const dispatches = github.commands.filter(({ command, args }) => command === 'gh' && args[0] === 'workflow');
  assert.equal(dispatches.length, 2);
  const installer = dispatches.find(({ args }) => args[2] === 'installer.yml').args;
  assert.equal(installer[installer.indexOf('--ref') + 1], `v${VERSION}`);
  const image = dispatches.find(({ args }) => args[2] === 'publish-image.yml').args;
  assert.equal(image[image.indexOf('--ref') + 1], 'main');
  assert.ok(image.includes(`expected_sha=${SHA}`) && image.includes(`expected_version=${VERSION}`));
  assert.equal(github.commands.filter(({ args }) => args[0] === 'run' && args[1] === 'watch').length, 2);
  const firstWatch = github.commands.findIndex(({ args }) => args[0] === 'run' && args[1] === 'watch');
  assert.equal(github.commands.slice(0, firstWatch).filter(({ args }) => args[0] === 'workflow' && args[1] === 'run').length, 2,
    'both builds must be dispatched before a synchronous wait can block the second dispatch');
});

test('a missing npm package stops finalization before any GitHub mutation', async (t) => {
  const candidate = fixture(t);
  const github = finalizationRunner(candidate.manifest, { missing: true });
  await assert.rejects(finalizeCandidate({ run: github.run, directory: candidate.directory, sha: SHA, version: VERSION }));
  assert.equal(github.commands.some(({ command }) => command === 'gh'), false);
});

test('the app package must also be confirmed before tagging an otherwise published MCP release', async (t) => {
  const candidate = fixture(t);
  const github = finalizationRunner(candidate.manifest, { missing: 'flujo-ai' });
  await assert.rejects(finalizeCandidate({ run: github.run, directory: candidate.directory, sha: SHA, version: VERSION }));
  assert.equal(github.commands.filter(({ command }) => command === 'npm').length, PUBLIC_PACKAGES.length);
  assert.equal(github.commands.some(({ command }) => command === 'gh'), false);
});

test('an existing tag for another commit cannot be overwritten or trigger release artifacts', async (t) => {
  const candidate = fixture(t);
  const github = finalizationRunner(candidate.manifest, { tag: { type: 'commit', sha: 'b'.repeat(40) } });
  await assert.rejects(finalizeCandidate({ run: github.run, directory: candidate.directory, sha: SHA, version: VERSION }));
  assert.equal(github.commands.some(({ args }) => args.includes('POST') || args[0] === 'workflow'), false);
});

test('finalization retry reuses the existing exact tag and still waits for both artifacts', async (t) => {
  const candidate = fixture(t);
  const github = finalizationRunner(candidate.manifest, { tag: { type: 'commit', sha: SHA } });
  await finalizeCandidate({ run: github.run, directory: candidate.directory, sha: SHA, version: VERSION });
  assert.equal(github.commands.some(({ args }) => args.includes('POST')), false);
  assert.equal(github.commands.filter(({ args }) => args[0] === 'workflow' && args[1] === 'run').length, 2);
  assert.equal(github.commands.filter(({ args }) => args[0] === 'run' && args[1] === 'watch').length, 2);
});

test('the Actions graph isolates npm identity and publishes only the tested artifacts from the original run', () => {
  const workflow = YAML.parse(readFileSync(new URL('../.github/workflows/publish-npm.yml', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.equal(workflow.permissions.contents, 'read');
  const { prepare, publish, finalize, attest, 'verify-main': verifyMain } = workflow.jobs;
  const diagnostic = workflow.jobs['diagnose-oidc'];
  assert.equal(workflow.on.workflow_dispatch.inputs.diagnose_oidc.default, false);
  assert.equal(diagnostic.if, 'inputs.diagnose_oidc');
  assert.equal(diagnostic.permissions['id-token'], 'write');
  assert.ok(diagnostic.steps.some(({ run }) => run === 'node scripts/npm-oidc-diagnostic.mjs'));
  assert.equal(diagnostic.steps.some(({ run }) => /npm-release\.mjs (publish|finalize)/.test(run ?? '')), false);
  for (const job of [prepare, verifyMain, publish, finalize, attest]) assert.equal(job.if, '${{ !inputs.diagnose_oidc }}');
  assert.deepEqual(publish.needs, ['prepare', 'verify-main', 'attest']);
  assert.deepEqual(attest.needs, ['prepare', 'verify-main']);
  assert.equal(attest.permissions['id-token'], 'write');
  assert.equal(attest.permissions.attestations, 'write');
  assert.equal(attest.permissions['artifact-metadata'], 'write');
  assert.ok(attest.steps.some(({ run }) => run === 'node scripts/npm-release.mjs verify-evidence'));
  assert.equal(attest.steps.some(({ run }) => /npm (?:ci|run build)|npm-release\.mjs prepare/.test(run ?? '')), false,
    'candidate lifecycle scripts must not run with attestation authority');
  assert.equal(attest.steps.filter(({ uses }) => uses?.startsWith('actions/attest@')).length, 2);
  // Each package may use a fifteen-minute readback window after its
  // ten-minute publish call. Keep setup/verification time outside that sum.
  const sequentialPublicationMinutes = PUBLIC_PACKAGES.length * (15 + 10);
  const setupAndVerificationMinutes = 25;
  assert.ok(publish['timeout-minutes'] >= sequentialPublicationMinutes + setupAndVerificationMinutes,
    'the publish job must accommodate every sequential package budget plus setup and verification');
  assert.ok(finalize.needs.includes('prepare') && finalize.needs.includes('publish'));
  assert.equal(publish.permissions['id-token'], 'write');
  assert.equal(publish.permissions.contents, 'read');
  assert.equal(finalize.permissions.contents, 'write');
  assert.equal(finalize.permissions.actions, 'write');
  for (const job of [prepare, verifyMain, finalize]) assert.notEqual(job.permissions?.['id-token'], 'write');
  for (const job of Object.values(workflow.jobs)) {
    assert.equal(job['runs-on'], 'ubuntu-latest');
    const setup = job.steps.find(({ uses }) => uses?.startsWith('actions/setup-node@'));
    assert.equal(setup.with['package-manager-cache'], false);
    assert.equal(job.steps.some(({ uses }) => uses?.startsWith('actions/cache@')), false);
  }
  const upload = prepare.steps.find(({ uses }) => uses?.startsWith('actions/upload-artifact@'));
  assert.equal(prepare.outputs.artifact_id, `\${{ steps.${upload.id}.outputs.artifact-id }}`);
  for (const job of [attest, publish, finalize]) {
    const download = job.steps.find(({ uses }) => uses?.startsWith('actions/download-artifact@'));
    assert.equal(download.with['artifact-ids'], '${{ needs.prepare.outputs.artifact_id }}');
    assert.equal(download.with['run-id'], undefined, 'a retry must use its original successful prepare job');
  }
  assert.ok(verifyMain.steps.some(({ run }) => run === 'node scripts/require-release-verification.mjs npm'));
});

test('both release-safety runners install pinned dependencies before the workflow structure checks', () => {
  const verification = YAML.parse(readFileSync(new URL('../.github/workflows/verify.yml', import.meta.url), 'utf8'));
  const job = verification.jobs['release-safety'];
  assert.deepEqual(job.strategy.matrix.os, ['ubuntu-latest', 'windows-latest']);
  const install = job.steps.findIndex(({ run }) => run === 'npm ci --include=dev');
  const tests = job.steps.findIndex(({ run }) => run?.startsWith('node --test ') && run.includes('scripts/npm-release.test.mjs'));
  assert.ok(install >= 0 && tests > install, 'YAML-dependent checks need a clean lockfile installation first');
});
