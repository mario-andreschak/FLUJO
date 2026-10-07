import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readOwnerPolicy } from '@/backend/services/security/ownerPolicy';

let directory: string;
let filename: string;
const policy = { schemaVersion: 1, ownerId: 'owner', credentials: [] };
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flujo-owner-policy-read-'));
  filename = path.join(directory, 'policy.json');
  fs.writeFileSync(filename, JSON.stringify(policy), { mode: 0o600 });
});
afterEach(() => { jest.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });

test('reads a private regular policy and accepts an atomic replacement on the next read', () => {
  expect(readOwnerPolicy(filename)).toEqual(policy);
  const updated = { ...policy, ownerId: 'replacement' };
  fs.writeFileSync(`${filename}.new`, JSON.stringify(updated), { mode: 0o600 });
  fs.renameSync(`${filename}.new`, filename);
  expect(readOwnerPolicy(filename)).toEqual(updated);
});
test('rejects hard links and directories before opening any descriptor', () => {
  fs.linkSync(filename, `${filename}.alias`);
  const open = jest.spyOn(fs, 'openSync');
  expect(() => readOwnerPolicy(filename)).toThrow('Invalid owner policy file');
  expect(() => readOwnerPolicy(directory)).toThrow('Invalid owner policy file');
  expect(open).not.toHaveBeenCalled();
});
test('rejects a parent junction or symlink before opening policy bytes', () => {
  const alias = path.join(directory, 'linked');
  fs.symlinkSync(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const open = jest.spyOn(fs, 'openSync');
  expect(() => readOwnerPolicy(path.join(alias, 'policy.json'))).toThrow('Invalid owner policy path');
  expect(open).not.toHaveBeenCalled();
});
test('rejects replacement between path admission and open, and closes its descriptor', () => {
  const open = fs.openSync.bind(fs);
  const close = jest.spyOn(fs, 'closeSync');
  const read = jest.spyOn(fs, 'readSync');
  let fd: number | undefined;
  jest.spyOn(fs, 'openSync').mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
    if (args[0] === filename && typeof args[1] === 'number') {
      fs.renameSync(filename, `${filename}.old`);
      fs.writeFileSync(filename, JSON.stringify(policy), { mode: 0o600 });
      fd = open(...args);
      return fd;
    }
    return open(...args);
  }) as typeof fs.openSync);
  expect(() => readOwnerPolicy(filename)).toThrow('Owner policy changed');
  expect(read).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledWith(fd);
});
test.each(['replace', 'grow'])('rejects %s during a read and closes its descriptor', action => {
  const read = fs.readSync.bind(fs);
  const close = jest.spyOn(fs, 'closeSync');
  let changed = false;
  let fd: number | undefined;
  jest.spyOn(fs, 'readSync').mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
    const count = read(...args);
    if (!changed) {
      changed = true; fd = args[0];
      if (action === 'replace') {
        fs.renameSync(filename, `${filename}.old`);
        fs.writeFileSync(filename, JSON.stringify(policy), { mode: 0o600 });
      } else fs.appendFileSync(filename, ' ');
    }
    return count;
  }) as typeof fs.readSync);
  expect(() => readOwnerPolicy(filename)).toThrow('Owner policy changed');
  expect(changed).toBe(true);
  expect(close).toHaveBeenCalledWith(fd);
});
