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
import {
  filesystemCallTool,
  filesystemToolDefinitions,
  shutdownFilesystemSearches,
} from './tools.js';
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
  { name: '@mario.andreschak/mcp-filesystem', version: '0.1.0' },
  { capabilities: { tools: {}, resources: {} } },
);

configureRootsProvider(async () => (await server.listRoots()).roots);

function callerNodeIdOf(meta: unknown): string | undefined {
  if (!meta || typeof meta !== 'object') return undefined;
  const flujo = (meta as Record<string, unknown>).flujo;
  if (!flujo || typeof flujo !== 'object') return undefined;
  const callerNodeId = (flujo as Record<string, unknown>).callerNodeId;
  return typeof callerNodeId === 'string' && callerNodeId.length > 0
    ? callerNodeId
    : undefined;
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: filesystemToolDefinitions(),
}));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
  filesystemCallTool(
    request.params.name,
    request.params.arguments ?? {},
    callerNodeIdOf(request.params._meta),
    extra.signal,
  ),
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
  shutdownFilesystemSearches();
  await server.close().catch(() => undefined);
}
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
process.once('SIGHUP', () => void shutdown());
process.stdin.once('end', () => void shutdown());
process.stdin.once('close', () => void shutdown());
server.onclose = () => void shutdown();

server.connect(transport).catch((error) => {
  shutdownFilesystemSearches();
  process.stderr.write(`@mario.andreschak/mcp-filesystem failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
