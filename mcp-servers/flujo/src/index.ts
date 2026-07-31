#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
  type ListResourceTemplatesResult,
  type ListResourcesResult,
  type ListToolsResult,
  type ReadResourceResult,
} from '@modelcontextprotocol/sdk/types.js';
import { flujoRequest } from './client.js';

export * from './client.js';

const server = new Server(
  { name: '@mario.andreschak/mcp-flujo', version: '0.1.0' },
  { capabilities: { tools: {}, resources: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => flujoRequest<ListToolsResult>('listTools'));
server.setRequestHandler(CallToolRequestSchema, async (request) =>
  flujoRequest<CallToolResult>('callTool', {
    name: request.params.name,
    args: request.params.arguments ?? {},
  }),
);
server.setRequestHandler(ListResourcesRequestSchema, async (request) =>
  flujoRequest<ListResourcesResult>('listResources', { cursor: request.params?.cursor }),
);
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () =>
  flujoRequest<ListResourceTemplatesResult>('listResourceTemplates'),
);
server.setRequestHandler(ReadResourceRequestSchema, async (request) =>
  flujoRequest<ReadResourceResult>('readResource', { uri: request.params.uri }),
);

const transport = new StdioServerTransport();
let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await server.close().catch(() => undefined);
}
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
process.once('SIGHUP', () => void shutdown());

server.connect(transport).catch((error) => {
  process.stderr.write(`@mario.andreschak/mcp-flujo failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
