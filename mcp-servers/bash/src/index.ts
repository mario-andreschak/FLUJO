#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { configureRootsProvider } from '@flujo-ai/mcp-shared';
import { bashCallTool, bashToolDefinitions, shutdownBashSessions } from './tools.js';

export * from './tools.js';

const server = new Server(
  { name: '@flujo-ai/mcp-bash', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

configureRootsProvider(async () => (await server.listRoots()).roots);
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: bashToolDefinitions() }));
server.setRequestHandler(CallToolRequestSchema, async (request) =>
  bashCallTool(request.params.name, request.params.arguments ?? {}),
);

const transport = new StdioServerTransport();
let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  shutdownBashSessions();
  configureRootsProvider(undefined);
  await server.close().catch(() => undefined);
}
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
process.once('SIGHUP', () => void shutdown());

server.connect(transport).catch((error) => {
  shutdownBashSessions();
  process.stderr.write(`@flujo-ai/mcp-bash failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
