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
/**
 * Idempotent shutdown (issue #413).
 *
 * Every way this process can be told to stop must land here, because the ONLY
 * thing that kills a live session's descendant tree is `shutdownBashSessions()`.
 * The critical addition is stdin EOF: the MCP stdio convention is that the host
 * closes stdin to request shutdown, and a host that then exits (or is killed)
 * never sends a signal at all. Without an EOF path this server — and every
 * background command and PTY it had spawned — survived its own host.
 */
async function shutdown(reason: string): Promise<void> {
  if (closing) return;
  closing = true;
  process.stderr.write(`@mario.andreschak/mcp-bash shutting down (${reason})\n`);
  // Stop accepting new work BEFORE tearing anything down, so a request that
  // arrives mid-shutdown cannot start a process nothing will ever kill.
  configureRootsProvider(undefined);
  shutdownBashSessions();
  await server.close().catch(() => undefined);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGHUP', () => void shutdown('SIGHUP'));
// stdio EOF: the host closed our input, so no further request can arrive.
process.stdin.once('end', () => void shutdown('stdin end'));
process.stdin.once('close', () => void shutdown('stdin close'));
// Transport close covers the SDK-side teardown (host closed the session). This
// must hook the SERVER's callback, not the transport's: Protocol.connect()
// installs its own transport.onclose, so assigning that directly would be
// silently overwritten by server.connect() below.
server.onclose = () => void shutdown('transport close');

server.connect(transport).catch((error) => {
  shutdownBashSessions();
  process.stderr.write(`@mario.andreschak/mcp-bash failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
