// Local stand-ins for the outside world of the schedule and approval check: an
// OpenAI-compatible model and an MCP server with one tool. Both write down every
// request, so a run nobody recorded, a tool that ran without approval or a tool
// that ran twice shows up in the report.
import { createServer } from 'node:http';

export const STAND_IN_TOOL = 'record_effect';
export const STAND_IN_MODEL_KEY = 'packaged-acceptance-stand-in-key';
/** What the stand-in model answers, with HTTP 400, to a request whose marker starts with "fail". */
export const STAND_IN_REFUSAL = 'The stand-in provider refused this request.';
const MARKER = /Acceptance marker: ([a-z0-9-]+)\./;
const RUN_TIME = /"now":\s*"([^"]+)"/;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_PROPOSALS_PER_MARKER = 5;

const textOf = message => typeof message?.content === 'string' ? message.content
  : Array.isArray(message?.content) ? message.content.map(part => part?.text ?? '').join('\n') : '';

/**
 * The marker the check put in a plan's prompt, and the fire time the scheduler
 * adds to every run's prompt ("now" in its run info), from the newest user
 * message that has a marker.
 */
export function runOf(messages) {
  for (const message of [...(messages ?? [])].reverse()) {
    if (message?.role !== 'user') continue;
    const text = textOf(message);
    const found = MARKER.exec(text);
    if (found) return { marker: found[1], firedAt: RUN_TIME.exec(text)?.[1] ?? null };
  }
  return { marker: null, firedAt: null };
}

/**
 * What the stand-in model answers. It asks for the tool while the tool has not
 * run for this marker yet. A "deny" marker asks only once: after any tool result
 * it answers in text, so a denied call never loops. A fresh call after a
 * refused stale one gets a new call id, as a real model would.
 */
export function standInReply(body, { effects, proposals }) {
  const { marker, firedAt } = runOf(body?.messages);
  const tool = (body?.tools ?? []).find(item => item?.function?.name?.includes(STAND_IN_TOOL));
  const hasToolResult = (body?.messages ?? []).some(message => message?.role === 'tool');
  const ran = effects.some(effect => effect.marker === marker);
  const asked = proposals.filter(proposal => proposal.marker === marker).length;
  const wantsTool = tool && marker && !ran && asked < MAX_PROPOSALS_PER_MARKER
    && !(marker.startsWith('deny') && hasToolResult);
  if (wantsTool) {
    return { marker, firedAt, toolCall: { id: `call-${marker}-${asked + 1}`, type: 'function',
      function: { name: tool.function.name, arguments: JSON.stringify({ marker }) } } };
  }
  return { marker, firedAt, text: `Stand-in answer for ${marker ?? 'an unmarked request'}.` };
}

async function readBody(request) {
  const chunks = []; let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) throw new Error('Request body is larger than 1 MiB.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(value === undefined ? '' : JSON.stringify(value));
}

function completion(body, reply, sequence) {
  const info = { id: `stand-in-${sequence}`, model: body.model ?? 'stand-in', created: Math.floor(Date.now() / 1000) };
  const usage = { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 };
  const finish = reply.toolCall ? 'tool_calls' : 'stop';
  if (!body.stream) {
    return { kind: 'json', value: { ...info, object: 'chat.completion', usage, choices: [{ index: 0, finish_reason: finish,
      message: reply.toolCall ? { role: 'assistant', content: null, tool_calls: [reply.toolCall] } : { role: 'assistant', content: reply.text } }] } };
  }
  const delta = reply.toolCall ? { role: 'assistant', tool_calls: [{ index: 0, ...reply.toolCall }] } : { role: 'assistant', content: reply.text };
  return { kind: 'stream', chunks: [
    { ...info, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] },
    { ...info, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: finish }], usage },
  ] };
}

/** Answer one MCP JSON-RPC message (Streamable HTTP, stateless, JSON responses). */
export function mcpReply(message, effects) {
  const { id, method, params } = message ?? {};
  if (id === undefined || id === null) return undefined;
  const result = value => ({ jsonrpc: '2.0', id, result: value });
  if (method === 'initialize') {
    return result({ protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
      capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'flujo-acceptance-effects', version: '1.0.0' } });
  }
  if (method === 'ping') return result({});
  if (method === 'tools/list') {
    return result({ tools: [{ name: STAND_IN_TOOL, description: 'Record one acceptance effect for the given marker.',
      inputSchema: { type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'], additionalProperties: false } }] });
  }
  if (method === 'tools/call' && params?.name === STAND_IN_TOOL && typeof params.arguments?.marker === 'string') {
    effects.push({ marker: params.arguments.marker, at: Date.now() });
    return result({ content: [{ type: 'text', text: `Effect recorded: ${params.arguments.marker}` }] });
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unsupported request ${method}.` } };
}

async function listen(server, host) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); });
  return server.address().port;
}

/**
 * Start both stand-ins on `host`. `appHost` is the name the app uses to reach
 * them (the same loopback address for host forms, a host-gateway name for
 * containers).
 */
export async function startStandIns({ host = '127.0.0.1', appHost = host } = {}) {
  const requests = []; const proposals = []; const effects = []; const failures = [];
  const model = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || !request.url.endsWith('/chat/completions')) return sendJson(response, 404, { error: { message: 'Not found.' } });
      if (request.headers.authorization !== `Bearer ${STAND_IN_MODEL_KEY}`) return sendJson(response, 401, { error: { message: 'Wrong stand-in key.' } });
      const body = JSON.parse(await readBody(request));
      const reply = standInReply(body, { effects, proposals });
      requests.push({ marker: reply.marker, firedAt: reply.firedAt, at: Date.now(), toolCall: Boolean(reply.toolCall) });
      if (reply.marker?.startsWith('fail')) {
        return sendJson(response, 400, { error: { message: STAND_IN_REFUSAL, type: 'invalid_request_error', code: 'stand_in_refusal' } });
      }
      if (reply.toolCall) proposals.push({ marker: reply.marker, id: reply.toolCall.id, at: Date.now() });
      const answer = completion(body, reply, requests.length);
      if (answer.kind === 'json') return sendJson(response, 200, answer.value);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const chunk of answer.chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      response.end('data: [DONE]\n\n');
    } catch (error) {
      failures.push(`model: ${error.message}`);
      sendJson(response, 500, { error: { message: 'Stand-in model could not read the request.' } });
    }
  });
  const mcp = createServer(async (request, response) => {
    try {
      if (new URL(request.url, 'http://stand-in').pathname !== '/mcp') return sendJson(response, 404, { error: 'Not found.' });
      if (request.method !== 'POST') return sendJson(response, 405, undefined, { allow: 'POST' });
      const reply = mcpReply(JSON.parse(await readBody(request)), effects);
      if (reply === undefined) { response.writeHead(202); response.end(); return; }
      sendJson(response, 200, reply);
    } catch (error) {
      failures.push(`mcp: ${error.message}`);
      sendJson(response, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Unreadable request.' } });
    }
  });
  const modelPort = await listen(model, host);
  let mcpPort;
  try { mcpPort = await listen(mcp, host); } catch (error) { model.close(); throw error; }
  return {
    modelUrl: `http://${appHost}:${modelPort}/v1`,
    mcpUrl: `http://${appHost}:${mcpPort}/mcp`,
    requests, proposals, effects, failures,
    requestsFor: marker => requests.filter(item => item.marker === marker),
    effectsFor: marker => effects.filter(item => item.marker === marker),
    async close() {
      for (const server of [model, mcp]) {
        server.closeAllConnections();
        await new Promise(resolve => server.close(() => resolve()));
      }
    },
  };
}
