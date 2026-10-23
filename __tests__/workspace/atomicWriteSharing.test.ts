import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteWithoutLinks } from '@/backend/services/workspace/backupRestoreFs';

let root: string, target: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-atomic-sharing-'));
  target = path.join(root, 'state.json');
  await fs.writeFile(target, 'previous complete state');
});
afterEach(async () => { jest.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
it('retries a Windows sharing conflict with the same temporary bytes and no missing target', async () => {
  const rename = fs.rename.bind(fs);
  const attempts: string[] = [];
  jest.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
    attempts.push(String(source));
    expect(await fs.readFile(target, 'utf8')).toBe('previous complete state');
    if (attempts.length < 3) throw Object.assign(new Error('temporary sharing conflict'), { code: 'EPERM' });
    await rename(source, destination);
  });
  await atomicWriteWithoutLinks(root, target, Buffer.from('next complete state'));
  expect(new Set(attempts).size).toBe(1);
  expect(attempts).toHaveLength(3);
  expect(await fs.readFile(target, 'utf8')).toBe('next complete state');
  expect(await fs.readdir(root)).toEqual(['state.json']);
});
it('rechecks execution ownership before retrying publication', async () => {
  let revoked = false;
  const rename = jest.spyOn(fs, 'rename').mockImplementation(async () => {
    revoked = true;
    throw Object.assign(new Error('sharing conflict'), { code: 'EPERM' });
  });
  await expect(atomicWriteWithoutLinks(root, target, Buffer.from('new'), {
    assertOwned: async () => { if (revoked) throw new Error('ownership revoked'); },
  })).rejects.toThrow('ownership revoked');
  expect(rename).toHaveBeenCalledTimes(1);
  expect(await fs.readFile(target, 'utf8')).toBe('previous complete state');
});
it('does not retry an unrelated filesystem failure', async () => {
  const rename = jest.spyOn(fs, 'rename').mockRejectedValue(Object.assign(new Error('I/O failure'), { code: 'EIO' }));
  await expect(atomicWriteWithoutLinks(root, target, Buffer.from('new'))).rejects.toThrow('I/O failure');
  expect(rename).toHaveBeenCalledTimes(1);
  expect(await fs.readFile(target, 'utf8')).toBe('previous complete state');
});
