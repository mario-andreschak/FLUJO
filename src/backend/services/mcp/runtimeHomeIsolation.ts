import { StorageKey } from '@/shared/types/storage';
import type { MCPServerConfig } from '@/shared/types/mcp';
import { loadItem, loadItemForBackup, saveItem } from '@/utils/storage/backend';
import { getCurrentWorkspace } from '@/utils/workspace';
import { assertMcpTransport } from './transportAdmission';

type StoredRecord = Record<string, unknown>;

const movedDefaults = new Map<string, Promise<boolean>>();

function isRecord(value: unknown): value is StoredRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * #1449 retired the workspace-wide "isolate every server" switch. A workspace
 * that had it on gets `isolated` written into each stdio server that followed
 * it, so the choice now lives only in the server's own settings.
 */
async function moveRetiredWorkspaceDefault(): Promise<boolean> {
  const settings = await loadItemForBackup<unknown>(StorageKey.SPEECH_SETTINGS, null);
  if (!isRecord(settings) || !isRecord(settings.experimental)
    || settings.experimental.mcpRuntimeHomeIsolation !== true) return false;
  const servers = await loadItem<Record<string, StoredRecord>>(StorageKey.MCP_SERVERS, {});
  const next = Object.fromEntries(Object.entries(servers).map(([name, server]) => [
    name,
    server.transport === 'stdio' && (server.runtimeHomeMode ?? 'inherit') === 'inherit'
      ? { ...server, runtimeHomeMode: 'isolated' }
      : server,
  ]));
  await saveItem(StorageKey.MCP_SERVERS, next);
  await saveItem(StorageKey.SPEECH_SETTINGS, settings);
  return true;
}

function retiredWorkspaceDefault(): Promise<boolean> {
  const workspace = getCurrentWorkspace();
  const pending = movedDefaults.get(workspace) ?? moveRetiredWorkspaceDefault();
  movedDefaults.set(workspace, pending);
  pending.catch(() => movedDefaults.delete(workspace));
  return pending;
}

/** Runs at workspace start-up so the move happens before any setting is saved again. */
export async function moveRetiredRuntimeHomeDefault(): Promise<void> {
  await retiredWorkspaceDefault().catch(() => false);
}

/**
 * A stdio server gets a private workspace HOME/config/cache tree when its own
 * settings say `isolated`; otherwise it uses the host home like a terminal.
 */
export async function resolveRuntimeHomeIsolation(config: MCPServerConfig): Promise<boolean> {
  assertMcpTransport(config);
  if (config.transport !== 'stdio' || config.runtimeHomeMode === 'host') return false;
  if (config.runtimeHomeMode === 'isolated') return true;
  return retiredWorkspaceDefault().catch(() => false);
}

export function _resetRuntimeHomeMigrationForTests(): void {
  movedDefaults.clear();
}
