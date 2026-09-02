import { loadItem } from '@/utils/storage/backend';
import { StorageKey, type Settings } from '@/shared/types/storage';
import type { MCPServerConfig } from '@/shared/types/mcp';
import { createLogger } from '@/utils/logger';

const log = createLogger('backend/services/mcp/runtimeHomeIsolation');

export const MCP_RUNTIME_HOME_ISOLATION_ENV = 'FLUJO_MCP_RUNTIME_HOME_ISOLATION';

/**
 * Parse the installation-wide operator override. Undefined and unrecognised
 * values mean "inherit" so a malformed launcher value cannot silently opt a
 * server into sharing or isolation.
 */
export function parseRuntimeHomeIsolationOverride(
  raw: string | undefined,
): boolean | undefined {
  const value = raw?.trim().toLowerCase();
  if (!value) return undefined;
  if (['1', 'true', 'yes', 'on', 'isolated'].includes(value)) return true;
  if (['0', 'false', 'no', 'off', 'host'].includes(value)) return false;
  return undefined;
}

/**
 * Resolve stdio runtime-home isolation with one authoritative precedence chain:
 *
 *   process environment > per-server mode > workspace default > off
 *
 * Settings storage is workspace-scoped, so this must run inside the request or
 * callback's bound workspace context. Failure is fail-open to the requested
 * product default (host home), not to isolation.
 */
export async function resolveRuntimeHomeIsolation(
  config: MCPServerConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<boolean> {
  if (config.transport !== 'stdio') return false;

  const processOverride = parseRuntimeHomeIsolationOverride(
    env[MCP_RUNTIME_HOME_ISOLATION_ENV],
  );
  if (processOverride !== undefined) return processOverride;

  if (config.runtimeHomeMode === 'isolated') return true;
  if (config.runtimeHomeMode === 'host') return false;

  try {
    const settings = await loadItem<Settings | undefined>(
      StorageKey.SPEECH_SETTINGS,
      undefined,
    );
    return settings?.experimental?.mcpRuntimeHomeIsolation === true;
  } catch (error) {
    log.warn('Could not read the workspace MCP runtime-home preference; defaulting to host home', {
      error,
    });
    return false;
  }
}
