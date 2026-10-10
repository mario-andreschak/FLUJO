import fs, { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { readPrivateApprovalAsync } from './trustedHostMcp';

/** Cross-process cooperating writers never remove or steal an existing lock. */
export async function withPrivateApprovalLedgerLock<T>(filename: string, signal: AbortSignal, action: () => Promise<T>): Promise<T> {
  await readPrivateApprovalAsync(filename, signal);
  const lock = `${filename}.writer-lock`;
  const deadline = Date.now() + 5000;
  let handle: fs.promises.FileHandle;
  while (true) {
    if (signal.aborted || Date.now() >= deadline) throw new Error('Private approval writer unavailable.');
    try {
      handle = await fs.promises.open(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await new Promise<void>(resolve => setTimeout(resolve, 25));
    }
  }
  try {
    await handle.writeFile(JSON.stringify({ schemaVersion: 1, nonce: randomUUID() }));
    await handle.sync();
    await readPrivateApprovalAsync(lock, signal);
    if (signal.aborted) throw new Error('Private approval request retired.');
    return await action();
  } finally {
    try {
      const held = await handle.stat({ bigint: true });
      const named = await fs.promises.lstat(lock, { bigint: true });
      if (!held.isFile() || !named.isFile() || named.isSymbolicLink() || held.nlink !== BigInt(1)
          || held.dev !== named.dev || held.ino !== named.ino) throw new Error('Private writer lock identity changed; cleanup refused.');
      await fs.promises.unlink(lock);
    } finally { await handle.close(); }
  }
}
