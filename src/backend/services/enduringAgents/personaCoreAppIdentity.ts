import { createHash } from 'crypto';

/** Reserved runtime identity for MCP nodes projected from a Persona App grant. */
export const PERSONA_CORE_APP_NODE_PREFIX = 'persona_core_app_';

/** Stable workspace-local node id for one exact MCP server configuration name. */
export function personaCoreAppNodeId(mcpServerName: string): string {
  const digest = createHash('sha256').update(mcpServerName).digest('hex').slice(0, 16);
  return `${PERSONA_CORE_APP_NODE_PREFIX}${digest}`;
}

export function isPersonaCoreAppNodeId(nodeId: string | undefined): boolean {
  return typeof nodeId === 'string' && nodeId.startsWith(PERSONA_CORE_APP_NODE_PREFIX);
}
