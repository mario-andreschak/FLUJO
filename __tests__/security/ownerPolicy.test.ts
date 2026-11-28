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

type Read = (...values: unknown[]) => Promise<fs.promises.FileReadResult<Buffer>>;
/** Watches the descriptor opened for the policy bytes, optionally changing the file around it. */
function watchPolicyHandle(hooks: { beforeOpen?: () => void; afterFirstRead?: () => void } = {}) {
  const open = fs.promises.open.bind(fs.promises);
  const watched = { opened: 0, read: jest.fn(), close: jest.fn() };
  jest.spyOn(fs.promises, 'open').mockImplementation((async (...args: Parameters<typeof fs.promises.open>) => {
    if (args[0] !== filename || typeof args[1] !== 'number') return open(...args);
    hooks.beforeOpen?.();
    const handle = await open(...args);
    watched.opened += 1;
    const read = handle.read.bind(handle) as Read;
    const close = handle.close.bind(handle);
    jest.spyOn(handle, 'read').mockImplementation((async (...values: unknown[]) => {
      watched.read();
      const result = await read(...values);
      if (watched.read.mock.calls.length === 1) hooks.afterFirstRead?.();
      return result;
    }) as typeof handle.read);
    jest.spyOn(handle, 'close').mockImplementation(async () => { watched.close(); await close(); });
    return handle;
  }) as typeof fs.promises.open);
  return watched;
}

test('reads a private regular policy and accepts an atomic replacement on the next read', async () => {
  expect(await readOwnerPolicy(filename)).toEqual(policy);
  const updated = { ...policy, ownerId: 'replacement' };
  fs.writeFileSync(`${filename}.new`, JSON.stringify(updated), { mode: 0o600 });
  fs.renameSync(`${filename}.new`, filename);
  expect(await readOwnerPolicy(filename)).toEqual(updated);
});
test('rejects hard links and directories before opening any descriptor', async () => {
  fs.linkSync(filename, `${filename}.alias`);
  const open = jest.spyOn(fs.promises, 'open');
  await expect(readOwnerPolicy(filename)).rejects.toThrow('Invalid owner policy file');
  await expect(readOwnerPolicy(directory)).rejects.toThrow('Invalid owner policy file');
  expect(open).not.toHaveBeenCalled();
});
test('rejects a parent junction or symlink before opening policy bytes', async () => {
  const alias = path.join(directory, 'linked');
  fs.symlinkSync(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const open = jest.spyOn(fs.promises, 'open');
  await expect(readOwnerPolicy(path.join(alias, 'policy.json'))).rejects.toThrow('Invalid owner policy path');
  expect(open).not.toHaveBeenCalled();
});
test('refuses a policy replaced between path admission and open at every look, closing every descriptor', async () => {
  let generation = 0;
  const watched = watchPolicyHandle({ beforeOpen: () => {
    fs.renameSync(filename, `${filename}.old${generation++}`);
    fs.writeFileSync(filename, JSON.stringify(policy), { mode: 0o600 });
  } });
  await expect(readOwnerPolicy(filename)).rejects.toThrow('Owner policy changed');
  expect(watched.opened).toBe(4);
  expect(watched.read).not.toHaveBeenCalled();
  expect(watched.close).toHaveBeenCalledTimes(4);
});
test.each(['replace', 'grow'])('reads again from scratch after a %s during a read, closing the first descriptor', async action => {
  const updated = { ...policy, ownerId: 'rewritten' };
  const watched = watchPolicyHandle({ afterFirstRead: () => {
    if (action === 'replace') {
      fs.renameSync(filename, `${filename}.old`);
      fs.writeFileSync(filename, JSON.stringify(updated), { mode: 0o600 });
    } else fs.appendFileSync(filename, ' ');
  } });
  expect(await readOwnerPolicy(filename)).toEqual(action === 'replace' ? updated : policy);
  expect(watched.opened).toBe(2);
  expect(watched.close).toHaveBeenCalledTimes(2);
});
