import type { CallToolResult, ReadResourceResult } from '@modelcontextprotocol/client';
import type { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { mcpService } from '@/frontend/services/mcp';

type AppBackend = Pick<typeof mcpService, 'callToolFromApp' | 'readResourceFromApp'>;
type AppRequestRoutes = Pick<AppBridge, 'oncalltool' | 'onreadresource' | 'onlistresources' | 'onlistresourcetemplates'>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Answers a View's MCP requests through FLUJO's backend. The bridge is built
 * without an MCP client of its own: the real connection belongs to the
 * backend, which also enforces app-visible tools and live consent. These are
 * the four requests a bridge with a tools-and-resources server forwards.
 */
export function routeMcpAppRequests(
  bridge: AppRequestRoutes,
  serverName: string,
  ownerScope: string,
  onAccessRevoked: (message: string) => void,
  backend: AppBackend,
  onToolCall?: (tool: string) => void,
): void {
  bridge.oncalltool = async (params, extra) => {
    const tool = typeof params?.name === 'string' ? params.name : undefined;
    if (!tool) throw new Error('MCP App tool call is missing a tool name');
    onToolCall?.(tool);
    // The host binds both server and owner. The App cannot override them;
    // the backend separately enforces app-visible tools and live consent.
    const response = await backend.callToolFromApp(
      serverName, tool, asRecord(params?.arguments) ?? {},
      undefined, extra.mcpReq.signal, ownerScope,
    );
    if (response?.httpStatus === 403) {
      const message = response.error || 'MCP Apps access was disabled for this server';
      onAccessRevoked(message);
      throw new Error(message);
    }
    if (!response || response.success === false) {
      throw new Error(response?.error || `Tool call failed: ${tool}`);
    }
    return response.data as CallToolResult;
  };
  bridge.onreadresource = async (params, extra) => {
    const uri = typeof params?.uri === 'string' ? params.uri : undefined;
    if (!uri) throw new Error('MCP App resource read is missing a URI');
    const response = await backend.readResourceFromApp(serverName, uri, extra.mcpReq.signal);
    if (response?.httpStatus === 403) {
      const message = response.error || 'MCP Apps access was disabled for this server';
      onAccessRevoked(message);
      throw new Error(message);
    }
    if (!response || response.success === false) {
      throw new Error(response?.error || `Resource read failed: ${uri}`);
    }
    return response.data as ReadResourceResult;
  };
  bridge.onlistresources = async () => ({ resources: [] });
  bridge.onlistresourcetemplates = async () => ({ resourceTemplates: [] });
}
