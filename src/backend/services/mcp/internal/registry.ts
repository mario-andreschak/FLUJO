/**
 * Registry and default configurations for FLUJO's shipped internal MCP servers.
 * Issue #346 persists these defaults as ordinary MCP_SERVERS records; reserved
 * names still identify the special host-owned dispatch behavior.
 */
import { MCPStdioConfig } from '@/shared/types/mcp';
import {
  INTERNAL_SERVER_NAME,
  builtInStdioCwd,
  builtInStdioEntrypoint,
  builtInStdioEnv,
  internalServerConfig,
} from '../internalServerConfig';

/** Reserved names of the built-in servers, in display order. */
export const FILESYSTEM_SERVER_NAME = 'filesystem';
export const BASH_SERVER_NAME = 'bash';

// Import from shared location and re-export for backward compatibility. The shared
// version lives in @/utils/shared/mcpConstants so that pure client-side modules
// (e.g. flowValidation.ts) can import isBuiltInServerName without pulling in
// server-only dependencies.
import { BUILTIN_SERVER_NAMES as _BUILTIN_SERVER_NAMES, isBuiltInServerName as _isBuiltInServerName } from '@/utils/shared/mcpConstants';
export const BUILTIN_SERVER_NAMES: readonly string[] = _BUILTIN_SERVER_NAMES;
export { _isBuiltInServerName as isBuiltInServerName };

/** Shared persisted-config factory for the shipped servers other than `flujo`. */
function builtInStdioConfig(name: string): MCPStdioConfig {
  return {
    name,
    transport: 'stdio',
    command: process.execPath,
    args: [builtInStdioEntrypoint(name)],
    env: builtInStdioEnv(name),
    cwd: builtInStdioCwd(name),
    disabled: false,
    autoApprove: [],
    rootPath: '',
    _buildCommand: '',
    _installCommand: '',
    exposeAsMcpServer: true,
  };
}

/** Build the current default config for one reserved internal server name. */
export function builtInServerConfig(name: string): MCPStdioConfig {
  if (name === INTERNAL_SERVER_NAME) return internalServerConfig();
  return builtInStdioConfig(name);
}

/** Legacy override payload consumed by the one-time issue #346 migration. */
export type InternalServerOverride = { disabled?: boolean; roots?: string[] };
export type InternalServerOverrides = Record<string, InternalServerOverride>;
