/**
 * Issue #1404: one published writer registration covers further writes of the
 * same process, while captures keep draining every write and are never starved.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PersonaRuntimeLockLostError,
  withWorkspaceProcessMutation,
  withWorkspaceProcessSnapshot,
} from '@/backend/services/enduringAgents/runtimeLock';

// Use real lock publication/retirement; isolate storage and OS identity only.
jest.mock('@/utils/storage/backend', () => ({
  assertSafeCollectionId: jest.fn(),
  runInWriteChain: (_key: string, task: () => Promise<unknown>) => task(),
}));
jest.mock('@/utils/workspace', () => ({
  ensureWorkspaceDirs: jest.fn(async () => undefined),
  getCurrentWorkspace: () => 'writer-lease-test',
  getWorkspaceDbDir: () => mockDbDir,
}));

let mockDbDir: string;
let lockRoot: string;
let admissionPath: string;
let savedIdentity: Promise<string | null> | undefined;
const MARKER = 'win32-v2:638927322190000000';
const isWriter = (name: string) => /^\.workspace-capture-writer-[0-9a-f-]{36}\.lock$/.test(name);
const writers = async () => (await fs.readdir(lockRoot).catch(() => [] as string[])).filter(isWriter);
const liveForeignOwner = (ownerId: string) => JSON.stringify({ ownerId,
  processInstanceId: 'separate-live-owner', pid: process.pid, processBirthMarkerV2: MARKER,
  workspace: 'writer-lease-test', acquiredAt: 0 });
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function countWriterPublications() {
  const originalLink = fs.link.bind(fs);
  let published = 0;
  const spy = jest.spyOn(fs, 'link').mockImplementation(async (source, target) => {
    if (isWriter(path.basename(String(target)))) published++;
    await originalLink(source, target);
  });
  return { get published() { return published; }, restore: () => spy.mockRestore() };
}

beforeEach(async () => {
  // jest.setup.ts disables sharing for ordinary suites; this suite tests it.
  delete process.env.FLUJO_WRITER_LEASE_IDLE_MS;
  mockDbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-writer-lease-'));
  lockRoot = path.join(mockDbDir, '.runtime-locks', 'enduring-agents');
  admissionPath = path.join(lockRoot, '.workspace-capture-admission.lock');
  savedIdentity = global.__flujo_enduring_agent_process_birth_marker_v2;
  global.__flujo_enduring_agent_process_birth_marker_v2 = Promise.resolve(MARKER);
});
afterEach(async () => {
  jest.restoreAllMocks();
  // Retire this test's idle registration before its folder disappears.
  await withWorkspaceProcessSnapshot(async () => undefined).catch(() => undefined);
  delete process.env.FLUJO_WRITER_LEASE_IDLE_MS;
  global.__flujo_enduring_agent_process_birth_marker_v2 = savedIdentity;
  if (path.dirname(mockDbDir) !== path.resolve(os.tmpdir())
      || !path.basename(mockDbDir).startsWith('flujo-writer-lease-')) throw new Error('Unexpected fixture root.');
  await fs.rm(mockDbDir, { recursive: true, force: true });
});

test('back-to-back writes share one registration and a capture still drains and retires it', async () => {
  const links = countWriterPublications();
  try {
    for (let index = 0; index < 5; index++) {
      await expect(withWorkspaceProcessMutation(async () => index)).resolves.toBe(index);
    }
    expect(links.published).toBe(1);
    // The idle registration remains published until it retires.
    expect(await writers()).toHaveLength(1);
    const started = performance.now();
    await expect(withWorkspaceProcessSnapshot(async () => 'captured')).resolves.toBe('captured');
    // A capture in this process retires the idle registration at once.
    expect(performance.now() - started).toBeLessThan(900);
    expect(await fs.readdir(lockRoot)).toEqual([]);
  } finally { links.restore(); }
});

test('a capture waits for a covered write that is still running', async () => {
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const running = new Promise<void>(resolve => { entered = resolve; });
  await withWorkspaceProcessMutation(async () => undefined);
  const write = withWorkspaceProcessMutation(async () => { entered(); await held; return 'written'; });
  await running;
  let captured = false;
  const capture = withWorkspaceProcessSnapshot(async () => { captured = true; return 'captured'; });
  await delay(100);
  expect(captured).toBe(false);
  // Writes that start while the capture waits do not join the busy registration.
  let lateWritten = false;
  const late = withWorkspaceProcessMutation(async () => { lateWritten = true; });
  await delay(50);
  expect(lateWritten).toBe(false);
  release();
  await expect(write).resolves.toBe('written');
  await expect(capture).resolves.toBe('captured');
  await late;
  expect(lateWritten).toBe(true);
});

test('a capture held by another process stops new writes from joining', async () => {
  await withWorkspaceProcessMutation(async () => undefined);
  expect(await writers()).toHaveLength(1);
  // Another process holds capture admission for its whole capture.
  await fs.writeFile(admissionPath, liveForeignOwner('00000000-0000-4000-8000-000000000301'));
  let written = false;
  const write = withWorkspaceProcessMutation(async () => { written = true; });
  await delay(150);
  expect(written).toBe(false);
  // The idle registration was retired instead of letting the write slip in.
  expect(await writers()).toEqual([]);
  await fs.unlink(admissionPath);
  await write;
  expect(written).toBe(true);
});

test('a write is not admitted under a registration that another owner replaced', async () => {
  const links = countWriterPublications();
  try {
    await withWorkspaceProcessMutation(async () => undefined);
    const [name] = await writers();
    const successor = liveForeignOwner('00000000-0000-4000-8000-000000000302');
    await fs.writeFile(path.join(lockRoot, name), successor);
    await expect(withWorkspaceProcessMutation(async () => 'written')).resolves.toBe('written');
    expect(links.published).toBe(2);
    // The foreign owner's record is never removed by this process.
    await expect(fs.readFile(path.join(lockRoot, name), 'utf8')).resolves.toBe(successor);
    await fs.unlink(path.join(lockRoot, name));
  } finally { links.restore(); }
});

test('losing the registration during a write is reported to that write', async () => {
  const successor = liveForeignOwner('00000000-0000-4000-8000-000000000303');
  let name = '';
  await expect(withWorkspaceProcessMutation(async () => {
    [name] = await writers();
    await fs.writeFile(path.join(lockRoot, name), successor);
  })).rejects.toBeInstanceOf(PersonaRuntimeLockLostError);
  await expect(fs.readFile(path.join(lockRoot, name), 'utf8')).resolves.toBe(successor);
  await fs.unlink(path.join(lockRoot, name));
  // The next write registers afresh.
  await expect(withWorkspaceProcessMutation(async () => 'next')).resolves.toBe('next');
});

test('an idle registration retires on its own', async () => {
  process.env.FLUJO_WRITER_LEASE_IDLE_MS = '50';
  await withWorkspaceProcessMutation(async () => undefined);
  expect(await writers()).toHaveLength(1);
  const deadline = Date.now() + 5_000;
  while ((await writers()).length > 0 && Date.now() < deadline) await delay(25);
  expect(await writers()).toEqual([]);
});

test('an idle time of zero registers every write separately', async () => {
  process.env.FLUJO_WRITER_LEASE_IDLE_MS = '0';
  const links = countWriterPublications();
  try {
    for (let index = 0; index < 3; index++) {
      await withWorkspaceProcessMutation(async () => undefined);
      expect(await writers()).toEqual([]);
    }
    expect(links.published).toBe(3);
  } finally { links.restore(); }
});
