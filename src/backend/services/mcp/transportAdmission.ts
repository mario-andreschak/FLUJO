import type { MCPServerConfig } from '@/shared/types/mcp';

export const MCP_TRANSPORT_INVALID = 'MCP_TRANSPORT_INVALID';

/** Validate runtime data before a transport-specific policy or factory runs. */
export function isMcpTransport(value: unknown): value is MCPServerConfig['transport'] {
  return value === 'stdio' || value === 'streamable' || value === 'sse' || value === 'websocket';
}

export class McpTransportError extends Error {
  constructor() {
    super(MCP_TRANSPORT_INVALID);
    this.name = 'McpTransportError';
  }
}

export function assertMcpTransport(config: Pick<MCPServerConfig, 'transport'>): void {
  if (!isMcpTransport(config.transport)) throw new McpTransportError();
}

/** Only persisted legacy records may omit the tag. Never coerce an explicit value. */
export function storedMcpTransport(value: unknown): MCPServerConfig['transport'] {
  if (value === undefined) return 'stdio';
  if (!isMcpTransport(value)) throw new McpTransportError();
  return value;
}
