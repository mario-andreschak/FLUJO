/**
 * Durable, ownership-scoped store for REMOTE MCP tasks (issue #404, plan step 6).
 *
 * Reuses the storage primitives (`db/mcp-remote-tasks/<recordId>.json`, atomic
 * writes, per-key write chains) and the lifecycle shape of
 * `backend/services/subflowTasks`, but NOT its restart semantics: a remote task
 * belongs to another process, so a non-terminal record is *resumed* when the
 * server/config identity still matches instead of being failed on restart.
 *
 * Security/privacy invariants enforced here:
 *  - the remote task id alone never authorizes anything: every lookup requires
 *    the server name AND the server identity fingerprint to match;
 *  - identity fields (recordId / remoteTaskId / serverName / serverIdentity /
 *    toolName / requestFingerprint / createdAt) are immutable after creation;
 *  - terminal states are immutable, which makes cancel-vs-complete races
 *    deterministic (first terminal write wins);
 *  - no arguments, credentials, headers, elicited input or result payloads are
 *    persisted — only a truncated argument fingerprint and bounded error text.
 */

import { createHash, randomUUID } from 'crypto';
import { createLogger } from '@/utils/logger';
import {
  assertSafeCollectionId,
  deleteCollectionItem,
  listCollectionItems,
  loadCollectionItem,
  loadItem,
  runInWriteChain,
  saveCollectionItem,
} from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import type { MCPServerConfig } from '@/shared/types/mcp/mcp';
import {
  DEFAULT_MCP_REMOTE_TASK_SETTINGS,
  MCP_REMOTE_TASK_COLLECTION,
  MCP_REMOTE_TASK_RECORD_VERSION,
  isLegalRemoteTaskTransition,
  isTerminalRemoteTaskRecord,
  type McpRemoteTaskOwnership,
  type McpRemoteTaskRecord,
  type McpRemoteTaskSettings,
} from '@/shared/types/mcp/taskRecords';
import {
  boundStatusMessage,
  isTerminalMcpTaskStatus,
  type McpTaskStatus,
} from '@/shared/types/mcp/tasks';
import { DEFAULT_WORKSPACE, getCurrentWorkspace, workspaceCacheKey } from '@/utils/workspace';

const log = createLogger('backend/services/mcp/remoteTaskStore');

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

let settingsCache: { value: McpRemoteTaskSettings; at: number } | null = null;
const settingsCacheByWorkspace = new Map<string, { value: McpRemoteTaskSettings; at: number }>();

function cachedSettings(): { value: McpRemoteTaskSettings; at: number } | null {
  const workspace = getCurrentWorkspace();
  return workspace === DEFAULT_WORKSPACE
    ? settingsCache
    : settingsCacheByWorkspace.get(workspace) ?? null;
}

function setCachedSettings(value: { value: McpRemoteTaskSettings; at: number } | null): void {
  const workspace = getCurrentWorkspace();
  if (workspace === DEFAULT_WORKSPACE) settingsCache = value;
  else if (value) settingsCacheByWorkspace.set(workspace, value);
  else settingsCacheByWorkspace.delete(workspace);
}

export async function getMcpRemoteTaskSettings(): Promise<McpRemoteTaskSettings> {
  const cached = cachedSettings();
  if (cached && Date.now() - cached.at < 30_000) return cached.value;
  try {
    const stored = await loadItem<Partial<McpRemoteTaskSettings>>(
      StorageKey.MCP_REMOTE_TASK_SETTINGS,
      DEFAULT_MCP_REMOTE_TASK_SETTINGS,
    );
    setCachedSettings({
      value: { ...DEFAULT_MCP_REMOTE_TASK_SETTINGS, ...stored },
      at: Date.now(),
    });
  } catch (error) {
    log.warn('Failed to load MCP remote task settings; using defaults', error);
    setCachedSettings({ value: DEFAULT_MCP_REMOTE_TASK_SETTINGS, at: Date.now() });
  }
  return cachedSettings()!.value;
}

export function _clearMcpRemoteTaskSettingsCache(): void {
  setCachedSettings(null);
}

// ---------------------------------------------------------------------------
// Identity + redaction helpers
// ---------------------------------------------------------------------------

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

function sha256Hex(input: string, chars = 32): string {
  return createHash('sha256').update(input).digest('hex').slice(0, chars);
}

/**
 * Canonical fingerprint of the server's connection/auth identity. Only
 * NON-SECRET structure is hashed (transport, command/args/url, and the *names*
 * of env vars / headers) — never a secret value — so the fingerprint can be
 * persisted and compared safely while still changing whenever the connection
 * identity changes.
 */
export function serverIdentityFingerprint(config: MCPServerConfig | undefined): string {
  if (!config) return 'unknown';
  const anyConfig = config as unknown as Record<string, unknown>;
  const material = {
    name: config.name,
    transport: config.transport,
    command: anyConfig.command ?? null,
    args: Array.isArray(anyConfig.args) ? anyConfig.args : null,
    serverUrl: anyConfig.serverUrl ?? anyConfig.websocketUrl ?? null,
    envKeys: Object.keys((anyConfig.env as Record<string, unknown>) ?? {}).sort(),
    headerKeys: Object.keys((anyConfig.headers as Record<string, unknown>) ?? {}).sort(),
    oauth: Boolean(anyConfig.oauth ?? anyConfig.oauthTokens),
  };
  return sha256Hex(stableStringify(material), 32);
}

/** Non-reversible, bounded fingerprint of the request arguments. */
export function requestFingerprint(args: Record<string, unknown> | undefined): string {
  return sha256Hex(stableStringify(args ?? {}), 16);
}

/**
 * Resolve the current identity fingerprint of a configured server by name.
 * The MCP service is imported lazily because it imports the tool layer that
 * creates task records.
 */
export async function resolveServerIdentity(serverName: string): Promise<string> {
  try {
    const { mcpService } = await import('@/backend/services/mcp');
    const configs = await mcpService.loadServerConfigs();
    const config = Array.isArray(configs)
      ? (configs as MCPServerConfig[]).find(c => c.name === serverName)
      : undefined;
    return serverIdentityFingerprint(config);
  } catch (error) {
    log.warn(`Could not resolve server identity for ${serverName}`, error);
    return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export interface CreateRemoteTaskInput {
  remoteTaskId: string;
  serverName: string;
  serverIdentity: string;
  toolName: string;
  args?: Record<string, unknown>;
  ownership: McpRemoteTaskOwnership;
  status: McpTaskStatus;
  statusMessage?: string;
  pollIntervalMs: number;
  ttlMs?: number;
  expiresAt?: number;
}

export async function createRemoteTaskRecord(
  input: CreateRemoteTaskInput,
): Promise<McpRemoteTaskRecord | null> {
  try {
    const now = Date.now();
    const recordId = randomUUID();
    assertSafeCollectionId(recordId);
    const record: McpRemoteTaskRecord = {
      version: MCP_REMOTE_TASK_RECORD_VERSION,
      recordId,
      remoteTaskId: input.remoteTaskId,
      serverName: input.serverName,
      serverIdentity: input.serverIdentity,
      toolName: input.toolName,
      requestFingerprint: requestFingerprint(input.args),
      ownership: input.ownership,
      status: input.status,
      ...(boundStatusMessage(input.statusMessage)
        ? { statusMessage: boundStatusMessage(input.statusMessage) }
        : {}),
      createdAt: now,
      updatedAt: now,
      pollIntervalMs: input.pollIntervalMs,
      nextPollAt: now + input.pollIntervalMs,
      ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      ...(isTerminalMcpTaskStatus(input.status) ? { completedAt: now } : {}),
    };
    await saveCollectionItem(MCP_REMOTE_TASK_COLLECTION, recordId, record);
    log.info(
      `Persisted remote MCP task record ${recordId} (server=${input.serverName}, tool=${input.toolName}, status=${input.status})`,
    );
    return record;
  } catch (error) {
    log.warn('Failed to persist remote MCP task record', error);
    return null;
  }
}

export async function getRemoteTaskRecord(
  recordId: string,
): Promise<McpRemoteTaskRecord | null> {
  try {
    assertSafeCollectionId(recordId);
    return await loadCollectionItem<McpRemoteTaskRecord | null>(
      MCP_REMOTE_TASK_COLLECTION,
      recordId,
      null,
    );
  } catch (error) {
    log.warn('Failed to load remote MCP task record', { recordId, error });
    return null;
  }
}

export async function listRemoteTaskRecords(
  filter: {
    serverName?: string;
    status?: McpTaskStatus;
    nonTerminalOnly?: boolean;
    conversationId?: string;
  } = {},
): Promise<McpRemoteTaskRecord[]> {
  try {
    const items = await listCollectionItems<McpRemoteTaskRecord>(MCP_REMOTE_TASK_COLLECTION);
    return items
      .filter(r => r && typeof r.recordId === 'string')
      .filter(r => !filter.serverName || r.serverName === filter.serverName)
      .filter(r => !filter.status || r.status === filter.status)
      .filter(r => !filter.nonTerminalOnly || !isTerminalRemoteTaskRecord(r))
      .filter(
        r =>
          !filter.conversationId ||
          r.ownership?.conversationId === filter.conversationId,
      )
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch (error) {
    log.warn('Failed to list remote MCP task records', error);
    return [];
  }
}

/**
 * Ownership-scoped lookup. A remote task id is NEVER sufficient on its own:
 * the server name and the server identity fingerprint must both match.
 */
export async function findRemoteTaskRecord(
  serverName: string,
  remoteTaskId: string,
  serverIdentity?: string,
): Promise<McpRemoteTaskRecord | null> {
  const records = await listRemoteTaskRecords({ serverName });
  return (
    records.find(
      r =>
        r.remoteTaskId === remoteTaskId &&
        (serverIdentity === undefined || r.serverIdentity === serverIdentity),
    ) ?? null
  );
}

export type RemoteTaskPatch = Partial<
  Omit<
    McpRemoteTaskRecord,
    | 'version'
    | 'recordId'
    | 'remoteTaskId'
    | 'serverName'
    | 'serverIdentity'
    | 'toolName'
    | 'requestFingerprint'
    | 'createdAt'
  >
>;

/**
 * Serialized, transition-checked patch. Runs inside the storage write chain for
 * this record, so concurrent poll/cancel/completion writes cannot interleave.
 * Returns the stored record unchanged when the transition is illegal (terminal
 * immutability), which is how the completion-versus-cancellation race resolves.
 */
export async function patchRemoteTaskRecord(
  recordId: string,
  patch: RemoteTaskPatch,
): Promise<McpRemoteTaskRecord | null> {
  try {
    assertSafeCollectionId(recordId);
    return await runInWriteChain(`mcp-remote-task:${recordId}`, async () => {
      const current = await loadCollectionItem<McpRemoteTaskRecord | null>(
        MCP_REMOTE_TASK_COLLECTION,
        recordId,
        null,
      );
      if (!current) return null;

      const nextStatus = patch.status ?? current.status;
      if (patch.status && !isLegalRemoteTaskTransition(current.status, patch.status)) {
        log.debug(
          `Rejected illegal remote task transition ${current.status} -> ${patch.status} for ${recordId}`,
        );
        return current;
      }

      const now = Date.now();
      const next: McpRemoteTaskRecord = {
        ...current,
        ...patch,
        // Immutable identity — a patch can never retarget a record.
        version: MCP_REMOTE_TASK_RECORD_VERSION,
        recordId: current.recordId,
        remoteTaskId: current.remoteTaskId,
        serverName: current.serverName,
        serverIdentity: current.serverIdentity,
        toolName: current.toolName,
        requestFingerprint: current.requestFingerprint,
        createdAt: current.createdAt,
        status: nextStatus,
        ...(patch.statusMessage !== undefined
          ? { statusMessage: boundStatusMessage(patch.statusMessage) }
          : {}),
        ...(patch.errorMessage !== undefined
          ? { errorMessage: boundStatusMessage(patch.errorMessage) }
          : {}),
        updatedAt: now,
      };
      if (isTerminalMcpTaskStatus(next.status) && !next.completedAt) next.completedAt = now;
      await saveCollectionItem(MCP_REMOTE_TASK_COLLECTION, recordId, next);
      return next;
    });
  } catch (error) {
    log.warn('Failed to patch remote MCP task record', { recordId, error });
    return null;
  }
}

export async function deleteRemoteTaskRecord(recordId: string): Promise<void> {
  try {
    assertSafeCollectionId(recordId);
    await deleteCollectionItem(MCP_REMOTE_TASK_COLLECTION, recordId);
  } catch (error) {
    log.warn('Failed to delete remote MCP task record', { recordId, error });
  }
}

/** Records that may be resumed after a restart/reconnect. */
export async function listResumableRemoteTaskRecords(
  now = Date.now(),
): Promise<McpRemoteTaskRecord[]> {
  const settings = await getMcpRemoteTaskSettings();
  const records = await listRemoteTaskRecords({ nonTerminalOnly: true });
  return records
    .filter(r => r.expiresAt === undefined || r.expiresAt > now)
    .slice(0, Math.max(0, settings.maxResumePerStartup));
}

/**
 * Retention sweep: removes terminal records older than the retention window and
 * marks (then removes) records whose remote TTL has lapsed while non-terminal.
 */
export async function sweepOldMcpRemoteTasks(
  now = Date.now(),
): Promise<{ removed: number; expired: number }> {
  const settings = await getMcpRemoteTaskSettings();
  let removed = 0;
  let expired = 0;
  const records = await listRemoteTaskRecords();

  for (const record of records) {
    // Fail closed on lapsed TTL: an expired remote task can never be polled or
    // resumed again, so record the terminal outcome before retention deletes it.
    if (
      !isTerminalRemoteTaskRecord(record) &&
      record.expiresAt !== undefined &&
      record.expiresAt <= now
    ) {
      const patched = await patchRemoteTaskRecord(record.recordId, {
        status: 'failed',
        diagnostic: 'expired',
        errorMessage: 'Remote MCP task expired before reaching a terminal state.',
      });
      if (patched) expired++;
    }
  }

  if (settings.retentionAgeDays <= 0) return { removed, expired };
  const cutoff = now - settings.retentionAgeDays * 24 * 60 * 60 * 1_000;
  for (const record of await listRemoteTaskRecords()) {
    if (!isTerminalRemoteTaskRecord(record)) continue;
    if ((record.completedAt ?? record.updatedAt) > cutoff) continue;
    await deleteRemoteTaskRecord(record.recordId);
    removed++;
  }
  return { removed, expired };
}

// ---------------------------------------------------------------------------
// Bounded poll concurrency (global + per server)
// ---------------------------------------------------------------------------

const globalForSlots = globalThis as unknown as {
  __flujoMcpTaskPollSlots?: { total: number; perServer: Map<string, number> };
};
const slots =
  globalForSlots.__flujoMcpTaskPollSlots ??
  (globalForSlots.__flujoMcpTaskPollSlots = { total: 0, perServer: new Map() });

export interface PollSlot {
  release: () => void;
}

/**
 * Try to acquire a poll slot. Returns undefined when a documented limit is
 * reached, so callers fail closed (with a `poll-limit` diagnostic) instead of
 * creating a poll storm.
 */
export async function acquirePollSlot(serverName: string): Promise<PollSlot | undefined> {
  const settings = await getMcpRemoteTaskSettings();
  const serverKey = workspaceCacheKey(serverName);
  const perServer = slots.perServer.get(serverKey) ?? 0;
  if (slots.total >= settings.maxConcurrentPolls) return undefined;
  if (perServer >= settings.maxConcurrentPollsPerServer) return undefined;

  slots.total++;
  slots.perServer.set(serverKey, perServer + 1);
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      slots.total = Math.max(0, slots.total - 1);
      const current = slots.perServer.get(serverKey) ?? 1;
      if (current <= 1) slots.perServer.delete(serverKey);
      else slots.perServer.set(serverKey, current - 1);
    },
  };
}

/** Test helper: reset the in-memory concurrency counters. */
export function _resetPollSlots(): void {
  slots.total = 0;
  slots.perServer.clear();
}
