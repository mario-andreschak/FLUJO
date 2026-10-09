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

export async function verifyCodexBuiltImport(root) {
  const factories = new Set();
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else if (entry.name.endsWith('.js')) {
        for (const factory of codexExternalFactories(await readFile(filename, 'utf8'))) factories.add(factory);
      }
    }
  }
  await visit(path.join(root, '.next/server'));
  assert.ok(factories.size, 'Production server does not contain a native Codex SDK import');
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'flujo-codex-built-import-'));
  try {
    // Different application location, same installed dependency closure. No
    // credentials, runtime-home creation, CLI launch, or provider request.
    await symlink(path.join(root, 'node_modules'), path.join(fixture, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    await writeFile(path.join(fixture, 'probe.mjs'), `import assert from 'node:assert/strict';\nfor (const factory of [${[...factories].join(',')}]) { const module = {}; factory(module); const { Codex } = await module.exports; assert.equal(typeof Codex, 'function'); const codex = new Codex(); assert.equal(typeof codex.startThread, 'function'); }\n`);
    const result = spawnSync(process.execPath, [path.join(fixture, 'probe.mjs')], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    return factories.size;
  } finally {
    assert.equal(path.dirname(path.resolve(fixture)), path.resolve(os.tmpdir()), 'Unexpected fixture cleanup directory');
    assert.ok(path.basename(fixture).startsWith('flujo-codex-built-import-'), 'Unexpected fixture cleanup name');
    // Remove the junction first: never recursively traverse installed modules.
    await rm(path.join(fixture, 'node_modules'), { force: true });
    await rm(fixture, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const count = await verifyCodexBuiltImport(path.resolve(process.argv[2] ?? '.'));
  console.log(`Codex production import: ${count} emitted external factory variants passed from a relocated runtime.`);
}
