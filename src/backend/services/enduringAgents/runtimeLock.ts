import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { promisify } from 'util';

import { assertSafeCollectionId, runInWriteChain } from '@/utils/storage/backend';
import { stableEnduringAgentId } from './ids';
import { getPersonaRuntimeClock } from './runtimeClock';
import {
  ensureWorkspaceDirs,
  getCurrentWorkspace,
  getWorkspaceDbDir,
} from '@/utils/workspace';

const runtimeClock = getPersonaRuntimeClock();

const LOCK_ROOT_SEGMENTS = ['.runtime-locks', 'enduring-agents'] as const;
const LOCK_ACQUIRE_TIMEOUT_MS = 15_000;
const LOCK_RETRY_MS = 25;
const PROCESS_BIRTH_CACHE_TTL_MS = 1_000;
// Keep the Windows OS lookup well inside the 15-second acquisition budget.
// A timeout is uncertainty and must never be treated as stale-owner evidence.
const WINDOWS_PROCESS_BIRTH_PROBE_TIMEOUT_MS = 900;
const PROCESS_BIRTH_MARKER_SUPPORTED = ['darwin', 'linux', 'win32'].includes(process.platform);
const UUID_FILE_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const execFileAsync = promisify(execFile);

interface ProcessBirthProbeOptions {
  encoding: 'utf8';
  timeout: number;
  windowsHide?: boolean;
  env?: NodeJS.ProcessEnv;
}

type ProcessBirthProbeRunner = (
  executable: string,
  args: string[],
  options: ProcessBirthProbeOptions,
) => Promise<{ stdout: string }>;

const defaultProcessBirthProbeRunner: ProcessBirthProbeRunner = async (
  executable,
  args,
  options,
) => {
  const { stdout } = await execFileAsync(executable, args, options);
  return { stdout: String(stdout) };
};
let processBirthProbeRunner = defaultProcessBirthProbeRunner;

declare global {
  // Next can evaluate this module in multiple route bundles in one process.
  // Sharing the incarnation prevents one bundle mistaking another bundle with
  // the same PID for a stale process after a hot reload.
  var __flujo_enduring_agent_process_instance_id: string | undefined;
  var __flujo_enduring_agent_process_birth_marker: Promise<string | null> | undefined;
  var __flujo_enduring_agent_process_birth_marker_v2: Promise<string | null> | undefined;
  var __flujo_enduring_agent_linux_boot_id: Promise<string | null> | undefined;
  var __flujo_enduring_agent_active_lock_owners: Set<string> | undefined;
  var __flujo_enduring_agent_issued_runtime_lock_scopes_v2: WeakMap<
    object,
    IssuedRuntimeLockScope
  > | undefined;
  var __flujo_enduring_agent_deferred_lock_cleanups: Set<string> | undefined;
}

const PROCESS_INSTANCE_ID = global.__flujo_enduring_agent_process_instance_id ??= randomUUID();
const ACTIVE_OWNER_IDS = global.__flujo_enduring_agent_active_lock_owners ??= new Set<string>();
const ISSUED_RUNTIME_LOCKS = global.__flujo_enduring_agent_issued_runtime_lock_scopes_v2
  ??= new WeakMap<object, IssuedRuntimeLockScope>();
const DEFERRED_CLEANUP_KEYS = global.__flujo_enduring_agent_deferred_lock_cleanups
  ??= new Set<string>();
const processBirthCache = new Map<number, { checkedAt: number; marker: string | null }>();
const processBirthInFlight = new Map<number, Promise<string | null>>();

interface LockOwnerRecord {
  ownerId: string;
  processInstanceId: string;
  pid: number;
  /** Accepted only when reading old locks; v2 writers intentionally omit it. */
  processBirthMarker?: string;
  /** Canonical, boot-qualified marker used by v2 readers. */
  processBirthMarkerV2?: string;
  workspace: string;
  acquiredAt: number;
}

interface RecoveryOwnerRecord extends LockOwnerRecord {
  targetOwnerId: string;
  targetProcessInstanceId: string;
  targetPid: number;
}

interface IssuedRuntimeLockScope {
  personaId: string;
  workspace: string;
  closing: boolean;
  activeOperations: number;
  idleWaiters: Set<() => void>;
}

export interface PersonaRuntimeLock {
  /** Re-check this immediately before each durable transition write. */
  assertOwned(): Promise<void>;
}

function getIssuedPersonaRuntimeLockScope(
  lock: PersonaRuntimeLock,
  personaId: string,
): IssuedRuntimeLockScope {
  const scope = ISSUED_RUNTIME_LOCKS.get(lock);
  if (
    !scope
    || scope.personaId !== personaId
    || scope.workspace !== getCurrentWorkspace()
  ) {
    throw new Error('Persona runtime lock capability was not issued by this runtime.');
  }
  return scope;
}

/** Keep the physical lock alive for the full dynamic extent of a durable write. */
export async function withIssuedPersonaRuntimeLockOperation<T>(
  lock: PersonaRuntimeLock,
  personaId: string,
  task: () => Promise<T>,
): Promise<T> {
  const scope = getIssuedPersonaRuntimeLockScope(lock, personaId);
  if (scope.closing) {
    throw new Error('Persona runtime lock capability is closing.');
  }
  scope.activeOperations += 1;
  try {
    await lock.assertOwned();
    return await task();
  } finally {
    scope.activeOperations -= 1;
    if (scope.activeOperations === 0) {
      for (const resolve of scope.idleWaiters) resolve();
      scope.idleWaiters.clear();
    }
  }
}

async function closeIssuedPersonaRuntimeLock(lock: PersonaRuntimeLock): Promise<void> {
  const scope = ISSUED_RUNTIME_LOCKS.get(lock);
  if (!scope) return;
  scope.closing = true;
  if (scope.activeOperations > 0) {
    await new Promise<void>((resolve) => scope.idleWaiters.add(resolve));
  }
}

export class PersonaRuntimeLockTimeoutError extends Error {
  readonly code = 'PERSONA_RUNTIME_LOCK_TIMEOUT' as const;

  constructor(readonly personaId: string) {
    super(`Timed out acquiring the runtime lock for Persona ${JSON.stringify(personaId)}.`);
    this.name = 'PersonaRuntimeLockTimeoutError';
  }
}

export class PersonaRuntimeLockLostError extends Error {
  readonly code = 'PERSONA_RUNTIME_LOCK_LOST' as const;

  constructor(readonly personaId: string) {
    super(`Lost the runtime lock for Persona ${JSON.stringify(personaId)}.`);
    this.name = 'PersonaRuntimeLockLostError';
  }
}

function delay(ms: number): Promise<void> {
  return runtimeClock.sleep(ms);
}

async function ensureRuntimeLockRoot(): Promise<string> {
  await ensureWorkspaceDirs(getCurrentWorkspace());
  const dbDir = path.resolve(getWorkspaceDbDir());
  const lockRoot = path.join(dbDir, ...LOCK_ROOT_SEGMENTS);
  await fs.mkdir(lockRoot, { recursive: true });

  const [canonicalDb, canonicalRoot] = await Promise.all([
    fs.realpath(dbDir),
    fs.realpath(lockRoot),
  ]);
  const relative = path.relative(canonicalDb, canonicalRoot);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Persona runtime lock root escapes the workspace database: ${lockRoot}`);
  }
  return canonicalRoot;
}

async function readLockRecord(lockPath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(lockPath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Persona runtime lock ${JSON.stringify(lockPath)} is malformed.`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    // A canonical lock is installed from a fully-written candidate through an
    // atomic hard link. Malformed content is therefore corruption, not a stale
    // acquisition that can be stolen safely.
    throw error;
  }
}

function parseOwnerRecord(
  lockPath: string,
  parsed: Record<string, unknown>,
): LockOwnerRecord {
  if (
    typeof parsed.ownerId !== 'string'
    || !UUID_FILE_SEGMENT.test(parsed.ownerId)
    || typeof parsed.processInstanceId !== 'string'
    || typeof parsed.pid !== 'number'
    || !Number.isInteger(parsed.pid)
    || parsed.pid <= 0
    || (
      parsed.processBirthMarker !== undefined
      && typeof parsed.processBirthMarker !== 'string'
    )
    || (
      parsed.processBirthMarkerV2 !== undefined
      && typeof parsed.processBirthMarkerV2 !== 'string'
    )
    || typeof parsed.workspace !== 'string'
    || typeof parsed.acquiredAt !== 'number'
  ) {
    throw new Error(`Persona runtime lock ${JSON.stringify(lockPath)} is malformed.`);
  }
  return parsed as unknown as LockOwnerRecord;
}

async function readOwner(lockPath: string): Promise<LockOwnerRecord | null> {
  const parsed = await readLockRecord(lockPath);
  return parsed ? parseOwnerRecord(lockPath, parsed) : null;
}

async function readRecoveryOwner(lockPath: string): Promise<RecoveryOwnerRecord | null> {
  const parsed = await readLockRecord(lockPath);
  if (!parsed) return null;
  const owner = parseOwnerRecord(lockPath, parsed);
  if (
    typeof parsed.targetOwnerId !== 'string'
    || !UUID_FILE_SEGMENT.test(parsed.targetOwnerId)
    || typeof parsed.targetProcessInstanceId !== 'string'
    || typeof parsed.targetPid !== 'number'
    || !Number.isInteger(parsed.targetPid)
    || parsed.targetPid <= 0
  ) {
    throw new Error(`Persona runtime recovery lock ${JSON.stringify(lockPath)} is malformed.`);
  }
  return { ...owner, ...parsed } as unknown as RecoveryOwnerRecord;
}

async function listRecoveryOwners(
  lockRoot: string,
  lockPath: string,
): Promise<Array<{ path: string; owner: RecoveryOwnerRecord }>> {
  const prefix = `${path.basename(lockPath)}.recovery.`;
  const names = (await fs.readdir(lockRoot)).filter(
    (name) => name.startsWith(prefix) && UUID_FILE_SEGMENT.test(name.slice(prefix.length)),
  );
  const records = await Promise.all(names.map(async (name) => {
    const recoveryPath = path.join(lockRoot, name);
    const owner = await readRecoveryOwner(recoveryPath);
    return owner ? { path: recoveryPath, owner } : null;
  }));
  return records.filter(
    (record): record is { path: string; owner: RecoveryOwnerRecord } => record !== null,
  );
}

function abandonmentMarkerPath(lockPath: string, ownerId: string): string {
  if (!UUID_FILE_SEGMENT.test(ownerId)) {
    throw new Error(`Persona runtime lock owner id ${JSON.stringify(ownerId)} is malformed.`);
  }
  const lockDirectory = path.dirname(lockPath);
  const markerPath = path.join(
    lockDirectory,
    `${path.basename(lockPath)}.abandoned.${ownerId}`,
  );
  if (path.dirname(markerPath) !== lockDirectory) {
    throw new Error('Persona runtime abandonment marker escapes its lock directory.');
  }
  return markerPath;
}

async function listAbandonedOwnerIds(
  lockRoot: string,
  lockPath: string,
): Promise<Set<string>> {
  const prefix = `${path.basename(lockPath)}.abandoned.`;
  const ownerIds = (await fs.readdir(lockRoot))
    .filter((name) => name.startsWith(prefix) && UUID_FILE_SEGMENT.test(name.slice(prefix.length)))
    .map((name) => name.slice(prefix.length));
  return new Set(ownerIds);
}

async function publishOwnerAbandoned(
  lockRoot: string,
  lockPath: string,
  owner: LockOwnerRecord,
): Promise<string> {
  const markerPath = abandonmentMarkerPath(lockPath, owner.ownerId);
  await installCandidateLockWithRetry(lockRoot, markerPath, owner);
  return markerPath;
}

async function cleanupAbandonmentMarker(markerPath: string): Promise<void> {
  try {
    await unlinkWithRetry(markerPath);
  } catch {
    // A leftover marker is safe and owner ids are never reused. A later scan
    // may remove it once no canonical/intent references that owner.
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    // EPERM or an unknown platform response is uncertainty: fail closed.
    return true;
  }
}

async function getLinuxBootId(): Promise<string | null> {
  const lookup = global.__flujo_enduring_agent_linux_boot_id
    ??= fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')
      .then((value) => value.trim() || null)
      .catch(() => null);
  const bootId = await lookup;
  if (!bootId && global.__flujo_enduring_agent_linux_boot_id === lookup) {
    global.__flujo_enduring_agent_linux_boot_id = undefined;
  }
  return bootId;
}

async function queryWindowsProcessBirthMarker(pid: number): Promise<string | null> {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) return null;
  const normalizedSystemRoot = path.win32.normalize(systemRoot);
  if (!/^[a-z]:\\/i.test(normalizedSystemRoot)) return null;
  const powershellPath = path.win32.join(
    normalizedSystemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const { stdout } = await processBirthProbeRunner(powershellPath, [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `$p=Get-Process -Id ${pid} -ErrorAction Stop; $p.StartTime.ToUniversalTime().Ticks`,
  ], {
    encoding: 'utf8',
    timeout: WINDOWS_PROCESS_BIRTH_PROBE_TIMEOUT_MS,
    windowsHide: true,
  });
  const value = stdout.trim();
  return value ? `win32-v2:${value}` : null;
}

async function queryPlatformProcessBirthMarker(pid: number): Promise<string | null> {
  try {
    if (process.platform === 'linux') {
      const [stat, bootId] = await Promise.all([
        fs.readFile(`/proc/${pid}/stat`, 'utf8'),
        getLinuxBootId(),
      ]);
      if (!bootId) return null;
      const closeParen = stat.lastIndexOf(')');
      if (closeParen < 0) return null;
      // Fields after the executable name begin at proc field 3; starttime is 22.
      const fields = stat.slice(closeParen + 1).trim().split(/\s+/);
      if (fields[0] === 'Z') return 'dead:linux-zombie';
      const startTime = fields[19];
      return startTime ? `linux-v2:${bootId}:${startTime}` : null;
    }
    if (process.platform === 'win32') {
      return await queryWindowsProcessBirthMarker(pid);
    }
    if (process.platform === 'darwin') {
      const { stdout } = await processBirthProbeRunner('/bin/ps', [
        '-o',
        'state=',
        '-o',
        'lstart=',
        '-p',
        String(pid),
      ], {
        encoding: 'utf8',
        timeout: 3_000,
        env: { ...process.env, LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
      });
      const value = stdout.trim();
      const parsed = /^(\S+)\s+(.+)$/.exec(value);
      if (!parsed) return null;
      if (parsed[1].includes('Z')) return 'dead:darwin-zombie';
      return `darwin-v2:${parsed[2].trim()}`;
    }
  } catch {
    // A failed birth lookup is uncertainty. PID liveness remains fail-closed.
  }
  return null;
}

let processBirthMarkerProbe = queryPlatformProcessBirthMarker;

async function queryProcessBirthMarker(pid: number): Promise<string | null> {
  try {
    return await processBirthMarkerProbe(pid);
  } catch {
    // Probe failures and timeouts are uncertainty. Callers must remain fail
    // closed and may only recover a lock from explicit stale-owner evidence.
    return null;
  }
}

async function getOwnProcessBirthMarkerV2(): Promise<string | null> {
  const lookup = global.__flujo_enduring_agent_process_birth_marker_v2
    ??= queryProcessBirthMarker(process.pid);
  const marker = await lookup;
  if (!marker && global.__flujo_enduring_agent_process_birth_marker_v2 === lookup) {
    // A transient probe failure must not disable PID-reuse protection for the
    // lifetime of the server. The next lock attempt gets a fresh observation.
    global.__flujo_enduring_agent_process_birth_marker_v2 = undefined;
  }
  if (!marker && PROCESS_BIRTH_MARKER_SUPPORTED) {
    throw new Error('Unable to establish this process birth identity for Persona locking.');
  }
  return marker;
}

/**
 * Establish and cache this process's fail-closed birth identity before a
 * readiness boundary is advertised (issue #457).
 *
 * Runtime locks still call the private lookup themselves. This initializer is
 * intentionally narrow: subprocess bootstraps can make "ready" truthful
 * without exposing the marker or weakening PID-reuse protection.
 */
export async function initializePersonaRuntimeLockProcessIdentity(): Promise<void> {
  await getOwnProcessBirthMarkerV2();
}

async function getProcessBirthMarker(pid: number): Promise<string | null> {
  if (pid === process.pid) return getOwnProcessBirthMarkerV2();
  const cached = processBirthCache.get(pid);
  if (cached && runtimeClock.monotonicNow() - cached.checkedAt < PROCESS_BIRTH_CACHE_TTL_MS) {
    return cached.marker;
  }
  const existing = processBirthInFlight.get(pid);
  if (existing) return existing;

  const lookup = queryProcessBirthMarker(pid)
    .then((marker) => {
      processBirthCache.set(pid, { checkedAt: runtimeClock.monotonicNow(), marker });
      return marker;
    })
    .finally(() => {
      if (processBirthInFlight.get(pid) === lookup) {
        processBirthInFlight.delete(pid);
      }
    });
  processBirthInFlight.set(pid, lookup);
  return lookup;
}

/** Narrow test seam for deterministic process-probe regression coverage. */
export function _setPersonaRuntimeLockProcessBirthProbeForTests(
  probe?: (pid: number) => Promise<string | null>,
): void {
  processBirthMarkerProbe = probe ?? queryPlatformProcessBirthMarker;
  processBirthCache.clear();
  processBirthInFlight.clear();
}

export function _setPersonaRuntimeLockProcessBirthProbeRunnerForTests(
  runner?: ProcessBirthProbeRunner,
): void {
  processBirthProbeRunner = runner ?? defaultProcessBirthProbeRunner;
}

export async function _getPersonaRuntimeLockProcessBirthMarkerForTests(
  pid: number,
): Promise<string | null> {
  return getProcessBirthMarker(pid);
}

export async function _queryWindowsProcessBirthMarkerForTests(
  pid: number,
): Promise<string | null> {
  try {
    return await queryWindowsProcessBirthMarker(pid);
  } catch {
    return null;
  }
}

function birthMarkerVersion(marker: string): string | null {
  if (/^linux-v2:[0-9a-f-]{36}:\d+$/i.test(marker)) return 'linux-v2';
  if (
    /^darwin-v2:[A-Z][a-z]{2} [A-Z][a-z]{2}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/
      .test(marker)
  ) return 'darwin-v2';
  if (/^win32-v2:\d+$/.test(marker)) return 'win32-v2';
  return null;
}

function birthMarkersProveDifferent(recorded: string, current: string): boolean {
  if (current.startsWith('dead:')) return true;
  const recordedVersion = birthMarkerVersion(recorded);
  return Boolean(
    recordedVersion
    && recordedVersion === birthMarkerVersion(current)
    && recorded !== current,
  );
}

async function isOwnerProcessAlive(
  owner: LockOwnerRecord,
  abandonedOwnerIds: ReadonlySet<string>,
): Promise<boolean> {
  if (abandonedOwnerIds.has(owner.ownerId)) return false;
  if (owner.pid === process.pid) {
    const ownBirthMarker = await getOwnProcessBirthMarkerV2();
    if (
      owner.processBirthMarkerV2
      && ownBirthMarker
      && birthMarkersProveDifferent(owner.processBirthMarkerV2, ownBirthMarker)
    ) return false;
    if (owner.processInstanceId === PROCESS_INSTANCE_ID) {
      return ACTIVE_OWNER_IDS.has(owner.ownerId);
    }
    // A sibling isolate can share a PID without sharing JS globals. Matching
    // OS birth identity proves the process itself is still alive; fail closed
    // when the platform cannot provide that identity.
    if (!owner.processBirthMarkerV2 || !ownBirthMarker) return true;
    return !birthMarkersProveDifferent(owner.processBirthMarkerV2, ownBirthMarker);
  }
  if (!isProcessAlive(owner.pid)) return false;
  if (!owner.processBirthMarkerV2) {
    // Legacy owners have no comparable v2 identity, but a canonical probe can
    // still prove that their PID is an unreaped zombie. Every other result is
    // uncertainty and remains fail-closed/alive for rolling compatibility.
    let current = await getProcessBirthMarker(owner.pid);
    if (current?.startsWith('dead:')) {
      current = await queryProcessBirthMarker(owner.pid);
      processBirthCache.set(owner.pid, {
        checkedAt: runtimeClock.monotonicNow(),
        marker: current,
      });
    }
    return !current?.startsWith('dead:');
  }
  let currentBirthMarker = await getProcessBirthMarker(owner.pid);
  if (
    currentBirthMarker
    && birthMarkersProveDifferent(owner.processBirthMarkerV2, currentBirthMarker)
  ) {
    // A PID can be reused inside the short positive cache window. A mismatch
    // is therefore only evidence of death after a fresh OS observation; a
    // cached match is safe but a cached mismatch is not.
    currentBirthMarker = await queryProcessBirthMarker(owner.pid);
    processBirthCache.set(owner.pid, {
      checkedAt: runtimeClock.monotonicNow(),
      marker: currentBirthMarker,
    });
  }
  return !currentBirthMarker
    || !birthMarkersProveDifferent(owner.processBirthMarkerV2, currentBirthMarker);
}

export async function _isPersonaRuntimeLockOwnerAliveForTests(
  pid: number,
  processBirthMarkerV2?: string,
): Promise<boolean> {
  return isOwnerProcessAlive({
    ownerId: randomUUID(),
    processInstanceId: 'runtime-lock-process-probe-test',
    pid,
    processBirthMarkerV2,
    workspace: getCurrentWorkspace(),
    acquiredAt: 0,
  }, new Set());
}

async function unlinkWithRetry(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await fs.unlink(filePath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      if (!['EACCES', 'EBUSY', 'EPERM'].includes(code ?? '') || attempt === 19) throw error;
      await delay(LOCK_RETRY_MS);
    }
  }
}

async function installCandidateLock(
  lockRoot: string,
  lockPath: string,
  owner: LockOwnerRecord,
): Promise<boolean> {
  const candidatePath = path.join(
    lockRoot,
    `${path.basename(lockPath)}.candidate.${randomUUID()}`,
  );
  try {
    await fs.writeFile(candidatePath, JSON.stringify(owner), { encoding: 'utf8', flag: 'wx' });
    try {
      // Hard-link installation is an atomic create-if-absent operation on the
      // shared local filesystem. Unlike an empty lock directory, the canonical
      // path is never visible without a complete owner record.
      await fs.link(candidatePath, lockPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  } finally {
    try { await fs.unlink(candidatePath); } catch { /* best-effort candidate cleanup */ }
  }
}

async function installCandidateLockWithRetry(
  lockRoot: string,
  lockPath: string,
  owner: LockOwnerRecord,
): Promise<boolean> {
  const startedAt = runtimeClock.monotonicNow();
  while (true) {
    try {
      return await installCandidateLock(lockRoot, lockPath, owner);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        !['EACCES', 'EBUSY', 'EPERM'].includes(code ?? '')
        || runtimeClock.monotonicNow() - startedAt >= LOCK_ACQUIRE_TIMEOUT_MS
      ) throw error;
      await delay(LOCK_RETRY_MS);
    }
  }
}

function backgroundDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = runtimeClock.setTimer(resolve, ms);
    timer.unref();
  });
}

function scheduleRecoveryIntentCleanup(
  lockRoot: string,
  lockPath: string,
  intentPath: string,
  intent: RecoveryOwnerRecord,
): void {
  const cleanupKey = `intent:${intentPath}`;
  if (DEFERRED_CLEANUP_KEYS.has(cleanupKey)) return;
  DEFERRED_CLEANUP_KEYS.add(cleanupKey);
  void (async () => {
    while (true) {
      let markerPath: string | null = null;
      try {
        markerPath = await publishOwnerAbandoned(lockRoot, lockPath, intent);
      } catch {
        // The unique intent can still be removed directly once the filesystem
        // becomes writable; its path is never reused by another operation.
      }
      ACTIVE_OWNER_IDS.delete(intent.ownerId);
      try {
        await unlinkWithRetry(intentPath);
        if (markerPath) await cleanupAbandonmentMarker(markerPath);
        return;
      } catch {
        await backgroundDelay(1_000);
      }
    }
  })().finally(() => {
    DEFERRED_CLEANUP_KEYS.delete(cleanupKey);
  });
}

async function withRecoveryIntent<T>(
  lockRoot: string,
  lockPath: string,
  target: LockOwnerRecord,
  task: (intent: RecoveryOwnerRecord) => Promise<T>,
): Promise<T> {
  const processBirthMarkerV2 = await getOwnProcessBirthMarkerV2();
  const intent: RecoveryOwnerRecord = {
    ownerId: randomUUID(),
    processInstanceId: PROCESS_INSTANCE_ID,
    pid: process.pid,
    ...(processBirthMarkerV2 ? { processBirthMarkerV2 } : {}),
    workspace: getCurrentWorkspace(),
    acquiredAt: runtimeClock.now(),
    targetOwnerId: target.ownerId,
    targetProcessInstanceId: target.processInstanceId,
    targetPid: target.pid,
  };
  const intentPath = `${lockPath}.recovery.${intent.ownerId}`;
  ACTIVE_OWNER_IDS.add(intent.ownerId);
  let installed = false;
  try {
    installed = await installCandidateLockWithRetry(lockRoot, intentPath, intent);
    if (!installed) {
      throw new Error(`Recovery intent ${JSON.stringify(intent.ownerId)} already exists.`);
    }
    return await task(intent);
  } finally {
    if (installed) {
      let markerPath: string | null = null;
      try {
        markerPath = await publishOwnerAbandoned(lockRoot, lockPath, intent);
      } catch {
        // Unlink may still succeed. If it does not, the deferred cleanup keeps
        // retrying after this logical operation has unwound.
      }
      ACTIVE_OWNER_IDS.delete(intent.ownerId);
      try {
        await unlinkWithRetry(intentPath);
        if (markerPath) await cleanupAbandonmentMarker(markerPath);
      } catch {
        scheduleRecoveryIntentCleanup(lockRoot, lockPath, intentPath, intent);
      }
    } else {
      ACTIVE_OWNER_IDS.delete(intent.ownerId);
    }
  }
}

async function retireOwnedCanonical(
  lockRoot: string,
  lockPath: string,
  owner: LockOwnerRecord,
): Promise<void> {
  await withRecoveryIntent(lockRoot, lockPath, owner, async () => {
    let markerPath: string | null = null;
    try {
      markerPath = await publishOwnerAbandoned(lockRoot, lockPath, owner);
    } finally {
      // The intent remains a live barrier until the conditional unlink below
      // finishes, so making the logical owner reclaimable here is safe.
      ACTIVE_OWNER_IDS.delete(owner.ownerId);
    }
    let removed = false;
    try {
      const current = await readOwner(lockPath);
      if (
        current?.ownerId === owner.ownerId
        && current.processInstanceId === owner.processInstanceId
        && current.pid === owner.pid
      ) {
        await unlinkWithRetry(lockPath);
      }
      removed = true;
    } finally {
      if (removed && markerPath) await cleanupAbandonmentMarker(markerPath);
    }
  });
}

function scheduleOwnedCanonicalRetirement(
  lockRoot: string,
  lockPath: string,
  owner: LockOwnerRecord,
): void {
  const cleanupKey = `canonical:${lockPath}:${owner.ownerId}`;
  if (DEFERRED_CLEANUP_KEYS.has(cleanupKey)) return;
  DEFERRED_CLEANUP_KEYS.add(cleanupKey);
  void (async () => {
    while (true) {
      try {
        await retireOwnedCanonical(lockRoot, lockPath, owner);
        return;
      } catch {
        try {
          const current = await readOwner(lockPath);
          if (
            !current
            || current.ownerId !== owner.ownerId
            || current.processInstanceId !== owner.processInstanceId
            || current.pid !== owner.pid
          ) return;
        } catch {
          // A transient read failure is uncertainty; retry without touching it.
        }
        await backgroundDelay(1_000);
      }
    }
  })().finally(() => {
    DEFERRED_CLEANUP_KEYS.delete(cleanupKey);
  });
}

async function acquireFilesystemLock(personaId: string): Promise<{
  lock: PersonaRuntimeLock;
  release: () => Promise<void>;
}> {
  const lockRoot = await ensureRuntimeLockRoot();
  const lockPath = path.join(lockRoot, `${personaId}.lock`);
  const processBirthMarkerV2 = await getOwnProcessBirthMarkerV2();
  const owner: LockOwnerRecord = {
    ownerId: randomUUID(),
    processInstanceId: PROCESS_INSTANCE_ID,
    pid: process.pid,
    ...(processBirthMarkerV2 ? { processBirthMarkerV2 } : {}),
    workspace: getCurrentWorkspace(),
    acquiredAt: runtimeClock.now(),
  };
  ACTIVE_OWNER_IDS.add(owner.ownerId);
  const acquireStartedAt = runtimeClock.monotonicNow();
  let canonicalInstalled = false;

  try {
    while (true) {
      const [recoveries, abandonedOwnerIds] = await Promise.all([
        listRecoveryOwners(lockRoot, lockPath),
        listAbandonedOwnerIds(lockRoot, lockPath),
      ]);
      const recoveryStates = await Promise.all(recoveries.map(async (recovery) => ({
        ...recovery,
        alive: await isOwnerProcessAlive(recovery.owner, abandonedOwnerIds),
      })));
      const liveRecoveries = recoveryStates.filter((recovery) => recovery.alive);
      await Promise.all(recoveryStates
        .filter((recovery) => !recovery.alive)
        // Recovery intent paths contain a random acquisition id and are never
        // reused, so removing a proven-dead intent cannot delete a successor.
        .map(async ({ path: recoveryPath, owner: recovery }) => {
          await unlinkWithRetry(recoveryPath);
          await cleanupAbandonmentMarker(abandonmentMarkerPath(lockPath, recovery.ownerId));
        }));
      if (liveRecoveries.length > 0) {
        if (runtimeClock.monotonicNow() - acquireStartedAt >= LOCK_ACQUIRE_TIMEOUT_MS) {
          throw new PersonaRuntimeLockTimeoutError(personaId);
        }
        await delay(LOCK_RETRY_MS);
        continue;
      }

      if (canonicalInstalled) {
        const installed = await readOwner(lockPath);
        if (
          installed?.ownerId === owner.ownerId
          && installed.processInstanceId === owner.processInstanceId
          && installed.pid === owner.pid
        ) break;
        canonicalInstalled = false;
      }

      if (await installCandidateLockWithRetry(lockRoot, lockPath, owner)) {
        canonicalInstalled = true;
        // A recovery intent may have appeared after the scan but before our
        // installation. Do not enter the critical section until every live
        // recovery syscall has finished, then verify none deleted this lock from
        // a stale view of its predecessor.
        const [afterInstall, abandonedAfterInstall] = await Promise.all([
          listRecoveryOwners(lockRoot, lockPath),
          listAbandonedOwnerIds(lockRoot, lockPath),
        ]);
        const liveAfterInstall = await Promise.all(afterInstall.map(
          ({ owner: recovery }) => isOwnerProcessAlive(recovery, abandonedAfterInstall),
        ));
        if (liveAfterInstall.some(Boolean)) {
          await delay(LOCK_RETRY_MS);
          continue;
        }
        const installed = await readOwner(lockPath);
        if (
          installed?.ownerId === owner.ownerId
          && installed.processInstanceId === owner.processInstanceId
          && installed.pid === owner.pid
        ) break;
        canonicalInstalled = false;
        continue;
      }
      const current = await readOwner(lockPath);
      if (!current) continue;
      if (!await isOwnerProcessAlive(current, abandonedOwnerIds)) {
        // Every recoverer publishes a unique live intent before its possible
        // unlink. A successor waits for all intents and re-checks ownership, so
        // multiple stale views cannot let a slow recoverer delete a lock that has
        // already begun writing.
        await withRecoveryIntent(lockRoot, lockPath, current, async (recoveryOwner) => {
          const target = await readOwner(lockPath);
          const abandonedAtUnlink = await listAbandonedOwnerIds(lockRoot, lockPath);
          if (
            target
            && target.ownerId === recoveryOwner.targetOwnerId
            && target.processInstanceId === recoveryOwner.targetProcessInstanceId
            && target.pid === recoveryOwner.targetPid
            && !await isOwnerProcessAlive(target, abandonedAtUnlink)
          ) {
            await unlinkWithRetry(lockPath);
            await cleanupAbandonmentMarker(
              abandonmentMarkerPath(lockPath, target.ownerId),
            );
          }
        });
        continue;
      }
      if (runtimeClock.monotonicNow() - acquireStartedAt >= LOCK_ACQUIRE_TIMEOUT_MS) {
        throw new PersonaRuntimeLockTimeoutError(personaId);
      }
      await delay(LOCK_RETRY_MS);
    }
  } catch (error) {
    try {
      if (canonicalInstalled) {
        try {
          await retireOwnedCanonical(lockRoot, lockPath, owner);
        } catch (cleanupError) {
          scheduleOwnedCanonicalRetirement(lockRoot, lockPath, owner);
          throw cleanupError;
        }
      }
    } finally {
      ACTIVE_OWNER_IDS.delete(owner.ownerId);
    }
    throw error;
  }

  const assertOwned = async (): Promise<void> => {
    const current = await readOwner(lockPath);
    if (
      current?.ownerId !== owner.ownerId
      || current.processInstanceId !== owner.processInstanceId
      || current.pid !== owner.pid
      || current.workspace !== owner.workspace
    ) {
      throw new PersonaRuntimeLockLostError(personaId);
    }
  };
  const runtimeLock: PersonaRuntimeLock = { assertOwned };
  ISSUED_RUNTIME_LOCKS.set(runtimeLock, {
    personaId,
    workspace: owner.workspace,
    closing: false,
    activeOperations: 0,
    idleWaiters: new Set(),
  });

  return {
    lock: runtimeLock,
    release: async () => {
      await closeIssuedPersonaRuntimeLock(runtimeLock);
      let assertionError: unknown;
      try {
        await assertOwned();
      } catch (error) {
        assertionError = error;
      }
      try {
        // Retiring is owner-conditional and intent-guarded, so it is safe even
        // when the preceding read lost the path or hit a transient error. It
        // also publishes abandonment before a failed unlink can strand a
        // completed logical owner.
        try {
          await retireOwnedCanonical(lockRoot, lockPath, owner);
        } catch (cleanupError) {
          scheduleOwnedCanonicalRetirement(lockRoot, lockPath, owner);
          throw cleanupError;
        }
      } finally {
        ACTIVE_OWNER_IDS.delete(owner.ownerId);
        ISSUED_RUNTIME_LOCKS.delete(runtimeLock);
      }
      if (assertionError) throw assertionError;
    },
  };
}

/**
 * Serialize Persona runtime mutations both within this module and across local
 * Next.js bundles/processes that share the workspace filesystem.
 */
export function withPersonaRuntimeLock<T>(
  personaId: string,
  task: (lock: PersonaRuntimeLock) => Promise<T>,
): Promise<T> {
  assertSafeCollectionId(personaId);
  return runInWriteChain(`enduring-agent-runtime/${personaId}`, async () => {
    const acquired = await acquireFilesystemLock(personaId);
    try {
      return await task(acquired.lock);
    } finally {
      await acquired.release();
    }
  });
}

/**
 * Filesystem-backed workspace coordinator for non-Persona state machines.
 * The leading dot is intentionally outside the safe Persona-id grammar, so a
 * user-created Persona can never alias one of these physical lock files.
 */
export function withWorkspaceRuntimeLock<T>(
  lockName: string,
  task: (lock: PersonaRuntimeLock) => Promise<T>,
): Promise<T> {
  assertSafeCollectionId(lockName);
  const physicalLockId = `.${lockName}`;
  return runInWriteChain(`workspace-runtime/${lockName}`, async () => {
    const acquired = await acquireFilesystemLock(physicalLockId);
    try {
      return await task(acquired.lock);
    } finally {
      await acquired.release();
    }
  });
}

/** Serialize Role-version allocation and Role reference creation by definition. */
export function withRoleDefinitionRuntimeLock<T>(
  roleDefinitionId: string,
  task: (lock: PersonaRuntimeLock) => Promise<T>,
): Promise<T> {
  assertSafeCollectionId(roleDefinitionId);
  return withWorkspaceRuntimeLock(
    stableEnduringAgentId('rolelock', {
      purpose: 'role-definition-mutation-v1',
      roleDefinitionId,
    }),
    task,
  );
}
