import { createHmac } from 'node:crypto';
import { promises as fs, type BigIntStats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadInstallationKey } from '@/backend/services/statistics/installationKey';
import { _setStatisticsDirForTests, credentialFingerprint } from '@/backend/services/statistics';
import { statisticsRevisionId } from '@/backend/services/statistics/metadata';

const denied = { name: 'StatisticsKeyAdmissionError', code: 'UNSAFE_STATISTICS_KEY',
  message: 'Statistics installation key is unavailable or unsafe.' };
const legacyKey = Buffer.from('0123456789abcdef0123456789abcdef');

describe('persistent statistics key admission', () => {
  let root: string;
  let keyFile: string;
  let previousDirectory: string;
  const processDescriptors = new Map<string, PropertyDescriptor | undefined>();

  // Workspace leases can perform independent I/O in this worker. Keep every
  // no-read/no-repair assertion bound to the entire statistics directory.
  const statisticsCalls = (mock: { mock: { calls: unknown[][] } }) => mock.mock.calls.filter(([file]) =>
    typeof file === 'string' && (file === root || file.startsWith(`${root}${path.sep}`)));

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-statistics-key-'));
    keyFile = path.join(root, '.installation-key');
    previousDirectory = _setStatisticsDirForTests(root);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    for (const [field, descriptor] of processDescriptors) {
      if (descriptor) Object.defineProperty(process, field, descriptor);
      else Reflect.deleteProperty(process, field);
    }
    processDescriptors.clear();
    _setStatisticsDirForTests(previousDirectory);
    await fs.rm(root, { recursive: true, force: true });
  });

  const seed = async (bytes = legacyKey) => fs.writeFile(keyFile, bytes, { mode: 0o600 });

  it('preserves durable bytes and credential/revision identities across key-cache reloads', async () => {
    await seed();
    const write = jest.spyOn(fs, 'writeFile');
    const expected = `cred_${createHmac('sha256', legacyKey).update('synthetic-credential').digest('base64url').slice(0, 22)}`;
    const revision = `rev_${createHmac('sha256', legacyKey).update('revision:prompt:synthetic-text').digest('base64url').slice(0, 22)}`;
    const unrelated = `${root}.workspace-lease`;
    try {
      await fs.writeFile(unrelated, 'synthetic independent lease', { flag: 'wx' });
      await expect(credentialFingerprint('synthetic-credential')).resolves.toBe(expected);
      await expect(statisticsRevisionId('prompt', 'synthetic-text')).resolves.toBe(revision);
      _setStatisticsDirForTests(root);
      await expect(credentialFingerprint('synthetic-credential')).resolves.toBe(expected);
      await expect(fs.readFile(keyFile)).resolves.toEqual(legacyKey);
      await expect(fs.readFile(unrelated, 'utf8')).resolves.toBe('synthetic independent lease');
      expect(statisticsCalls(write)).toHaveLength(0);
    } finally { await fs.unlink(unrelated); }
  });

  it('creates a 32-byte key exclusively, validates the publication and reuses it', async () => {
    const write = jest.spyOn(fs, 'writeFile');
    const first = await loadInstallationKey(root);
    expect(first).toHaveLength(32);
    expect(write).toHaveBeenCalledWith(keyFile, expect.any(Buffer), { flag: 'wx', mode: 0o600 });
    await expect(fs.readFile(keyFile)).resolves.toEqual(first);
    await expect(loadInstallationKey(root)).resolves.toEqual(first);
    expect(statisticsCalls(write)).toHaveLength(1);
  });

  it.each([0, 31, 33, 1024])('rejects a %i-byte existing key before opening and preserves it', async size => {
    const bytes = Buffer.alloc(size, 42);
    await seed(bytes);
    const open = jest.spyOn(fs, 'open');
    const write = jest.spyOn(fs, 'writeFile');
    await expect(loadInstallationKey(root)).rejects.toMatchObject(denied);
    expect(statisticsCalls(open)).toHaveLength(0);
    expect(statisticsCalls(write)).toHaveLength(0);
    await expect(fs.readFile(keyFile)).resolves.toEqual(bytes);
  });

  it('refuses a directory key without replacing it', async () => {
    await fs.mkdir(keyFile);
    const open = jest.spyOn(fs, 'open');
    const write = jest.spyOn(fs, 'writeFile');
    await expect(loadInstallationKey(root)).rejects.toMatchObject(denied);
    expect(statisticsCalls(open)).toHaveLength(0);
    expect(statisticsCalls(write)).toHaveLength(0);
    expect((await fs.lstat(keyFile)).isDirectory()).toBe(true);
  });

  it('refuses a multiply-linked key without altering either name', async () => {
    await seed();
    const alias = path.join(root, 'alias');
    await fs.link(keyFile, alias);
    const open = jest.spyOn(fs, 'open');
    await expect(loadInstallationKey(root)).rejects.toMatchObject(denied);
    expect(statisticsCalls(open)).toHaveLength(0);
    await expect(fs.readFile(alias)).resolves.toEqual(legacyKey);
    await expect(fs.readFile(keyFile)).resolves.toEqual(legacyKey);
  });

  it.each([32, 31])('admits only a valid concurrent exclusive-creation winner (%i bytes)', async size => {
    const writeFile = fs.writeFile.bind(fs);
    const winner = Buffer.alloc(size, 77);
    const write = jest.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
      if (String(args[0]) !== keyFile) return writeFile(...args);
      await writeFile(keyFile, winner, { flag: 'wx', mode: 0o600 });
      return writeFile(...args);
    });
    if (size === 32) await expect(loadInstallationKey(root)).resolves.toEqual(winner);
    else await expect(loadInstallationKey(root)).rejects.toMatchObject(denied);
    expect(statisticsCalls(write)).toHaveLength(1);
    await expect(fs.readFile(keyFile)).resolves.toEqual(winner);
  });

  it('rejects an invalid just-created publication rather than returning generated bytes', async () => {
    const writeFile = fs.writeFile.bind(fs);
    jest.spyOn(fs, 'writeFile').mockImplementation(async (...args) => String(args[0]) === keyFile
      ? writeFile(keyFile, Buffer.alloc(31), { flag: 'wx', mode: 0o600 }) : writeFile(...args));
    await expect(loadInstallationKey(root)).rejects.toMatchObject(denied);
    expect((await fs.stat(keyFile)).size).toBe(31);
  });

  it.each(['replace', 'delete'] as const)('refuses a key %s after admission without regenerating it', async action => {
    await seed();
    const openFile = fs.open.bind(fs);
    const write = jest.spyOn(fs, 'writeFile');
    jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (String(args[0]) !== keyFile) return openFile(...args);
      await fs.rename(keyFile, path.join(root, 'original'));
      if (action === 'replace') await fs.copyFile(path.join(root, 'original'), keyFile);
      return openFile(...args);
    });
    await expect(loadInstallationKey(root)).rejects.toMatchObject(denied);
    expect(statisticsCalls(write)).toHaveLength(0);
    await expect(fs.readFile(path.join(root, 'original'))).resolves.toEqual(legacyKey);
    if (action === 'delete') await expect(fs.lstat(keyFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects named key replacement after descriptor reading', async () => {
    await seed();
    const openFile = fs.open.bind(fs);
    jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await openFile(...args);
      if (String(args[0]) !== keyFile) return handle;
      type PositionalRead = (buffer: Buffer, offset: number, length: number, position: number) => Promise<{ bytesRead: number; buffer: Buffer }>;
      const positional: { read: PositionalRead } = handle;
      const read = positional.read.bind(handle);
      let replaced = false;
      jest.spyOn(positional, 'read').mockImplementation(async (...readArgs) => {
        const result = await read(...readArgs);
        if (!replaced) {
          replaced = true;
          await fs.rename(keyFile, path.join(root, 'original'));
          await fs.copyFile(path.join(root, 'original'), keyFile);
        }
        return result;
      });
      return handle;
    });
    await expect(loadInstallationKey(root)).rejects.toMatchObject(denied);
  });

  it('denies canonical directory drift before content reading', async () => {
    await seed();
    const realpath = fs.realpath.bind(fs);
    let calls = 0;
    jest.spyOn(fs, 'realpath').mockImplementation(async (...args) => {
      const actual = await realpath(...args);
      if (String(args[0]) !== root) return actual;
      return ++calls > 1 ? path.join(root, 'changed-target') : actual;
    });
    const open = jest.spyOn(fs, 'open');
    await expect(loadInstallationKey(root)).rejects.toMatchObject(denied);
    expect(statisticsCalls(open)).toHaveLength(0);
  });

  // These model POSIX metadata policy on every host; they do not claim native
  // POSIX permissions or Windows ACL enforcement. Actual descriptor reads stay
  // real, with matching modeled lstat/fstat identities where admission passes.
  async function modelMetadata(keyPatch: Partial<BigIntStats> = {}, directoryPatch: Partial<BigIntStats> = {}, platform = 'linux') {
    for (const [field, value] of Object.entries({ platform, geteuid: (): number => 1234, getuid: (): number => 5678 })) {
      processDescriptors.set(field, Object.getOwnPropertyDescriptor(process, field));
      Object.defineProperty(process, field, { configurable: true, value });
    }
    const model = (stat: BigIntStats, isKey: boolean): BigIntStats => Object.assign(
      Object.create(Object.getPrototypeOf(stat)), stat,
      { uid: BigInt(1234), mode: (stat.mode & ~BigInt(0o777)) | BigInt(isKey ? 0o600 : 0o755) },
      isKey ? keyPatch : directoryPatch,
    );
    const lstat = fs.lstat.bind(fs);
    jest.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
      const stat = await lstat(...args);
      return args[1] && String(args[0]) === keyFile ? model(stat as BigIntStats, true)
        : args[1] && String(args[0]) === root ? model(stat as BigIntStats, false) : stat;
    });
    const openFile = fs.open.bind(fs);
    jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await openFile(...args);
      if (String(args[0]) !== keyFile) return handle;
      const stat = await handle.stat({ bigint: true });
      jest.spyOn(handle, 'stat').mockResolvedValue(model(stat, true));
      return handle;
    });
  }

  it.each([
    ['foreign key owner', { uid: BigInt(5678) }, {}],
    ['group-readable key', { mode: BigInt(0o100640) }, {}],
    ['world-readable key', { mode: BigInt(0o100604) }, {}],
    ['foreign directory owner', {}, { uid: BigInt(5678) }],
    ['group-writable directory', {}, { mode: BigInt(0o40770) }],
    ['world-writable directory', {}, { mode: BigInt(0o40707) }],
  ] as const)('denies modeled POSIX %s before bytes or repair', async (_label, keyPatch, directoryPatch) => {
    await seed();
    await modelMetadata(keyPatch, directoryPatch);
    const write = jest.spyOn(fs, 'writeFile');
    const open = jest.mocked(fs.open);
    await expect(loadInstallationKey(root)).rejects.toMatchObject(denied);
    expect(statisticsCalls(open)).toHaveLength(0);
    expect(statisticsCalls(write)).toHaveLength(0);
  });

  it.each(['key', 'directory'] as const)('rejects a modeled symbolic-link %s before opening', async target => {
    await seed();
    const symlink = { isSymbolicLink: () => true };
    await modelMetadata(target === 'key' ? symlink : {}, target === 'directory' ? symlink : {});
    await expect(loadInstallationKey(root)).rejects.toMatchObject(denied);
    expect(statisticsCalls(jest.mocked(fs.open))).toHaveLength(0);
  });

  it('accepts modeled owner-readonly legacy key and nonwritable 0755 directory without chmod', async () => {
    await seed();
    await modelMetadata({ mode: BigInt(0o100400) });
    const chmod = jest.spyOn(fs, 'chmod');
    await expect(loadInstallationKey(root)).resolves.toEqual(legacyKey);
    expect(statisticsCalls(chmod)).toHaveLength(0);
  });

  it('uses the modeled real uid only when effective uid support is absent', async () => {
    await seed();
    await modelMetadata();
    Object.defineProperty(process, 'geteuid', { configurable: true, value: undefined });
    Object.defineProperty(process, 'getuid', { configurable: true, value: () => 1234 });
    await expect(loadInstallationKey(root)).resolves.toEqual(legacyKey);
  });

  it('does not interpret Windows uid/mode bits as POSIX ACL evidence', async () => {
    await seed();
    await modelMetadata({ uid: BigInt(9999), mode: BigInt(0o100666) }, { uid: BigInt(9999), mode: BigInt(0o40777) }, 'win32');
    await expect(loadInstallationKey(root)).resolves.toEqual(legacyKey);
  });

  it.each([3, 4])('refuses directory inode drift at descriptor read recheck %i', async driftAt => {
    await seed();
    const lstat = fs.lstat.bind(fs);
    let directoryReads = 0;
    jest.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
      const stat = await lstat(...args);
      if (String(args[0]) === root && args[1] && ++directoryReads >= driftAt) {
        return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { ino: (stat as BigIntStats).ino + BigInt(1) });
      }
      return stat;
    });
    const openFile = fs.open.bind(fs);
    let read: jest.SpyInstance | undefined;
    jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await openFile(...args);
      if (String(args[0]) !== keyFile) return handle;
      read = jest.spyOn(handle, 'read');
      return handle;
    });
    await expect(loadInstallationKey(root)).rejects.toMatchObject(denied);
    expect(read).toBeDefined();
    if (driftAt === 3) expect(read).not.toHaveBeenCalled();
    else expect(read).toHaveBeenCalled();
  });

  it('redacts native errors and preserves best-effort revision omission on key denial', async () => {
    await seed(Buffer.alloc(31));
    await expect(statisticsRevisionId('prompt', 'synthetic-text')).resolves.toBeUndefined();
    _setStatisticsDirForTests(root);
    const lstat = fs.lstat.bind(fs);
    jest.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
      if (String(args[0]) === root || String(args[0]) === keyFile) throw new Error(`${root} owner=1234 key=KEY_CANARY`);
      return lstat(...args);
    });
    await expect(loadInstallationKey(root)).rejects.toMatchObject(denied);
    await expect(loadInstallationKey(root)).rejects.not.toThrow(/KEY_CANARY|owner=|flujo-statistics-key/);
  });

  it('retains the existing per-directory key promise and empty-credential behavior', async () => {
    await seed();
    const first = await credentialFingerprint('synthetic-credential');
    await fs.writeFile(keyFile, Buffer.alloc(32, 99));
    const open = jest.spyOn(fs, 'open');
    await expect(credentialFingerprint('synthetic-credential')).resolves.toBe(first);
    await expect(credentialFingerprint('')).resolves.toBeUndefined();
    expect(statisticsCalls(open)).toHaveLength(0);
    _setStatisticsDirForTests(root);
    await expect(credentialFingerprint('synthetic-credential')).resolves.not.toBe(first);
  });

  it('retains a denied key promise until explicit cache reload without retrying or repair', async () => {
    await seed(Buffer.alloc(31));
    await expect(credentialFingerprint('synthetic-credential')).rejects.toMatchObject(denied);
    await seed();
    const open = jest.spyOn(fs, 'open');
    await expect(credentialFingerprint('synthetic-credential')).rejects.toMatchObject(denied);
    expect(statisticsCalls(open)).toHaveLength(0);
    _setStatisticsDirForTests(root);
    await expect(credentialFingerprint('synthetic-credential')).resolves.toMatch(/^cred_/);
  });

  it('keeps distinct durable key identities bound to their selected statistics directories', async () => {
    await seed();
    const first = await credentialFingerprint('synthetic-credential');
    const second = path.join(root, 'second-workspace-statistics');
    await fs.mkdir(second, { mode: 0o700 });
    await fs.writeFile(path.join(second, '.installation-key'), Buffer.alloc(32, 99), { mode: 0o600 });
    _setStatisticsDirForTests(second);
    await expect(credentialFingerprint('synthetic-credential')).resolves.not.toBe(first);
    _setStatisticsDirForTests(root);
    await expect(credentialFingerprint('synthetic-credential')).resolves.toBe(first);
    await expect(fs.readFile(keyFile)).resolves.toEqual(legacyKey);
  });
});
