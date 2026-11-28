// Local stand-ins for what a FLUJO container talks to in the container smoke (#1408): the
// Anthropic Messages API as the bundled Claude Code calls it, and one MCP server. They only
// script answers; FLUJO, its adapters and Claude Code itself run for real, and nothing leaves
// the machine. The Anthropic side is the shared stand-in in scripts/anthropic-stand-in.mjs.
// The OpenAI-compatible stand-in is the first-use journey's stub model.
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { closer, listen, readBody, startAnthropicStandIn, systemTextOf, textOf } from '../anthropic-stand-in.mjs';

export const TOOL_MARKER = '[smoke:tool]';
export const CLASSIFY_INSTRUCTION = 'Answer with exactly one word: order, store or other.';
export const ANSWERS = Object.freeze({
  classify: 'order',
  plain: 'Store 3 opens at nine.',
  tool: 'Your order A-1 ships today.',
});
export const ORDER_TOOL = 'lookup_order';
const blocksOf = (content) => (typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []);

/**
 * The stand-in model's next answer to one Messages API request: a call of the order tool for a
 * tool turn until its result is in, one word for the classification, otherwise a short answer.
 */
export function planClaudeReply(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const lastText = messages.map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === 'user' && textOf(message.content).trim()).at(-1);
  const after = lastText ? messages.slice(lastText.index + 1) : [];
  const toolResultIn = after.some((message) => blocksOf(message.content).some((block) => block?.type === 'tool_result'));
  const system = systemTextOf(body?.system);
  const tool = (Array.isArray(body?.tools) ? body.tools : []).find((entry) => String(entry?.name ?? '').includes(ORDER_TOOL));
  const userText = lastText ? textOf(lastText.message.content) : '';
  if (userText.includes(TOOL_MARKER) && !toolResultIn && tool) return { type: 'tool_use', name: tool.name, input: { order_id: 'A-1' } };
  if (userText.includes(TOOL_MARKER) && toolResultIn) return { type: 'text', text: ANSWERS.tool };
  if (system.includes(CLASSIFY_INSTRUCTION) || userText.includes(CLASSIFY_INSTRUCTION)) return { type: 'text', text: ANSWERS.classify };
  return { type: 'text', text: ANSWERS.plain };
}

/**
 * A stand-in for Anthropic's Messages API. Claude Code reaches it through ANTHROPIC_BASE_URL with
 * FLUJO's subscription token unchanged; `requests` records when each model request arrived.
 */
export async function startClaudeStandIn({ port = 0, host = '127.0.0.1', clock = () => performance.now() } = {}) {
  const requests = [];
  const standIn = await startAnthropicStandIn({
    port, host, requireCredential: false,
    reply: ({ body, record }) => {
      const block = planClaudeReply(body);
      requests.push({ arrival: clock(), model: body.model, stream: body.stream === true, oauth: record.oauth,
        tools: (body.tools ?? []).length, answer: block.type });
      return { blocks: [block], usage: { output_tokens: 8 } };
    },
  });
  return { baseUrl: standIn.baseUrl, requests, close: standIn.close };
}

const TOOLS = Object.freeze([
  { name: ORDER_TOOL, description: 'Look up an order by its id.', inputSchema: { type: 'object',
    properties: { order_id: { type: 'string', description: 'Order id' } }, required: ['order_id'] } },
]);

/**
 * A stand-in MCP server (Streamable HTTP) with one order tool. Like the TypeScript SDK's
 * McpServer it announces list changes, so FLUJO may reuse its tool list. `methods` records
 * every JSON-RPC method that reached it.
 */
export async function startMcpStandIn({ port = 0, host = '127.0.0.1' } = {}) {
  const methods = [];
  const sessions = new Map();
  const open = async () => {
    const server = new Server({ name: 'flujo-container-smoke', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));
    server.setRequestHandler(CallToolRequestSchema, (request) => ({
      content: [{ type: 'text', text: JSON.stringify({ order: request.params.arguments?.order_id ?? null, status: 'ships today' }) }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true });
    await server.connect(transport);
    return { server, transport };
  };
  const listener = http.createServer(async (request, response) => {
    try {
      const raw = await readBody(request);
      const body = raw.length ? JSON.parse(raw.toString('utf8')) : undefined;
      for (const message of Array.isArray(body) ? body : body ? [body] : []) if (message.method) methods.push(message.method);
      let session = sessions.get(request.headers['mcp-session-id']);
      if (!session && body?.method === 'initialize') session = await open();
      if (!session) {
        response.writeHead(request.method === 'GET' ? 405 : 404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null }));
        return;
      }
      await session.transport.handleRequest(request, response, body);
      if (session.transport.sessionId) sessions.set(session.transport.sessionId, session);
    } catch (error) {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: String(error?.message ?? error) }, id: null }));
    }
  });
  const chosen = await listen(listener, port, host);
  const stop = closer(listener);
  return {
    url: `http://${host}:${chosen}/mcp`, methods,
    async close() {
      for (const session of sessions.values()) await session.transport.close().catch(() => undefined);
      await stop();
    },
  };
}
