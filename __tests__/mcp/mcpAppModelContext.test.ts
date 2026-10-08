import {
  formatMcpAppModelContexts,
  MAX_MCP_APP_CONTEXT_BYTES,
  parseMcpAppModelContexts,
  withMcpAppModelContext,
} from '@/backend/mcpApps/modelContext';
import type { FlujoChatMessage } from '@/shared/types/chat';

describe('MCP App model context', () => {
  it('validates and preserves content plus structuredContent', () => {
    const serialized = JSON.stringify({
      'weather::ui://weather/dashboard': {
        content: [{ type: 'text', text: 'Region: north' }],
        structuredContent: { region: 'north', selected: [1, 2] },
      },
    });
    const result = parseMcpAppModelContexts(serialized);
    expect(result.error).toBeUndefined();
    expect(result.contexts?.['weather::ui://weather/dashboard']).toEqual({
      content: [{ type: 'text', text: 'Region: north' }],
      structuredContent: { region: 'north', selected: [1, 2] },
    });
  });

  it('rejects malformed identities, payload shapes, and oversized metadata', () => {
    expect(parseMcpAppModelContexts(JSON.stringify({ app: {} })).error).toMatch(/identity/);
    expect(parseMcpAppModelContexts(JSON.stringify({
      'app\n::ui://x': {},
    })).error).toMatch(/identity/);
    expect(parseMcpAppModelContexts(JSON.stringify({
      'app::ui://x': { content: { type: 'text' } },
    })).error).toMatch(/must be an array/);
    expect(parseMcpAppModelContexts('x'.repeat(MAX_MCP_APP_CONTEXT_BYTES + 1)).error)
      .toMatch(/exceeds/);
  });

  it('formats context as explicitly untrusted model data', () => {
    const text = formatMcpAppModelContexts({
      'app::ui://x': { structuredContent: { selected: 'A' } },
    });
    expect(text).toContain('[MCP App model context]');
    expect(text).toContain('untrusted context');
    expect(text).toContain('"selected":"A"');
  });

  it('injects one wire-only message immediately before the latest user input', () => {
    const messages: FlujoChatMessage[] = [
      { id: 's', timestamp: 1, role: 'system', content: 'system' },
      { id: 'u1', timestamp: 2, role: 'user', content: 'old' },
      { id: 'a', timestamp: 3, role: 'assistant', content: 'answer' },
      { id: 'u2', timestamp: 4, role: 'user', content: 'current' },
    ];
    const result = withMcpAppModelContext(messages, {
      'app::ui://x': { content: [{ type: 'text', text: 'picked A' }] },
    });
    expect(result.map((message) => message.id)).toEqual([
      's',
      'u1',
      'a',
      'mcp-app-model-context',
      'u2',
    ]);
    expect(messages.map((message) => message.id)).toEqual(['s', 'u1', 'a', 'u2']);
  });

  it('returns the original wire array when there is no app context', () => {
    const messages: FlujoChatMessage[] = [
      { id: 'u', timestamp: 1, role: 'user', content: 'hello' },
    ];
    expect(withMcpAppModelContext(messages, {})).toBe(messages);
  });
});
