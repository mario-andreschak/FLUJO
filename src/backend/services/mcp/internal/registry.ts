/**
 * Registry and default configurations for FLUJO's shipped internal MCP servers.
 * Issue #346 persists these defaults as ordinary MCP_SERVERS records; reserved
 * names still identify the special host-owned dispatch behavior.
 */
import { MCPStdioConfig } from '@/shared/types/mcp';
import {
  INTERNAL_SERVER_NAME,
  builtInStdioArgs,
  builtInStdioEnv,
  internalServerConfig,
} from '../internalServerConfig';

/** Reserved names of the built-in servers, in display order. */
export const FILESYSTEM_SERVER_NAME = 'filesystem';
export const BASH_SERVER_NAME = 'bash';
export const BROWSER_SERVER_NAME = 'browser';

// Import from shared location and re-export for backward compatibility. The shared
// version lives in @/utils/shared/mcpConstants so that pure client-side modules
// (e.g. flowValidation.ts) can import isBuiltInServerName without pulling in
// server-only dependencies.
import {
  BUILTIN_SERVER_NAMES as _BUILTIN_SERVER_NAMES,
  isBuiltInServerName as _isBuiltInServerName,
  MCPPackageCapabilities,
} from '@/utils/shared/mcpConstants';
export const BUILTIN_SERVER_NAMES: readonly string[] = _BUILTIN_SERVER_NAMES;
export { _isBuiltInServerName as isBuiltInServerName };

const PACKAGE_IDS: Record<string, string> = {
  [INTERNAL_SERVER_NAME]: '@flujo-ai/mcp-flujo',
  [FILESYSTEM_SERVER_NAME]: '@flujo-ai/mcp-filesystem',
  [BASH_SERVER_NAME]: '@flujo-ai/mcp-bash',
  [BROWSER_SERVER_NAME]: '@flujo-ai/mcp-browser',
};

const PACKAGE_CAPABILITIES: Record<string, MCPPackageCapabilities> = {
  [INTERNAL_SERVER_NAME]: { resources: true, flujoControlPlane: true },
  [FILESYSTEM_SERVER_NAME]: {
    hostPathAccess: {
      environmentRootVariables: ['FLUJO_FS_ROOTS'],
      protectedPaths: true,
      snapshots: true,
    },
    mcpApps: true,
    resources: true,
  },
  [BASH_SERVER_NAME]: {
    hostPathAccess: {
      environmentRootVariables: ['FLUJO_BASH_ROOTS', 'FLUJO_FS_ROOTS'],
      protectedPaths: true,
      snapshots: true,
    },
    mcpApps: true,
    resources: true,
  },
  [BROWSER_SERVER_NAME]: {
    mcpApps: true,
    resources: true,
  },
};

/** Shared persisted-config factory for the shipped servers other than `flujo`. */
function builtInStdioConfig(name: string): MCPStdioConfig {
  return {
    name,
    transport: 'stdio',
    command: 'npx',
    args: builtInStdioArgs(name),
    env: builtInStdioEnv(name),
    // Resolved to FLUJO_APP_ROOT only at launch; never persist an install path.
    cwd: '',
    // Browser automation is seeded off unless the operator explicitly opts in.
    // The ordinary persisted record can subsequently be enabled in MCP Manager.
    disabled: name === BROWSER_SERVER_NAME
      ? !/^(1|true|yes|on)$/i.test(process.env.FLUJO_BROWSER_ENABLED?.trim() ?? '')
      : false,
    autoApprove: [],
    rootPath: '',
    _buildCommand: '',
    _installCommand: '',
    exposeAsMcpServer: true,
    internalPackage: PACKAGE_IDS[name],
    packageCapabilities: PACKAGE_CAPABILITIES[name],
  };
}

/** Build the current default config for one reserved internal server name. */
export function builtInServerConfig(name: string): MCPStdioConfig {
  if (name === INTERNAL_SERVER_NAME) {
    return {
      ...internalServerConfig(),
      internalPackage: PACKAGE_IDS[name],
      packageCapabilities: PACKAGE_CAPABILITIES[name],
    };
  }
  return builtInStdioConfig(name);
}

/** Legacy override payload consumed by the one-time issue #346 migration. */
export type InternalServerOverride = { disabled?: boolean; roots?: string[] };
export type InternalServerOverrides = Record<string, InternalServerOverride>;
