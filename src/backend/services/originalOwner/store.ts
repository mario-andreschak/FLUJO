import { AsyncLocalStorage } from 'node:async_hooks';
import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getWorkspaceDbDir } from '@/utils/workspace';
import { withWorkspaceRuntimeLock, type PersonaRuntimeLock } from '@/backend/services/enduringAgents/runtimeLock';
import { readNativeHeldFile } from '@/backend/execution/flow/handlers/nativeHeldFile';
import { BookSchema, type OriginalOwnerBook, refuse } from './types';

const MAX_BYTES = 16 * 1024 * 1024;
const empty = (): OriginalOwnerBook => ({ version: 1, accounts: [], enrollments: [], steps: [] });
type HeldBook = { book: OriginalOwnerBook; lock: PersonaRuntimeLock; filename: string; active: boolean };
const scopeRoot = globalThis as typeof globalThis & { __flujoOriginalOwnerBook?: AsyncLocalStorage<HeldBook> };
const held = scopeRoot.__flujoOriginalOwnerBook ??= new AsyncLocalStorage<HeldBook>();
export function originalOwnerFilename(): string {
  // Already excluded from snapshots. This new namespace never opens old host/worker journals.
  return path.join(getWorkspaceDbDir(), 'native-session-origins', 'owner-runtime-v1', 'book.json');
}
async function directories(create: boolean) {
  const database = path.resolve(getWorkspaceDbDir());
  const names = [database, path.join(database, 'native-session-origins'), path.dirname(originalOwnerFilename())];
  for (const directory of names) {
    if (create) await fs.mkdir(directory, { recursive: false, mode: 0o700 }).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || path.relative(directory, await fs.realpath(directory)) !== '') refuse('original_owner_path_changed');
    if (directory !== database && process.platform !== 'win32'
      && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())) refuse('original_owner_path_not_private');
  }
}
export async function readOriginalOwnerBook(): Promise<OriginalOwnerBook> {
  const current = held.getStore();
  if (current?.active && current.filename === originalOwnerFilename()) return current.book;
  let bytes: Buffer;
  try { bytes = await readNativeHeldFile(originalOwnerFilename(), MAX_BYTES, { privateOwner: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty(); throw error; }
  await directories(false);
  try { return BookSchema.parse(JSON.parse(bytes.toString('utf8'))); }
  catch { return refuse('original_owner_journal_invalid'); }
}
/** A single cross-process writer covers account revocation, step CAS and budget reservations. */
export async function mutateOriginalOwnerBook<T>(task: (book: OriginalOwnerBook) => Promise<T>): Promise<T> {
  const current = held.getStore();
  if (current?.active && current.filename === originalOwnerFilename()) { await current.lock.assertOwned(); return task(current.book); }
  return withWorkspaceRuntimeLock('original-owner', async lock => {
    await directories(true);
    const book = await readOriginalOwnerBook();
    const operation: HeldBook = { book, lock, filename: originalOwnerFilename(), active: true };
    try {
      return await held.run(operation, async () => {
        const result = await task(book);
        await flushOriginalOwnerBook();
        return result;
      });
    } finally { operation.active = false; }
  });
}
/** Explicit durability barrier, including nested Parent commits, BEFORE an effect. */
export async function flushOriginalOwnerBook(): Promise<void> {
  const current = held.getStore();
  if (!current?.active || current.filename !== originalOwnerFilename()) refuse('original_owner_writer_required');
  BookSchema.parse(current.book);
  const bytes = Buffer.from(JSON.stringify(current.book));
  if (bytes.length > MAX_BYTES) refuse('original_owner_journal_full');
  const filename = current.filename;
  const temporary = path.join(path.dirname(filename), `.pending-${randomUUID()}`);
  let committed = false;
  const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
    | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    await handle.writeFile(bytes); await handle.sync(); await handle.close();
    await directories(false); await current.lock.assertOwned();
    await fs.rename(temporary, filename); committed = true;
    if (process.platform !== 'win32') {
      const parent = await fs.open(path.dirname(filename), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await parent.sync(); } finally { await parent.close(); }
    }
  } finally {
    await handle.close().catch(() => {});
    if (!committed) await fs.unlink(temporary).catch(() => {});
  }
}
