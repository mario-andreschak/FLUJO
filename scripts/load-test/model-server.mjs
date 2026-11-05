#!/usr/bin/env node
/**
 * A stand-in model server for load tests. It answers in OpenAI format and never
 * calls anything else, so a load test costs nothing and does not depend on a provider.
 *
 * It behaves as told, and the behaviour can change while it runs (POST /__control):
 * how slowly it answers, how large the answer is, whether it asks for a tool, and how
 * often it fails, refuses, drops the connection or never answers at all.
 *
 * Every answer repeats the marker found in the last user message, so a test can tell
 * when a conversation received an answer meant for another one.
 *
 *   node scripts/load-test/model-server.mjs --port 4311 --delay-ms 200
 */
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

export const DEFAULT_MODEL_BEHAVIOUR = Object.freeze({
  delayMs: 200, // Time before the first byte of an answer.
  jitterMs: 50, // Up to this much extra, chosen at random for each request.
  chunks: 8, // Pieces a streamed answer is sent in.
  chunkDelayMs: 15, // Pause between those pieces.
  replyBytes: 400, // Rough size of a text answer.
  toolRounds: 1, // Tool calls asked for per user message, when tools are offered.
  failRate: 0, // Share of requests answered with HTTP 500.
  rateLimitRate: 0, // Share of requests answered with HTTP 429.
  retryAfterSeconds: 1, // Value of Retry-After on those refusals.
  dropRate: 0, // Share of requests whose connection is cut partway through.
  hangRate: 0, // Share of requests that are never answered.
});

const NONCE = /\[nonce:([A-Za-z0-9_-]+)\]/;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
  return '';
}

function lastUserIndex(messages) {
  for (let index = messages.length - 1; index >= 0; index--) if (messages[index]?.role === 'user') return index;
  return -1;
}

function decisionReply(system) {
  const lines = system.split('\n');
  const start = lines.findIndex((line) => line.startsWith('Possible answers'));
  const option = lines.slice(start + 1).find((line) => line.startsWith('- '));
  const answer = option ? option.slice(2).split(':')[0].trim() : 'yes';
  return JSON.stringify({ answer, probability: 0.93, reason: 'Stand-in model decision.' });
}

/** What this request should get back. Pure, so the tool's tests can check it directly. */
export function planAnswer(body, behaviour = DEFAULT_MODEL_BEHAVIOUR) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const system = textOf(messages.find((message) => message?.role === 'system')?.content);
  if (system.startsWith('You make one decision')) return { kind: 'text', text: decisionReply(system) };
  const userIndex = lastUserIndex(messages);
  const lastUser = userIndex >= 0 ? textOf(messages[userIndex].content) : '';
  const nonce = NONCE.exec(lastUser)?.[1];
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const toolResults = messages.slice(userIndex + 1).filter((message) => message?.role === 'tool').length;
  if (tools.length > 0 && toolResults < behaviour.toolRounds) {
    const tool = tools.find((candidate) => /echo/.test(candidate?.function?.name ?? '')) ?? tools[0];
    return {
      kind: 'tool',
      name: tool.function.name,
      argumentsJson: JSON.stringify({ text: nonce ? `[nonce:${nonce}]` : 'load test' }),
    };
  }
  const head = nonce ? `[nonce:${nonce}] ` : '';
  const padding = 'Stand-in answer. '.repeat(Math.ceil(Math.max(0, behaviour.replyBytes - head.length) / 17));
  return { kind: 'text', text: head + padding.slice(0, Math.max(0, behaviour.replyBytes - head.length)) };
}

const usage = { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 };

function pieces(text, count) {
  if (!text) return [''];
  const size = Math.max(1, Math.ceil(text.length / Math.max(1, count)));
  const parts = [];
  for (let index = 0; index < text.length; index += size) parts.push(text.slice(index, index + size));
  return parts;
}

/** Starts a stand-in model and resolves once it listens. */
export async function startModelServer({ port = 0, host = '127.0.0.1', behaviour = {} } = {}) {
  let current = { ...DEFAULT_MODEL_BEHAVIOUR, ...behaviour };
  const blankStats = () => ({
    requests: 0, active: 0, peakActive: 0, completed: 0, failed: 0, rateLimited: 0, dropped: 0, hung: 0,
    clientAborts: 0, toolCalls: 0, decisions: 0, requestBytes: 0, largestRequestBytes: 0,
  });
  let stats = blankStats();
  const sleepers = new Set();
  const sleep = (ms, response) => new Promise((resolve) => {
    if (ms <= 0) { resolve(); return; }
    const entry = { timer: undefined, resolve };
    const finish = () => { sleepers.delete(entry); response.off('close', finish); clearTimeout(entry.timer); resolve(); };
    entry.timer = setTimeout(finish, ms);
    sleepers.add(entry);
    response.once('close', finish);
  });

  async function answer(request, response, body) {
    stats.requests++;
    stats.active++;
    stats.peakActive = Math.max(stats.peakActive, stats.active);
    let finished = false;
    let counted = false;
    response.once('close', () => {
      stats.active--;
      if (!finished && !counted) stats.clientAborts++;
    });
    const behaviourNow = current;
    const roll = Math.random();
    let edge = behaviourNow.hangRate;
    if (roll < edge) { counted = true; stats.hung++; return; }
    await sleep(behaviourNow.delayMs + Math.random() * behaviourNow.jitterMs, response);
    if (response.destroyed || response.writableEnded) return;
    edge += behaviourNow.failRate;
    if (roll < edge) {
      stats.failed++; finished = true;
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Stand-in failure.', type: 'server_error' } }));
      return;
    }
    edge += behaviourNow.rateLimitRate;
    if (roll < edge) {
      stats.rateLimited++; finished = true;
      response.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(behaviourNow.retryAfterSeconds) });
      response.end(JSON.stringify({ error: { message: 'Rate limit reached. Too many requests.', type: 'rate_limit_error' } }));
      return;
    }
    edge += behaviourNow.dropRate;
    const drop = roll < edge;
    const plan = planAnswer(body, behaviourNow);
    if (plan.kind === 'tool') stats.toolCalls++;
    if (plan.kind === 'text' && plan.text.startsWith('{"answer"')) stats.decisions++;
    const base = { id: `chatcmpl-${stats.requests}`, created: Math.floor(Date.now() / 1000), model: body.model ?? 'stand-in' };
    const toolCall = plan.kind === 'tool'
      ? { index: 0, id: `call_${stats.requests}`, type: 'function', function: { name: plan.name, arguments: plan.argumentsJson } }
      : undefined;
    const finishReason = plan.kind === 'tool' ? 'tool_calls' : 'stop';
    if (!body.stream) {
      if (drop) { counted = true; stats.dropped++; request.socket.destroy(); return; }
      finished = true; stats.completed++;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ...base, object: 'chat.completion', usage, choices: [{
        index: 0, finish_reason: finishReason, logprobs: null,
        message: plan.kind === 'tool'
          ? { role: 'assistant', content: null, refusal: null, tool_calls: [toolCall] }
          : { role: 'assistant', content: plan.text, refusal: null },
      }] }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const send = (delta, reason = null, extra = {}) => response.write(`data: ${JSON.stringify({
      ...base, object: 'chat.completion.chunk', choices: [{ index: 0, finish_reason: reason, delta }], ...extra,
    })}\n\n`);
    send({ role: 'assistant', content: plan.kind === 'tool' ? null : '' });
    const parts = plan.kind === 'tool' ? [] : pieces(plan.text, behaviourNow.chunks);
    if (toolCall) send({ tool_calls: [toolCall] });
    const cutAt = drop ? Math.floor(parts.length / 2) : -1;
    if (drop && parts.length === 0) { counted = true; stats.dropped++; request.socket.destroy(); return; }
    for (let index = 0; index < parts.length; index++) {
      if (index === cutAt) { counted = true; stats.dropped++; request.socket.destroy(); return; }
      if (response.destroyed) return;
      send({ content: parts[index] });
      await sleep(behaviourNow.chunkDelayMs, response);
    }
    if (response.destroyed) return;
    finished = true; stats.completed++;
    send({}, finishReason);
    response.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [], usage })}\n\n`);
    response.end('data: [DONE]\n\n');
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://stand-in');
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('error', () => undefined);
    response.on('error', () => undefined);
    request.on('end', () => {
      const raw = Buffer.concat(chunks);
      if (request.method === 'GET' && url.pathname === '/__stats') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ ...stats, behaviour: current }));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/__control') {
        const update = raw.length ? JSON.parse(raw.toString('utf8')) : {};
        current = { ...(update.reset ? DEFAULT_MODEL_BEHAVIOUR : current), ...(update.behaviour ?? {}) };
        if (update.resetStats) stats = { ...blankStats(), active: stats.active };
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ behaviour: current }));
        return;
      }
      if (request.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ object: 'list', data: [{ id: 'stand-in', object: 'model', created: 1, owned_by: 'load-test' }] }));
        return;
      }
      if (request.method === 'POST' && /\/chat\/completions$/.test(url.pathname)) {
        stats.requestBytes += raw.length;
        stats.largestRequestBytes = Math.max(stats.largestRequestBytes, raw.length);
        let body;
        try { body = JSON.parse(raw.toString('utf8')); }
        catch {
          response.writeHead(400, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ error: { message: 'Invalid JSON.', type: 'invalid_request_error' } }));
          return;
        }
        answer(request, response, body).catch(() => { try { response.destroy(); } catch { /* already closed */ } });
        return;
      }
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Not found.', type: 'invalid_request_error' } }));
    });
  });
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;
  server.requestTimeout = 0;
  server.maxConnections = Infinity;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host, backlog: 4096 }, resolve);
  });
  const address = server.address();
  return {
    port: address.port,
    baseUrl: `http://${host}:${address.port}/v1`,
    stats: () => ({ ...stats, behaviour: current }),
    close: () => new Promise((resolve) => {
      for (const entry of sleepers) { clearTimeout(entry.timer); entry.resolve(); }
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

function parseArguments(argv) {
  const options = { behaviour: {} };
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index].replace(/^--/, '');
    const value = Number(argv[index + 1]);
    if (name === 'port') options.port = value;
    else if (name === 'host') options.host = argv[index + 1];
    else options.behaviour[name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const running = await startModelServer(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify({ listening: running.port, baseUrl: running.baseUrl })}\n`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => running.close().then(() => process.exit(0)));
}
