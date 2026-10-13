import assert from 'node:assert/strict';
import { readdir, readFile, mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Verify emitted code, not an adapter mock. The SDK uses import.meta.url to
// locate its bundled native CLI; bundling it persists the build host's URL.
export function codexExternalFactories(source) {
  assert.doesNotMatch(source, /file:\/\/\/[^"'\s]*codex-sdk/, 'Codex SDK contains a build-host file URL');
  assert.doesNotMatch(source, /createRequire\([^)]*codex-sdk/, 'Codex SDK was bundled with a build-host filename');
  return [...source.matchAll(/([A-Za-z_$][\w$]*)=>\{\1\.exports=import\(["']@openai\/codex-sdk["']\)\}/g)].map(match => match[0]);
}

export function claudeExternalFactories(source) {
  assert.doesNotMatch(source, /file:\/\/\/[^"'\s]*claude-agent-sdk/, 'Claude SDK contains a build-host file URL');
  assert.doesNotMatch(source, /createRequire\)?\([^)]*claude-agent-sdk/, 'Claude SDK was bundled with a build-host filename');
  return [...source.matchAll(/([A-Za-z_$][\w$]*)=>\{\1\.exports=import\(["']@anthropic-ai\/claude-agent-sdk["']\)\}/g)].map(match => match[0]);
}

const claudeProbe = `
import { createRequire } from 'node:module';
import { existsSync, statSync } from 'node:fs';
for (const factory of factories) {
  const module = {};
  factory(module);
  const sdk = await module.exports;
  for (const name of ['query', 'tool', 'createSdkMcpServer']) assert.equal(typeof sdk[name], 'function');
}
// Resolve only: query() would start Claude, even with an already-aborted signal.
const sdkEntry = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk');
const sdkRequire = createRequire(sdkEntry);
const { platform, arch } = process;
const musl = platform === 'linux' && typeof process.report?.getReport === 'function'
  && process.report.getReport().header?.glibcVersionRuntime === undefined;
const targets = platform === 'android' ? ['linux-' + arch + '-android']
  : platform === 'linux' ? (musl ? ['linux-' + arch + '-musl', 'linux-' + arch] : ['linux-' + arch, 'linux-' + arch + '-musl'])
  : [platform + '-' + arch];
let executable;
for (const target of targets) {
  try {
    const candidate = sdkRequire.resolve('@anthropic-ai/claude-agent-sdk-' + target + '/claude' + (platform === 'win32' ? '.exe' : ''));
    if (existsSync(candidate) && statSync(candidate).isFile()) { executable = candidate; break; }
  } catch {}
}
assert.ok(executable, 'Relocated Claude SDK cannot resolve its installed native executable for ' + platform + '-' + arch);
`;

async function verifyBuiltImport(root, provider, externalFactories, probe) {
  const factories = new Set();
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else if (entry.name.endsWith('.js')) {
        for (const factory of externalFactories(await readFile(filename, 'utf8'))) factories.add(factory);
      }
    }
  }
  await visit(path.join(root, '.next/server'));
  assert.ok(factories.size, `Production server does not contain a native ${provider} SDK import`);
  const prefix = `flujo-${provider.toLowerCase()}-built-import-`;
  const fixture = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    // Different application location, same installed dependency closure. No
    // credentials, runtime-home creation, CLI launch, or provider request.
    await symlink(path.join(root, 'node_modules'), path.join(fixture, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    await writeFile(path.join(fixture, 'probe.mjs'), `import assert from 'node:assert/strict';\nconst factories = [${[...factories].join(',')}];\n${probe}\n`);
    const result = spawnSync(process.execPath, [path.join(fixture, 'probe.mjs')], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    return factories.size;
  } finally {
    assert.equal(path.dirname(path.resolve(fixture)), path.resolve(os.tmpdir()), 'Unexpected fixture cleanup directory');
    assert.ok(path.basename(fixture).startsWith(prefix), 'Unexpected fixture cleanup name');
    // Remove the junction first: never recursively traverse installed modules.
    await rm(path.join(fixture, 'node_modules'), { force: true });
    await rm(fixture, { recursive: true, force: true });
  }
}

export async function verifyCodexBuiltImport(root) {
  return verifyBuiltImport(root, 'Codex', codexExternalFactories, `for (const factory of factories) { const module = {}; factory(module); const { Codex } = await module.exports; assert.equal(typeof Codex, 'function'); const codex = new Codex(); assert.equal(typeof codex.startThread, 'function'); }`);
}

export async function verifyClaudeBuiltImport(root) {
  return verifyBuiltImport(root, 'Claude', claudeExternalFactories, claudeProbe);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] ?? '.');
  const codexCount = await verifyCodexBuiltImport(root);
  console.log(`Codex production import: ${codexCount} emitted external factory variants passed from a relocated runtime.`);
  const claudeCount = await verifyClaudeBuiltImport(root);
  console.log(`Claude production import: ${claudeCount} emitted external factory variants and native executable resolution passed from a relocated runtime.`);
}
