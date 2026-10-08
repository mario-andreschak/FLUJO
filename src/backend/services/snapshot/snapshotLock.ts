import { AsyncLocalStorage } from 'node:async_hooks';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export type SnapshotOperationKind = 'capture' | 'read' | 'revert' | 'cleanup' | 'migration';

interface SnapshotLeaseContext {
  heldKeys: Set<string>;
}

interface SnapshotLeaseOwner {
  pid: number;
  startedAt: string;
  operation: SnapshotOperationKind;
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
  return path.resolve(root).toLowerCase();
}

function lockDirectory(root: string): string {
  return `${path.resolve(root)}.operation-lock`;
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readOwner(root: string): Promise<SnapshotLeaseOwner | undefined> {
  try {
    const value = JSON.parse(
      await fs.readFile(path.join(lockDirectory(root), 'owner.json'), 'utf8'),
    ) as Partial<SnapshotLeaseOwner>;
    if (
      Number.isSafeInteger(value.pid)
      && typeof value.startedAt === 'string'
      && typeof value.operation === 'string'
    ) {
      return value as SnapshotLeaseOwner;
    }
  } catch {
    // A partial owner record is stale once no live process can be identified.
  }
  return undefined;
}

async function acquireFilesystemLease(
  root: string,
  operation: SnapshotOperationKind,
): Promise<() => Promise<void>> {
  const lock = lockDirectory(root);
  await fs.mkdir(path.dirname(lock), { recursive: true });

  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await fs.mkdir(lock);
      const owner: SnapshotLeaseOwner = {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        operation,
      };
      await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify(owner), 'utf8');
      return async () => {
        const current = await readOwner(root);
        if (current?.pid === process.pid) {
          await fs.rm(lock, { recursive: true, force: true });
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = await readOwner(root);
      if (!owner || !processAlive(owner.pid)) {
        await fs.rm(lock, { recursive: true, force: true });
        continue;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 50);
        timer.unref?.();
      });
    }
  }

  throw new SnapshotLeaseBusyError();
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
    await releaseFilesystem();
    releaseQueue();
    if (tails.get(key) === tail) tails.delete(key);
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
