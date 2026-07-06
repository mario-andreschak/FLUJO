/**
 * Regression test for issue #47 (symptom 2): a PAT / Bearer-token / header change on an
 * HTTP (streamable or SSE) MCP server must rebuild the client, even though the URL is
 * unchanged.
 *
 * Before the fix, shouldRecreateClient compared ONLY the serverUrl for HTTP transports, so
 * updating a server's Authorization header (same URL) was not detected: connectServer
 * short-circuited as "already connected" and kept talking to the stale-token client. That
 * is exactly why a PAT update verified fine in the Tool Tester / a manual chat run (a fresh
 * client in the acting instance) yet the planned execution still failed with `unauthorized`.
 *
 * The fix stashes an httpConfigKey (transport + url + auth/session material) on the transport
 * at creation time and compares it raw-to-raw in shouldRecreateClient. This test drives the
 * REAL connection module (no mocks) so it actually exercises that comparison.
 */
import { createNewClient, createTransport, shouldRecreateClient } from '@/backend/services/mcp/connection';
import type { MCPServerConfig } from '@/shared/types/mcp';

/** Build a live-ish client whose transport was created from `config`, as connectServer does. */
function clientFor(config: MCPServerConfig) {
  const client = createNewClient(config);
  const transport = createTransport(config);
  // Client.transport is a getter over the protected _transport field; connect() would set
  // it in production. Assign it directly so shouldRecreateClient sees the keyed transport.
  (client as unknown as { _transport: unknown })._transport = transport;
  return client;
}

const streamable = (auth: string): MCPServerConfig => ({
  name: 'gh',
  transport: 'streamable',
  serverUrl: 'https://api.example.com/mcp',
  headers: { Authorization: `Bearer ${auth}` },
  disabled: false,
} as unknown as MCPServerConfig);

const sse = (auth: string): MCPServerConfig => ({
  name: 'gh',
  transport: 'sse',
  serverUrl: 'https://api.example.com/sse',
  headers: { Authorization: `Bearer ${auth}` },
  disabled: false,
} as unknown as MCPServerConfig);

describe('shouldRecreateClient — HTTP auth-material change detection (issue #47)', () => {
  it('does NOT rebuild a streamable client when the config is byte-identical', () => {
    const config = streamable('TOKEN_OLD');
    const client = clientFor(config);

    const result = shouldRecreateClient(client, streamable('TOKEN_OLD'));

    expect(result.needsNewClient).toBe(false);
  });

  it('rebuilds a streamable client when only the PAT / Bearer token changed (same URL)', () => {
    const client = clientFor(streamable('TOKEN_OLD'));

    const result = shouldRecreateClient(client, streamable('TOKEN_NEW'));

    expect(result.needsNewClient).toBe(true);
    expect(result.reason).toMatch(/auth|parameters/i);
  });

  it('rebuilds an SSE client when only the PAT / Bearer token changed (same URL)', () => {
    const client = clientFor(sse('TOKEN_OLD'));

    const result = shouldRecreateClient(client, sse('TOKEN_NEW'));

    expect(result.needsNewClient).toBe(true);
    expect(result.reason).toMatch(/auth|parameters/i);
  });

  it('does NOT rebuild an SSE client when the config is byte-identical', () => {
    const client = clientFor(sse('TOKEN_OLD'));

    const result = shouldRecreateClient(client, sse('TOKEN_OLD'));

    expect(result.needsNewClient).toBe(false);
  });
});
