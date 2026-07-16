/**
 * FLUJO as an MCP server — per-server proxy endpoint (#17A).
 *
 * Hosts an MCP server at `/mcp-proxy/<server>` that re-exposes a single
 * downstream MCP server's tools to external MCP clients (Claude Desktop, Cursor,
 * mcp-inspector, ...). One downstream server per path → no name collisions, so
 * tool names pass through unchanged.
 *
 * Inbound transport: the official `StreamableHTTPServerTransport` in STATELESS
 * mode (fresh Server+transport per request; the SDK does all protocol work). We
 * bridge Next.js's Web `Request`/`Response` to the Node `http` objects the SDK
 * transport expects via `fetch-to-node`. The actual forwarding lives in
 * `proxyForward.ts` so it stays transport-agnostic and testable.
 *
 * Posture (single-user/localhost): a localhost guard blocks the DNS-rebinding
 * vector; no bearer token in v1 (see the design plan / future security pass).
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { toReqRes, toFetchResponse } from 'fetch-to-node';
import {
  isServerExposed,
  isLocalRequest,
  proxyListTools,
  proxyCallTool,
} from '@/backend/services/mcp/proxyForward';
import { createLogger } from '@/utils/logger';

// The SDK transport + fetch-to-node need Node APIs — never the edge runtime.
export const runtime = 'nodejs';

const log = createLogger('app/mcp-proxy/[server]/route');
const PROXY_VERSION = '3.19.0';

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function buildProxyServer(serverName: string): Server {
  const server = new Server(
    { name: `flujo-proxy-${serverName}`, version: PROXY_VERSION },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => proxyListTools(serverName));
  server.setRequestHandler(CallToolRequestSchema, (req) =>
    proxyCallTool(serverName, req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>),
  );
  return server;
}

async function handle(request: Request, serverName: string): Promise<Response> {
  // Localhost-only posture (blocks DNS-rebinding) — v1 single-user.
  if (!isLocalRequest(request.headers.get('host'), request.headers.get('origin'))) {
    log.warn('Rejected non-local request', { serverName, host: request.headers.get('host') });
    return jsonError(403, 'Forbidden: this endpoint only accepts local requests.');
  }

  // Opt-in gate: unknown and not-exposed servers look identical (404).
  if (!(await isServerExposed(serverName))) {
    return jsonError(404, `MCP server '${serverName}' is not found or not exposed.`);
  }

  const server = buildProxyServer(serverName);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless: no session validation, fresh per request
    enableJsonResponse: true,
  });

  const { req, res } = toReqRes(request);

  try {
    await server.connect(transport);
    // Let the transport read & parse the body from the (fetch-to-node) Node stream.
    // Do NOT call request.json() here: that locks the same body ReadableStream that
    // `req` streams from, causing "Invalid state: ReadableStream is locked".
    await transport.handleRequest(req, res);
    return await toFetchResponse(res);
  } catch (error) {
    log.error('Proxy request failed', { serverName, error });
    return jsonError(500, 'Internal proxy error.');
  } finally {
    // Close once, here — NOT on a res 'close' listener. By the time the synthetic
    // fetch-to-node response has been turned into a Response, its controller is
    // already finalized, so a late transport.close() double-closes it and throws
    // "Controller is already closed" as an UNCAUGHT exception. Swallow the benign
    // already-closed errors; for stateless JSON the body is buffered by now.
    try {
      await transport.close();
    } catch {
      /* already closed */
    }
    try {
      await server.close();
    } catch {
      /* already closed */
    }
  }
}

interface RouteCtx {
  params: Promise<{ server: string }>;
}

export async function POST(request: Request, ctx: RouteCtx): Promise<Response> {
  return handle(request, (await ctx.params).server);
}

export async function GET(request: Request, ctx: RouteCtx): Promise<Response> {
  return handle(request, (await ctx.params).server);
}

export async function DELETE(request: Request, ctx: RouteCtx): Promise<Response> {
  return handle(request, (await ctx.params).server);
}
