import { withWorkspaceRoute } from '@/app/api/_workspace';
/**
 * FLUJO as an MCP server — Flows-as-tools endpoint (#38, Item D / #17).
 *
 * Hosts an MCP server at `/mcp-flows` that exposes every saved FLUJO Flow as a tool,
 * so any external MCP client/host (Claude Desktop, Cursor, mcp-inspector, ...)
 * can let its LLM discover and pick the right flow autonomously — the literal
 * answer to "can the LLM pick a flow like an MCP tool?". A `tools/call` runs the
 * chosen flow through the execution keystone (`runFlow`) and returns its output.
 *
 * Inbound transport: the official Web-standard streamable HTTP transport in
 * STATELESS mode (fresh Server+transport per request; the SDK does all protocol
 * work directly with Next.js's Web `Request`/`Response`). The tool logic lives in
 * `backend/services/mcp/flowTools.ts` so it stays transport-agnostic and testable.
 *
 * The route wrapper enforces the configured owner policy. The localhost guard
 * also blocks DNS rebinding; durable Tasks require an explicit owner bearer.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { isLocalRequest } from '@/backend/services/mcp/proxyForward';
import { flowToolsListTools, flowToolsCallTool } from '@/backend/services/mcp/flowTools';
import { handleStatelessMcpRequest } from '@/backend/services/mcp/statelessHttpTransport';
import {
  authoringToolDefinitions,
  authoringCallTool,
  isAuthoringTool,
} from '@/backend/services/mcp/flowAuthoringTools';
import { createLogger } from '@/utils/logger';
import { mcpTasksServerEnabled } from '@/backend/services/mcp/tasksProtocol';
import { handleModernFlowsMcpRequest, isLegacyFlowsMcpRequest } from '@/backend/services/mcp/flowsTasksServer';

// Flow execution and MCP services use Node APIs — never the edge runtime.
export const runtime = 'nodejs';

const log = createLogger('app/mcp-flows/route');
const SERVER_VERSION = '3.46.3';

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Bound the public SDK's body-primary era probe before it clones/parses JSON. */
async function classificationBodyFits(request: Request): Promise<boolean> {
  const limit = 256 * 1024;
  const length = request.headers.get('content-length');
  if (length && Number(length) > limit) return false;
  if (!request.body) return true;
  const reader = request.clone().body!.getReader();
  let bytes = 0;
  try {
    while (true) {
      request.signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) return true;
      bytes += chunk.value.byteLength;
      if (bytes > limit) {
        // Cancelling one tee branch alone waits for the other. Retire both,
        // without delaying the rejection on an uncooperative source stream.
        void reader.cancel().catch(() => undefined);
        void request.body.cancel().catch(() => undefined);
        return false;
      }
    }
  } finally { reader.releaseLock(); }
}

// MCP 2026-07-28 note: the new spec introduces `Mcp-Method` and `Mcp-Name` HTTP request
// headers as advisory routing hints for load balancers and intermediate proxies. FLUJO
// re-terminates every inbound MCP request (a fresh `Server` + Web-standard transport
// is created per HTTP request), so routing is already handled by the URL path (`/mcp-flows`).
// The `Mcp-Method`/`Mcp-Name` headers are safely ignored by the v1
// transport; no implementation is needed here.
function buildFlowsServer(): Server {
  const server = new Server(
    { name: 'flujo-flows', version: SERVER_VERSION },
    // The retained legacy protocol is synchronous. Only the separate modern,
    // explicitly enabled owner-authorized handler can advertise durable Tasks.
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Authoring tools (create_flow / validate_flow_spec / list_flow_building_blocks)
    // are listed alongside flows-as-tools. Their names are reserved: a flow whose
    // slug collides is shadowed (with a warning) rather than breaking dispatch.
    const authoring = authoringToolDefinitions();
    const { tools } = await flowToolsListTools();
    const flowTools = tools.filter((t) => {
      if (isAuthoringTool(t.name)) {
        log.warn(`Flow tool '${t.name}' collides with a reserved authoring tool name; shadowed`, {});
        return false;
      }
      return true;
    });
    return { tools: [...authoring, ...flowTools] };
  });
  server.setRequestHandler(CallToolRequestSchema, (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    if (isAuthoringTool(req.params.name)) {
      return authoringCallTool(req.params.name, args);
    }
    return flowToolsCallTool(req.params.name, args);
  });
  return server;
}

async function handle(request: Request): Promise<Response> {
  // Localhost-only posture (blocks DNS-rebinding) — v1 single-user.
  if (!isLocalRequest(request.headers.get('host'), request.headers.get('origin'))) {
    log.warn('Rejected non-local request', { host: request.headers.get('host') });
    return jsonError(403, 'Forbidden: this endpoint only accepts local requests.');
  }

  if (mcpTasksServerEnabled()) {
    if (!await classificationBodyFits(request)) return jsonError(413, 'MCP request body exceeds the limit.');
    if (!await isLegacyFlowsMcpRequest(request)) return handleModernFlowsMcpRequest(request);
  }

  const server = buildFlowsServer();

  try {
    return await handleStatelessMcpRequest(server, request);
  } catch (error) {
    log.error('Flows MCP request failed', { error });
    return jsonError(500, 'Internal MCP server error.');
  }
}

async function POST_handler(request: Request): Promise<Response> {
  return handle(request);
}

async function GET_handler(request: Request): Promise<Response> {
  return handle(request);
}

async function DELETE_handler(request: Request): Promise<Response> {
  return handle(request);
}

export const GET = withWorkspaceRoute(GET_handler);
export const POST = withWorkspaceRoute(POST_handler);
export const DELETE = withWorkspaceRoute(DELETE_handler);
