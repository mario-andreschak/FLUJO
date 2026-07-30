import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from '@/utils/logger';

const log = createLogger('backend/services/mcp/internal/stdioBridge');

type BridgeRequest = {
  id: string;
  token: string;
  operation: 'listTools' | 'callTool' | 'listResources' | 'listResourceTemplates' | 'readResource';
  name?: string;
  args?: Record<string, unknown>;
  uri?: string;
};

type BridgeState = {
  endpoint: string;
  token: string;
  server?: net.Server;
  starting?: Promise<void>;
};

declare global {
  // eslint-disable-next-line no-var
  var __flujo_stdio_bridge: BridgeState | undefined;
}

function bridgeState(): BridgeState {
  if (!global.__flujo_stdio_bridge) {
    global.__flujo_stdio_bridge = {
      endpoint: process.platform === 'win32'
        ? `\\\\.\\pipe\\flujo-mcp-${process.pid}`
        : path.join(os.tmpdir(), `flujo-mcp-${process.pid}.sock`),
      token: crypto.randomBytes(32).toString('hex'),
    };
  }
  return global.__flujo_stdio_bridge;
}

async function dispatch(request: BridgeRequest): Promise<unknown> {
  const { mcpService } = await import('../index');
  switch (request.operation) {
    case 'listTools': {
      const { internalToolDefinitions } = await import('../internalTools');
      return { tools: internalToolDefinitions() };
    }
    case 'callTool': {
      const { internalCallTool } = await import('../internalTools');
      return internalCallTool(mcpService, request.name ?? '', request.args ?? {}, 'host');
    }
    case 'listResources': {
      const { internalListResources } = await import('../internalResources');
      return internalListResources();
    }
    case 'listResourceTemplates': {
      const { internalListResourceTemplates } = await import('../internalResources');
      return internalListResourceTemplates();
    }
    case 'readResource': {
      const { internalReadResource } = await import('../internalResources');
      const result = await internalReadResource(request.uri ?? '');
      if (!result.success || !result.data) throw new Error(result.error ?? 'Resource read failed');
      return result.data;
    }
  }
}

function handleSocket(socket: net.Socket, state: BridgeState): void {
  socket.setEncoding('utf8');
  let pending = '';
  socket.on('data', (chunk: string) => {
    pending += chunk;
    let newline = pending.indexOf('\n');
    while (newline >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      newline = pending.indexOf('\n');
      if (!line.trim()) continue;
      void (async () => {
        let request: BridgeRequest | undefined;
        try {
          request = JSON.parse(line) as BridgeRequest;
          if (!request || request.token !== state.token) throw new Error('Unauthorized FLUJO MCP bridge request');
          const result = await dispatch(request);
          socket.write(`${JSON.stringify({ id: request.id, result })}\n`);
        } catch (error) {
          socket.write(`${JSON.stringify({
            id: request?.id ?? '',
            error: error instanceof Error ? error.message : String(error),
          })}\n`);
        }
      })();
    }
  });
  socket.on('error', (error) => log.debug('Bridge socket error', error));
}

export async function ensureFlujoStdioBridge(): Promise<{ endpoint: string; token: string }> {
  const state = bridgeState();
  if (state.server?.listening) return { endpoint: state.endpoint, token: state.token };
  if (!state.starting) {
    state.starting = new Promise<void>((resolve, reject) => {
      if (process.platform !== 'win32') {
        try { fs.unlinkSync(state.endpoint); } catch { /* no stale socket */ }
      }
      const server = net.createServer((socket) => handleSocket(socket, state));
      state.server = server;
      server.once('error', reject);
      server.listen(state.endpoint, () => {
        server.off('error', reject);
        server.on('error', (error) => log.warn('FLUJO stdio bridge error', error));
        // The bridge is auxiliary to the backend and must not keep Node/Jest alive
        // after all MCP clients and other application work have finished.
        server.unref();
        resolve();
      });
    }).finally(() => {
      state.starting = undefined;
    });
  }
  await state.starting;
  return { endpoint: state.endpoint, token: state.token };
}

export async function closeFlujoStdioBridge(): Promise<void> {
  const state = global.__flujo_stdio_bridge;
  if (!state) return;

  // Avoid leaking a listener when shutdown races the initial listen callback.
  if (state.starting) await state.starting.catch(() => undefined);

  const server = state.server;
  state.server = undefined;
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (process.platform !== 'win32') {
    try { fs.unlinkSync(state.endpoint); } catch { /* already removed */ }
  }
  global.__flujo_stdio_bridge = undefined;
}
