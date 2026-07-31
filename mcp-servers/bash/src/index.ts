#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { configureRootsProvider } from '@flujo-ai/mcp-shared';
import { bashCallTool, bashToolDefinitions, shutdownBashSessions } from './tools.js';
import { bashListResources, bashReadResource, isBashAppUri } from './resources.js';

export * from './tools.js';
export * from './resources.js';

const server = new Server(
  { name: '@mario.andreschak/mcp-bash', version: '0.1.0' },
  {
    capabilities: {
      tools: {},
      resources: {},
      extensions: {
        'io.modelcontextprotocol/ui': {
          mimeTypes: ['text/html;profile=mcp-app'],
        },
      },
    },
  },
);

configureRootsProvider(async () => (await server.listRoots()).roots);

function flujoMetaOf(meta: unknown): { callerNodeId?: string; ownerScope?: string } {
  if (!meta || typeof meta !== 'object') return {};
  const flujo = (meta as Record<string, unknown>).flujo;
  if (!flujo || typeof flujo !== 'object') return {};
  const values = flujo as Record<string, unknown>;
  const callerNodeId = typeof values.callerNodeId === 'string' && values.callerNodeId.length > 0
    ? values.callerNodeId
    : undefined;
  const ownerScope = typeof values.ownerScope === 'string' && values.ownerScope.length > 0
    ? values.ownerScope
    : undefined;
  return { callerNodeId, ownerScope };
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: bashToolDefinitions() }));
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const meta = flujoMetaOf(request.params._meta);
  const progressToken = request.params._meta?.progressToken;
  return bashCallTool(
    request.params.name,
    request.params.arguments ?? {},
    meta.callerNodeId,
    meta.ownerScope,
    {
      signal: extra.signal,
      ...(progressToken !== undefined
        ? {
            onProgress: async (progress) => {
              await server.notification(
                {
                  method: 'notifications/progress',
                  params: { progressToken, ...progress },
                },
                { relatedRequestId: extra.requestId },
              );
            },
          }
        : {}),
    },
  );
});
server.setRequestHandler(ListResourcesRequestSchema, async () => bashListResources());
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;
  const result = isBashAppUri(uri)
    ? bashReadResource(uri)
    : { success: false, error: `Unknown Bash resource: ${uri}`, statusCode: 404 };
  if (!result.success || !result.data) {
    throw new Error(result.error ?? `Could not read ${uri}`);
  }
  return result.data;
});

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
  process.stderr.write(`@mario.andreschak/mcp-bash failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
