/**
 * Lease-based lazy MCP pool (issue #413).
 *
 * FLUJO used to warm EVERY enabled server at startup and keep it forked for the
 * process lifetime. On a machine with a dozen configured servers that is a dozen
 * node/python trees permanently resident, regardless of whether any flow ever
 * touches them — the dominant contributor to the "FLUJO eats RAM/CPU while idle"
 * reports.
 *
 * The pool inverts that: a consumer ACQUIRES a lease right before it needs a
 * client, and releases it in `finally`. A server with zero leases and zero pins
 * is idle and may be closed by the idle sweep or evicted under capacity
 * pressure; a server with demand is never touched. Because leases live in the
 * process-wide lifecycle coordinator, demand is a global fact — an idle sweep in
 * one module instance cannot close a server another instance is calling.
 *
 * Deliberately NOT here: admission control, global work queues, model/Jest
 * concurrency limits (explicitly out of scope for #413).
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createLogger } from '@/utils/logger';
import {
  addLease,
  addPin,
  getRuntime,
  hasDemand,
  listRuntimes,
  peekRuntime,
  removeLease,
  removePin,
  type McpRuntimeState,
} from './lifecycleCoordinator';

const log = createLogger('backend/services/mcp/mcpLeasePool');

/** How long a zero-lease, unpinned warm server may idle before it is closed. */
const DEFAULT_IDLE_TTL_MS = 10 * 60_000;
/** How many servers may be warm at once before idle-only LRU eviction kicks in. */
const DEFAULT_MAX_WARM = 8;

function idleTtlMs(): number {
  const raw = Number(process.env.FLUJO_MCP_IDLE_TTL_MS);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return DEFAULT_IDLE_TTL_MS;
}

function maxWarmServers(): number {
  const raw = Number(process.env.FLUJO_MCP_MAX_WARM_SERVERS);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return DEFAULT_MAX_WARM;
}

/**
 * A held claim on one warm MCP server.
 *
 * `client` is the live client at acquisition time and `generation` the runtime
 * generation it belongs to. If a config replacement bumps the generation the
 * lease is stale — `isStale()` says so, and the holder should re-acquire rather
 * than keep talking to a client that is being torn down.
 */
export interface McpLease {
  readonly serverName: string;
  readonly generation: number;
  readonly client: Client;
  /** True once a newer generation replaced the runtime this lease belongs to. */
  isStale(): boolean;
  /** Idempotent: releasing twice is a no-op, so `finally` is always safe. */
  release(): void;
}

/** The connect/lookup surface the pool needs; MCPService satisfies it. */
export interface LeaseBackend {
  getClient(serverName: string): Client | undefined;
  connectServer(serverName: string): Promise<{ success: boolean; error?: string }>;
  disconnectServer(serverName: string): Promise<{ success: boolean; error?: string }>;
  isServerDisabled(serverName: string): Promise<boolean>;
}

export interface AcquireResult {
  success: boolean;
  lease?: McpLease;
  error?: string;
}

interface PoolCounters {
  acquires: number;
  coalesced: number;
  connects: number;
  failures: number;
  idleClosures: number;
  lruEvictions: number;
}

declare global {
  var __flujo_mcp_pool_counters: PoolCounters | undefined;
}

function counters(): PoolCounters {
  if (!global.__flujo_mcp_pool_counters) {
    global.__flujo_mcp_pool_counters = {
      acquires: 0,
      coalesced: 0,
      connects: 0,
      failures: 0,
      idleClosures: 0,
      lruEvictions: 0,
    };
  }
  return global.__flujo_mcp_pool_counters;
}

function makeLease(serverName: string, client: Client, generation: number): McpLease {
  let released = false;
  addLease(serverName);
  return {
    serverName,
    generation,
    client,
    isStale(): boolean {
      const record = peekRuntime(serverName);
      return !record || record.generation !== generation;
    },
    release(): void {
      // Idempotent by design: a `finally` that also runs on an early return path
      // must not decrement the counter twice (that would make a busy server look
      // idle and expose it to the idle sweep mid-call).
      if (released) return;
      released = true;
      removeLease(serverName);
    },
  };
}

/**
 * Acquire a lease on a server, connecting it on demand.
 *
 * The lease is registered BEFORE the client is handed out, so an idle sweep that
 * runs between the connect and the caller's first request still sees demand.
 * Concurrent acquisitions of a cold server coalesce onto one connect because the
 * lifecycle coordinator de-dupes `connectServer`.
 */
export async function acquireLease(
  backend: LeaseBackend,
  serverName: string,
): Promise<AcquireResult> {
  counters().acquires += 1;

  if (await backend.isServerDisabled(serverName)) {
    return {
      success: false,
      error: `Server '${serverName}' is disabled. Enable it on the MCP page to use it.`,
    };
  }

  const existing = backend.getClient(serverName);
  if (existing) {
    counters().coalesced += 1;
    const record = getRuntime(serverName);
    return { success: true, lease: makeLease(serverName, existing, record.generation) };
  }

  counters().connects += 1;
  const result = await backend.connectServer(serverName);
  const client = backend.getClient(serverName);
  if (!result.success || !client) {
    counters().failures += 1;
    return {
      success: false,
      error: result.error ?? `Could not establish an MCP connection to '${serverName}'.`,
    };
  }
  const record = getRuntime(serverName);
  return { success: true, lease: makeLease(serverName, client, record.generation) };
}

/**
 * Run `fn` while holding a lease, releasing it in `finally`.
 *
 * This is the shape every migrated consumer should use: it makes
 * acquire-before-use / release-always structurally impossible to get wrong.
 */
export async function withLease<T>(
  backend: LeaseBackend,
  serverName: string,
  fn: (lease: McpLease) => Promise<T>,
): Promise<{ success: boolean; error?: string; value?: T }> {
  const acquired = await acquireLease(backend, serverName);
  if (!acquired.success || !acquired.lease) {
    return { success: false, error: acquired.error };
  }
  try {
    return { success: true, value: await fn(acquired.lease) };
  } finally {
    acquired.lease.release();
  }
}

/**
 * Pin a server so neither the idle sweep nor LRU eviction may close it.
 *
 * Pins model demand that outlives a single call: resource subscriptions and
 * triggers, MCP App sessions, in-flight remote tasks, and an explicit always-on
 * configuration. Unlike a lease, a pin has a name so the holder can release
 * exactly its own claim.
 */
export function pinServer(serverName: string, pin: string): void {
  addPin(serverName, pin);
}

export function unpinServer(serverName: string, pin: string): void {
  removePin(serverName, pin);
}

/**
 * Close warm servers that have been idle longer than the TTL.
 *
 * Only zero-lease, unpinned, warm records are candidates. Never connects
 * anything: an idle sweep that warmed a cold server would defeat the whole
 * point of lazy pooling.
 */
export async function sweepIdleServers(backend: LeaseBackend): Promise<string[]> {
  const ttl = idleTtlMs();
  const now = Date.now();
  const closed: string[] = [];

  for (const record of listRuntimes()) {
    if (record.state !== 'warm') continue;
    if (record.leases > 0 || record.pins.size > 0) continue;
    if (now - record.lastUsedAt < ttl) continue;
    // Re-check demand immediately before closing: a lease may have been taken
    // while we awaited an earlier disconnect in this same sweep.
    if (hasDemand(record.serverName)) continue;
    log.info(
      `sweepIdleServers: closing ${record.serverName} after ${Math.round((now - record.lastUsedAt) / 1000)}s idle`,
    );
    await backend.disconnectServer(record.serverName).catch(() => undefined);
    counters().idleClosures += 1;
    closed.push(record.serverName);
  }
  return closed;
}

/**
 * Enforce the warm-server cap by closing the least-recently-used IDLE server.
 *
 * Capacity pressure must never interrupt work, so pinned/leased records are not
 * candidates at all — if every warm server is in demand the cap is simply
 * exceeded until something is released.
 */
export async function enforceWarmCapacity(backend: LeaseBackend): Promise<string[]> {
  const limit = maxWarmServers();
  const evicted: string[] = [];

  for (;;) {
    const warm = listRuntimes().filter(r => r.state === 'warm');
    if (warm.length <= limit) break;
    const candidates = warm
      .filter(r => r.leases === 0 && r.pins.size === 0)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    const victim = candidates[0];
    if (!victim) break;
    log.info(`enforceWarmCapacity: evicting idle LRU server ${victim.serverName} (warm=${warm.length}, limit=${limit})`);
    await backend.disconnectServer(victim.serverName).catch(() => undefined);
    counters().lruEvictions += 1;
    evicted.push(victim.serverName);
  }
  return evicted;
}

export interface PoolDiagnostics extends PoolCounters {
  servers: Array<{
    server: string;
    state: McpRuntimeState;
    leases: number;
    pins: string[];
    idleMs: number;
  }>;
  idleTtlMs: number;
  maxWarmServers: number;
}

/** Bounded pool snapshot for the diagnostics report. */
export function getPoolDiagnostics(): PoolDiagnostics {
  const now = Date.now();
  return {
    ...counters(),
    idleTtlMs: idleTtlMs(),
    maxWarmServers: maxWarmServers(),
    servers: listRuntimes().map(record => ({
      server: record.serverName,
      state: record.state,
      leases: record.leases,
      pins: Array.from(record.pins),
      idleMs: Math.max(0, now - record.lastUsedAt),
    })),
  };
}

/** Test-only: reset pool counters (runtime records reset separately). */
export function _resetPoolForTests(): void {
  global.__flujo_mcp_pool_counters = undefined;
}
