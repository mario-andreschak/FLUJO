/**
 * One process-wide MCP lifecycle coordinator (issue #413).
 *
 * MCPService owns several parallel registries (clients, transports,
 * generations, retry timers, in-flight connects). Most are global-backed so
 * every Next.js module instance shares them — but `inFlightConnects` was
 * INSTANCE-local, so two module instances could each believe they were the only
 * one connecting a server and fork two child processes for one config. This
 * module hoists the connect/teardown bookkeeping into ONE global registry keyed
 * by workspace + server name, so de-duplication, retry accounting and teardown
 * are process-wide facts rather than per-instance guesses.
 *
 * Design rules:
 *  - The coordinator holds *bookkeeping only*: promises, counters, timestamps,
 *    generation and state. Clients/transports keep living in MCPService's
 *    existing global maps, so nothing here changes what a caller receives.
 *  - `beginConnect` and `beginTeardown` are the two chokepoints. Both fold a
 *    concurrent caller onto the SAME promise, so a connect can never overlap
 *    itself and a teardown can never run twice.
 *  - A teardown always awaits the previous connect (and vice versa) so a
 *    replacement connection can never be established while its predecessor's
 *    child process is still exiting.
 *  - Leases/pins live here (not in the pool) because the record is the single
 *    place that knows a server is still in demand while an idle sweep runs.
 */
import { createLogger } from '@/utils/logger';
import { getCurrentWorkspace } from '@/utils/workspace';
import { randomUUID } from 'node:crypto';
import type { MCPShutdownObservation, MCPShutdownReceipt } from '@/shared/types/mcp/shutdown';

const log = createLogger('backend/services/mcp/lifecycleCoordinator');

/** Observable lifecycle state of one server runtime. */
export type McpRuntimeState =
  | 'cold'
  | 'starting'
  | 'warm'
  | 'stopping'
  | 'error';

export interface McpRuntimeRecord {
  /** `${workspace}\0${serverName}` — the canonical runtime identity. */
  readonly key: string;
  readonly workspace: string;
  readonly serverName: string;
  /** Opaque process-local identity; generations are never portable across restarts. */
  readonly runtimeId: string;
  state: McpRuntimeState;
  /**
   * Incremented on every accepted connect. A callback (onclose/onerror) or a
   * lease that captured an older generation is stale and must be a no-op.
   */
  generation: number;
  /** Fingerprint of the configuration the current runtime was built from. */
  configFingerprint?: string;
  /** Shared connect promise — concurrent callers fold onto this. */
  connectPromise?: Promise<unknown>;
  /** Shared teardown promise — idempotent and awaitable. */
  teardownPromise?: Promise<MCPShutdownReceipt>;
  shutdownReceipt?: MCPShutdownReceipt;
  /** Reason recorded for the in-flight/last teardown (diagnostics only). */
  teardownReason?: string;
  /** Consecutive failed connect attempts (drives backoff elsewhere). */
  retryAttempts: number;
  /** Cumulative connect failures for this record (bounded counter). */
  connectFailures: number;
  /** Cumulative handshake failures (connect threw after transport creation). */
  handshakeFailures: number;
  /** Cumulative teardowns that needed a forced kill. */
  forcedKills: number;
  /** Last teardown duration, ms. */
  lastTeardownMs?: number;
  /** Active leases (see mcpLeasePool). Zero means idle-eligible. */
  leases: number;
  /** Named pins: subscriptions, MCP App sessions, tasks, always-on config. */
  pins: Set<string>;
  /** Last time the runtime served a lease/call. */
  lastUsedAt: number;
  /** When the current runtime became warm. */
  warmSince?: number;
  lastError?: string;
}

declare global {
  var __flujo_mcp_lifecycle: Map<string, McpRuntimeRecord> | undefined;
}

function registry(): Map<string, McpRuntimeRecord> {
  if (!global.__flujo_mcp_lifecycle) {
    global.__flujo_mcp_lifecycle = new Map<string, McpRuntimeRecord>();
  }
  return global.__flujo_mcp_lifecycle;
}

/** Canonical runtime key. Server names are only unique WITHIN a workspace (#406). */
export function runtimeKey(serverName: string, workspace = getCurrentWorkspace()): string {
  return `${workspace}\u0000${serverName}`;
}

/** Get (creating if needed) the runtime record for a server in this workspace. */
export function getRuntime(serverName: string): McpRuntimeRecord {
  const workspace = getCurrentWorkspace();
  const key = runtimeKey(serverName, workspace);
  let record = registry().get(key);
  if (!record) {
    record = {
      key,
      workspace,
      serverName,
      runtimeId: randomUUID(),
      state: 'cold',
      generation: 0,
      retryAttempts: 0,
      connectFailures: 0,
      handshakeFailures: 0,
      forcedKills: 0,
      leases: 0,
      pins: new Set<string>(),
      lastUsedAt: Date.now(),
    };
    registry().set(key, record);
  }
  return record;
}

/** Peek at a record without creating one. */
export function peekRuntime(serverName: string): McpRuntimeRecord | undefined {
  return registry().get(runtimeKey(serverName));
}

/** All records of the CURRENT workspace. */
export function listRuntimes(): McpRuntimeRecord[] {
  const workspace = getCurrentWorkspace();
  return Array.from(registry().values()).filter(r => r.workspace === workspace);
}

/** All records across every workspace (process shutdown / diagnostics). */
export function listAllRuntimes(): McpRuntimeRecord[] {
  return Array.from(registry().values());
}

/**
 * De-duplicated connect.
 *
 * Folds a concurrent caller onto the in-flight attempt (process-wide, unlike the
 * old instance-local map) and always awaits a pending teardown first, so a fresh
 * client is never built while the previous child is still exiting.
 */
export async function beginConnect<T>(
  serverName: string,
  attempt: (record: McpRuntimeRecord) => Promise<T>,
): Promise<T> {
  const record = getRuntime(serverName);

  // Never start a connection on top of a teardown that has not finished: the
  // old child may still hold the port/profile/lock the new one needs.
  if (record.teardownPromise) {
    await record.teardownPromise.catch(() => undefined);
  }

  const existing = record.connectPromise as Promise<T> | undefined;
  if (existing) {
    log.debug(`beginConnect: reusing in-flight attempt for ${serverName}`);
    return existing;
  }

  record.state = record.state === 'warm' ? 'warm' : 'starting';
  record.shutdownReceipt = undefined;
  const promise = (async () => attempt(record))()
    .finally(() => {
      if (record.connectPromise === promise) record.connectPromise = undefined;
    });
  record.connectPromise = promise;
  return promise;
}

/** Record a successful connect: bump generation, clear failure state. */
export function markConnected(serverName: string, configFingerprint?: string): number {
  const record = getRuntime(serverName);
  record.generation += 1;
  record.shutdownReceipt = undefined;
  record.state = 'warm';
  record.configFingerprint = configFingerprint;
  record.retryAttempts = 0;
  record.lastError = undefined;
  record.warmSince = Date.now();
  record.lastUsedAt = Date.now();
  return record.generation;
}

/** Record a failed connect. `handshake` distinguishes post-transport failures. */
export function markConnectFailed(
  serverName: string,
  error: string,
  handshake = false,
): void {
  const record = getRuntime(serverName);
  record.state = 'error';
  record.lastError = error;
  record.connectFailures = Math.min(record.connectFailures + 1, Number.MAX_SAFE_INTEGER);
  if (handshake) record.handshakeFailures += 1;
  record.retryAttempts += 1;
}

/** Record that the runtime is cold again (after a completed teardown). */
export function markCold(serverName: string): void {
  const record = getRuntime(serverName);
  record.state = 'cold';
  record.warmSince = undefined;
  record.configFingerprint = undefined;
}

/**
 * ONE idempotent, awaitable teardown per runtime.
 *
 * Used for handshake failures, fatal transport errors, invalid clients,
 * reconnect replacement, disable/delete and application shutdown. Repeated calls
 * while a teardown is in flight fold onto the same promise, so "close it" is
 * safe to shout from several code paths at once — which is what previously
 * produced double-close races and orphaned grandchildren.
 */
export function beginTeardown(
  serverName: string,
  reason: string,
  close: (record: McpRuntimeRecord) => Promise<Partial<MCPShutdownObservation> | void>,
): Promise<MCPShutdownReceipt> {
  const record = getRuntime(serverName);
  if (record.teardownPromise) {
    log.debug(`beginTeardown: folding onto in-flight teardown for ${serverName} (${reason})`);
    return record.teardownPromise;
  }

  const startedAt = Date.now();
  record.state = 'stopping';
  record.teardownReason = reason;

  const promise = Promise.resolve().then(async () => {
    // A teardown must not race the connect it is replacing.
    if (record.connectPromise) {
      await record.connectPromise.catch(() => undefined);
    }
    // A connect in flight may have registered a new generation while we waited.
    const generation = record.generation;
    record.state = 'stopping';
    let observation: MCPShutdownObservation = {
      processOwnership: 'unknown', exitOutcome: 'unknown', forced: false,
      errorClassification: 'exit_unobserved',
    };
    try {
      const result = await close(record);
      if (result) {
        observation = { ...observation, ...result };
        if (observation.forced) record.forcedKills += 1;
      }
    } catch (error) {
      observation.errorClassification = 'close_failed';
      log.warn(
        `beginTeardown: close failed for ${serverName} (${reason}): ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      record.lastTeardownMs = Math.max(0, Date.now() - startedAt);
      if (record.generation === generation) {
        record.state = 'cold';
        record.warmSince = undefined;
        record.configFingerprint = undefined;
      }
      if (record.teardownPromise === promise) record.teardownPromise = undefined;
    }
    const receipt: MCPShutdownReceipt = Object.freeze({
      schemaVersion: 1, runtimeId: record.runtimeId,
      workspace: record.workspace, serverName: record.serverName, generation,
      observedAt: new Date().toISOString(), durationMs: record.lastTeardownMs!,
      // Whitelist fields; never retain raw errors, commands or caller extras.
      processOwnership: observation.processOwnership,
      exitOutcome: observation.exitOutcome, forced: observation.forced,
      errorClassification: observation.errorClassification,
      ...(observation.isolation?.schemaVersion === 1
        && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(observation.isolation.generation)
        && ['removed', 'absent', 'unknown'].includes(observation.isolation.cleanupOutcome)
        ? { isolation: Object.freeze({ schemaVersion: 1 as const,
          generation: observation.isolation.generation, cleanupOutcome: observation.isolation.cleanupOutcome }) } : {}),
    });
    if (record.generation === generation) record.shutdownReceipt = receipt;
    return receipt;
  });

  record.teardownPromise = promise;
  return promise;
}

/** Only the current generation's receipt, never one from a replacement runtime. */
export function getShutdownReceipt(serverName: string): MCPShutdownReceipt | undefined {
  const record = peekRuntime(serverName);
  if (!record || record.connectPromise) return undefined;
  return record.shutdownReceipt?.generation === record.generation
    ? record.shutdownReceipt : undefined;
}

/** True when `generation` is no longer the live generation (stale callback). */
export function isStaleGeneration(serverName: string, generation: number): boolean {
  const record = peekRuntime(serverName);
  return !record || record.generation !== generation;
}

// --- Demand accounting (leases + pins) --------------------------------------

export function addLease(serverName: string): void {
  const record = getRuntime(serverName);
  record.leases += 1;
  record.lastUsedAt = Date.now();
}

export function removeLease(serverName: string): void {
  const record = getRuntime(serverName);
  record.leases = Math.max(0, record.leases - 1);
  record.lastUsedAt = Date.now();
}

export function addPin(serverName: string, pin: string): void {
  getRuntime(serverName).pins.add(pin);
}

export function removePin(serverName: string, pin: string): void {
  peekRuntime(serverName)?.pins.delete(pin);
}

/** A runtime is in demand while any lease or pin exists. */
export function hasDemand(serverName: string): boolean {
  const record = peekRuntime(serverName);
  if (!record) return false;
  return record.leases > 0 || record.pins.size > 0;
}

// --- Diagnostics ------------------------------------------------------------

export interface McpRuntimeDiagnostics {
  server: string;
  workspace: string;
  state: McpRuntimeState;
  generation: number;
  leases: number;
  pins: string[];
  idleMs: number;
  connectFailures: number;
  handshakeFailures: number;
  forcedKills: number;
  lastTeardownMs?: number;
  lastError?: string;
  shutdownReceipt?: MCPShutdownReceipt;
}

/**
 * Bounded snapshot for the diagnostics report. Deliberately carries counters and
 * state only — never stderr, provider payloads or command lines.
 */
export function getLifecycleDiagnostics(allWorkspaces = false): McpRuntimeDiagnostics[] {
  const now = Date.now();
  const records = allWorkspaces ? listAllRuntimes() : listRuntimes();
  return records.map(record => ({
    server: record.serverName,
    workspace: record.workspace,
    state: record.state,
    generation: record.generation,
    leases: record.leases,
    pins: Array.from(record.pins),
    idleMs: Math.max(0, now - record.lastUsedAt),
    connectFailures: record.connectFailures,
    handshakeFailures: record.handshakeFailures,
    forcedKills: record.forcedKills,
    lastTeardownMs: record.lastTeardownMs,
    lastError: record.lastError,
    shutdownReceipt: record.connectPromise ? undefined : record.shutdownReceipt,
  }));
}

/** Test-only: drop every runtime record. */
export function _resetLifecycleForTests(): void {
  global.__flujo_mcp_lifecycle = undefined;
}
