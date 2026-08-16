import type { MCPServerConfig, MCPStdioConfig } from '@/shared/types/mcp';

import type { ToolCallSource } from './appsProtocol';
import { shippedDescriptorForConfig } from './shippedServers';

const FLUJO_PACKAGE_ID = '@mario.andreschak/mcp-flujo';
const CREATE_TICKET_TOOL = 'create_ticket_for_human';
const SAFE_CONVERSATION_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Runtime context that may be attached only by FLUJO's execution engine. */
export interface TrustedMcpToolInvocationContext {
  conversationId?: string;
}

export function trustedFlujoTicketConversationId(
  config: MCPServerConfig | null,
  toolName: string,
  source: ToolCallSource,
  context?: TrustedMcpToolInvocationContext,
): string | undefined {
  const conversationId = context?.conversationId?.trim();
  if (
    source !== 'model'
    || toolName !== CREATE_TICKET_TOOL
    || !conversationId
    || !SAFE_CONVERSATION_ID.test(conversationId)
    || config?.transport !== 'stdio'
    || shippedDescriptorForConfig(config as MCPStdioConfig)?.packageId !== FLUJO_PACKAGE_ID
  ) {
    return undefined;
  }
  return conversationId;
}

/** Read the deliberately tiny success envelope returned by mcp-flujo. */
export function createdTicketIdFromMcpResult(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  for (const item of content) {
    if (!item || typeof item !== 'object' || (item as { type?: unknown }).type !== 'text') continue;
    const value = (item as { text?: unknown }).text;
    if (typeof value !== 'string') continue;
    try {
      const parsed = JSON.parse(value) as { created?: unknown; id?: unknown };
      if (parsed.created === true && typeof parsed.id === 'string' && SAFE_CONVERSATION_ID.test(parsed.id)) {
        return parsed.id;
      }
    } catch {
      // Other text blocks are ordinary tool output, not the ticket envelope.
    }
  }
  return undefined;
}

/**
 * Add provenance required by a shipped FLUJO control-plane tool without
 * trusting model-authored arguments. The package/source identity is stable
 * across user renames; arbitrary MCP servers that reuse the same tool name are
 * deliberately left byte-for-byte unchanged.
 */
export function injectTrustedFlujoToolContext(
  config: MCPServerConfig | null,
  toolName: string,
  args: Record<string, unknown>,
  source: ToolCallSource,
  context?: TrustedMcpToolInvocationContext,
): Record<string, unknown> {
  const conversationId = trustedFlujoTicketConversationId(config, toolName, source, context);
  if (!conversationId) return args;

  // Override, rather than default, so a model cannot attribute its ticket to a
  // different conversation (and therefore a different Persona Activity).
  return { ...args, conversation_id: conversationId };
}
