import { mcpService } from '@/backend/services/mcp';
import { runWithWorkspace } from '@/utils/workspace';
import { createLogger } from '@/utils/logger';
import {
  getWorkerBootstrapStatus, isWorkerMode, setWorkerBootstrapStatus, type PublishedWorkerMcpServers, type WorkerMcpServerReport,
} from './workerMode';
import { normalizeWorkerMcpServers, workerMcpConnectReasonCode, workerMcpReasonCode, workerMcpServerReport } from './workerMcpReason';

const log = createLogger('backend/services/workspace/workerMcpServers');

/** First check after startup or an approval; each quiet check doubles the wait up to the longest. */
export const FIRST_WORKER_MCP_RECHECK_MS = 15_000;
export const LONGEST_WORKER_MCP_RECHECK_MS = 5 * 60_000;

interface RecheckState {
  timer?: ReturnType<typeof setTimeout>;
  delayMs: number;
  /** Bumped by a stop, so a check still running then does not arm the next one. */
  epoch: number;
}

declare global {
  // Shared across Next.js module instances, like the worker status itself.
  var __flujo_worker_mcp_recheck: RecheckState | undefined;
}

function recheckState(): RecheckState {
  return global.__flujo_worker_mcp_recheck ??= { delayMs: FIRST_WORKER_MCP_RECHECK_MS, epoch: 0 };
}

function reasonCode(server: WorkerMcpServerReport | undefined): string | undefined {
  return server && 'reason' in server ? server.reason.code : undefined;
}

/** Publish the server list and log every server whose state changed, with its fixed reason. */
export function publishWorkerMcpServers(reports: readonly WorkerMcpServerReport[]): PublishedWorkerMcpServers {
  const status = getWorkerBootstrapStatus();
  const previous = new Map((status.servers ?? []).map(server => [server.name, server]));
  // Once ready, the worker retries by itself; before that, /api/init or a restart does.
  const servers = normalizeWorkerMcpServers(reports, { afterReady: status.state === 'ready' });
  setWorkerBootstrapStatus({ servers });
  for (const server of servers) {
    const before = previous.get(server.name);
    if (before?.status === server.status && reasonCode(before) === reasonCode(server)) continue;
    if ('reason' in server) {
      log.warn(`Worker MCP server "${server.name}" is ${server.status} (${server.reason.code}): ${server.reason.message} ${server.reason.action}`);
    } else if (before) {
      log.info(`Worker MCP server "${server.name}" is ${server.status}.`);
    }
  }
  return servers;
}

/** Read every configured server's live state after startup, keeping preparation reasons. */
export async function collectWorkerMcpServers(prepared: readonly WorkerMcpServerReport[]): Promise<WorkerMcpServerReport[]> {
  const configs = await mcpService.loadServerConfigs();
  if (!Array.isArray(configs)) throw new Error('Worker MCP configurations could not be loaded.');
  const earlier = new Map(prepared.map(server => [server.name, server]));
  return Promise.all(configs.map(async (config): Promise<WorkerMcpServerReport> => {
    if (config.disabled) return { name: config.name, status: 'disabled' };
    const status = await mcpService.getServerStatus(config.name);
    if (status.status === 'connected') return { name: config.name, status: 'ready' };
    if (status.requiresApproval) return workerMcpServerReport(config.name, workerMcpConnectReasonCode(status));
    const before = earlier.get(config.name);
    return before?.status === 'waiting' ? before : workerMcpServerReport(config.name, 'CONNECT_FAILED');
  }));
}

function needsRecheck(): boolean {
  const status = getWorkerBootstrapStatus();
  return isWorkerMode() && status.state === 'ready'
    && (status.servers ?? []).some(server => server.status === 'waiting' || server.status === 'failed');
}

/**
 * Try again to start servers that wait for approval (or failed after the
 * worker became ready). The normal connect path makes every approval check, so
 * this never starts a server that is not approved. Only those servers change.
 */
export async function recheckWorkerMcpServers(names?: readonly string[]): Promise<readonly WorkerMcpServerReport[]> {
  const status = getWorkerBootstrapStatus();
  if (!isWorkerMode() || status.state !== 'ready' || !status.workspace) return status.servers ?? [];
  const pending = (status.servers ?? []).filter(server => (server.status === 'waiting' || server.status === 'failed')
    && (!names || names.includes(server.name)));
  if (!pending.length) return status.servers ?? [];
  const updates = new Map<string, WorkerMcpServerReport | null>();
  await runWithWorkspace(status.workspace, async () => {
    const configs = await mcpService.loadServerConfigs();
    const byName = new Map(Array.isArray(configs) ? configs.map(config => [config.name, config]) : []);
    for (const server of pending) {
      const config = byName.get(server.name);
      if (Array.isArray(configs) && !config) { updates.set(server.name, null); continue; }
      if (config?.disabled) { updates.set(server.name, { name: server.name, status: 'disabled' }); continue; }
      try {
        const connected = await mcpService.connectServer(server.name);
        updates.set(server.name, connected.success ? { name: server.name, status: 'ready' }
          : workerMcpServerReport(server.name, workerMcpConnectReasonCode(connected)));
      } catch (error) {
        updates.set(server.name, workerMcpServerReport(server.name, workerMcpReasonCode(error, 'CONNECT_FAILED')));
      }
    }
  });
  // Merge into the newest list so a concurrent check of another server is kept.
  const servers = (getWorkerBootstrapStatus().servers ?? []).flatMap(server => {
    const update = updates.get(server.name);
    return update === null ? [] : [update ?? server];
  });
  return publishWorkerMcpServers(servers);
}

/**
 * Keep checking waiting servers in the background while any remain. It stops
 * by itself when none are left and never holds the process open.
 */
export function scheduleWorkerMcpRecheck(options: { reset?: boolean } = {}): void {
  const state = recheckState();
  if (options.reset) {
    state.delayMs = FIRST_WORKER_MCP_RECHECK_MS;
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
  }
  if (state.timer || !needsRecheck()) return;
  const { epoch } = state;
  const timer = setTimeout(() => {
    if (state.timer === timer) state.timer = undefined;
    state.delayMs = Math.min(state.delayMs * 2, LONGEST_WORKER_MCP_RECHECK_MS);
    void recheckWorkerMcpServers()
      .catch(() => log.warn('Worker MCP server check failed; it will run again.'))
      .finally(() => { if (state.epoch === epoch) scheduleWorkerMcpRecheck(); });
  }, state.delayMs);
  timer.unref?.();
  state.timer = timer;
}

/** Stop background checks (tests and shutdown). */
export function stopWorkerMcpRecheck(): void {
  const state = recheckState();
  if (state.timer) clearTimeout(state.timer);
  state.timer = undefined;
  state.delayMs = FIRST_WORKER_MCP_RECHECK_MS;
  state.epoch += 1;
}

/**
 * An owner just approved `name`: start it now instead of at the next check.
 * Never throws; the approval itself already succeeded.
 */
export async function startApprovedWorkerServer(name: string): Promise<WorkerMcpServerReport | undefined> {
  if (!isWorkerMode()) return undefined;
  try {
    const servers = await recheckWorkerMcpServers([name]);
    return servers.find(server => server.name === name);
  } catch {
    log.warn(`Worker MCP server "${name}" could not start right after approval; it will be checked again.`);
    return undefined;
  } finally {
    scheduleWorkerMcpRecheck({ reset: true });
  }
}
