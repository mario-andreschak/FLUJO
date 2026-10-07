import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { readOperatorSecret } from '@/utils/encryption/operatorSecret';

let root: string; let filename: string; let secret: string;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = { FLUJO_DATA_DIR: process.env.FLUJO_DATA_DIR, FLUJO_PARENT_DATA_DIR: process.env.FLUJO_PARENT_DATA_DIR,
    FLUJO_ENCRYPTION_SECRET_FILE: process.env.FLUJO_ENCRYPTION_SECRET_FILE };
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'flujo-operator-file-race-'));
  filename = path.join(root, 'independent-secret'); secret = randomBytes(32).toString('base64url');
  process.env.FLUJO_DATA_DIR = path.join(root, 'data'); delete process.env.FLUJO_PARENT_DATA_DIR;
  process.env.FLUJO_ENCRYPTION_SECRET_FILE = filename;
  fs.writeFileSync(filename, secret, { mode: 0o600 });
});
afterEach(() => {
  jest.restoreAllMocks();
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  fs.rmSync(root, { recursive: true, force: true });
});
test('reads the independent private file with nonblocking/no-follow flags and closes the actual descriptor', () => {
  const open = jest.spyOn(fs, 'openSync'); const close = jest.spyOn(fs, 'closeSync');
  expect(readOperatorSecret()).toBe(secret);
  const flags = open.mock.calls[0][1] as number;
  expect(typeof flags).toBe('number');
  for (const flag of [fs.constants.O_NOFOLLOW, fs.constants.O_NONBLOCK]) {
    if (typeof flag === 'number' && flag !== 0) expect(flags & flag).toBe(flag);
  }
  expect(close).toHaveBeenCalledWith(open.mock.results[0].value);
});
test('replacement after admission is rejected before reading any bytes from the new descriptor', () => {
  const open = fs.openSync.bind(fs); const close = jest.spyOn(fs, 'closeSync');
  const read = jest.spyOn(fs, 'readSync'); let opened: number | undefined;
  jest.spyOn(fs, 'openSync').mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
    if (args[0] === filename && typeof args[1] === 'number') {
      fs.renameSync(filename, `${filename}.old`);
      fs.writeFileSync(filename, randomBytes(32).toString('base64url'), { mode: 0o600 });
      opened = open(...args); return opened;
    }
    return open(...args);
  }) as typeof fs.openSync);
  expect(() => readOperatorSecret()).toThrow('Private encryption secret changed');
  expect(read).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledWith(opened);
});
test.each(['replace', 'grow'])('%s during reading is rejected and the exact opened descriptor closes', action => {
  const read = fs.readSync.bind(fs); const close = jest.spyOn(fs, 'closeSync');
  let changed = false; let opened: number | undefined;
  jest.spyOn(fs, 'readSync').mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
    const count = read(...args);
    if (!changed) {
      changed = true; opened = args[0];
      if (action === 'replace') {
        fs.renameSync(filename, `${filename}.old`);
        fs.writeFileSync(filename, secret, { mode: 0o600 });
      } else fs.appendFileSync(filename, 'a');
    }
    return count;
  }) as typeof fs.readSync);
  expect(() => readOperatorSecret()).toThrow('Private encryption secret changed');
  expect(changed).toBe(true); expect(close).toHaveBeenCalledWith(opened);
});
test('hard links and data-directory mounts refuse before opening secret bytes', () => {
  const open = jest.spyOn(fs, 'openSync');
  fs.linkSync(filename, `${filename}.alias`);
  expect(() => readOperatorSecret()).toThrow('Private encryption secret is unavailable');
  expect(open).not.toHaveBeenCalled();
  fs.unlinkSync(`${filename}.alias`); process.env.FLUJO_DATA_DIR = root;
  expect(() => readOperatorSecret()).toThrow('Private encryption secret must be outside the data directory');
  expect(open).not.toHaveBeenCalled();
});
