#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { browserCallTool, browserToolDefinitions } from './tools.js';
import { browserListResources, browserReadResource } from './resources.js';
import { shutdownBrowserRuntime } from './runtime.js';

export * from './tools.js';
export * from './resources.js';
export * from './runtime.js';

const server = new Server(
  { name: '@mario.andreschak/mcp-browser', version: '3.38.0' },
  { capabilities: { tools: {}, resources: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: browserToolDefinitions() }));
server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
  browserCallTool(request.params.name, request.params.arguments ?? {}, extra.signal),
);
server.setRequestHandler(ListResourcesRequestSchema, async () => browserListResources());
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));
server.setRequestHandler(ReadResourceRequestSchema, async (request) => browserReadResource(request.params.uri));

const transport = new StdioServerTransport();
let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await shutdownBrowserRuntime();
  await server.close().catch(() => undefined);
}
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
process.once('SIGHUP', () => void shutdown());
process.once('beforeExit', () => void shutdownBrowserRuntime());

server.connect(transport).catch((error) => {
  process.stderr.write(`@mario.andreschak/mcp-browser failed: ${error instanceof Error ? error.name : 'unknown error'}\n`);
  process.exitCode = 1;
});
