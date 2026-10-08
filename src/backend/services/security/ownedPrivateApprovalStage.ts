import fs, { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { readPrivateApprovalAsync } from './trustedHostMcp';

function same(first: fs.BigIntStats, second: fs.BigIntStats): boolean {
  return first.dev === second.dev && first.ino === second.ino && first.size === second.size
    && first.mtimeNs === second.mtimeNs && first.ctimeNs === second.ctimeNs && first.mode === second.mode
    && first.uid === second.uid && first.gid === second.gid && first.nlink === second.nlink;
}

/** Keep the created object open; foreign replacement paths are never cleaned up. */
export async function createOwnedPrivateApprovalStage(filename: string, value: unknown, signal: AbortSignal) {
  const stage = path.join(path.dirname(filename), `.flujo-mcp-consent-${randomUUID()}`);
  const content = Buffer.from(JSON.stringify(value));
  if (content.length > 64 * 1024) throw new Error('Approval ledger exceeds its bound.');
  const expectedDigest = createHash('sha256').update(content).digest('hex');
  const handle = await fs.promises.open(stage, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  let published = false;
  let identity: fs.BigIntStats;
  const owned = async () => {
    const held = await handle.stat({ bigint: true });
    const named = await fs.promises.lstat(stage, { bigint: true });
    return held.isFile() && named.isFile() && !named.isSymbolicLink() && held.nlink === BigInt(1)
      && held.dev === named.dev && held.ino === named.ino;
  };
  const dispose = async () => {
    try {
      if (!published && await owned()) await fs.promises.unlink(stage);
    } finally { content.fill(0); await handle.close(); }
  };
  try {
    await handle.writeFile(content); await handle.sync();
    identity = await handle.stat({ bigint: true });
    await readPrivateApprovalAsync(stage, signal);
  } catch (error) { await dispose(); throw error; }
  return {
    path: stage,
    async publish(destination: string, beforeEffect?: () => void) {
      if (path.dirname(destination) !== path.dirname(stage) || signal.aborted) throw new Error('Approval publication retired.');
      await readPrivateApprovalAsync(stage, signal);
      if (!same(identity, await handle.stat({ bigint: true })) || !await owned()) throw new Error('Owned approval stage changed.');
      const bytes = Buffer.alloc(content.length + 1);
      try {
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        if (bytesRead !== content.length || createHash('sha256').update(bytes.subarray(0, bytesRead)).digest('hex') !== expectedDigest
            || !same(identity, await handle.stat({ bigint: true })) || !same(identity, await fs.promises.lstat(stage, { bigint: true }))) throw new Error('Owned approval bytes changed.');
      } finally { bytes.fill(0); }
      if (signal.aborted) throw new Error('Approval publication retired.');
      beforeEffect?.();
      await fs.promises.rename(stage, destination); published = true;
    },
    dispose,
  };
}
