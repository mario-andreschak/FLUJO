import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

/**
 * Handle one request with a fresh stateless MCP transport.
 *
 * Next route handlers already use Web Request/Response objects, so using the
 * SDK's Web-standard transport avoids a Web -> Node -> Web conversion. Besides
 * being redundant, fetch-to-node's response bridge can emit `finish` after its
 * ReadableStream has been cancelled and throw ERR_INVALID_STATE from a late
 * controller.close() callback.
 */
export async function handleStatelessMcpRequest(server: Server, request: Request): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } finally {
    // Server owns the transport after connect(), so this is the only close call
    // needed. The Web transport guards cancellation/close races internally.
    try {
      await server.close();
    } catch {
      /* already closed */
    }
  }
}
