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
import { MCPStdioConfig } from '@/shared/types/mcp';

export const INTERNAL_SERVER_NAME = 'flujo';

const BUILT_IN_STDIO_COMMANDS: Record<string, string> = {
  flujo: 'flujo-mcp-flujo',
  filesystem: 'flujo-mcp-filesystem',
  bash: 'flujo-mcp-bash',
};

export function builtInStdioCommand(name: string): string {
  const command = BUILT_IN_STDIO_COMMANDS[name];
  if (!command) throw new Error(`Unknown built-in MCP server: ${name}`);
  return command;
}

export function builtInStdioArgs(name: string): string[] {
  return ['--no-install', builtInStdioCommand(name)];
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
  const commonForwarded = [
    'FLUJO_BASE_URL',
    'FLUJO_EXTRA_CA_CERTS',
    'NODE_EXTRA_CA_CERTS',
    'NODE_OPTIONS',
    'NODE_TLS_REJECT_UNAUTHORIZED',
    'SSL_CERT_FILE',
  ];
  for (const key of commonForwarded) {
    const value = process.env[key];
    if (typeof value === 'string') env[key] = value;
  }
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

/** Current default used when issue #346 seeds the persisted `flujo` config. */
export function internalServerConfig(): MCPStdioConfig {
  return {
    name: INTERNAL_SERVER_NAME,
    transport: 'stdio',
    command: 'npx',
    args: builtInStdioArgs(INTERNAL_SERVER_NAME),
    env: builtInStdioEnv(INTERNAL_SERVER_NAME),
    // Built-ins resolve this portable empty marker to FLUJO_APP_ROOT at launch.
    // Persisting an install-specific absolute path would break upgrades/relocation.
    cwd: '',
    disabled: false,
    autoApprove: [],
    rootPath: '',
    _buildCommand: '',
    _installCommand: '',
    // Always re-exposed at /mcp-proxy/flujo so external MCP clients (Claude Code,
    // Cursor, the brain, …) can drive FLUJO through one endpoint. Same posture as
    // the /mcp-flows endpoint: localhost-only (DNS-rebind guarded) and gated by
    // the encryption lock — see proxyForward.ts.
    exposeAsMcpServer: true,
  };
}
