import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  withWorkspaceProcessMutation,
  withWorkspaceProcessSnapshot,
  WORKSPACE_WRITER_REGISTRATION_BATCH_SIZE,
} from '@/backend/services/enduringAgents/runtimeLock';

// Use real lock publication/retirement; isolate storage and OS identity only.
jest.mock('@/utils/storage/backend', () => ({
  assertSafeCollectionId: jest.fn(),
  runInWriteChain: (_key: string, task: () => Promise<unknown>) => task(),
}));
jest.mock('@/utils/workspace', () => ({
  ensureWorkspaceDirs: jest.fn(async () => undefined),
  getCurrentWorkspace: () => 'writer-registration-test',
  getWorkspaceDbDir: () => mockDbDir,
}));

let mockDbDir: string;
let lockRoot: string;
let admissionPath: string;
let savedIdentity: Promise<string | null> | undefined;
const writerPath = (target: unknown) => /\.workspace-capture-writer-[0-9a-f-]+\.lock$/.test(String(target));
function gate() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}
async function observed(promise: Promise<void>): Promise<boolean> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise.then(() => true),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 2_000); })]);
  } finally { clearTimeout(timer); }
}

beforeEach(async () => {
  mockDbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-writer-registration-'));
  lockRoot = path.join(mockDbDir, '.runtime-locks', 'enduring-agents');
  admissionPath = path.join(lockRoot, '.workspace-capture-admission.lock');
  savedIdentity = global.__flujo_enduring_agent_process_birth_marker_v2;
  global.__flujo_enduring_agent_process_birth_marker_v2 = Promise.resolve('win32-v2:638927322190000000');
});
afterEach(async () => {
  jest.restoreAllMocks();
  global.__flujo_enduring_agent_process_birth_marker_v2 = savedIdentity;
  if (path.dirname(mockDbDir) !== path.resolve(os.tmpdir())
      || !path.basename(mockDbDir).startsWith('flujo-writer-registration-')) throw new Error('Unexpected fixture root.');
  // This suite, including its disposable cleanup, is invoked through flujo-bash.
  await fs.rm(mockDbDir, { recursive: true, force: true });
});

test('publishes independent writers together while capture waits for publication and every mutation', async () => {
  const publication = gate(), allPublishing = gate(), mutation = gate(), allMutating = gate();
  const snapshotAttempt = gate();
  const originalLink = fs.link.bind(fs);
  const writers = new Set<string>();
  let mutations = 0, admissionAttempts = 0, captured = false;
  jest.spyOn(fs, 'link').mockImplementation(async (source, target) => {
    if (writerPath(target)) {
      writers.add(String(target));
      if (writers.size === WORKSPACE_WRITER_REGISTRATION_BATCH_SIZE) allPublishing.open();
      await publication.promise;
    } else if (String(target) === admissionPath && ++admissionAttempts > 1) snapshotAttempt.open();
    await originalLink(source, target);
  });
  const jobs = Array.from({ length: WORKSPACE_WRITER_REGISTRATION_BATCH_SIZE }, () =>
    withWorkspaceProcessMutation(async () => {
      mutations++;
      if (mutations === WORKSPACE_WRITER_REGISTRATION_BATCH_SIZE) allMutating.open();
      await mutation.promise;
    }));
  let snapshot: Promise<string> | undefined;
  try {
    expect(await observed(allPublishing.promise)).toBe(true);
    expect(mutations).toBe(0);
    snapshot = withWorkspaceProcessSnapshot(async lock => {
      await lock.assertOwned(); captured = true; return 'drained';
    });
    expect(await observed(snapshotAttempt.promise)).toBe(true);
    expect(captured).toBe(false); expect(mutations).toBe(0);
    publication.open();
    expect(await observed(allMutating.promise)).toBe(true);
    expect(captured).toBe(false);
    mutation.open();
    await Promise.all(jobs);
    await expect(snapshot).resolves.toBe('drained');
    await expect(fs.readdir(lockRoot)).resolves.toEqual([]);
  } finally {
    publication.open(); mutation.open();
    await Promise.allSettled(jobs);
    await snapshot?.catch(() => {});
  }
});

test('a failed writer publication refuses its effect and leaves successful registrations drainable', async () => {
  const originalLink = fs.link.bind(fs);
  const failure = Object.assign(new Error('Injected publication failure'), { code: 'EIO' });
  let failed = false, effects = 0;
  jest.spyOn(fs, 'link').mockImplementation(async (source, target) => {
    if (writerPath(target) && !failed) { failed = true; throw failure; }
    await originalLink(source, target);
  });
  const outcomes = await Promise.allSettled(Array.from({ length: WORKSPACE_WRITER_REGISTRATION_BATCH_SIZE }, () =>
    withWorkspaceProcessMutation(async () => { effects++; })));
  expect(outcomes.filter(row => row.status === 'rejected')).toEqual([{ status: 'rejected', reason: failure }]);
  expect(effects).toBe(WORKSPACE_WRITER_REGISTRATION_BATCH_SIZE - 1);
  await expect(withWorkspaceProcessSnapshot(async () => 'drained')).resolves.toBe('drained');
  await expect(fs.readdir(lockRoot)).resolves.toEqual([]);
});

test('loss of the shared admission owner refuses every effect and preserves the successor', async () => {
  const originalLink = fs.link.bind(fs);
  let published = 0, effects = 0;
  const successor = JSON.stringify({ ownerId: '00000000-0000-4000-8000-000000000101',
    processInstanceId: 'separate-live-owner', pid: process.pid,
    processBirthMarkerV2: 'win32-v2:638927322190000000',
    workspace: 'writer-registration-test', acquiredAt: 0 });
  jest.spyOn(fs, 'link').mockImplementation(async (source, target) => {
    await originalLink(source, target);
    if (writerPath(target) && ++published === WORKSPACE_WRITER_REGISTRATION_BATCH_SIZE) {
      await fs.writeFile(admissionPath, successor);
    }
  });
  const outcomes = await Promise.allSettled(Array.from({ length: WORKSPACE_WRITER_REGISTRATION_BATCH_SIZE }, () =>
    withWorkspaceProcessMutation(async () => { effects++; })));
  expect(outcomes.every(row => row.status === 'rejected')).toBe(true);
  expect(effects).toBe(0);
  await expect(fs.readFile(admissionPath, 'utf8')).resolves.toBe(successor);
  expect((await fs.readdir(lockRoot)).filter(writerPath)).toEqual([]);
});
