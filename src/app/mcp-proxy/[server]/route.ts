import { withWorkspaceRoute } from '@/app/api/_workspace';
/**
 * FLUJO as an MCP server — per-server proxy endpoint (#17A).
 *
 * Hosts an MCP server at `/mcp-proxy/<server>` that re-exposes a single
 * downstream MCP server's tools to external MCP clients (Claude Desktop, Cursor,
 * mcp-inspector, ...). One downstream server per path → no name collisions, so
 * tool names pass through unchanged.
 *
 * Inbound transport: the official Web-standard streamable HTTP transport in
 * STATELESS mode (fresh Server+transport per request; the SDK does all protocol
 * work directly with Next.js's Web `Request`/`Response`). Forwarding lives in
 * `proxyForward.ts` so it stays transport-agnostic and testable.
 *
 * Posture (single-user/localhost): a localhost guard blocks the DNS-rebinding
 * vector; no bearer token in v1 (see the design plan / future security pass).
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  isServerExposed,
  isLocalRequest,
  proxyListTools,
  proxyCallTool,
  proxyListResources,
  proxyListResourceTemplates,
  proxyReadResource,
} from '@/backend/services/mcp/proxyForward';
import { handleStatelessMcpRequest } from '@/backend/services/mcp/statelessHttpTransport';
import { createLogger } from '@/utils/logger';

// Proxy forwarding and downstream MCP services use Node APIs — never the edge runtime.
export const runtime = 'nodejs';

const log = createLogger('app/mcp-proxy/[server]/route');
const PROXY_VERSION = '3.43.0';

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// MCP 2026-07-28 note: the new spec introduces `Mcp-Method` and `Mcp-Name` HTTP request
// headers as advisory routing hints for load balancers and intermediate proxies. FLUJO
// re-terminates every inbound MCP request (a fresh `Server` + Web-standard transport
// is created per HTTP request), so routing is already handled by the URL path
// (`/mcp-proxy/<server>`). The `Mcp-Method`/`Mcp-Name` headers are safely ignored by
// the v1 Web-standard transport; no implementation is needed here.
function buildProxyServer(serverName: string): Server {
  const server = new Server(
    { name: `flujo-proxy-${serverName}`, version: PROXY_VERSION },
    // The resources capability must be declared or SDK clients won't issue
    // resources/* requests at all (Tier 3: the internal "flujo" server serves
    // run-scoped resources; other exposed servers get passthrough).
    //
    // MCP Tasks (#404) is deliberately NOT advertised here: `tasks/get`,
    // `tasks/result` and `tasks/cancel` are not registered, and this endpoint
    // has no authenticated caller identity (localhost + explicit exposure are
    // an exposure boundary, NOT per-task ownership), so task lookup would be
    // reachable by task id alone. Advertising it would also claim partial
    // support. See docs/features/mcp-tasks.md ("Server-side status") and the
    // FEATURES.ENABLE_MCP_TASKS_SERVER flag.
    { capabilities: { tools: {}, resources: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => proxyListTools(serverName));
  server.setRequestHandler(CallToolRequestSchema, (req) =>
    proxyCallTool(serverName, req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>),
  );
  server.setRequestHandler(ListResourcesRequestSchema, () => proxyListResources(serverName));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, () => proxyListResourceTemplates(serverName));
  server.setRequestHandler(ReadResourceRequestSchema, (req) =>
    proxyReadResource(serverName, req.params.uri),
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

  try {
    return await handleStatelessMcpRequest(server, request);
  } catch (error) {
    log.error('Proxy request failed', { serverName, error });
    return jsonError(500, 'Internal proxy error.');
  }
}

interface RouteCtx {
  params: Promise<{ server: string }>;
}

async function POST_handler(request: Request, ctx: RouteCtx): Promise<Response> {
  return handle(request, (await ctx.params).server);
}

async function GET_handler(request: Request, ctx: RouteCtx): Promise<Response> {
  return handle(request, (await ctx.params).server);
}

async function DELETE_handler(request: Request, ctx: RouteCtx): Promise<Response> {
  return handle(request, (await ctx.params).server);
}

export const GET = withWorkspaceRoute(GET_handler);
export const POST = withWorkspaceRoute(POST_handler);
export const DELETE = withWorkspaceRoute(DELETE_handler);
