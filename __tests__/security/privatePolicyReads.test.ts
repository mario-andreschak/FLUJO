import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPrivatePolicyJson } from '@/backend/services/security/readPrivatePolicy';

let directory: string;
let filename: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(path.resolve(os.tmpdir()), 'flujo-private-policy-'));
  filename = path.join(directory, 'policy.json');
  fs.writeFileSync(filename, '{"approved":true}', { mode: 0o600 });
});
afterEach(() => {
  jest.restoreAllMocks();
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !/^flujo-private-policy-[A-Za-z0-9]+$/.test(path.basename(resolved))
      || fs.realpathSync.native(resolved) !== resolved) throw new Error('Unsafe policy fixture cleanup');
  fs.rmSync(resolved, { recursive: true });
});

test.each([undefined, '', 'relative.json'])('invalid path projects only a fixed diagnostic (%s)', file => {
  expect(() => readPrivatePolicyJson(file)).toThrow('Private policy read unavailable');
});

test('a hardlinked policy is denied before any descriptor content read', () => {
  fs.linkSync(filename, path.join(directory, 'alias.json'));
  const read = jest.spyOn(fs, 'readSync');
  expect(() => readPrivatePolicyJson(filename)).toThrow('Private policy read unavailable');
  expect(read).not.toHaveBeenCalled();
});

test('invalid UTF-8 inside otherwise valid JSON is denied', () => {
  fs.writeFileSync(filename, Buffer.concat([Buffer.from('{"value":"'), Buffer.from([0xff]), Buffer.from('"}') ]));
  expect(() => readPrivatePolicyJson(filename)).toThrow('Private policy read unavailable');
});

test.each(['before open', 'after first read'])('actual same-size inode replacement %s is denied', phase => {
  const replacement = path.join(directory, 'replacement.json');
  fs.writeFileSync(replacement, '{"approved":true}', { mode: 0o600 });
  const oldInode = fs.statSync(filename, { bigint: true }).ino;
  expect(fs.statSync(replacement, { bigint: true }).ino).not.toBe(oldInode);
  let swapped = false;
  let descriptor: number | undefined;
  const open = fs.openSync;
  const read = fs.readSync;
  jest.spyOn(fs, 'openSync').mockImplementation((file, flags, mode) => {
    if (file === filename && phase === 'before open' && !swapped) {
      swapped = true; fs.renameSync(replacement, filename);
    }
    const fd = open(file, flags, mode);
    if (file === filename) descriptor = fd;
    return fd;
  });
  jest.spyOn(fs, 'readSync').mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
    const count = read(...args);
    if (args[0] === descriptor && phase === 'after first read' && !swapped) {
      swapped = true; fs.renameSync(replacement, filename);
    }
    return count;
  }) as typeof fs.readSync);
  expect(() => readPrivatePolicyJson(filename)).toThrow('Private policy read unavailable');
  expect(swapped).toBe(true);
});

(process.platform === 'win32' ? test.skip : test)('actual POSIX public permissions are denied before bytes', () => {
  fs.chmodSync(filename, 0o644);
  const read = jest.spyOn(fs, 'readSync');
  expect(() => readPrivatePolicyJson(filename)).toThrow('Private policy read unavailable');
  expect(read).not.toHaveBeenCalled();
});
