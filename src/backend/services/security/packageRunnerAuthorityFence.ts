import fs, { constants, type BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { readPrivateApprovalSetAsync, readPrivateApprovalSet } from './trustedHostMcp';

const same = (a: BigIntStats, b: BigIntStats) =>
  (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'gid', 'nlink'] as const).every(key => a[key] === b[key]);
function parents(filename: string) {
  let parent = path.dirname(filename);
  for (;;) {
    const stat = fs.lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Linked authority fence parent');
    const next = path.dirname(parent); if (next === parent) break; parent = next;
  }
}
/** A held-file fence complements existing native private authority checks.
 * It rejects mutation/replacement through staged publication awaits. The final
 * validation + rename is NOT an OS-atomic compare-and-swap against a malicious
 * same-account writer; only cooperating ledger writers serialize on the lock.
 */
export async function capturePackageRunnerAuthorityFence(input: readonly string[], signal?: AbortSignal) {
  const files = Object.freeze([...input]);
  if (!files.length || files.length > 4 || files.some(filename => !path.isAbsolute(filename))) throw new Error('Invalid authority fence set');
  const values = await readPrivateApprovalSetAsync(files, signal);
  const held: Array<{ handle: FileHandle; filename: string; identity: BigIntStats | undefined; bytes: Buffer }> = [];
  async function dispose() {
    const failures: unknown[] = [];
    for (const item of [...held]) {
      try { await item.handle.close(); item.bytes.fill(0); held.splice(held.indexOf(item), 1); }
      catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Held runner authority close remains unresolved');
  }
  try {
    for (let index = 0; index < files.length; index++) {
      signal?.throwIfAborted();
      const filename = files[index]; parents(filename);
      const handle = await fs.promises.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      const item = { handle, filename, identity: undefined as BigIntStats | undefined, bytes: Buffer.alloc(0) };
      held.push(item);
      item.identity = await handle.stat({ bigint: true });
      const named = await fs.promises.lstat(filename, { bigint: true });
      if (!item.identity.isFile() || named.isSymbolicLink() || item.identity.nlink !== BigInt(1)
          || !same(item.identity, named) || item.identity.size > BigInt(64 * 1024)) throw new Error('Unsafe held authority object');
      item.bytes = Buffer.alloc(Number(item.identity.size) + 1);
      let offset = 0;
      while (offset < item.bytes.length) {
        const { bytesRead } = await handle.read(item.bytes, offset, item.bytes.length - offset, offset);
        if (!bytesRead) break; offset += bytesRead;
      }
      if (BigInt(offset) !== item.identity.size || !same(item.identity, await handle.stat({ bigint: true }))
          || JSON.stringify(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(item.bytes.subarray(0, offset)))) !== JSON.stringify(values[index])) {
        throw new Error('Held authority bytes differ from admitted private authority');
      }
      item.bytes = item.bytes.subarray(0, offset);
    }
  } catch (primary) {
    try { await dispose(); } catch (cleanup) {
      throw Object.assign(new AggregateError([primary, cleanup], 'Authority capture/close failed'), { dispose });
    }
    throw primary;
  }
  return {
    values,
    assertCurrent() {
      signal?.throwIfAborted();
      if (held.length !== files.length || JSON.stringify(readPrivateApprovalSet(files, signal)) !== JSON.stringify(values)) {
        throw new Error('Current native authority revision changed');
      }
      for (const item of held) {
        parents(item.filename);
        const named = fs.lstatSync(item.filename, { bigint: true });
        if (!item.identity || !named.isFile() || named.isSymbolicLink() || !same(item.identity, named)
            || !same(item.identity, fs.fstatSync(item.handle.fd, { bigint: true }))) throw new Error('Held/named authority identity changed');
        const bytes = Buffer.alloc(item.bytes.length + 1);
        try {
          let offset = 0;
          while (offset < bytes.length) {
            const count = fs.readSync(item.handle.fd, bytes, offset, bytes.length - offset, offset);
            if (!count) break; offset += count;
          }
          if (offset !== item.bytes.length || !bytes.subarray(0, offset).equals(item.bytes)
              || !same(item.identity, fs.fstatSync(item.handle.fd, { bigint: true }))
              || !same(item.identity, fs.lstatSync(item.filename, { bigint: true }))) throw new Error('Held authority full bytes changed');
        } finally { bytes.fill(0); }
      }
    },
    dispose,
  };
}
