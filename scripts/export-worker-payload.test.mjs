import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPackageFilePatterns, nativePeArchitecture, packageFilePatterns, packPath, safeRelative } from './export-worker-payload.mjs';
import { assertExportRoute } from './worker-payload-route.mjs';

test('payload rejects traversal, absolute paths and Windows alternate streams', () => {
  for (const name of ['../secret', '/absolute', 'C:/secret', 'a/../b', 'a\\b', 'a.txt:stream']) {
    assert.throws(() => safeRelative(name));
  }
});
test('payload rejects live data, credential files and transient Next output', () => {
  for (const name of ['.env', 'a/.env.production', '.npmrc', '.git/config', 'userdata/result.json',
    'workspaces/work/db/models.json', '.next/cache/compiler.bin', '.next/dev/lock']) assert.throws(() => safeRelative(name));
});
test('package selection admits compiled runtime files and refuses arbitrary source', () => {
  for (const name of ['.next/BUILD_ID', 'scripts/launch-next.mjs', 'mcp-servers/filesystem/dist/index.js', 'bin/node-runtime.mjs']) {
    assert.equal(packPath(name), name);
  }
  assert.throws(() => packPath('src/backend/engine/index.ts'));
  assert.throws(() => packPath('scripts/smoke-cloud-worker.mjs'));
  for (const name of ['scripts/export-worker-payload.mjs', 'scripts/export-worker-payload.test.mjs',
    'scripts/worker-payload-route.mjs']) assert.throws(() => packPath(name), /proposal modules/);
});

test('immutable package pattern audit refuses broadened or missing package selection', () => {
  assert.doesNotThrow(() => assertPackageFilePatterns({ files: [...packageFilePatterns] }));
  assert.throws(() => assertPackageFilePatterns({ files: [...packageFilePatterns, 'scripts/**/*'] }));
  assert.throws(() => assertPackageFilePatterns({ files: packageFilePatterns.slice(1) }));
});

const route = () => ({ eventName: 'pull_request', repository: 'mario-andreschak/FLUJO', workflowSha: 'a'.repeat(40),
  proposalSha: 'b'.repeat(40), runAttempt: '1', event: { action: 'ready_for_review', pull_request: { draft: false,
    head: { ref: 'codex/worker-payload-export-pr-route-8fe', sha: 'b'.repeat(40), repo: { full_name: 'mario-andreschak/FLUJO' } },
    base: { ref: 'codex/scorecard-integration', repo: { full_name: 'mario-andreschak/FLUJO' } } } } });

test('bounded artifact route accepts only the selected same-repository proposal event', () => {
  assert.equal(assertExportRoute(route()).proposalSha, 'b'.repeat(40));
});

test('draft publication, fork, unrelated branch, source mismatch and rerun cannot export', () => {
  const cases = [
    value => { value.event.pull_request.draft = true; },
    value => { value.event.action = 'opened'; },
    value => { value.event.action = 'synchronize'; },
    value => { value.event.pull_request.head.repo.full_name = 'outside/FLUJO'; },
    value => { value.event.pull_request.head.ref = 'codex/unrelated'; },
    value => { value.event.pull_request.base.ref = 'main'; },
    value => { value.proposalSha = 'c'.repeat(40); },
    value => { value.runAttempt = '2'; },
    value => { value.eventName = 'pull_request_target'; },
  ];
  for (const change of cases) { const value = route(); change(value); assert.throws(() => assertExportRoute(value)); }
});
test('native header inventory requires actual Windows x64 PE headers', () => {
  const header = Buffer.alloc(128); header.write('MZ'); header.writeUInt32LE(64, 60);
  header.write('PE\0\0', 64, 'ascii'); header.writeUInt16LE(0x8664, 68);
  assert.equal(nativePeArchitecture(header), 'win32-x64');
  header.writeUInt16LE(0xaa64, 68); assert.throws(() => nativePeArchitecture(header));
  assert.throws(() => nativePeArchitecture(Buffer.from('ELF synthetic')));
});
