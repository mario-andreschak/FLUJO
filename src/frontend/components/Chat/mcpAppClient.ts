import type { Client, RequestOptions } from '@modelcontextprotocol/client';
import type { mcpService } from '@/frontend/services/mcp';

type AppBackend = Pick<typeof mcpService, 'callToolFromApp' | 'readResourceFromApp'>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** The SDK2 bridge calls request(message, options); no result-schema argument. */
export function makeMcpAppClient(
  serverName: string,
  ownerScope: string,
  onAccessRevoked: (message: string) => void,
  backend: AppBackend,
  onToolCall?: (tool: string) => void,
): Client {
  const shim = {
    getServerCapabilities: () => ({ tools: {}, resources: {} }),
    setNotificationHandler: () => { /* no listChanged advertised */ },
    request: async (
      req: { method: string; params?: unknown },
      options?: RequestOptions,
    ) => {
      const { method, params } = req;
      if (method === 'tools/call') {
        const callParams = asRecord(params);
        const tool = typeof callParams?.name === 'string' ? callParams.name : undefined;
        if (!tool) throw new Error('MCP App tool call is missing a tool name');
        onToolCall?.(tool);
        // The host binds both server and owner. The App cannot override them;
        // the backend separately enforces app-visible tools and live consent.
        const response = await backend.callToolFromApp(
          serverName, tool, asRecord(callParams?.arguments) ?? {},
          undefined, options?.signal, ownerScope,
        );
        if (response?.httpStatus === 403) {
          const message = response.error || 'MCP Apps access was disabled for this server';
          onAccessRevoked(message);
          throw new Error(message);
        }
        if (!response || response.success === false) {
          throw new Error(response?.error || `Tool call failed: ${tool}`);
        }
        return response.data;
      }
      if (method === 'resources/read') {
        const readParams = asRecord(params);
        const uri = typeof readParams?.uri === 'string' ? readParams.uri : undefined;
        if (!uri) throw new Error('MCP App resource read is missing a URI');
        const response = await backend.readResourceFromApp(serverName, uri, options?.signal);
        if (response?.httpStatus === 403) {
          const message = response.error || 'MCP Apps access was disabled for this server';
          onAccessRevoked(message);
          throw new Error(message);
        }
        if (!response || response.success === false) {
          throw new Error(response?.error || `Resource read failed: ${uri}`);
        }
        return response.data;
      }
      if (method === 'resources/list') return { resources: [] };
      if (method === 'resources/templates/list') return { resourceTemplates: [] };
      throw new Error(`MCP App requested unsupported method: ${method}`);
    },
  };
  // AppBridge only uses the three methods above; the real connection belongs
  // to the backend. Keeping this seam separate permits real SDK2 wire tests.
  return shim as unknown as Client;
}
