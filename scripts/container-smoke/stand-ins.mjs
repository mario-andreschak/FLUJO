// Local stand-ins for what a FLUJO container talks to in the container smoke (#1408): the
// Anthropic Messages API as the bundled Claude Code calls it, and one MCP server. They only
// script answers; FLUJO, its adapters and Claude Code itself run for real, and nothing leaves
// the machine. The OpenAI-compatible stand-in is the first-use journey's stub model.
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export const TOOL_MARKER = '[smoke:tool]';
export const CLASSIFY_INSTRUCTION = 'Answer with exactly one word: order, store or other.';
export const ANSWERS = Object.freeze({
  classify: 'order',
  plain: 'Store 3 opens at nine.',
  tool: 'Your order A-1 ships today.',
});
export const ORDER_TOOL = 'lookup_order';
const MAX_BODY = 8 * 1024 * 1024;

const blocksOf = (content) => (typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []);
const textOf = (content) => blocksOf(content).filter((block) => block?.type === 'text').map((block) => block.text).join('\n');

async function readBody(request) {
  const parts = [];
  let size = 0;
  for await (const part of request) {
    size += part.length;
    if (size > MAX_BODY) throw new Error('Request body is larger than 8 MiB.');
    parts.push(part);
  }
  return Buffer.concat(parts);
}

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
  const system = Array.isArray(body?.system) ? body.system.map((block) => block?.text ?? '').join('\n') : String(body?.system ?? '');
  const tool = (Array.isArray(body?.tools) ? body.tools : []).find((entry) => String(entry?.name ?? '').includes(ORDER_TOOL));
  const userText = lastText ? textOf(lastText.message.content) : '';
  if (userText.includes(TOOL_MARKER) && !toolResultIn && tool) return { type: 'tool_use', name: tool.name, input: { order_id: 'A-1' } };
  if (userText.includes(TOOL_MARKER) && toolResultIn) return { type: 'text', text: ANSWERS.tool };
  if (system.includes(CLASSIFY_INSTRUCTION) || userText.includes(CLASSIFY_INSTRUCTION)) return { type: 'text', text: ANSWERS.classify };
  return { type: 'text', text: ANSWERS.plain };
}

/** The server-sent events of one streamed Messages API answer. */
export function claudeAnswerEvents(model, block, id = `msg_${randomUUID().replaceAll('-', '')}`) {
  const start = block.type === 'text'
    ? { type: 'text', text: '' }
    : { type: 'tool_use', id: `toolu_${randomUUID().replaceAll('-', '')}`, name: block.name, input: {} };
  const delta = block.type === 'text'
    ? { type: 'text_delta', text: block.text }
    : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) };
  return [
    ['message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: start }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: block.type === 'text' ? 'end_turn' : 'tool_use', stop_sequence: null },
      usage: { output_tokens: 8 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server.address().port));
  });
}

function closer(server) {
  return () => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

/**
 * A stand-in for Anthropic's Messages API. Claude Code reaches it through ANTHROPIC_BASE_URL with
 * FLUJO's subscription token unchanged; `requests` records when each model request arrived.
 */
export async function startClaudeStandIn({ port = 0, host = '127.0.0.1', clock = () => performance.now() } = {}) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const arrival = clock();
    try {
      const url = new URL(request.url ?? '/', 'http://stand-in.invalid');
      if (request.method !== 'POST' || url.pathname !== '/v1/messages') {
        await readBody(request);
        response.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({
          type: 'error', error: { type: 'not_found_error', message: `The stand-in serves POST /v1/messages only, not ${request.method} ${url.pathname}.` } }));
        return;
      }
      const body = JSON.parse((await readBody(request)).toString('utf8') || '{}');
      const block = planClaudeReply(body);
      requests.push({ arrival, model: body.model, stream: body.stream === true, oauth: /^Bearer sk-ant-oat01-/.test(request.headers.authorization ?? ''),
        tools: (body.tools ?? []).length, answer: block.type });
      const events = claudeAnswerEvents(body.model, block);
      if (body.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        for (const [event, data] of events) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        response.end();
        return;
      }
      const message = events[0][1].message;
      const content = block.type === 'text' ? [{ type: 'text', text: block.text }] : [{ ...events[1][1].content_block, input: block.input }];
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...message, content,
        stop_reason: events[4][1].delta.stop_reason, usage: { input_tokens: 20, output_tokens: 8 } }));
    } catch (error) {
      if (!response.headersSent) response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: String(error?.message ?? error) } }));
    }
  });
  const chosen = await listen(server, port, host);
  return { baseUrl: `http://${host}:${chosen}`, requests, close: closer(server) };
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
