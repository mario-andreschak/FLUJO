/**
 * FLUJO as an MCP server — Flows-as-tools endpoint (#38, Item D / #17).
 *
 * Hosts an MCP server at `/mcp-flows` that exposes every saved FLUJO Flow as a tool,
 * so any external MCP client/host (Claude Desktop, Cursor, mcp-inspector, ...)
 * can let its LLM discover and pick the right flow autonomously — the literal
 * answer to "can the LLM pick a flow like an MCP tool?". A `tools/call` runs the
 * chosen flow through the execution keystone (`runFlow`) and returns its output.
 *
 * Inbound transport: the official `StreamableHTTPServerTransport` in STATELESS
 * mode (fresh Server+transport per request; the SDK does all protocol work). We
 * bridge Next.js's Web `Request`/`Response` to the Node `http` objects the SDK
 * transport expects via `fetch-to-node`. The tool logic lives in
 * `backend/services/mcp/flowTools.ts` so it stays transport-agnostic and testable.
 *
 * Posture (single-user/localhost): the same localhost guard as `/mcp-proxy` blocks
 * the DNS-rebinding vector; no bearer token in v1.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { toReqRes, toFetchResponse } from 'fetch-to-node';
import { isLocalRequest } from '@/backend/services/mcp/proxyForward';
import { flowToolsListTools, flowToolsCallTool } from '@/backend/services/mcp/flowTools';
import { createLogger } from '@/utils/logger';

// The SDK transport + fetch-to-node need Node APIs — never the edge runtime.
export const runtime = 'nodejs';

const log = createLogger('app/mcp-flows/route');
const SERVER_VERSION = '3.11.0';

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function buildFlowsServer(): Server {
  const server = new Server(
    { name: 'flujo-flows', version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => flowToolsListTools());
  server.setRequestHandler(CallToolRequestSchema, (req) =>
    flowToolsCallTool(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>),
  );
  return server;
}

async function handle(request: Request): Promise<Response> {
  // Localhost-only posture (blocks DNS-rebinding) — v1 single-user.
  if (!isLocalRequest(request.headers.get('host'), request.headers.get('origin'))) {
    log.warn('Rejected non-local request', { host: request.headers.get('host') });
    return jsonError(403, 'Forbidden: this endpoint only accepts local requests.');
  }

  const server = buildFlowsServer();
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
    log.error('Flows MCP request failed', { error });
    return jsonError(500, 'Internal MCP server error.');
  } finally {
    // Close once, here — NOT on a res 'close' listener (see the /mcp-proxy route
    // for the "Controller is already closed" rationale). For stateless JSON the
    // body is buffered by now; swallow benign already-closed errors.
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

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

export async function DELETE(request: Request): Promise<Response> {
  return handle(request);
}
