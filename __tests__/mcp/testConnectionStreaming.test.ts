/**
 * Regression test for MCPService.testConnection live-output streaming (issue #64).
 *
 * testConnection now accepts an optional `onOutput` sink. When attached it must:
 *   - forward the child's stderr chunks AS THEY ARRIVE (not buffered to the end),
 *   - emit lifecycle `status` markers around spawn / handshake / list-tools,
 *   - emit a terminal `result` event mirroring the returned value,
 * and when the sink is omitted, behave exactly as before (return the same object).
 */

import { EventEmitter } from 'events';
import type { CommandStreamEvent } from '@/shared/types/streaming';

// A stdio transport stand-in that is an `instanceof` the (mocked) StdioClientTransport,
// so testConnection's `transport instanceof StdioClientTransport` stderr branch runs.
jest.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
  class StdioClientTransport {
    public stderr = new EventEmitter();
    public onerror: ((err: Error) => void) | undefined;
  }
  return { StdioClientTransport };
});

// Websocket transport is imported at module load; give it a harmless stub.
jest.mock('@modelcontextprotocol/sdk/client/websocket.js', () => ({
  WebSocketClientTransport: class {},
}));

jest.mock('@/backend/utils/resolveGlobalVars', () => ({
  resolveGlobalVars: jest.fn(async (v: unknown) => v),
}));

jest.mock('@/backend/services/mcp/config', () => ({
  loadServerConfigs: jest.fn(async () => []),
  saveConfig: jest.fn(async () => ({ success: true })),
}));

// createTransport returns a fresh (mocked) StdioClientTransport instance; the fake
// client emits a stderr chunk on that transport during connect().
jest.mock('@/backend/services/mcp/connection', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  return {
    createNewClient: jest.fn(),
    createTransport: jest.fn(() => new StdioClientTransport()),
    resolveConfigHeaders: jest.fn(async (config: unknown) => config),
    safelyCloseClient: jest.fn(async () => undefined),
    shouldRecreateClient: jest.fn(() => ({ needsNewClient: false })),
  };
});

import { MCPService } from '@/backend/services/mcp';
import * as connection from '@/backend/services/mcp/connection';
import type { MCPServerConfig } from '@/shared/types/mcp';

const stdioConfig = {
  name: 'probe',
  transport: 'stdio' as const,
  command: 'node',
  args: ['server.js'],
  env: {},
  disabled: false,
} as unknown as MCPServerConfig;

function armClient(opts: { fail?: boolean; toolCount?: number } = {}) {
  const client = {
    // On connect, the server writes a diagnostic line to stderr, then the handshake
    // resolves (or rejects to exercise the failure path).
    connect: jest.fn(async (transport: { stderr: EventEmitter }) => {
      transport.stderr.emit('data', Buffer.from('server: listening on stdio\n'));
      if (opts.fail) throw new Error('handshake refused');
    }),
    listTools: jest.fn(async () => ({
      tools: Array.from({ length: opts.toolCount ?? 0 }, (_, i) => ({ name: `t${i}` })),
    })),
    close: jest.fn(async () => undefined),
  };
  (connection.createNewClient as jest.Mock).mockReturnValue(client);
  return client;
}

describe('MCPService.testConnection streaming (onOutput)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('forwards stderr live and emits ordered status + result events on success', async () => {
    armClient({ toolCount: 2 });
    const events: CommandStreamEvent[] = [];

    const result = await new MCPService().testConnection(stdioConfig, (e) => events.push(e));

    expect(result).toEqual({ success: true, data: { toolCount: 2 } });

    // stderr chunk was forwarded verbatim.
    expect(events).toContainEqual({ type: 'stderr', data: 'server: listening on stdio\n' });

    // Lifecycle phases appear in order.
    const phases = events.filter((e) => e.type === 'status').map((e: any) => e.phase);
    expect(phases).toEqual(['spawning', 'handshaking', 'listing-tools']);

    // Exactly one terminal result mirroring the returned value, and it is last.
    const results = events.filter((e) => e.type === 'result');
    expect(results).toEqual([{ type: 'result', success: true, data: { toolCount: 2 } }]);
    expect(events[events.length - 1]).toEqual({ type: 'result', success: true, data: { toolCount: 2 } });
  });

  it('emits a failure result (still after forwarding stderr) when the handshake fails', async () => {
    armClient({ fail: true });
    const events: CommandStreamEvent[] = [];

    const result = await new MCPService().testConnection(stdioConfig, (e) => events.push(e));

    expect(result.success).toBe(false);
    expect(events).toContainEqual({ type: 'stderr', data: 'server: listening on stdio\n' });
    const last = events[events.length - 1] as any;
    expect(last.type).toBe('result');
    expect(last.success).toBe(false);
  });

  it('behaves identically (no throw) when no sink is provided', async () => {
    armClient({ toolCount: 1 });
    const result = await new MCPService().testConnection(stdioConfig);
    expect(result).toEqual({ success: true, data: { toolCount: 1 } });
  });
});
