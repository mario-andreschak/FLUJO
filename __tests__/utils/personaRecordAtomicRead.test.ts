import { promises as fs, type BigIntStats } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readPersonaRecordText } from '@/utils/storage/readPersonaRecord';
import * as strictReader from '@/utils/readPlainFile';

jest.mock('@/utils/readPlainFile', () => {
  const actual = jest.requireActual<typeof import('@/utils/readPlainFile')>('@/utils/readPlainFile');
  return { ...actual, readPlainFile: jest.fn((...args: Parameters<typeof actual.readPlainFile>) => actual.readPlainFile(...args)) };
});

let root: string;
let file: string;
let serial: number;
const before = JSON.stringify({ id: 'record', personaId: 'persona', goal: { pendingDispatchId: 'dispatch' } });
const after = JSON.stringify({ id: 'record', personaId: 'persona', goal: { cancellationRequested: true } });
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-persona-atomic-read-'));
  file = path.join(root, 'collection', 'persona', 'record.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, before, { mode: 0o600 });
  serial = 0;
  jest.mocked(strictReader.readPlainFile).mockImplementation((...args) =>
    jest.requireActual<typeof import('@/utils/readPlainFile')>('@/utils/readPlainFile').readPlainFile(...args));
});
afterEach(async () => {
  jest.restoreAllMocks();
  if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('flujo-persona-atomic-read-')) {
    throw new Error('Unsafe Persona read fixture cleanup');
  }
  await fs.rm(root, { recursive: true, force: true });
});
const read = () => readPersonaRecordText(file, root);
async function replace(content = after, heldDescriptor = false) {
  const temporary = path.join(root, `published-${++serial}.json`);
  await fs.writeFile(temporary, content, { mode: 0o600 });
  // Windows refuses rename-over-open. Its descriptor-held fixture moves the
  // old name aside then publishes; Linux exercises the ordinary atomic replace.
  if (heldDescriptor && process.platform === 'win32') await fs.rename(file, path.join(root, `retired-${serial}.json`));
  await fs.rename(temporary, file);
}
function opens(hook: (attempt: number, handle?: Awaited<ReturnType<typeof fs.open>>) => Promise<void>, afterOpen = false,
  afterRead?: () => Promise<void>) {
  const actualOpen = fs.open.bind(fs);
  const counts = { opened: 0, read: 0, closed: 0 };
  jest.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    if (args[0] !== file) return actualOpen(...args);
    const attempt = ++counts.opened;
    if (!afterOpen) await hook(attempt);
    const handle = await actualOpen(...args);
    const descriptorRead = handle.read.bind(handle);
    // Preserve the real positional-buffer overload used by readPlainFile.
    const positional = handle as unknown as { read(buffer: Buffer, offset: number, length: number, position: number):
      Promise<{ bytesRead: number; buffer: Buffer }> };
    jest.spyOn(positional, 'read').mockImplementation(async (buffer, offset, length, position) => {
      counts.read++;
      const result = await descriptorRead(buffer, offset, length, position);
      await afterRead?.();
      return result;
    });
    const close = handle.close.bind(handle);
    jest.spyOn(handle, 'close').mockImplementation(async () => { counts.closed++; await close(); });
    if (afterOpen) await hook(attempt, handle);
    return handle;
  });
  return counts;
}

it('returns a fully checked record and its matching metadata', async () => {
  const stats = await fs.lstat(file, { bigint: true });
  expect(await read()).toEqual({ content: before, sizeBytes: Buffer.byteLength(before), mtimeMs: Number(stats.mtimeNs) / 1e6 });
});
it('returns null for an initially absent record', async () => {
  await fs.unlink(file);
  expect(await read()).toBeNull();
});
it.each([false, true])('reads fresh cancellation state after named-file publication (%s: replacement after open)', async afterOpen => {
  const counts = opens(async attempt => { if (attempt === 1) await replace(after, afterOpen); }, afterOpen);
  expect((await read())?.content).toBe(after);
  expect(counts).toEqual({ opened: 2, read: 2, closed: 2 });
});
it('retries a replaced snapshot after descriptor bytes were already read', async () => {
  let changed = false;
  const failedPredicates: string[] = [];
  const actualRead = jest.requireActual<typeof import('@/utils/readPlainFile')>('@/utils/readPlainFile').readPlainFile;
  jest.mocked(strictReader.readPlainFile).mockImplementation(async (...args) => {
    try { return await actualRead(...args); }
    catch (error) { failedPredicates.push((error as strictReader.PlainFileReadError).code); throw error; }
  });
  const counts = opens(async () => undefined, false, async () => {
    if (changed) return;
    changed = true;
    await replace(after, true);
  });
  expect((await read())?.content).toBe(after);
  expect(failedPredicates).toEqual(['FILE_CHANGED']);
  expect(counts.opened).toBe(2);
  expect(counts.closed).toBe(2);
});
it('allows two successive atomic publications but never exceeds three descriptor attempts', async () => {
  const counts = opens(async attempt => { if (attempt < 3) await replace(attempt === 1 ? before : after); });
  expect((await read())?.content).toBe(after);
  expect(counts.opened).toBe(3);
  expect(counts.closed).toBe(3);
});
it('refuses continuously replaced records at the fixed three-attempt bound', async () => {
  const counts = opens(async () => { await replace(); });
  await expect(read()).rejects.toMatchObject({ code: 'UNSAFE_FILE' });
  expect(counts).toEqual({ opened: 3, read: 0, closed: 3 });
});
it('never retries an in-place change with the same inode', async () => {
  const counts = opens(async () => { await fs.writeFile(file, 'in-place change'); });
  await expect(read()).rejects.toMatchObject({ code: 'UNSAFE_FILE' });
  expect(counts).toEqual({ opened: 1, read: 0, closed: 1 });
});
it('refuses a hard-linked prior record without opening it', async () => {
  await fs.link(file, path.join(root, 'prior-alias'));
  const counts = opens(async () => undefined);
  await expect(read()).rejects.toMatchObject({ code: 'UNSAFE_FILE' });
  expect(counts.opened).toBe(0);
});
it('never retries a hard-linked replacement', async () => {
  const counts = opens(async () => { await replace(); await fs.link(file, path.join(root, 'replacement-alias')); });
  await expect(read()).rejects.toMatchObject({ code: 'UNSAFE_FILE' });
  expect(counts).toEqual({ opened: 1, read: 0, closed: 1 });
});
it.each(['mode', 'uid', 'gid', 'dev'] as const)('never retries a replacement with changed exact %s metadata', async field => {
  let replaced = false;
  const actualLstat = fs.lstat.bind(fs);
  jest.spyOn(fs, 'lstat').mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
    const result = await actualLstat(...args);
    if (args[0] !== file || !replaced) return result;
    // Isolate each metadata guard with real file stats; Windows has no POSIX
    // uid/gid/chmod equivalent. Actual ownership is not changed by this seam.
    const copy: BigIntStats = Object.assign(Object.create(Object.getPrototypeOf(result)), result);
    copy[field] = field === 'mode' ? copy.mode ^ BigInt(0o020) : copy[field] + BigInt(1);
    return copy;
  });
  const counts = opens(async () => { await replace(); replaced = true; });
  await expect(read()).rejects.toMatchObject({ code: 'UNSAFE_FILE' });
  expect(counts).toEqual({ opened: 1, read: 0, closed: 1 });
});
it('never retries a deleted replacement path', async () => {
  const counts = opens(async (_attempt, handle) => {
    const stat = handle!.stat.bind(handle);
    jest.spyOn(handle!, 'stat').mockImplementation(async options => {
      const value = await stat(options);
      await fs.unlink(file);
      return value;
    });
  }, true);
  await expect(read()).rejects.toMatchObject({ code: 'ENOENT' });
  expect(counts.opened).toBe(1);
  expect(counts.closed).toBe(1);
});
it('rejects a nonregular replacement without accepting any bytes', async () => {
  const counts = opens(async () => { await fs.unlink(file); await fs.mkdir(file); });
  await expect(read()).rejects.toThrow();
  expect(counts.opened).toBe(1);
  expect(counts.read).toBe(0);
});
it.each(['ordinary', 'junction'] as const)('refuses a replaced %s parent rather than retrying through it', async kind => {
  let changed = false;
  const counts = opens(async () => {
    if (changed) return;
    changed = true;
    const parent = path.dirname(file);
    await fs.rename(parent, path.join(root, 'saved-parent'));
    if (kind === 'junction') {
      const foreign = path.join(root, 'foreign-parent');
      await fs.mkdir(foreign);
      await fs.writeFile(path.join(foreign, 'record.json'), after, { mode: 0o600 });
      await fs.symlink(foreign, parent, process.platform === 'win32' ? 'junction' : 'dir');
    } else { await fs.mkdir(parent); await fs.writeFile(file, after, { mode: 0o600 }); }
  });
  await expect(read()).rejects.toThrow('parent changed');
  expect(counts).toEqual({ opened: 1, read: 0, closed: 1 });
});
it('refuses an outside-root path before opening any descriptor', async () => {
  const open = jest.spyOn(fs, 'open');
  await expect(readPersonaRecordText(file, path.join(root, 'unrelated'))).rejects.toThrow('escapes');
  expect(open).not.toHaveBeenCalled();
});
it('binds parents before the first leaf stat and rejects their replacement before open', async () => {
  const actualLstat = fs.lstat.bind(fs);
  let changed = false;
  jest.spyOn(fs, 'lstat').mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
    const result = await actualLstat(...args);
    if (args[0] === file && !changed) {
      changed = true;
      await fs.rename(path.dirname(file), path.join(root, 'original-parent'));
      await fs.mkdir(path.dirname(file));
      await fs.writeFile(file, after, { mode: 0o600 });
    }
    return result;
  });
  const counts = opens(async () => undefined);
  await expect(read()).rejects.toThrow('parent changed');
  expect(counts).toEqual({ opened: 0, read: 0, closed: 0 });
});
