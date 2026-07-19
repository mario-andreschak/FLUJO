/**
 * Registry of FLUJO's built-in ("internal") MCP servers (issue #170).
 *
 * Historically there was exactly one built-in server (`flujo`) and the machinery
 * in MCPService hard-coded that single name and the rule "built-in ⇒ always
 * enabled, cannot be disabled". This module generalizes that to a small list of
 * built-in servers, each synthesized at load time (never persisted), and adds a
 * per-server enable/disable override that IS persisted (only the tiny
 * `{ disabled }` flag — never the synthetic config).
 *
 * This module is intentionally kept dependency-light and free of the heavy
 * dispatcher imports: MCPService (index.ts) statically imports it to synthesize
 * configs and answer name checks, while the actual tool definitions + dispatch
 * live behind a dynamic import (see ./dispatch.ts) to preserve the module cycle
 * break documented in internalServerConfig.ts.
 */
import { loadItem, saveItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { MCPStdioConfig } from '@/shared/types/mcp';
import { createLogger } from '@/utils/logger';
import { INTERNAL_SERVER_NAME, internalServerConfig } from '../internalServerConfig';

const log = createLogger('backend/services/mcp/internal/registry');

/** Reserved names of the built-in servers, in display order. */
export const FILESYSTEM_SERVER_NAME = 'filesystem';
export const BASH_SERVER_NAME = 'bash';

export const BUILTIN_SERVER_NAMES: readonly string[] = [
  INTERNAL_SERVER_NAME,
  FILESYSTEM_SERVER_NAME,
  BASH_SERVER_NAME,
];

/** Is this name one of FLUJO's built-in servers? (Pure string check — no I/O.) */
export function isBuiltInServerName(name: string): boolean {
  return BUILTIN_SERVER_NAMES.includes(name);
}

/**
 * Shared synthetic-config factory for the built-in servers that are NOT `flujo`.
 * Mirrors internalServerConfig(): `builtIn: true`, exposed at its own
 * /mcp-proxy/<name> endpoint, and enabled by default.
 */
function builtInStdioConfig(name: string): MCPStdioConfig {
  return {
    name,
    transport: 'stdio',
    command: '',
    args: [],
    env: {},
    disabled: false,
    autoApprove: [],
    rootPath: '',
    _buildCommand: '',
    _installCommand: '',
    builtIn: true,
    exposeAsMcpServer: true,
  };
}

/** Synthesize the config for a single built-in server by name (unshadowed). */
export function builtInServerConfig(name: string): MCPStdioConfig {
  if (name === INTERNAL_SERVER_NAME) return internalServerConfig();
  return builtInStdioConfig(name);
}

/** Synthesize the config for every built-in server (enabled by default). */
export function builtInServerConfigs(): MCPStdioConfig[] {
  return BUILTIN_SERVER_NAMES.map((name) => builtInServerConfig(name));
}

/**
 * Persisted per-built-in-server overrides. Only the `disabled` flag is stored;
 * the synthetic configs themselves are never persisted (invariant preserved by
 * config.ts saveConfig(), which drops builtIn entries).
 */
export type InternalServerOverride = { disabled?: boolean };
export type InternalServerOverrides = Record<string, InternalServerOverride>;

export async function loadInternalOverrides(): Promise<InternalServerOverrides> {
  try {
    const raw = await loadItem<InternalServerOverrides>(StorageKey.MCP_INTERNAL_OVERRIDES, {});
    return raw && typeof raw === 'object' ? raw : {};
  } catch (err) {
    log.warn('loadInternalOverrides: failed to read overrides', err);
    return {};
  }
}

/** Persist the enabled/disabled state of a single built-in server. */
export async function setInternalServerDisabled(name: string, disabled: boolean): Promise<void> {
  const overrides = await loadInternalOverrides();
  overrides[name] = { ...(overrides[name] ?? {}), disabled };
  await saveItem(StorageKey.MCP_INTERNAL_OVERRIDES, overrides);
  log.info(`setInternalServerDisabled: ${name} -> disabled=${disabled}`);
}

/**
 * Synthesize built-in configs with any persisted `disabled` override applied.
 * Used by MCPService.loadServerConfigs().
 */
export async function builtInServerConfigsWithOverrides(): Promise<MCPStdioConfig[]> {
  const overrides = await loadInternalOverrides();
  return builtInServerConfigs().map((cfg) => {
    const ov = overrides[cfg.name];
    return ov?.disabled ? { ...cfg, disabled: true } : cfg;
  });
}
