import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readNativeHeldFile } from '@/backend/execution/flow/handlers/nativeHeldFile';

let directory: string;
let file: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-native-held-'));
  file = path.join(directory, 'record.json');
  await fs.writeFile(file, '{"owned":true}', { mode: 0o600 });
});
afterEach(async () => {
  jest.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

test('returns exact admitted bytes and retains the regular single-link source', async () => {
  expect((await readNativeHeldFile(file, 64)).toString()).toBe('{"owned":true}');
  expect((await fs.stat(file)).nlink).toBe(1);
});
test('refuses oversized records before reading and preserves their bytes', async () => {
  await expect(readNativeHeldFile(file, 4)).rejects.toThrow();
  expect(await fs.readFile(file, 'utf8')).toBe('{"owned":true}');
});
test('refuses hard-linked records without changing either name', async () => {
  const other = path.join(directory, 'foreign.json');
  await fs.link(file, other);
  await expect(readNativeHeldFile(file, 64)).rejects.toThrow();
  expect(await fs.readFile(other, 'utf8')).toBe('{"owned":true}');
});
test('refuses a named replacement after opening while leaving the foreign replacement intact', async () => {
  const open = fs.open.bind(fs);
  jest.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
    const handle = await open(...args);
    await fs.rename(file, path.join(directory, 'original.json'));
    await fs.writeFile(file, '{"foreign":true}', { mode: 0o600 });
    return handle;
  });
  await expect(readNativeHeldFile(file, 64)).rejects.toThrow();
  expect(await fs.readFile(file, 'utf8')).toBe('{"foreign":true}');
});
test('refuses content changed through the held file and clears the rejected read buffer', async () => {
  const open = fs.open.bind(fs);
  let buffer: Buffer | undefined;
  jest.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
    const handle = await open(...args);
    const read = handle.read.bind(handle);
    jest.spyOn(handle, 'read').mockImplementationOnce(async (...readArgs: Parameters<typeof read>) => {
      buffer = readArgs[0] as Buffer;
      const result = await read(...readArgs);
      await fs.appendFile(file, 'changed');
      return result;
    });
    return handle;
  });
  await expect(readNativeHeldFile(file, 64)).rejects.toThrow();
  expect(buffer?.every(value => value === 0)).toBe(true);
  expect(await fs.readFile(file, 'utf8')).toBe('{"owned":true}changed');
});
