import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import {
  getCurrentWorkspace,
  normalizeWorkspaceName,
  runWithWorkspace,
} from '@/utils/workspace';
import {
  captureWorkspaceSnapshot,
  SnapshotArchiveError,
  writeWorkspaceSnapshotArchive,
} from './snapshotArchive';
import {
  beginWorkspaceSnapshotBoundary,
  workspaceMutationStatus,
  type WorkspaceSnapshotBoundary,
} from './workspaceMutationGate';
import { WORKSPACE_LAYOUT_VERSION } from './layoutVersion';
import { getWorkerCompatibility, type WorkerCompatibility } from './workerCompatibility';

const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1000;
const MAX_SESSION_TTL_MS = 60 * 60 * 1000;
const DEFAULT_CAPTURE_TIMEOUT_MS = 30_000;
const MAX_CAPTURE_TIMEOUT_MS = 60_000;
const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type SnapshotState =
  | 'beginning'
  | 'staging'
  | 'ready'
  | 'finalized'
  | 'aborted'
  | 'failed';

export interface SnapshotInfo {
  sessionId: string;
  workspace: string;
  generation: number;
  state: SnapshotState;
  createdAt: string;
  expiresAt: string;
  bytesStaged: number;
  filesStaged: number;
  archiveBytes?: number;
  sha256?: string;
  errorCode?: string;
  error?: string;
}

interface SnapshotSessionRecord {
  sessionId: string;
  workspace: string;
  generation: number;
  state: SnapshotState;
  createdAtMs: number;
  expiresAtMs: number;
  bytesStaged: number;
  filesStaged: number;
  archiveBytes?: number;
  sha256?: string;
  archivePath?: string;
  stagingDir?: string;
  errorCode?: string;
  error?: string;
  abortRequested: boolean;
  controller: AbortController;
  flowIds?: string[];
  expiryTimer?: ReturnType<typeof setTimeout>;
}

export class SnapshotCoordinatorError extends Error {
  constructor(
    readonly code:
      | 'SNAPSHOT_BUSY'
      | 'SNAPSHOT_NOT_FOUND'
      | 'SNAPSHOT_NOT_READY'
      | 'SNAPSHOT_EXPIRED'
      | 'SNAPSHOT_INTEGRITY',
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'SnapshotCoordinatorError';
  }
}

declare global {
  var __flujoWorkspaceSnapshotSessions:
    | Map<string, SnapshotSessionRecord>
    | undefined;
}

const sessions = globalThis.__flujoWorkspaceSnapshotSessions
  ?? (globalThis.__flujoWorkspaceSnapshotSessions = new Map());

function sessionTtlMs(): number {
  const configured = Number.parseInt(process.env.FLUJO_SNAPSHOT_SESSION_TTL_MS ?? '', 10);
  if (!Number.isSafeInteger(configured) || configured <= 0) return DEFAULT_SESSION_TTL_MS;
  return Math.min(configured, MAX_SESSION_TTL_MS);
}

function captureTimeoutMs(): number {
  const configured = Number.parseInt(process.env.FLUJO_SNAPSHOT_CAPTURE_TIMEOUT_MS ?? '', 10);
  if (!Number.isSafeInteger(configured) || configured <= 0) return DEFAULT_CAPTURE_TIMEOUT_MS;
  return Math.min(configured, MAX_CAPTURE_TIMEOUT_MS);
}

function publicInfo(session: SnapshotSessionRecord): SnapshotInfo {
  return {
    sessionId: session.sessionId,
    workspace: session.workspace,
    generation: session.generation,
    state: session.state,
    createdAt: new Date(session.createdAtMs).toISOString(),
    expiresAt: new Date(session.expiresAtMs).toISOString(),
    bytesStaged: session.bytesStaged,
    filesStaged: session.filesStaged,
    archiveBytes: session.archiveBytes,
    sha256: session.sha256,
    errorCode: session.errorCode,
    error: session.error,
  };
}

function isTerminal(state: SnapshotState): boolean {
  return state === 'finalized' || state === 'aborted' || state === 'failed';
}

async function removeStaging(session: SnapshotSessionRecord): Promise<void> {
  const stagingDir = session.stagingDir;
  session.archivePath = undefined;
  session.stagingDir = undefined;
  if (stagingDir) {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function clearExpiryTimer(session: SnapshotSessionRecord): void {
  if (!session.expiryTimer) return;
  clearTimeout(session.expiryTimer);
  session.expiryTimer = undefined;
}

async function expireSession(session: SnapshotSessionRecord): Promise<void> {
  if (isTerminal(session.state)) return;
  clearExpiryTimer(session);
  session.abortRequested = true;
  session.state = 'aborted';
  session.errorCode = 'SNAPSHOT_EXPIRED';
  session.controller.abort(new Error('Snapshot session expired.'));
  await removeStaging(session);
}

async function expireIfNeeded(session: SnapshotSessionRecord): Promise<void> {
  if (Date.now() <= session.expiresAtMs || isTerminal(session.state)) return;
  await expireSession(session);
}

async function currentSession(workspace: string): Promise<SnapshotSessionRecord | undefined> {
  const session = sessions.get(workspace);
  if (session) await expireIfNeeded(session);
  return session;
}

function requireSession(workspace: string, sessionId: string): SnapshotSessionRecord {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new SnapshotCoordinatorError(
      'SNAPSHOT_NOT_FOUND',
      404,
      'Snapshot session was not found.',
    );
  }
  const session = sessions.get(workspace);
  if (!session || session.sessionId !== sessionId) {
    throw new SnapshotCoordinatorError(
      'SNAPSHOT_NOT_FOUND',
      404,
      'Snapshot session was not found.',
    );
  }
  return session;
}

async function prepareSession(session: SnapshotSessionRecord): Promise<void> {
  let boundary: WorkspaceSnapshotBoundary | undefined;
  const { signal } = session.controller;
  // Bound the whole write pause, including draining existing writers. The
  // boundary listens to this signal itself, so cancellation releases it even
  // if a filesystem operation has not returned to this function yet.
  const pauseBudget = captureTimeoutMs();
  const captureTimer = setTimeout(() => {
    if (signal.aborted) return;
    session.abortRequested = true;
    session.state = 'failed';
    session.errorCode = 'SNAPSHOT_TIMEOUT';
    clearExpiryTimer(session);
    session.controller.abort(new Error('Workspace snapshot exceeded its capture time limit.'));
  }, pauseBudget);
  captureTimer.unref?.();
  try {
    boundary = await beginWorkspaceSnapshotBoundary(session.workspace, pauseBudget, signal);
    session.generation = boundary.generation;
    signal.throwIfAborted();
    session.state = 'staging';

    const captured = await captureWorkspaceSnapshot(
      session.workspace,
      session.generation,
      { signal, flowIds: session.flowIds },
    );
    signal.throwIfAborted();
    session.bytesStaged = captured.bytes;
    session.filesStaged = captured.files;

    // The ZIP now owns immutable buffers for the selected generation. Resume
    // managed writes before compression and archive persistence.
    boundary.release();
    boundary = undefined;
    clearTimeout(captureTimer);

    const archive = await writeWorkspaceSnapshotArchive(captured, { signal });
    session.archivePath = archive.archivePath;
    session.stagingDir = archive.stagingDir;
    session.archiveBytes = archive.size;
    session.sha256 = archive.sha256;

    if (session.abortRequested) {
      if (session.errorCode !== 'SNAPSHOT_TIMEOUT') session.state = 'aborted';
      await removeStaging(session);
      return;
    }
    session.state = 'ready';
  } catch (error) {
    if (session.abortRequested) {
      if (session.errorCode !== 'SNAPSHOT_TIMEOUT') session.state = 'aborted';
    } else {
      session.state = 'failed';
      clearExpiryTimer(session);
      session.errorCode = error instanceof SnapshotArchiveError
        ? error.code
        : error instanceof Error && error.name === 'WorkspaceSnapshotBusyError'
          ? 'SNAPSHOT_BUSY'
          : error instanceof Error && error.name === 'WorkspaceSnapshotTimeoutError'
            ? 'SNAPSHOT_TIMEOUT'
            : 'SNAPSHOT_FAILED';
      // Archive errors are deliberately credential-free, actionable preflight
      // messages. Never expose arbitrary filesystem/parser/provider exceptions.
      session.error = error instanceof SnapshotArchiveError ? error.message : undefined;
    }
    await removeStaging(session);
  } finally {
    clearTimeout(captureTimer);
    boundary?.release();
  }
}

export const snapshotCoordinator = {
  async info(workspace = getCurrentWorkspace()): Promise<{
    workspace: string;
    layoutVersion: number;
    workerCompatibility: WorkerCompatibility;
    capability: 'available' | 'busy';
    coherence: 'registered-flujo-writers';
    externalRootsIncluded: false;
    activeOperation: SnapshotInfo | null;
  }> {
    const normalizedWorkspace = normalizeWorkspaceName(workspace);
    const session = await currentSession(normalizedWorkspace);
    const mutation = workspaceMutationStatus(normalizedWorkspace);
    const active = session && !isTerminal(session.state) ? publicInfo(session) : null;
    return {
      workspace: normalizedWorkspace,
      layoutVersion: WORKSPACE_LAYOUT_VERSION,
      workerCompatibility: getWorkerCompatibility(),
      capability: active || mutation.blocked ? 'busy' : 'available',
      coherence: 'registered-flujo-writers',
      externalRootsIncluded: false,
      activeOperation: active,
    };
  },

  async begin(workspace = getCurrentWorkspace(), options: { flowIds?: string[] } = {}): Promise<SnapshotInfo> {
    const normalizedWorkspace = normalizeWorkspaceName(workspace);
    // Admission must be synchronous through sessions.set(). An await while
    // checking or cleaning the old record lets two callers reserve the same
    // workspace and makes one operation's archive inaccessible.
    const existing = sessions.get(normalizedWorkspace);
    if (existing && !isTerminal(existing.state) && Date.now() <= existing.expiresAtMs) {
      throw new SnapshotCoordinatorError(
        'SNAPSHOT_BUSY',
        409,
        'A snapshot is already active for this workspace.',
      );
    }
    if (existing) {
      // Each operation owns its cleanup even after its map entry is replaced.
      // Late archive completion observes the same abort signal and cleans up.
      if (!isTerminal(existing.state)) void expireSession(existing);
      else {
        clearExpiryTimer(existing);
        void removeStaging(existing);
      }
    }

    const now = Date.now();
    const ttlMs = sessionTtlMs();
    const session: SnapshotSessionRecord = {
      sessionId: randomUUID(),
      workspace: normalizedWorkspace,
      generation: workspaceMutationStatus(normalizedWorkspace).generation,
      state: 'beginning',
      createdAtMs: now,
      expiresAtMs: now + ttlMs,
      bytesStaged: 0,
      filesStaged: 0,
      abortRequested: false,
      controller: new AbortController(),
      flowIds: options.flowIds ? [...options.flowIds] : undefined,
    };
    sessions.set(normalizedWorkspace, session);
    const expiryTimer = setTimeout(() => {
      void runWithWorkspace(normalizedWorkspace, async () => {
        await expireSession(session);
      });
    }, ttlMs);
    expiryTimer.unref?.();
    session.expiryTimer = expiryTimer;
    void runWithWorkspace(normalizedWorkspace, () => prepareSession(session));
    return publicInfo(session);
  },

  async status(
    sessionId: string,
    workspace = getCurrentWorkspace(),
  ): Promise<SnapshotInfo> {
    const normalizedWorkspace = normalizeWorkspaceName(workspace);
    const session = requireSession(normalizedWorkspace, sessionId);
    await expireIfNeeded(session);
    return publicInfo(session);
  },

  async readDownload(
    sessionId: string,
    workspace = getCurrentWorkspace(),
  ): Promise<{ content: Buffer; sha256: string; size: number }> {
    const normalizedWorkspace = normalizeWorkspaceName(workspace);
    const session = requireSession(normalizedWorkspace, sessionId);
    await expireIfNeeded(session);
    if (session.errorCode === 'SNAPSHOT_EXPIRED') {
      throw new SnapshotCoordinatorError(
        'SNAPSHOT_EXPIRED',
        410,
        'Snapshot session has expired.',
      );
    }
    if (
      session.state !== 'ready'
      || !session.archivePath
      || !session.sha256
      || session.archiveBytes === undefined
    ) {
      throw new SnapshotCoordinatorError(
        'SNAPSHOT_NOT_READY',
        409,
        'Snapshot archive is not ready.',
      );
    }

    const content = await fs.readFile(session.archivePath);
    const sha256 = createHash('sha256').update(content).digest('hex');
    if (content.byteLength !== session.archiveBytes || sha256 !== session.sha256) {
      session.state = 'failed';
      session.errorCode = 'SNAPSHOT_INTEGRITY';
      await removeStaging(session);
      throw new SnapshotCoordinatorError(
        'SNAPSHOT_INTEGRITY',
        500,
        'Snapshot archive failed its integrity check.',
      );
    }
    return { content, sha256, size: content.byteLength };
  },

  async finalize(
    sessionId: string,
    workspace = getCurrentWorkspace(),
  ): Promise<SnapshotInfo> {
    const normalizedWorkspace = normalizeWorkspaceName(workspace);
    const session = requireSession(normalizedWorkspace, sessionId);
    await expireIfNeeded(session);
    if (session.state === 'finalized') return publicInfo(session);
    if (session.state !== 'ready') {
      throw new SnapshotCoordinatorError(
        'SNAPSHOT_NOT_READY',
        409,
        'Only a ready snapshot can be finalized.',
      );
    }
    clearExpiryTimer(session);
    await removeStaging(session);
    session.state = 'finalized';
    return publicInfo(session);
  },

  async abort(
    sessionId: string,
    workspace = getCurrentWorkspace(),
  ): Promise<SnapshotInfo> {
    const normalizedWorkspace = normalizeWorkspaceName(workspace);
    const session = requireSession(normalizedWorkspace, sessionId);
    if (session.state === 'aborted') return publicInfo(session);
    if (session.state === 'finalized') {
      throw new SnapshotCoordinatorError(
        'SNAPSHOT_NOT_READY',
        409,
        'A finalized snapshot cannot be aborted.',
      );
    }
    clearExpiryTimer(session);
    session.abortRequested = true;
    session.state = 'aborted';
    session.controller.abort(new Error('Snapshot session was aborted.'));
    await removeStaging(session);
    return publicInfo(session);
  },
};
