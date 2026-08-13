import type { MCPServerConfig } from '@/shared/types/mcp';

import {
  createdTicketIdFromMcpResult,
  injectTrustedFlujoToolContext,
  trustedFlujoTicketConversationId,
} from '@/backend/services/mcp/trustedToolContext';

const shippedFlujo = (name = 'renamed-control-plane'): MCPServerConfig => ({
  name,
  transport: 'stdio',
  command: 'node',
  args: ['mcp-servers/flujo/dist/index.js'],
  source: { type: 'marketplace', id: '@mario.andreschak/mcp-flujo' },
} as MCPServerConfig);

describe('trusted shipped FLUJO tool context', () => {
  it('overrides model-authored ticket provenance using immutable package identity', () => {
    expect(injectTrustedFlujoToolContext(
      shippedFlujo(),
      'create_ticket_for_human',
      { message: 'Review this', conversation_id: 'spoofed-conversation' },
      'model',
      { conversationId: 'conversation-current' },
    )).toEqual({
      message: 'Review this',
      conversation_id: 'conversation-current',
    });
  });

  it('does not inject into an arbitrary server with the same name or tool', () => {
    const args = { message: 'Review this' };
    const arbitrary = {
      ...shippedFlujo('flujo'),
      source: { type: 'marketplace', id: 'somebody/else' },
    } as MCPServerConfig;

    expect(injectTrustedFlujoToolContext(
      arbitrary,
      'create_ticket_for_human',
      args,
      'model',
      { conversationId: 'conversation-current' },
    )).toBe(args);
  });

  it('leaves host/app calls, other tools, and invalid conversation ids unchanged', () => {
    const args = { message: 'Review this' };
    expect(injectTrustedFlujoToolContext(
      shippedFlujo(), 'create_ticket_for_human', args, 'host', { conversationId: 'conversation-current' },
    )).toBe(args);
    expect(injectTrustedFlujoToolContext(
      shippedFlujo(), 'read_conversation', args, 'model', { conversationId: 'conversation-current' },
    )).toBe(args);
    expect(injectTrustedFlujoToolContext(
      shippedFlujo(), 'create_ticket_for_human', args, 'model', { conversationId: '../escape' },
    )).toBe(args);
  });

  it('exposes trusted provenance only for the exact shipped model invocation', () => {
    expect(trustedFlujoTicketConversationId(
      shippedFlujo(),
      'create_ticket_for_human',
      'model',
      { conversationId: 'conversation-current' },
    )).toBe('conversation-current');
    expect(trustedFlujoTicketConversationId(
      shippedFlujo(),
      'create_ticket_for_human',
      'host',
      { conversationId: 'conversation-current' },
    )).toBeUndefined();
  });

  it('extracts only a safe created-ticket success envelope', () => {
    expect(createdTicketIdFromMcpResult({
      content: [{ type: 'text', text: JSON.stringify({ created: true, id: 'ticket-1' }) }],
    })).toBe('ticket-1');
    expect(createdTicketIdFromMcpResult({
      content: [{ type: 'text', text: JSON.stringify({ created: false, id: 'ticket-1' }) }],
    })).toBeUndefined();
    expect(createdTicketIdFromMcpResult({
      content: [{ type: 'text', text: JSON.stringify({ created: true, id: '../escape' }) }],
    })).toBeUndefined();
  });
});
