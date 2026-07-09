/**
 * Unit tests for closed-connection detection (the "This operation was aborted" guard).
 *
 * Every SDK transport (streamable HTTP, SSE, stdio) creates an internal AbortController in
 * start() and aborts it in close(); HTTP transports pass its signal to every fetch, so a
 * closed transport rejects each call instantly with AbortError. isClientConnectionClosed
 * reads exactly that signal (plus the transport-detached state the SDK's own onclose leaves
 * behind), and shouldRecreateClient treats it as grounds to rebuild — BEFORE any config
 * comparison, so connectServer can never short-circuit on a corpse as "already connected".
 */

import { isClientConnectionClosed } from '@/utils/mcp/utils';
import { shouldRecreateClient } from '@/backend/services/mcp/connection';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { MCPServerConfig } from '@/shared/types/mcp';

const clientWith = (transport: unknown): Client => ({ transport } as unknown as Client);

describe('isClientConnectionClosed', () => {
  it('reports open when the transport is missing (ambiguous: never-connected looks the same)', () => {
    expect(isClientConnectionClosed(clientWith(undefined))).toBe(false);
  });

  it('reports closed when the transport abort signal has fired', () => {
    const controller = new AbortController();
    controller.abort();
    expect(isClientConnectionClosed(clientWith({ _abortController: controller }))).toBe(true);
  });

  it('reports open for a healthy transport', () => {
    expect(
      isClientConnectionClosed(clientWith({ _abortController: new AbortController() }))
    ).toBe(false);
  });

  it('reports open when the abort controller is absent (not-yet-started or future SDK shape)', () => {
    expect(isClientConnectionClosed(clientWith({}))).toBe(false);
  });
});

describe('shouldRecreateClient on a closed connection', () => {
  const config: MCPServerConfig = {
    name: 'srv',
    transport: 'stdio',
    command: 'x',
    args: [],
    env: {},
    disabled: false,
    autoApprove: [],
    rootPath: '',
    _buildCommand: '',
    _installCommand: '',
  } as MCPServerConfig;

  it('demands a new client when the existing connection is closed', () => {
    const controller = new AbortController();
    controller.abort();
    const result = shouldRecreateClient(clientWith({ _abortController: controller }), config);
    expect(result.needsNewClient).toBe(true);
    expect(result.reason).toBe('Existing connection is closed');
  });
});
