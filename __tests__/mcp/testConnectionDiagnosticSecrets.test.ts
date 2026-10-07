import { EventEmitter } from 'events';
import type { MCPServerConfig } from '@/shared/types/mcp/mcp';
import type { CommandStreamEvent } from '@/shared/types/streaming';

jest.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class { stderr = new EventEmitter(); onerror?: (error: Error) => void; },
}));
jest.mock('@modelcontextprotocol/sdk/client/websocket.js', () => ({ WebSocketClientTransport: class {} }));
jest.mock('@/backend/utils/resolveGlobalVars', () => ({ resolveGlobalVars: jest.fn(async (value) => value) }));
jest.mock('@/backend/services/mcp/config', () => ({ loadServerConfigs: jest.fn(async () => []), saveConfig: jest.fn() }));
jest.mock('@/utils/mcp/oauthProbe', () => ({ probeOAuthSupport: jest.fn(async () => ({ oauthCapable: true })) }));
jest.mock('@/backend/services/mcp/connection', () => {
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  return {
    createNewClient: jest.fn(), createTransport: jest.fn(() => new StdioClientTransport()),
    resolveConfigHeaders: jest.fn(), safelyCloseClient: jest.fn(async () => undefined),
    shouldRecreateClient: jest.fn(() => ({ needsNewClient: false })),
  };
});

import { MCPService } from '@/backend/services/mcp';
import * as connection from '@/backend/services/mcp/connection';
import * as configStore from '@/backend/services/mcp/config';

const token = 'synthetic-opaque-diagnostic-credential';
const stdio = {
  name: 'probe', transport: 'stdio', command: 'node', args: ['synthetic.js'], disabled: false,
  env: { CUSTOM: { value: '${global:CUSTOM}', metadata: { isSecret: true } } },
} as unknown as MCPServerConfig;
const remote = {
  name: 'probe', transport: 'streamable', serverUrl: 'https://synthetic.invalid/mcp', disabled: false,
  env: {}, headers: { Authorization: { value: '********', metadata: { isSecret: true } } },
} as unknown as MCPServerConfig;

function clientFor(connect: (transport: any) => Promise<void>) {
  (connection.createNewClient as jest.Mock).mockReturnValue({
    connect: jest.fn(connect), listTools: jest.fn(async () => ({ tools: [] })), close: jest.fn(),
  });
}
beforeEach(() => {
  jest.clearAllMocks();
  (configStore.loadServerConfigs as jest.Mock).mockResolvedValue([]);
  (connection.resolveConfigHeaders as jest.Mock).mockImplementation(async (config) => ({
    ...config, env: { CUSTOM: token }, headers: { Authorization: `Bearer ${token}` },
  }));
});

it('redacts byte-split stdio credentials in live output and failure result', async () => {
  const events: CommandStreamEvent[] = [];
  clientFor(async (transport) => {
    transport.stderr.emit('data', Buffer.from('server: ready\n'));
    expect(events).toContainEqual({ type: 'stderr', data: 'server: ready\n' });
    for (const byte of Buffer.from(`HTTP 401 ${token}\n`)) transport.stderr.emit('data', Buffer.from([byte]));
    throw Object.assign(new Error(`HTTP 401 ${token}`), { code: 401 });
  });
  const result = await new MCPService().testConnection(stdio, (event) => events.push(event));
  expect(result.requiresAuthentication).toBe(true);
  expect(result.error).toContain('HTTP 401 [REDACTED]');
  expect(JSON.stringify({ result, events })).not.toContain(token);
  expect(events.at(-1)).toMatchObject({ type: 'result', success: false, error: result.error });
});

it('redacts a hydrated saved header and cause chain while preserving OAuth and TLS guidance', async () => {
  (configStore.loadServerConfigs as jest.Mock).mockResolvedValue([{
    ...remote, headers: { Authorization: { value: 'saved-ciphertext', metadata: { isSecret: true } } },
  }]);
  clientFor(async (transport) => {
    const cause = Object.assign(new Error(`certificate ${token}`), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' });
    const error = Object.assign(new Error(`HTTP 401 ${token}`, { cause }), { code: 401 });
    transport.onerror(error);
    throw error;
  });
  const events: CommandStreamEvent[] = [];
  const result = await new MCPService().testConnection(remote, (event) => events.push(event));
  expect(result.requiresAuthentication).toBe(true);
  expect(result.oauthCapable).toBe(true);
  expect(result.error).toContain('TLS certificate trust problem');
  expect(result.error).toContain('NODE_EXTRA_CA_CERTS');
  expect(JSON.stringify({ result, events })).not.toContain(token);
  expect(connection.resolveConfigHeaders).toHaveBeenCalledWith(expect.objectContaining({
    headers: { Authorization: { value: 'saved-ciphertext', metadata: { isSecret: true } } },
  }));
});

it('flushes a truncated credential prefix before the success result and ignores late stderr', async () => {
  let usedTransport: any;
  clientFor(async (transport) => {
    usedTransport = transport;
    transport.stderr.emit('data', Buffer.from(`probe ${token.slice(0, 12)}`));
  });
  const events: CommandStreamEvent[] = [];
  const result = await new MCPService().testConnection(stdio, (event) => events.push(event));
  expect(result.success).toBe(true);
  expect(events.filter((event) => event.type === 'stderr').map((event: any) => event.data).join('')).toBe('probe [REDACTED]');
  const count = events.length;
  usedTransport.stderr.emit('data', Buffer.from(token));
  expect(events).toHaveLength(count);
  expect(events.at(-1)).toMatchObject({ type: 'result', success: true });
});

it('decodes split UTF-8 bytes before secret matching', async () => {
  const unicodeToken = 'synthetic-秘密-credential';
  (connection.resolveConfigHeaders as jest.Mock).mockResolvedValue({ ...stdio, env: { CUSTOM: unicodeToken } });
  clientFor(async (transport) => {
    for (const byte of Buffer.from(`rejected ${unicodeToken}\n`)) transport.stderr.emit('data', Buffer.from([byte]));
    throw new Error('handshake refused');
  });
  const result = await new MCPService().testConnection(stdio);
  expect(result.error).toBe('rejected [REDACTED]');
});
