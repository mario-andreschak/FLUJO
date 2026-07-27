import http from 'http';
import { randomBytes } from 'crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createLogger } from '@/utils/logger';

const log = createLogger('backend/services/model/adapters/codexToolBridge');

/**
 * One tool exposed to Codex through the bridge. `inputSchema` is the tool's
 * JSON Schema (OpenAI `function.parameters` passes through unchanged — MCP
 * speaks raw JSON Schema, so unlike the Claude Agent SDK path no Zod
 * translation is needed and composed/ref schemas survive intact).
 */
export interface BridgeTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown> | undefined;
  handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
}

export interface CodexToolBridge {
  /** Streamable-HTTP MCP endpoint URL for the codex subprocess. */
  url: string;
  close(): Promise<void>;
}

/**
 * Ephemeral per-run MCP server for the Codex adapter.
 *
 * The Codex SDK — unlike the Claude Agent SDK — has no in-process MCP server
 * seam: the `codex` CLI only reaches tools over stdio or streamable HTTP. So
 * for the duration of ONE createCompletion call we host the node's bound FLUJO
 * tools on a loopback HTTP server (random OS-assigned port + random URL token)
 * and hand the URL to the CLI via `mcp_servers.<name>.url`. The handlers close
 * over the adapter's dispatch/approval/recording logic, so every tool call
 * still executes AND is observed inside FLUJO, exactly like the Claude path.
 *
 * Security posture mirrors /mcp-proxy: bound to 127.0.0.1 only; the
 * unguessable token (128-bit) scopes the endpoint to this run so another local
 * process can't stumble into a different conversation's tools.
 */
export async function startCodexToolBridge(tools: BridgeTool[]): Promise<CodexToolBridge> {
  const token = randomBytes(16).toString('hex');
  const path = `/mcp/${token}`;

  const buildServer = (): Server => {
    const server = new Server(
      { name: 'flujo', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map(t => ({
        name: t.name,
        description: t.description,
        // MCP requires an object schema; parameter-less tools get the minimal one.
        inputSchema: (t.inputSchema ?? { type: 'object', properties: {} }) as { type: 'object' },
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
      const tool = tools.find(t => t.name === req.params.name);
      if (!tool) {
        return { content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }], isError: true };
      }
      try {
        return await tool.handler((req.params.arguments ?? {}) as Record<string, unknown>);
      } catch (err) {
        // Surface handler failures as tool errors instead of a JSON-RPC fault,
        // so the model can react to them like any other failed call.
        return {
          content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    });
    return server;
  };

  const httpServer = http.createServer(async (req, res) => {
    // Token gate: everything else 404s indistinguishably.
    if (!req.url || !req.url.startsWith(path)) {
      res.writeHead(404).end();
      return;
    }
    // Stateless MCP per request (same pattern as /mcp-proxy): a fresh
    // Server+transport pair, torn down when the response settles.
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      log.error('Codex tool-bridge request failed', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal bridge error.' }));
      }
    } finally {
      try { await transport.close(); } catch { /* already closed */ }
      try { await server.close(); } catch { /* already closed */ }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });
  const address = httpServer.address();
  if (!address || typeof address === 'string') {
    httpServer.close();
    throw new Error('Codex tool bridge failed to bind a loopback port.');
  }
  const url = `http://127.0.0.1:${address.port}${path}`;
  log.debug('Codex tool bridge started', { port: address.port, toolCount: tools.length });

  return {
    url,
    close: () =>
      new Promise<void>((resolve) => {
        // Sever keep-alive connections too, or close() waits for the (dead)
        // codex subprocess's sockets to time out.
        httpServer.closeAllConnections?.();
        httpServer.close(() => resolve());
      }),
  };
}
