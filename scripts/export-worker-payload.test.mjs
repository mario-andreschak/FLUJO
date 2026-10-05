import assert from 'node:assert/strict';
import test from 'node:test';
import { nativePeArchitecture, packPath, safeRelative } from './export-worker-payload.mjs';

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
});
test('native header inventory requires actual Windows x64 PE headers', () => {
  const header = Buffer.alloc(128); header.write('MZ'); header.writeUInt32LE(64, 60);
  header.write('PE\0\0', 64, 'ascii'); header.writeUInt16LE(0x8664, 68);
  assert.equal(nativePeArchitecture(header), 'win32-x64');
  header.writeUInt16LE(0xaa64, 68); assert.throws(() => nativePeArchitecture(header));
  assert.throws(() => nativePeArchitecture(Buffer.from('ELF synthetic')));
});
