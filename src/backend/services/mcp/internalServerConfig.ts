/**
 * Identity of FLUJO's built-in internal MCP server.
 *
 * The internal server exposes FLUJO's own backend API (flow authoring/execution,
 * MCP server management, marketplace install, models, planned executions) as MCP
 * tools that FLUJO's own flows can bind like any other server. MCPService launches
 * the standalone stdio package and supplies a private authenticated bridge back to
 * the application services that own FLUJO state.
 *
 * This module remains dependency-light because MCPService imports it at startup.
 * Backend handlers stay behind the bridge and are loaded dynamically, preserving
 * the module-cycle break around runFlow / flowAuthoringTools / registryInstall.
 */
import path from 'node:path';
import { MCPStdioConfig } from '@/shared/types/mcp';

export const INTERNAL_SERVER_NAME = 'flujo';

export function builtInStdioEntrypoint(name: string): string {
  return path.join(process.cwd(), 'mcp-servers', name, 'dist', 'index.js');
}

export function builtInStdioCwd(name: string): string {
  return path.dirname(builtInStdioEntrypoint(name));
}

/**
 * Forward only the operator controls a standalone child needs. The bash server's
 * explicit full-inheritance opt-in is special: when enabled, copy the backend
 * environment so its historical semantics remain intact across the new process
 * boundary. Otherwise the SDK supplies its minimal safe platform environment.
 */
export function builtInStdioEnv(name: string): Record<string, string> {
  const env: Record<string, string> = {
    FLUJO_DATA_DIR: process.env.FLUJO_DATA_DIR ?? process.cwd(),
  };
  const bashInherits = name === 'bash' && /^(1|true|yes|on)$/i.test(
    process.env.FLUJO_BASH_INHERIT_ENV?.trim() ?? '',
  );
  if (bashInherits) {
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string') env[key] = value;
    }
  }
  const forwarded = name === 'filesystem'
    ? ['FLUJO_FS_ROOTS', 'FLUJO_ALLOW_PROTECTED_PATHS']
    : name === 'bash'
      ? ['FLUJO_BASH_ROOTS', 'FLUJO_FS_ROOTS', 'FLUJO_BASH_INHERIT_ENV', 'FLUJO_ALLOW_PROTECTED_PATHS']
      : [];
  for (const key of forwarded) {
    const value = process.env[key];
    if (typeof value === 'string') env[key] = value;
  }
  return env;
}

/**
 * The synthetic config entry for the built-in server. Appended by
 * MCPService.loadServerConfigs() when no stored server claims the name (a stored
 * config always wins, so a pre-existing user server named "flujo" keeps working
 * and simply shadows the built-in). Never persisted: saveConfig() drops any
 * config with `builtIn: true`.
 */
export function internalServerConfig(): MCPStdioConfig {
  return {
    name: INTERNAL_SERVER_NAME,
    transport: 'stdio',
    command: process.execPath,
    args: [builtInStdioEntrypoint(INTERNAL_SERVER_NAME)],
    env: builtInStdioEnv(INTERNAL_SERVER_NAME),
    cwd: builtInStdioCwd(INTERNAL_SERVER_NAME),
    disabled: false,
    autoApprove: [],
    rootPath: '',
    _buildCommand: '',
    _installCommand: '',
    builtIn: true,
    // Always re-exposed at /mcp-proxy/flujo so external MCP clients (Claude Code,
    // Cursor, the brain, …) can drive FLUJO through one endpoint. Same posture as
    // the /mcp-flows endpoint: localhost-only (DNS-rebind guarded) and gated by
    // the encryption lock — see proxyForward.ts.
    exposeAsMcpServer: true,
  };
}
