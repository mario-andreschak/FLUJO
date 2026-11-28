/**
 * How FLUJO reads the Linux Secret Service through `secret-tool` (#1443).
 * secret-tool answers both "nothing found" and "found, but the keyring is
 * locked" with exit 1 and no message. A locked keyring must never look like a
 * lost key: that would tell the owner their key is gone after a password reset.
 * The real keyring is covered by systemKeyRealStore.test.ts through
 * scripts/check-system-key-store.mjs.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { secretServiceStore, SystemKeyStoreUnavailableError } from '@/utils/encryption/systemKeyStore';

type Callback = (error: Error | null, stdout: string, stderr: string) => void;
const mockExecFile = jest.fn<unknown, [string, string[], unknown, Callback]>();
jest.mock('node:child_process', () => ({ execFile: (...args: Parameters<typeof mockExecFile>) => mockExecFile(...args) }));

interface Answer { code: number; stdout?: string; stderr?: string }
const calls: string[][] = [];
let answers: Record<string, Answer>;

beforeEach(() => {
  calls.length = 0;
  mockExecFile.mockImplementation((_file, args, _options, callback) => {
    calls.push(args);
    const answer = answers[args[0]] ?? { code: 127, stderr: 'unexpected call' };
    process.nextTick(() => callback(answer.code === 0 ? null : Object.assign(new Error('exit'), { code: answer.code, killed: false }),
      answer.stdout ?? '', answer.stderr ?? ''));
    return { stdin: { on: () => undefined, end: () => undefined } };
  });
});

const store = secretServiceStore('/usr/bin/secret-tool');
const id = randomUUID();

it('reads the key the keyring hands over', async () => {
  const secret = randomBytes(32).toString('base64url');
  answers = { lookup: { code: 0, stdout: `${secret}` } };
  expect(await store.load(id, undefined)).toBe(secret);
  expect(calls).toEqual([['lookup', 'application', 'flujo', 'flujo-system-key', id]]);
});

it('reports a key that is not in the keyring as missing', async () => {
  answers = { lookup: { code: 1 }, search: { code: 0 } };
  expect(await store.load(id, undefined)).toBeNull();
  expect(calls.map(args => args[0])).toEqual(['lookup', 'search']);
});

it('reports a key in a locked keyring as unavailable, so FLUJO waits instead of asking for the recovery key as if it were lost', async () => {
  // Exactly how secret-tool 0.20 answers: the attributes come on standard error.
  answers = {
    lookup: { code: 1 },
    search: {
      code: 0,
      stdout: '[/1]\nlabel = FLUJO system key\ncreated = 2026-11-28 02:17:43\nmodified = 2026-11-28 02:17:43\n',
      stderr: `secret-tool: Cannot get secret of a locked object\nattribute.application = flujo\nattribute.flujo-system-key = ${id}\n`,
    },
  };
  await expect(store.load(id, undefined)).rejects.toThrow(SystemKeyStoreUnavailableError);
  await expect(store.load(id, undefined)).rejects.toThrow(/locked/);
});

it('does not take another key in the listing for this one', async () => {
  answers = { lookup: { code: 1 }, search: { code: 0, stdout: 'label = FLUJO system key\n', stderr: `attribute.flujo-system-key = ${randomUUID()}\n` } };
  expect(await store.load(id, undefined)).toBeNull();
});

it('reports a keyring that cannot be reached as unavailable', async () => {
  answers = { lookup: { code: 1, stderr: 'secret-tool: The name org.freedesktop.secrets was not provided by any .service files\n' } };
  await expect(store.load(id, undefined)).rejects.toThrow(SystemKeyStoreUnavailableError);
  answers = { lookup: { code: 1 }, search: { code: 1, stderr: 'secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY\n' } };
  await expect(store.load(id, undefined)).rejects.toThrow(SystemKeyStoreUnavailableError);
});
