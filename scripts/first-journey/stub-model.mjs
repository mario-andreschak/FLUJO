#!/usr/bin/env node
// A local, free stand-in for an AI model that speaks the OpenAI Chat Completions protocol.
// FLUJO still runs its real adapter, flow engine, MCP client, approvals and stores; only the
// model's answers are scripted. Never count a run against it as proof of AI quality.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STUB_MODEL_ID = 'journey-stub';
export const STUB_TEST_REPLY = 'Hello from the local stub model.';
export const STUB_FINAL_PREFIX = 'The tool answered:';
const MAX_BODY = 4 * 1024 * 1024;

function text(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('');
  return content == null ? '' : JSON.stringify(content);
}

/**
 * Decide the next assistant message. With tools on offer and no tool result since the last user
 * message, it calls the tool the user named (`use <tool>`), or the first tool whose name ends with
 * a preferred suffix. Once a tool result is in, it answers in words and quotes that result.
 */
export function planCompletion(body, { preferredTools = ['get_allowed_directories', 'list_allowed_directories'] } = {}) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const tools = (Array.isArray(body?.tools) ? body.tools : []).map((tool) => tool?.function ?? tool).filter((tool) => tool?.name);
  const lastUser = messages.map((message, index) => ({ message, index })).filter(({ message }) => message.role === 'user').at(-1);
  const userText = lastUser ? text(lastUser.message.content) : '';
  const since = lastUser ? messages.slice(lastUser.index + 1) : [];
  const toolResult = since.filter((message) => message.role === 'tool').at(-1);
  if (toolResult) {
    const excerpt = text(toolResult.content).replace(/\s+/g, ' ').trim().slice(0, 300);
    return { role: 'assistant', content: `${STUB_FINAL_PREFIX} ${excerpt}` };
  }
  const call = (name, args = {}) => ({
    role: 'assistant',
    content: null,
    tool_calls: [{ id: `call_${randomUUID().replaceAll('-', '')}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  });
  // AI Setup's "Test model" checks a real tool round-trip with this diagnostic tool.
  const diagnostic = tools.find((candidate) => candidate.name.endsWith('verify_tool_round_trip'));
  const requestId = /requestId "([^"]+)"/.exec(userText)?.[1];
  if (diagnostic && requestId) return call(diagnostic.name, { requestId, payload: { values: [2, 3] } });

  const named = /\buse\s+(?:the\s+)?(?:tool\s+)?[`"']?([A-Za-z0-9_.:-]+)/i.exec(userText)?.[1];
  const tool = (named && tools.find((candidate) => candidate.name === named || candidate.name.endsWith(`_${named}`) || candidate.name.endsWith(`__${named}`)))
    ?? tools.find((candidate) => preferredTools.some((suffix) => candidate.name === suffix || candidate.name.endsWith(suffix)));
  if (tool && userText) return call(tool.name);
  return { role: 'assistant', content: STUB_TEST_REPLY };
}

function send(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload));
}

export async function startStubModel({ port = 0, host = '127.0.0.1', onEvent = () => {}, plan = planCompletion } = {}) {
  const events = [];
  const record = (event) => {
    const entry = { at: new Date().toISOString(), ...event };
    events.push(entry);
    if (events.length > 500) events.shift();
    onEvent(entry);
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://stub.invalid');
      const route = url.pathname.replace(/\/+$/, '');
      if (request.method === 'GET' && (route === '/v1/models' || route === '/models')) {
        send(response, 200, { object: 'list', data: [{ id: STUB_MODEL_ID, object: 'model', created: 0, owned_by: 'flujo-first-journey' }] });
        return;
      }
      if (request.method !== 'POST' || !(route === '/v1/chat/completions' || route === '/chat/completions')) {
        send(response, 404, { error: { message: `The stub model only serves /v1/models and /v1/chat/completions, not ${request.method} ${route}.` } });
        return;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_BODY) throw new Error('Request is larger than 4 MiB.');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const message = plan(body);
      record({
        kind: 'completion',
        model: body.model,
        offeredTools: (body.tools ?? []).length,
        calledTools: message.tool_calls?.map((call) => call.function.name) ?? [],
        answered: typeof message.content === 'string',
      });
      const identity = { id: `chatcmpl-${randomUUID()}`, created: Math.floor(Date.now() / 1000), model: body.model || STUB_MODEL_ID };
      const usage = { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 };
      const finishReason = message.tool_calls ? 'tool_calls' : 'stop';
      if (body.stream) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const emit = (chunk) => response.write(`data: ${JSON.stringify({ ...identity, object: 'chat.completion.chunk', ...chunk })}\n\n`);
        const delta = message.tool_calls
          ? { role: 'assistant', content: null, tool_calls: message.tool_calls.map((call, index) => ({ ...call, index })) }
          : { role: 'assistant', content: message.content };
        emit({ choices: [{ index: 0, delta, finish_reason: null }] });
        emit({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }] });
        if (body.stream_options?.include_usage) emit({ choices: [], usage });
        response.end('data: [DONE]\n\n');
        return;
      }
      send(response, 200, { ...identity, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: finishReason }], usage });
    } catch (error) {
      record({ kind: 'error', message: String(error?.message ?? error) });
      if (!response.headersSent) send(response, 400, { error: { message: String(error?.message ?? error) } });
      else response.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const { port: chosen } = server.address();
  return {
    url: `http://${host}:${chosen}/v1`,
    events,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => { server.close(resolve); });
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const portArg = process.argv.find((arg) => arg.startsWith('--port='));
  const stub = await startStubModel({
    port: portArg ? Number(portArg.slice('--port='.length)) : 0,
    onEvent: (event) => console.log(JSON.stringify(event)),
  });
  console.log(`Stub model ready at ${stub.url} (model "${STUB_MODEL_ID}", no API key needed). Stop with Ctrl+C.`);
  const stop = () => { void stub.close().then(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
