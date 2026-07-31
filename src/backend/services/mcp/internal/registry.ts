/**
 * Package metadata and default configurations for FLUJO's bundled MCP servers.
 * Issue #346 persists these defaults as ordinary MCP_SERVERS records.
 */
import { MCPStdioConfig } from '@/shared/types/mcp';
import { MCPPackageCapabilities } from '@/utils/shared/mcpConstants';
import {
  INTERNAL_SERVER_NAME,
  bundledStdioArgs,
  bundledStdioEnv,
  internalServerConfig,
} from '../internalServerConfig';

export const FILESYSTEM_SERVER_NAME = 'filesystem';
export const BASH_SERVER_NAME = 'bash';
export const BROWSER_SERVER_NAME = 'browser';
export const SHIPPED_SERVER_NAMES: readonly string[] = [
  INTERNAL_SERVER_NAME,
  FILESYSTEM_SERVER_NAME,
  BASH_SERVER_NAME,
  BROWSER_SERVER_NAME,
];

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
function shippedStdioConfig(name: string): MCPStdioConfig {
  return {
    name,
    transport: 'stdio',
    command: 'npx',
    args: bundledStdioArgs(name),
    env: bundledStdioEnv(name),
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

/** Build the current default config for one bundled server package. */
export function shippedServerConfig(name: string): MCPStdioConfig {
  if (name === INTERNAL_SERVER_NAME) {
    return {
      ...internalServerConfig(),
      internalPackage: PACKAGE_IDS[name],
      packageCapabilities: PACKAGE_CAPABILITIES[name],
    };
  }
  return shippedStdioConfig(name);
}

/** Legacy override payload consumed by the one-time issue #346 migration. */
export type InternalServerOverride = { disabled?: boolean; roots?: string[] };
export type InternalServerOverrides = Record<string, InternalServerOverride>;
