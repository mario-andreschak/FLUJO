import { AsyncLocalStorage } from 'node:async_hooks';
import { promises as fs, type BigIntStats } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { readPlainFile } from '@/utils/readPlainFile';
import type { RuntimeProcessIdentity } from '../enduringAgents/runtimeLock';

export type SnapshotOperationKind = 'capture' | 'read' | 'revert' | 'cleanup' | 'migration';

interface SnapshotLeaseContext {
  heldKeys: Set<string>;
}

interface SnapshotLeaseOwner {
  pid: number;
  startedAt: string;
  operation: SnapshotOperationKind;
  ownerId?: string;
  identity?: RuntimeProcessIdentity;
}

interface ObservedOwner {
  owner: SnapshotLeaseOwner;
  digest: string;
  directory: BigIntStats;
}

declare global {
  var __flujoSnapshotOperationTails: Map<string, Promise<void>> | undefined;
  var __flujoSnapshotOperationContext: AsyncLocalStorage<SnapshotLeaseContext> | undefined;
  var __flujoSnapshotOperationActivity: Map<string, Map<SnapshotOperationKind, number>> | undefined;
}

const tails = globalThis.__flujoSnapshotOperationTails
  ?? (globalThis.__flujoSnapshotOperationTails = new Map());
const context = globalThis.__flujoSnapshotOperationContext
  ?? (globalThis.__flujoSnapshotOperationContext = new AsyncLocalStorage());
const activity = globalThis.__flujoSnapshotOperationActivity
  ?? (globalThis.__flujoSnapshotOperationActivity = new Map());

export class SnapshotLeaseBusyError extends Error {
  readonly code = 'SNAPSHOT_STORE_BUSY';

  constructor() {
    super('Snapshot storage is temporarily busy');
    this.name = 'SnapshotLeaseBusyError';
  }
}

function keyFor(root: string): string {
  const resolved = path.resolve(root);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function lockDirectory(root: string): string {
  return `${path.resolve(root)}.operation-lock`;
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function sameDirectory(first: BigIntStats, second: BigIntStats): boolean {
  return second.isDirectory() && !second.isSymbolicLink() && first.dev === second.dev && first.ino === second.ino
    && first.mode === second.mode && first.uid === second.uid && first.gid === second.gid;
}

async function readOwner(root: string): Promise<ObservedOwner | undefined> {
  try {
    const lock = lockDirectory(root);
    const directory = await fs.lstat(lock, { bigint: true });
    if (!directory.isDirectory() || directory.isSymbolicLink()) return undefined;
    const bytes = await readPlainFile(path.join(lock, 'owner.json'), { maxBytes: 4096, ownerOnly: true });
    if (!sameDirectory(directory, await fs.lstat(lock, { bigint: true }))) return undefined;
    const value = JSON.parse(bytes.toString('utf8')) as Partial<SnapshotLeaseOwner>;
    if (
      Number.isSafeInteger(value.pid)
      && value.pid! > 0
      && typeof value.startedAt === 'string'
      && Number.isFinite(Date.parse(value.startedAt))
      && ['capture', 'read', 'revert', 'cleanup', 'migration'].includes(value.operation!)
      && (value.ownerId === undefined || /^[a-f0-9-]{36}$/.test(value.ownerId))
      && (value.identity === undefined || (value.identity.pid === value.pid
        && typeof value.identity.processInstanceId === 'string'
        && (value.identity.processBirthMarkerV2 === undefined || typeof value.identity.processBirthMarkerV2 === 'string')))
    ) {
      return { owner: value as SnapshotLeaseOwner, digest: createHash('sha256').update(bytes).digest('hex'), directory };
    }
  } catch {
    // Missing/partial/unreadable ownership is uncertainty, never proof of death.
  }
  return undefined;
}

async function withLeaseTransition<T>(root: string, task: (assertOwned: () => Promise<void>) => Promise<T>): Promise<T> {
  // All publishers and reapers in the selected workspace use the existing
  // owner-generation/recovery-intent protocol. A stale observation is checked
  // again under that fence before it can create or remove an entry.
  const { withWorkspaceRuntimeLock } = await import('../enduringAgents/runtimeLock');
  const name = `snapshot_transition_${createHash('sha256').update(keyFor(root)).digest('hex').slice(0, 40)}`;
  return withWorkspaceRuntimeLock(name, async fence => {
    await fence.assertOwned();
    return task(() => fence.assertOwned());
  });
}

async function retireOwner(root: string, observed: ObservedOwner, requireDead = false): Promise<boolean> {
  return withLeaseTransition(root, async assertOwned => {
    const admitted = await readOwner(root);
    if (!admitted || admitted.digest !== observed.digest || !sameDirectory(observed.directory, admitted.directory)) return false;
    if (requireDead) {
      const { isRuntimeProcessIdentityAlive } = await import('../enduringAgents/runtimeLock');
      if (admitted.owner.identity ? await isRuntimeProcessIdentityAlive(admitted.owner.identity) : processAlive(admitted.owner.pid)) return false;
    }
    const lock = lockDirectory(root);
    const retirementPath = path.join(lock, 'retire.json');
    const nonce = randomUUID();
    let handle;
    await assertOwned();
    try { handle = await fs.open(retirementPath, 'wx', 0o600); }
    catch (error) {
      if (['EEXIST', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
      throw error;
    }
    try { await handle.writeFile(JSON.stringify({ nonce, targetDigest: observed.digest })); }
    finally { await handle.close(); }
    const current = await readOwner(root);
    if (!current || current.digest !== observed.digest || !sameDirectory(observed.directory, current.directory)) {
      // Do not unlink a pathname that may now belong to a successor.
      return false;
    }
    // Only one retire.json can be installed in a published generation. The winner
    // moves that complete directory away before a successor can publish. Competing
    // reapers must re-read the owner after their exclusive claim, not reuse a PID.
    const retired = `${lock}.retired-${nonce}`;
    await assertOwned();
    await fs.rename(lock, retired);
    const moved = await fs.lstat(retired, { bigint: true });
    if (!sameDirectory(observed.directory, moved)) throw new SnapshotLeaseBusyError();
    const ownerBytes = await readPlainFile(path.join(retired, 'owner.json'), { maxBytes: 4096, ownerOnly: true });
    const retirement = JSON.parse((await readPlainFile(path.join(retired, 'retire.json'), { maxBytes: 4096, ownerOnly: true })).toString('utf8'));
    if (createHash('sha256').update(ownerBytes).digest('hex') !== observed.digest || retirement.nonce !== nonce) {
      throw new SnapshotLeaseBusyError();
    }
    // Never recursively delete a raced pathname or unexpected entries.
    await assertOwned();
    await fs.unlink(path.join(retired, 'owner.json'));
    await fs.unlink(path.join(retired, 'retire.json'));
    await fs.rmdir(retired);
    return true;
  });
}

async function acquireFilesystemLease(
  root: string,
  operation: SnapshotOperationKind,
): Promise<() => Promise<void>> {
  const lock = lockDirectory(root);
  await fs.mkdir(path.dirname(lock), { recursive: true });
  const { getRuntimeProcessIdentity, isRuntimeProcessIdentityAlive } = await import('../enduringAgents/runtimeLock');
  const owner: SnapshotLeaseOwner = {
    pid: process.pid, startedAt: new Date().toISOString(), operation,
    ownerId: randomUUID(), identity: await getRuntimeProcessIdentity(),
  };
  // Publish a complete private directory atomically. No process observes a
  // directory before its owner record exists, or executes shared temp contents.
  const candidate = await fs.mkdtemp(`${lock}.candidate-`);
  await fs.chmod(candidate, 0o700);
  const candidateDirectory = await fs.lstat(candidate, { bigint: true });
  const candidateOwnerPath = path.join(candidate, 'owner.json');
  let candidateOwner: BigIntStats | undefined;
  let published = false;
  try {
    const ownerHandle = await fs.open(candidateOwnerPath, 'wx', 0o600);
    try {
      candidateOwner = await ownerHandle.stat({ bigint: true });
      await ownerHandle.writeFile(JSON.stringify(owner));
      await ownerHandle.sync();
      candidateOwner = await ownerHandle.stat({ bigint: true });
    }
    finally { await ownerHandle.close(); }
    for (let attempt = 0; attempt < 50; attempt += 1) {
      let exists = false;
      try { await fs.lstat(lock); exists = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (!exists) {
        try {
          const release = await withLeaseTransition(root, async assertOwned => {
            try { await fs.lstat(lock); return undefined; }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
            await assertOwned();
            if (!sameDirectory(candidateDirectory, await fs.lstat(candidate, { bigint: true }))) throw new SnapshotLeaseBusyError();
            await readPlainFile(candidateOwnerPath, { expected: candidateOwner, maxBytes: 4096, ownerOnly: true });
            await fs.rename(candidate, lock);
            published = true;
            const admitted = await readOwner(root);
            if (!admitted || admitted.owner.ownerId !== owner.ownerId || !sameDirectory(candidateDirectory, admitted.directory)) throw new SnapshotLeaseBusyError();
            return async () => {
              const current = await readOwner(root);
              if (!current || current.owner.ownerId !== owner.ownerId || current.digest !== admitted.digest
                  || !sameDirectory(admitted.directory, current.directory)) throw new SnapshotLeaseBusyError();
              if (!await retireOwner(root, current)) throw new SnapshotLeaseBusyError();
            };
          });
          if (release) return release;
        } catch (error) {
          if (published || !['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        }
      }
      const previous = await readOwner(root);
      if (previous && !(previous.owner.identity
        ? await isRuntimeProcessIdentityAlive(previous.owner.identity)
        : processAlive(previous.owner.pid))) {
        if (await retireOwner(root, previous, true)) continue;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 50);
        timer.unref?.();
      });
    }
    throw new SnapshotLeaseBusyError();
  } finally {
    if (!published) {
      try {
        if (sameDirectory(candidateDirectory, await fs.lstat(candidate, { bigint: true }))) {
          const current = await fs.lstat(candidateOwnerPath, { bigint: true }).catch(() => undefined);
          if (candidateOwner && current?.isFile() && !current.isSymbolicLink()
              && current.dev === candidateOwner.dev && current.ino === candidateOwner.ino) await fs.unlink(candidateOwnerPath);
          if (sameDirectory(candidateDirectory, await fs.lstat(candidate, { bigint: true }))) await fs.rmdir(candidate);
        }
      } catch { /* preserve uncertain or unowned candidate entries */ }
    }
  }
}

function changeActivity(root: string, operation: SnapshotOperationKind, delta: 1 | -1): void {
  const key = keyFor(root);
  const counts = activity.get(key) ?? new Map<SnapshotOperationKind, number>();
  const next = Math.max(0, (counts.get(operation) ?? 0) + delta);
  if (next === 0) counts.delete(operation);
  else counts.set(operation, next);
  if (counts.size === 0) activity.delete(key);
  else activity.set(key, counts);
}

export function snapshotOperationActivity(
  root: string,
): Readonly<Record<SnapshotOperationKind, number>> {
  const counts = activity.get(keyFor(root));
  return {
    capture: counts?.get('capture') ?? 0,
    read: counts?.get('read') ?? 0,
    revert: counts?.get('revert') ?? 0,
    cleanup: counts?.get('cleanup') ?? 0,
    migration: counts?.get('migration') ?? 0,
  };
}

/**
 * Serialize every operation that can observe or mutate one workspace snapshot
 * store. Async-local ownership makes nested reads/reverts re-entrant, while the
 * atomic directory lease composes across Next workers and migration processes.
 */
export async function withSnapshotStoreLease<T>(
  root: string,
  operation: SnapshotOperationKind,
  task: () => Promise<T>,
  options: { failIfBusy?: boolean } = {},
): Promise<T> {
  const key = keyFor(root);
  const inherited = context.getStore();
  if (inherited?.heldKeys.has(key)) {
    changeActivity(root, operation, 1);
    try {
      return await task();
    } finally {
      changeActivity(root, operation, -1);
    }
  }

  if (options.failIfBusy && tails.has(key)) throw new SnapshotLeaseBusyError();

  const predecessor = tails.get(key) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const current = new Promise<void>((resolve) => { releaseQueue = resolve; });
  const tail = predecessor.catch(() => undefined).then(() => current);
  tails.set(key, tail);

  await predecessor.catch(() => undefined);
  const releaseFilesystem = await acquireFilesystemLease(root, operation).catch((error) => {
    releaseQueue();
    if (tails.get(key) === tail) tails.delete(key);
    throw error;
  });
  const heldKeys = new Set(inherited?.heldKeys ?? []);
  heldKeys.add(key);
  changeActivity(root, operation, 1);
  try {
    return await context.run({ heldKeys }, task);
  } finally {
    changeActivity(root, operation, -1);
    try { await releaseFilesystem(); }
    finally {
      releaseQueue();
      if (tails.get(key) === tail) tails.delete(key);
    }
  }
}

/** Acquire several stores in deterministic order, used by snapshot migration. */
export async function withSnapshotMigrationLeases<T>(
  roots: readonly string[],
  task: () => Promise<T>,
): Promise<T> {
  const unique = [...new Set(roots.map(root => path.resolve(root)))].sort();
  const acquire = (index: number): Promise<T> => (
    index >= unique.length
      ? task()
      : withSnapshotStoreLease(unique[index], 'migration', () => acquire(index + 1))
  );
  return acquire(0);
}
