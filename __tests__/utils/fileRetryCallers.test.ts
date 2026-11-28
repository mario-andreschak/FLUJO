/**
 * Issue #1050: every place that reads or replaces a file on the resource-list
 * path (and every former hand-written copy of the retry) waits out a
 * short-lived lock through src/utils/transientFileRetry.ts. Each test makes the
 * real file call fail the way Windows does (antivirus or the indexer holding
 * the file: EBUSY on open or read, EPERM on a rename over a file a reader has
 * open) and checks that the real code still finishes, and that a lock that
 * does not clear up is still refused.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StorageKey } from '@/shared/types/storage';

jest.mock('@/backend/services/security/trustedHostMcp', () => ({
  ...jest.requireActual<object>('@/backend/services/security/trustedHostMcp'),
  readPrivateApprovalAsync: jest.fn(async () => ({})),
}));

type FileMethod = 'open' | 'readFile' | 'rename' | 'appendFile';

const errno = (code: string) => Object.assign(new Error(`${code}: synthetic short-lived lock`), { code });

/** The next `times` calls of `method` whose path ends with `suffix` fail with `code`; all other calls run for real. */
function lockNext(method: FileMethod, suffix: string, code: string, times = 1) {
  const real = (fs[method] as (...args: unknown[]) => Promise<unknown>).bind(fs);
  const state = { failed: 0 };
  jest.spyOn(fs, method).mockImplementation((async (...args: unknown[]) => {
    const target = String(method === 'rename' ? args[1] : args[0]);
    if (state.failed < times && target.endsWith(suffix)) { state.failed += 1; throw errno(code); }
    return real(...args);
  }) as never);
  return state;
}

let root: string;
let previousDataDir: string | undefined;
beforeEach(async () => {
  previousDataDir = process.env.FLUJO_DATA_DIR;
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-file-retry-callers-'));
  process.env.FLUJO_DATA_DIR = root;
});
afterEach(async () => {
  jest.restoreAllMocks();
  if (previousDataDir === undefined) delete process.env.FLUJO_DATA_DIR;
  else process.env.FLUJO_DATA_DIR = previousDataDir;
  await fs.rm(root, { recursive: true, force: true });
});

describe('storage reads (mcp_servers.json and every other stored item)', () => {
  it('reads a stored item that antivirus held for a moment', async () => {
    const { loadItem, saveItem } = await import('@/utils/storage/backend');
    await saveItem(StorageKey.MCP_SERVERS, { flujo: { name: 'flujo' } });
    const lock = lockNext('readFile', 'mcp_servers.json', 'EBUSY', 2);
    await expect(loadItem(StorageKey.MCP_SERVERS, {})).resolves.toEqual({ flujo: { name: 'flujo' } });
    expect(lock.failed).toBe(2);
  });

  it('still fails, and never returns the default, when the lock lasts', async () => {
    const { loadItem, saveItem } = await import('@/utils/storage/backend');
    await saveItem(StorageKey.MCP_SERVERS, { flujo: { name: 'flujo' } });
    const lock = lockNext('readFile', 'mcp_servers.json', 'EBUSY', 100);
    await expect(loadItem(StorageKey.MCP_SERVERS, { fallback: true })).rejects.toMatchObject({ code: 'EBUSY' });
    expect(lock.failed).toBe(4);
  });

  it('reads a collection item the same way', async () => {
    const { loadCollectionItem, saveCollectionItem } = await import('@/utils/storage/backend');
    await saveCollectionItem('tickets', 't1', { id: 't1' });
    const lock = lockNext('readFile', 't1.json', 'EPERM');
    await expect(loadCollectionItem('tickets', 't1', null)).resolves.toEqual({ id: 't1' });
    expect(lock.failed).toBe(1);
  });
});

describe('accounts store', () => {
  it('replaces a private file while a reader holds it, and appends to the audit log', async () => {
    const { writePrivateFileAtomic, appendAudit, accountsDirectory } = await import('@/backend/services/accounts/store');
    const file = path.join(root, 'accounts-test', 'state.json');
    await writePrivateFileAtomic(file, 'first');
    const rename = lockNext('rename', 'state.json', 'EPERM', 3);
    await writePrivateFileAtomic(file, 'second');
    expect(rename.failed).toBe(3);
    await expect(fs.readFile(file, 'utf8')).resolves.toBe('second');
    expect((await fs.readdir(path.dirname(file))).sort()).toEqual(['state.json']);

    jest.restoreAllMocks();
    const append = lockNext('appendFile', 'audit.jsonl', 'EBUSY');
    await appendAudit({ action: 'sign-in', actorUserId: null });
    expect(append.failed).toBe(1);
    await expect(fs.readFile(path.join(accountsDirectory(), 'audit.jsonl'), 'utf8')).resolves.toContain('sign-in');
  });
});

describe('shared item history', () => {
  it('appends and lists history while the file is briefly held', async () => {
    const { runWithWorkspace } = await import('@/utils/workspace');
    const { listHistory, recordHistory } = await import('@/backend/services/sharedItems/history');
    const actor = { userId: 'u_anna000000000000000', name: 'Anna' };
    const append = lockNext('appendFile', '.jsonl', 'EBUSY');
    const recorded = await runWithWorkspace('history-ws', () => recordHistory({
      kind: 'model', itemId: 'm1', action: 'created', actor, revision: 'r1', previousRevision: null, snapshot: null,
    }));
    expect(recorded).not.toBeNull();
    expect(append.failed).toBe(1);

    jest.restoreAllMocks();
    const read = lockNext('readFile', '.jsonl', 'EACCES');
    const listed = await runWithWorkspace('history-ws', () => listHistory('model', 'm1'));
    expect(listed.map(entry => entry.revision)).toEqual(['r1']);
    expect(read.failed).toBe(1);
  });
});

describe('plain file reads', () => {
  it('opens a file that antivirus held for a moment and refuses one that stays held', async () => {
    const { readPlainFile } = await import('@/utils/readPlainFile');
    const file = path.join(root, 'plain.json');
    await fs.writeFile(file, '{"a":1}');
    const lock = lockNext('open', 'plain.json', 'EBUSY');
    await expect(readPlainFile(file)).resolves.toEqual(Buffer.from('{"a":1}'));
    expect(lock.failed).toBe(1);

    jest.restoreAllMocks();
    const lasting = lockNext('open', 'plain.json', 'EBUSY', 100);
    await expect(readPlainFile(file)).rejects.toMatchObject({ code: 'EBUSY' });
    expect(lasting.failed).toBe(4);
  });
});

describe('owner sign-in file', () => {
  async function writeOwnerPolicy(file: string, ownerId: string) {
    const { issueOwnerCredential } = await import('@/backend/services/security/ownerCredentials');
    const { record } = issueOwnerCredential(['control:admin'], Date.now() + 60_000);
    const temporary = `${file}.${ownerId}.tmp`;
    await fs.writeFile(temporary, JSON.stringify({ schemaVersion: 1, ownerId, credentials: [record] }), { mode: 0o600 });
    await fs.rename(temporary, file);
  }

  it('reads the policy after a short-lived lock', async () => {
    const { readOwnerPolicy } = await import('@/backend/services/security/ownerPolicy');
    const file = path.join(root, 'owner.json');
    await writeOwnerPolicy(file, 'owner-a');
    const lock = lockNext('open', 'owner.json', 'EBUSY', 2);
    await expect(readOwnerPolicy(file)).resolves.toMatchObject({ ownerId: 'owner-a' });
    expect(lock.failed).toBe(2);
  });

  it('reads again from scratch when the file is replaced between two looks', async () => {
    const { readOwnerPolicy } = await import('@/backend/services/security/ownerPolicy');
    const file = path.join(root, 'owner.json');
    await writeOwnerPolicy(file, 'owner-a');
    const realOpen = fs.open.bind(fs);
    let replaced = false;
    jest.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (!replaced && String(args[0]).endsWith('owner.json')) { replaced = true; await writeOwnerPolicy(file, 'owner-b'); }
      return realOpen(...args);
    });
    await expect(readOwnerPolicy(file)).resolves.toMatchObject({ ownerId: 'owner-b' });
    expect(replaced).toBe(true);
  });

  it('refuses after the last wait when the lock lasts', async () => {
    const { readOwnerPolicy } = await import('@/backend/services/security/ownerPolicy');
    const file = path.join(root, 'owner.json');
    await writeOwnerPolicy(file, 'owner-a');
    const lock = lockNext('open', 'owner.json', 'EBUSY', 100);
    await expect(readOwnerPolicy(file)).rejects.toMatchObject({ code: 'EBUSY' });
    expect(lock.failed).toBe(4);
  });
});

describe('approval writer', () => {
  it('publishes the new ledger once a reader lets go, checking authority before every attempt', async () => {
    const { createOwnedPrivateApprovalStage } = await import('@/backend/services/security/ownedPrivateApprovalStage');
    const ledger = path.join(root, 'approval.json');
    await fs.writeFile(ledger, JSON.stringify({ approvals: [] }));
    const controller = new AbortController();
    const stage = await createOwnedPrivateApprovalStage(ledger, { approvals: ['next'] }, controller.signal);
    const rename = lockNext('rename', 'approval.json', 'EPERM', 2);
    const authority = jest.fn(async () => {});
    try { await stage.publish(ledger, authority); } finally { await stage.dispose(); }
    expect(rename.failed).toBe(2);
    expect(authority).toHaveBeenCalledTimes(3);
    await expect(fs.readFile(ledger, 'utf8')).resolves.toBe(JSON.stringify({ approvals: ['next'] }));
    expect(await fs.readdir(root)).toEqual(['approval.json']);
  });

  it('stops when authority is withdrawn during the wait and leaves the old ledger in place', async () => {
    const { createOwnedPrivateApprovalStage } = await import('@/backend/services/security/ownedPrivateApprovalStage');
    const ledger = path.join(root, 'approval.json');
    await fs.writeFile(ledger, 'previous');
    const stage = await createOwnedPrivateApprovalStage(ledger, { approvals: ['next'] }, new AbortController().signal);
    lockNext('rename', 'approval.json', 'EPERM', 100);
    let checks = 0;
    const withdrawn = new Error('Approval authority changed.');
    try {
      await expect(stage.publish(ledger, async () => { if (++checks > 1) throw withdrawn; })).rejects.toBe(withdrawn);
    } finally { await stage.dispose(); }
    expect(checks).toBe(2);
    await expect(fs.readFile(ledger, 'utf8')).resolves.toBe('previous');
    expect(await fs.readdir(root)).toEqual(['approval.json']);
  });
});

/** libuv's UV_FS_O_EXLOCK: Windows opens the file with no sharing, as some scanners do. */
const WINDOWS_NO_SHARING = 0x10000000;
const onWindows = process.platform === 'win32' ? describe : describe.skip;

onWindows('a real exclusive Windows lock, released after a moment', () => {
  async function lockBriefly(file: string, ms = 120) {
    const flags = (await import('node:fs')).constants.O_RDONLY | WINDOWS_NO_SHARING;
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    // A scanner may still be looking at the file FLUJO just wrote; take the lock once it lets go.
    for (const started = Date.now(); !handle; await new Promise(resolve => setTimeout(resolve, 10))) {
      try { handle = await fs.open(file, flags); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EBUSY' || Date.now() - started > 5_000) throw error; }
    }
    await expect(fs.readFile(file)).rejects.toMatchObject({ code: 'EBUSY' });
    const held = handle;
    return new Promise<void>(resolve => setTimeout(() => { void held.close().then(resolve); }, ms));
  }

  it('is waited out by stored-item, plain-file and owner sign-in reads', async () => {
    const { loadItem, saveItem } = await import('@/utils/storage/backend');
    const { readPlainFile } = await import('@/utils/readPlainFile');
    const { readOwnerPolicy } = await import('@/backend/services/security/ownerPolicy');
    const { issueOwnerCredential } = await import('@/backend/services/security/ownerCredentials');
    await saveItem(StorageKey.MCP_SERVERS, { flujo: { name: 'flujo' } });
    const { getWorkspaceDbDir } = await import('@/utils/workspace');
    const config = path.join(getWorkspaceDbDir(), 'mcp_servers.json');
    const owner = path.join(root, 'owner.json');
    await fs.writeFile(owner, JSON.stringify({ schemaVersion: 1, ownerId: 'owner-a',
      credentials: [issueOwnerCredential(['control:admin'], Date.now() + 60_000).record] }), { mode: 0o600 });

    let released = lockBriefly(config);
    await expect(loadItem(StorageKey.MCP_SERVERS, {})).resolves.toEqual({ flujo: { name: 'flujo' } });
    await released;
    released = lockBriefly(config);
    await expect(readPlainFile(config)).resolves.toBeInstanceOf(Buffer);
    await released;
    released = lockBriefly(owner);
    await expect(readOwnerPolicy(owner)).resolves.toMatchObject({ ownerId: 'owner-a' });
    await released;
  });
});
