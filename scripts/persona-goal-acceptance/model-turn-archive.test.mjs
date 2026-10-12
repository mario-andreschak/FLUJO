import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { readRuntimeModelTurnArchive } from './model-turn-archive.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test('collector retains v1 outcomes and binds v2 outcomes to both source hashes across a fresh process', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-turn-evidence-'));
  try {
    const dir = path.join(root, 'conversation');
    await fs.mkdir(dir);
    for (const version of [1, 2]) {
      const filename = path.join(dir, `dispatch${version}${version === 2 ? '.v2' : ''}.json.gz`);
      const bytes = gzipSync(JSON.stringify({ version, entry: {
        id: `dispatch${version}`, conversationId: 'conversation', archiveVersion: version,
        outcome: version === 1 ? 'completed' : 'running', attempt: version,
      }, canonicalMessages: [{ content: 'immutable context' }], media: [] }));
      await fs.writeFile(filename, bytes);
      const initial = await readRuntimeModelTurnArchive(filename);
      assert.equal(initial.outcome, version === 1 ? 'completed' : 'running');
      assert.equal(initial.sourceFileSha256, sha256(bytes));
      assert.equal(initial.sourceOutcomeSha256, undefined);
      if (version === 2) {
        const payload = Buffer.from(JSON.stringify({ version: 1, archiveVersion: 2,
          conversationId: 'conversation', dispatchId: 'dispatch2', outcome: 'error' }));
        await fs.writeFile(path.join(dir, 'dispatch2.outcome.json'), payload);
        const fresh = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
          'import { readRuntimeModelTurnArchive } from ' + JSON.stringify(new URL('./model-turn-archive.mjs', import.meta.url).href)
          + '; process.stdout.write(JSON.stringify(await readRuntimeModelTurnArchive(process.argv[1])));', filename,
        ], { encoding: 'utf8', windowsHide: true }));
        assert.equal(fresh.outcome, 'error');
        assert.equal(fresh.sourceOutcomeSha256, sha256(payload));
        assert.equal(fresh.sourceFileSha256, sha256(bytes));
      }
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('collector rejects foreign, oversized, unsupported or contradictory v2 evidence', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-turn-invalid-'));
  try {
    const dir = path.join(root, 'conversation');
    await fs.mkdir(dir);
    const filename = path.join(dir, 'dispatch.v2.json.gz');
    const snapshot = { version: 2, entry: { id: 'dispatch', conversationId: 'conversation', archiveVersion: 2, outcome: 'running' } };
    await fs.writeFile(filename, gzipSync(JSON.stringify(snapshot)));
    const outcomePath = path.join(dir, 'dispatch.outcome.json');
    const record = { version: 1, archiveVersion: 2, conversationId: 'conversation', dispatchId: 'dispatch', outcome: 'cancelled' };
    for (const invalid of [{ ...record, dispatchId: 'other' }, { ...record, conversationId: 'other' },
      { ...record, outcome: 'running' }, { ...record, archiveVersion: 1 }, { ...record, extra: true }]) {
      await fs.writeFile(outcomePath, JSON.stringify(invalid));
      await assert.rejects(readRuntimeModelTurnArchive(filename), /outcome identity/);
    }
    await fs.writeFile(outcomePath, Buffer.alloc(1025, 32));
    await assert.rejects(readRuntimeModelTurnArchive(filename), /byte limit/);
    await fs.unlink(outcomePath);
    for (const invalid of [{ ...snapshot, version: 3 }, { ...snapshot, entry: { ...snapshot.entry, id: 'other' } },
      { ...snapshot, entry: { ...snapshot.entry, outcome: 'completed' } }]) {
      await fs.writeFile(filename, gzipSync(JSON.stringify(invalid)));
      await assert.rejects(readRuntimeModelTurnArchive(filename));
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
