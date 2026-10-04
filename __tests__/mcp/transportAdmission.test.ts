import { isMcpTransport, storedMcpTransport, MCP_TRANSPORT_INVALID } from '@/backend/services/mcp/transportAdmission';

describe('MCP transport admission', () => {
  it.each(['stdio', 'streamable', 'sse', 'websocket'])('admits the exact %s tag', (tag) => {
    expect(isMcpTransport(tag)).toBe(true);
    expect(storedMcpTransport(tag)).toBe(tag);
  });

  it('canonicalizes only a missing persisted tag', () => {
    expect(storedMcpTransport(undefined)).toBe('stdio');
    expect(isMcpTransport(undefined)).toBe(false);
  });

  it.each([null, false, 0, '', 'STDIO', ' stdio', 'unknown-secret', {}, ['stdio']])(
    'refuses explicit malformed tag %p', (tag) => {
      expect(isMcpTransport(tag)).toBe(false);
      expect(() => storedMcpTransport(tag)).toThrow(MCP_TRANSPORT_INVALID);
    },
  );
});
