import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
const realRemove = fs.rm.bind(fs);
import type {
  CapturedWorkspaceSnapshot,
  WorkspaceArchiveResult,
} from '@/backend/services/workspace/snapshotArchive';

const mockCapture = jest.fn<Promise<CapturedWorkspaceSnapshot>, [string, number, { signal?: AbortSignal }?]>();
const mockWriteArchive = jest.fn<Promise<WorkspaceArchiveResult>, [CapturedWorkspaceSnapshot, { signal?: AbortSignal }?]>();

jest.mock('@/backend/services/enduringAgents/runtimeLock', () => ({
  withWorkspaceProcessMutation: (task: () => Promise<unknown>) => task(),
  withWorkspaceProcessSnapshot: (task: () => Promise<unknown>) => task(),
}));

jest.mock('@/backend/services/workspace/snapshotArchive', () => ({
  captureWorkspaceSnapshot: (...args: Parameters<typeof mockCapture>) => mockCapture(...args),
  writeWorkspaceSnapshotArchive: (...args: Parameters<typeof mockWriteArchive>) => mockWriteArchive(...args),
  SnapshotArchiveError: class extends Error {},
  resolveSnapshotKey: (value: string) => jest.requireActual('@/backend/services/workspace/snapshotArchive').resolveSnapshotKey(value),
}));

import { snapshotCoordinator } from '@/backend/services/workspace/snapshotCoordinator';
import {
  withWorkspaceMutation,
  workspaceMutationStatus,
} from '@/backend/services/workspace/workspaceMutationGate';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let count = 0; count < 16; count += 1) await Promise.resolve();
}

const captured = { files: 1, bytes: 7 } as CapturedWorkspaceSnapshot;
const archive = (name: string): WorkspaceArchiveResult => ({
  archivePath: `/snapshot-test/${name}/workspace.snapshot.zip`,
  stagingDir: `/snapshot-test/${name}`,
  sha256: 'test-sha256',
  plaintextSha256: 'test-sha256',
  encrypted: false,
  size: 10,
  files: 1,
  bytes: 7,
});

describe('snapshot coordinator cancellation and ownership', () => {
  let remove: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    globalThis.__flujoWorkspaceSnapshotSessions?.clear();
    globalThis.__flujoWorkspaceMutationGates?.clear();
    mockCapture.mockReset().mockResolvedValue(captured);
    mockWriteArchive.mockReset().mockResolvedValue(archive('ready'));
    remove = jest.spyOn(fs, 'rm').mockResolvedValue(undefined);
  });

  afterEach(() => {
    for (const session of globalThis.__flujoWorkspaceSnapshotSessions?.values() ?? []) {
      session.controller.abort();
    }
    jest.clearAllTimers();
    jest.useRealTimers();
    remove.mockRestore();
    delete process.env.FLUJO_SNAPSHOT_CAPTURE_TIMEOUT_MS;
    delete process.env.FLUJO_SNAPSHOT_SESSION_TTL_MS;
  });

  it('fails and removes the archive when captured spool cleanup fails', async () => {
    const dispose = jest.fn().mockRejectedValue(new Error('injected captured cleanup failure'));
    mockCapture.mockResolvedValueOnce({ ...captured, dispose });
    const session = await snapshotCoordinator.begin('capture-cleanup-failure');
    await flushMicrotasks();
    expect(await snapshotCoordinator.status(session.sessionId, 'capture-cleanup-failure')).toMatchObject({ state: 'failed', errorCode: 'SNAPSHOT_FAILED' });
    expect(dispose).toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith('/snapshot-test/ready', { recursive: true, force: true });
  });

  it('advertises worker compatibility in authenticated snapshot information', async () => {
    const info = await snapshotCoordinator.info('compatibility');
    expect(info.workerCompatibility).toMatchObject({
      applicationVersion: expect.any(String), snapshotFormatVersion: 2,
      layoutVersion: 2, workerProtocolVersion: 1,
    });
    expect(info.capability).toBe('available');
  });

  it('publishes distinct restore and wire digests and detects altered download bytes', async () => {
    const wire = Buffer.from('authenticated encrypted envelope bytes');
    const wireHash = createHash('sha256').update(wire).digest('hex');
    const plaintextHash = 'b'.repeat(64);
    const root = await fs.mkdtemp(path.join(tmpdir(), 'flujo-download-coordinator-'));
    const archivePath = path.join(root, 'snapshot');
    await fs.writeFile(archivePath, wire, { mode: 0o600 });
    mockWriteArchive.mockResolvedValueOnce({ ...archive('encrypted'), archivePath, stagingDir: root, sha256: wireHash,
      plaintextSha256: plaintextHash, encrypted: true, size: wire.length });
    try {
      const started = await snapshotCoordinator.begin('encrypted-download');
      await flushMicrotasks();
      await expect(snapshotCoordinator.status(started.sessionId, 'encrypted-download')).resolves.toMatchObject({
        state: 'ready', sha256: wireHash, plaintextSha256: plaintextHash, encrypted: true,
      });
      const download = await snapshotCoordinator.readDownload(started.sessionId, 'encrypted-download');
      expect(download).toMatchObject({ sha256: wireHash, plaintextSha256: plaintextHash, encrypted: true });
      const reader = download.content.getReader(); const chunks: Uint8Array[] = [];
      for (;;) { const result = await reader.read(); if (result.done) break; chunks.push(result.value); }
      expect(Buffer.concat(chunks)).toEqual(wire);
      await fs.writeFile(archivePath, 'changed encrypted envelope bytes');
      await expect(snapshotCoordinator.readDownload(started.sessionId, 'encrypted-download')).rejects.toMatchObject({ code: 'SNAPSHOT_INTEGRITY' });
      await expect(snapshotCoordinator.status(started.sessionId, 'encrypted-download')).resolves.toMatchObject({ state: 'failed' });
    } finally { await realRemove(root, { recursive: true, force: true }); }
  });

  it('reserves a workspace atomically for concurrent begin requests', async () => {
    const pendingCapture = deferred<CapturedWorkspaceSnapshot>();
    mockCapture.mockReturnValue(pendingCapture.promise);
    const results = await Promise.allSettled([
      snapshotCoordinator.begin('concurrent-begin'),
      snapshotCoordinator.begin('concurrent-begin'),
    ]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(results[1]).toMatchObject({ reason: { code: 'SNAPSHOT_BUSY', status: 409 } });
    const first = results[0];
    if (first.status !== 'fulfilled') throw new Error('First begin unexpectedly failed.');
    expect((await snapshotCoordinator.status(first.value.sessionId, 'concurrent-begin')).state).toBe('staging');
    pendingCapture.resolve(captured);
    await flushMicrotasks();
    expect(mockWriteArchive).toHaveBeenCalledTimes(1);
  });

  it('aborts a pending capture and unblocks writers before the capture resolves', async () => {
    const pendingCapture = deferred<CapturedWorkspaceSnapshot>();
    mockCapture.mockReturnValueOnce(pendingCapture.promise);
    const session = await snapshotCoordinator.begin('abort-capture');
    await flushMicrotasks();
    const writer = jest.fn(async () => undefined);
    const queued = withWorkspaceMutation(writer, 'abort-capture');
    expect(workspaceMutationStatus('abort-capture').blocked).toBe(true);

    expect((await snapshotCoordinator.abort(session.sessionId, 'abort-capture')).state).toBe('aborted');
    await queued;
    expect(writer).toHaveBeenCalledTimes(1);
    expect(mockCapture.mock.calls[0][2]?.signal?.aborted).toBe(true);
    pendingCapture.resolve(captured);
    await flushMicrotasks();
    expect(mockWriteArchive).not.toHaveBeenCalled();
  });

  it('cleans a late archive after its aborted session has been replaced', async () => {
    const pendingArchive = deferred<WorkspaceArchiveResult>();
    mockWriteArchive.mockReturnValueOnce(pendingArchive.promise);
    const first = await snapshotCoordinator.begin('replace-aborted');
    await flushMicrotasks();
    await snapshotCoordinator.abort(first.sessionId, 'replace-aborted');
    const second = await snapshotCoordinator.begin('replace-aborted');
    await flushMicrotasks();
    pendingArchive.resolve(archive('old-late-result'));
    await flushMicrotasks();

    expect(remove).toHaveBeenCalledWith('/snapshot-test/old-late-result', { recursive: true, force: true });
    expect((await snapshotCoordinator.status(second.sessionId, 'replace-aborted')).state).toBe('ready');
    expect(mockWriteArchive.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('expires a writing session and retains cleanup ownership after replacement', async () => {
    process.env.FLUJO_SNAPSHOT_SESSION_TTL_MS = '100';
    const pendingArchive = deferred<WorkspaceArchiveResult>();
    mockWriteArchive.mockReturnValueOnce(pendingArchive.promise);
    const first = await snapshotCoordinator.begin('expiry-cleanup');
    await flushMicrotasks();
    await jest.advanceTimersByTimeAsync(101);
    expect(await snapshotCoordinator.status(first.sessionId, 'expiry-cleanup')).toMatchObject({
      state: 'aborted', errorCode: 'SNAPSHOT_EXPIRED',
    });
    const second = await snapshotCoordinator.begin('expiry-cleanup');
    pendingArchive.resolve(archive('expired-late-result'));
    await flushMicrotasks();

    expect(remove).toHaveBeenCalledWith('/snapshot-test/expired-late-result', { recursive: true, force: true });
    expect((await snapshotCoordinator.status(second.sessionId, 'expiry-cleanup')).state).toBe('ready');
  });

  it('bounds the capture pause, reports timeout, and discards the late result', async () => {
    process.env.FLUJO_SNAPSHOT_CAPTURE_TIMEOUT_MS = '25';
    const pendingCapture = deferred<CapturedWorkspaceSnapshot>();
    mockCapture.mockReturnValueOnce(pendingCapture.promise);
    const session = await snapshotCoordinator.begin('capture-deadline');
    const writer = withWorkspaceMutation(async () => undefined, 'capture-deadline');
    await jest.advanceTimersByTimeAsync(25);
    await writer;

    expect(workspaceMutationStatus('capture-deadline').blocked).toBe(false);
    expect(await snapshotCoordinator.status(session.sessionId, 'capture-deadline')).toMatchObject({
      state: 'failed', errorCode: 'SNAPSHOT_TIMEOUT',
    });
    pendingCapture.resolve(captured);
    await flushMicrotasks();
    expect(mockWriteArchive).not.toHaveBeenCalled();
    expect((await snapshotCoordinator.status(session.sessionId, 'capture-deadline')).state).toBe('failed');
  });

  it('includes draining writers in the capture deadline and caps configuration at sixty seconds', async () => {
    process.env.FLUJO_SNAPSHOT_CAPTURE_TIMEOUT_MS = '120000';
    const finishWriter = deferred<void>();
    const writer = withWorkspaceMutation(() => finishWriter.promise, 'drain-deadline');
    const session = await snapshotCoordinator.begin('drain-deadline');
    await jest.advanceTimersByTimeAsync(59_999);
    expect(workspaceMutationStatus('drain-deadline').blocked).toBe(true);
    await jest.advanceTimersByTimeAsync(1);
    expect(workspaceMutationStatus('drain-deadline').blocked).toBe(false);
    expect(await snapshotCoordinator.status(session.sessionId, 'drain-deadline')).toMatchObject({
      state: 'failed', errorCode: 'SNAPSHOT_TIMEOUT',
    });
    expect(mockCapture).not.toHaveBeenCalled();
    finishWriter.resolve();
    await writer;
  });

  it('releases the gate and clears the capture deadline before archive compression', async () => {
    process.env.FLUJO_SNAPSHOT_CAPTURE_TIMEOUT_MS = '25';
    const pendingArchive = deferred<WorkspaceArchiveResult>();
    mockWriteArchive.mockReturnValueOnce(pendingArchive.promise);
    const session = await snapshotCoordinator.begin('compression-unblocked');
    await flushMicrotasks();
    expect(workspaceMutationStatus('compression-unblocked').blocked).toBe(false);
    await jest.advanceTimersByTimeAsync(30);
    expect(mockWriteArchive.mock.calls[0][1]?.signal?.aborted).toBe(false);
    pendingArchive.resolve(archive('compressed'));
    await flushMicrotasks();
    expect((await snapshotCoordinator.status(session.sessionId, 'compression-unblocked')).state).toBe('ready');
  });
});
