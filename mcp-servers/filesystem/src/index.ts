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
import { configureRootsProvider } from '@flujo-ai/mcp-shared';
import { filesystemCallTool, filesystemToolDefinitions } from './tools.js';
import {
  filesystemListResources,
  filesystemReadResource,
  isFilesystemAppUri,
  isTouchedFileUri,
  readTouchedFileResource,
} from './resources.js';

export * from './tools.js';
export * from './resources.js';

const server = new Server(
  { name: '@flujo-ai/mcp-filesystem', version: '0.1.0' },
  { capabilities: { tools: {}, resources: {} } },
);

configureRootsProvider(async () => (await server.listRoots()).roots);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: filesystemToolDefinitions(),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) =>
  filesystemCallTool(request.params.name, request.params.arguments ?? {}),
);

server.setRequestHandler(ListResourcesRequestSchema, async () => filesystemListResources());
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;
  const result = isFilesystemAppUri(uri)
    ? filesystemReadResource(uri)
    : isTouchedFileUri(uri)
      ? await readTouchedFileResource(uri)
      : { success: false, error: `Unknown filesystem resource: ${uri}`, statusCode: 404 };
  if (!result.success || !result.data) throw new Error(result.error ?? `Could not read ${uri}`);
  return result.data;
});

const transport = new StdioServerTransport();
let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  configureRootsProvider(undefined);
  await server.close().catch(() => undefined);
}
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
process.once('SIGHUP', () => void shutdown());

server.connect(transport).catch((error) => {
  process.stderr.write(`@flujo-ai/mcp-filesystem failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
