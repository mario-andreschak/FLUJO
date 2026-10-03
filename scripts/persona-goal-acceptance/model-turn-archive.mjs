import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

// Disk contract: docs/performance/model-turn-archive-v2.md. Keep the outcome
// limit/identity checks aligned with src/shared/types/modelTurn.ts.
const OUTCOME_MAX_BYTES = 1024;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export async function readRuntimeModelTurnArchive(filename) {
  const compressed = await fs.readFile(filename);
  const snapshot = JSON.parse(gunzipSync(compressed).toString('utf8'));
  const turn = snapshot.entry;
  const version2 = filename.endsWith('.v2.json.gz');
  const dispatchId = path.basename(filename).slice(0, version2 ? -11 : -8);
  if (![1, 2].includes(snapshot.version) || snapshot.version !== (version2 ? 2 : 1)
    || turn?.archiveVersion !== snapshot.version || turn.id !== dispatchId
    || turn.conversationId !== path.basename(path.dirname(filename))) {
    throw new Error('Invalid runtime model-turn archive identity');
  }
  let sourceOutcomeSha256;
  if (version2) {
    if (turn.outcome !== 'running') throw new Error('V2 dispatch snapshot must remain immutable');
    let handle;
    try {
      handle = await fs.open(path.join(path.dirname(filename), `${dispatchId}.outcome.json`), 'r');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (handle) {
      try {
        const bytes = Buffer.alloc(OUTCOME_MAX_BYTES + 1);
        let offset = 0;
        while (offset < bytes.length) {
          const chunk = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (!chunk.bytesRead) break;
          offset += chunk.bytesRead;
        }
        if (offset > OUTCOME_MAX_BYTES) throw new Error('Runtime model-turn outcome exceeds byte limit');
        const payload = bytes.subarray(0, offset);
        const outcome = JSON.parse(payload.toString('utf8'));
        if (!outcome || Object.keys(outcome).sort().join(',') !== 'archiveVersion,conversationId,dispatchId,outcome,version'
          || outcome.version !== 1 || outcome.archiveVersion !== 2
          || outcome.conversationId !== turn.conversationId || outcome.dispatchId !== turn.id
          || !['completed', 'error', 'cancelled'].includes(outcome.outcome)) {
          throw new Error('Invalid runtime model-turn outcome identity');
        }
        turn.outcome = outcome.outcome;
        sourceOutcomeSha256 = sha256(payload);
      } finally {
        await handle.close();
      }
    }
  }
  return { ...turn, sourceFileSha256: sha256(compressed), ...(sourceOutcomeSha256 ? { sourceOutcomeSha256 } : {}) };
}
