/**
 * Identity of FLUJO's built-in internal MCP server.
 *
 * The internal server exposes FLUJO's own backend API (flow authoring/execution,
 * MCP server management, marketplace install, models, planned executions) as MCP
 * tools that FLUJO's own flows can bind like any other server. There is no process
 * and no transport: MCPService short-circuits this name in listServerTools/callTool/
 * getServerStatus etc. straight to the in-process dispatcher (internalTools.ts).
 *
 * This module is deliberately tiny and dependency-free: it is statically imported
 * by MCPService (index.ts), while the tool definitions + dispatcher live in
 * internalTools.ts and are loaded with a dynamic import at the point of use —
 * internalTools reaches into runFlow / flowAuthoringTools / registryInstall, which
 * transitively import mcpService again, and a static import from index.ts would
 * close that cycle at module-init time.
 */
import { MCPStdioConfig } from '@/shared/types/mcp';

export const INTERNAL_SERVER_NAME = 'flujo';

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
    command: '',
    args: [],
    env: {},
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
