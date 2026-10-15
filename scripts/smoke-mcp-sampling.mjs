#!/usr/bin/env node
// Focused built-app acceptance for #1093. Run through flujo-bash MCP.
// The real OpenRouter credential stays in the loopback relay's memory.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpServer, createMcpHandler, inputRequired, inputResponse } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { createSmokeOperator } from './smoke-bundled-operator.mjs';

assert.equal(process.argv.slice(2).join(' '), '--production --openrouter-free',
  'Usage: smoke-mcp-sampling.mjs --production --openrouter-free (build first; explicit live opt-in)');
const apiKey = process.env.FLUJO_SAMPLING_OPENROUTER_KEY;
assert.ok(apiKey?.startsWith('sk-or-'), 'An explicit OpenRouter credential is required');
delete process.env.FLUJO_SAMPLING_OPENROUTER_KEY;
const application = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildId = (await fs.readFile(path.join(application, '.next/BUILD_ID'), 'utf8')).trim();
const modelName = 'openrouter/free';
const relayKey = randomBytes(24).toString('hex'), password = randomBytes(32).toString('hex');
const cases = [
  { id: 'request-cap', request: 32, policy: 64, model: 128, expected: 32 },
  { id: 'policy-cap', request: 64, policy: 24, model: 128, expected: 24 },
  { id: 'model-cap', request: 64, policy: 128, model: 16, expected: 16 },
  { id: 'natural-stop', request: 1024, policy: 1024, model: 1024, expected: 1024, natural: true },
];
const receipt = { schemaVersion: 1, buildId, provider: 'OpenRouter', model: modelName,
  endpoint: 'https://openrouter.ai/api/v1/responses', adapter: 'openai-responses', modelFallbacks: 0,
  productionSamplingSha256: createHash('sha256').update(await fs.readFile(path.join(application, 'src/backend/services/mcp/sampling.ts'))).digest('hex'),
  cases: [], providerRequests: [], relayRefusals: [], generations: [], limitations: [
    'Source production build; not installed or packed artifact qualification',
    'Text sampling only; no sampling-with-tools or OAuth certification',
    'Provider usage and stop reason are observed metadata, not an independent tokenizer measurement',
  ] };
const sessions = new Map(), samples = new Map();
let child, childClosed, operator, base, serverLog = '', activeCase, failure;

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
async function unusedPort() {
  const server = http.createServer(), port = await listen(server);
  await new Promise(resolve => server.close(resolve)); return port;
}
async function readJson(request) {
  const chunks = []; let length = 0;
  for await (const chunk of request) { length += chunk.length; assert.ok(length <= 128 * 1024); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function samplingParams(test) {
  return { messages: [{ role: 'user', content: { type: 'text', text: test.natural
    ? 'Reply with exactly OK. No explanation.'
    : 'Write the numbers from one to one thousand, separated by spaces. Continue until you reach one thousand.' } }],
  maxTokens: test.request, temperature: 0 };
}
function saveSample(id, result) { samples.set(id, result); return { content: [{ type: 'text', text: JSON.stringify(result) }] }; }

const relay = http.createServer(async (request, response) => {
  const controller = new AbortController();
  let stage = 'route';
  response.once('close', () => { if (!response.writableEnded) controller.abort(); });
  try {
    const route = new URL(request.url, 'http://127.0.0.1');
    assert.equal(route.pathname, '/v1/responses');
    assert.ok([...route.searchParams].every(([name, value]) => name === 'stream' && value === 'false'));
    stage = 'credential';
    assert.equal(request.headers.authorization, `Bearer ${relayKey}`);
    stage = 'body';
    const body = await readJson(request), test = activeCase;
    assert.ok(test, 'An owned sampling case must be active');
    stage = 'model'; assert.equal(body.model, modelName);
    stage = 'token-bound'; assert.equal(body.max_output_tokens, test.expected);
    stage = 'non-streaming'; assert.ok(body.stream === undefined || body.stream === false);
    stage = 'no-tools'; assert.equal(body.tools, undefined);
    const record = { caseId: test.key, requestMaxTokens: body.max_output_tokens, requestModel: body.model };
    receipt.providerRequests.push(record);
    stage = 'upstream';
    const upstream = await fetch(receipt.endpoint, { method: 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'X-Title': 'FLUJO sampling acceptance', 'HTTP-Referer': 'https://flujo.com.co' },
      body: JSON.stringify({ ...body, provider: { allow_fallbacks: false } }),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]) });
    record.httpStatus = upstream.status;
    const result = await upstream.json();
    if (upstream.ok) {
      record.responseModel = result.model;
      record.responseStatus = result.status;
      record.incompleteReason = result.incomplete_details?.reason ?? null;
      record.finishReason = result.status === 'incomplete' && record.incompleteReason === 'max_output_tokens'
        ? 'length' : result.status === 'completed' ? 'stop' : result.status;
      record.inputTokens = result.usage?.input_tokens;
      record.outputTokens = result.usage?.output_tokens;
      record.cost = result.usage?.cost ?? null;
      assert.ok(Number.isSafeInteger(record.outputTokens) && record.outputTokens <= test.expected,
        'Provider-reported output must fit the effective bound');
    }
    response.writeHead(upstream.status, { 'content-type': 'application/json' }); response.end(JSON.stringify(result));
  } catch (error) {
    receipt.relayRefusals.push({ caseId: activeCase?.key, stage, error: error.name,
      path: new URL(request.url, 'http://127.0.0.1').pathname });
    if (!response.destroyed) { response.writeHead(502, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: `Sampling relay refused the request (${error.name}).` } })); }
  }
});

const modern = createMcpHandler(() => {
  const server = new McpServer({ name: 'sampling-reference-modern', version: '1.0.0' });
  server.registerTool('sample', { inputSchema: z.object({ caseId: z.string() }) }, async ({ caseId }, context) => {
    const test = cases.find(value => value.id === caseId); assert.ok(test);
    const response = inputResponse(context.mcpReq.inputResponses, 'sampling');
    if (response.kind === 'missing') return inputRequired({ inputRequests: { sampling: inputRequired.createMessage(samplingParams(test)) } });
    assert.equal(response.kind, 'sampling'); return saveSample(`modern:${caseId}`, response.result);
  });
  return server;
}, { legacy: 'reject' });

const reference = http.createServer(async (request, response) => {
  try {
    if (request.url === '/modern') {
      const controller = new AbortController();
      response.once('close', () => { if (!response.writableEnded) controller.abort(); });
      const body = request.method === 'POST' ? JSON.stringify(await readJson(request)) : undefined;
      const web = new Request(`http://127.0.0.1:${reference.address().port}/modern`, {
        method: request.method, headers: request.headers, signal: controller.signal, ...(body ? { body } : {}) });
      const result = await modern.fetch(web);
      response.writeHead(result.status, Object.fromEntries(result.headers));
      if (!result.body) { response.end(); return; }
      const stream = Readable.fromWeb(result.body);
      stream.on('error', () => response.destroy()); response.once('close', () => stream.destroy()); stream.pipe(response); return;
    }
    assert.equal(request.url, '/legacy');
    let session = sessions.get(request.headers['mcp-session-id']);
    if (!session) {
      const server = new Server({ name: 'sampling-reference-legacy', version: '1.0.0' }, { capabilities: { tools: {} } });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID,
        onsessioninitialized: id => sessions.set(id, { server, transport }) });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'sample',
        inputSchema: { type: 'object', properties: { caseId: { type: 'string' } }, required: ['caseId'] } }] }));
      server.setRequestHandler(CallToolRequestSchema, async (call, context) => {
        const test = cases.find(value => value.id === call.params.arguments.caseId); assert.ok(test);
        assert.ok(server.getClientCapabilities()?.sampling);
        assert.equal(server.getClientCapabilities()?.sampling?.tools, undefined);
        return saveSample(`legacy:${test.id}`, await server.createMessage(samplingParams(test), { relatedRequestId: context.requestId, signal: context.signal }));
      });
      await server.connect(transport); session = { server, transport };
    }
    await session.transport.handleRequest(request, response, request.method === 'POST' ? await readJson(request) : undefined);
  } catch (error) { if (!response.headersSent) response.writeHead(500); response.end(`Reference refused request (${error.name}).`); }
});

async function api(endpoint, body, method = body === undefined ? 'GET' : 'POST') {
  const url = new URL(endpoint, base); url.searchParams.set('workspace', 'default-workspace');
  const response = await fetch(url, { method, headers: { authorization: `Bearer ${operator.token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120_000) });
  const result = await response.json();
  assert.ok(response.ok, `Sampling API ${endpoint} returned ${response.status}: ${JSON.stringify(result)}`); return result;
}
function environment(root) {
  const safe = {};
  for (const [name, value] of Object.entries(process.env)) if (/^(path|systemroot|windir|comspec|pathext|systemdrive)$/i.test(name)) safe[name] = value;
  return { ...safe, ...operator.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
    HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), TEMP: path.join(root, 'temp'), TMP: path.join(root, 'temp'),
    FLUJO_DATA_DIR: path.join(root, 'data'), FLUJO_APP_ROOT: application, FLUJO_BASE_URL: base,
    FLUJO_EXPOSURE_MODE: 'localhost', FLUJO_MCP_APP_SANDBOX_HOST: '127.0.0.1' };
}

try {
  operator = await createSmokeOperator(); const root = path.dirname(operator.env.FLUJO_OWNER_AUTH_FILE);
  for (const name of ['data', 'home', 'temp']) await fs.mkdir(path.join(root, name));
  const relayPort = await listen(relay), referencePort = await listen(reference), appPort = await unusedPort(), sandboxPort = await unusedPort();
  base = `http://127.0.0.1:${appPort}`;
  const ready = new Promise((resolve, reject) => {
    child = fork(path.join(application, 'scripts/persona-browser-acceptance/next-process.cjs'), [String(appPort)], {
      cwd: application, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...environment(root), FLUJO_PORT: String(appPort), FLUJO_MCP_APP_SANDBOX_PORT: String(sandboxPort) },
    });
    child.once('error', reject); child.once('exit', () => reject(new Error('App exited before readiness')));
    child.once('message', message => message?.type === 'journey-server-ready' && message.pid === child.pid ? resolve() : reject(new Error('Invalid readiness receipt')));
  });
  childClosed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { serverLog = `${serverLog}${bytes}`.slice(-64_000); });
  await Promise.race([ready, delay(60_000, undefined, { ref: false }).then(() => { throw new Error('App readiness timeout'); })]);
  for (const action of ['initialize', 'authenticate']) assert.equal((await api('/api/encryption/secure', { action, password })).success, true);
  for (const generation of ['legacy', 'modern']) {
    await api('/api/storage', { key: 'speech_settings', value: { experimental: { mcpBetaProtocol: generation === 'modern' } } });
    for (const test of cases) {
      const key = `${generation}:${test.id}`, name = `sampling-${generation}-${test.id}`, modelId = `${name}-model`;
      await api('/api/model', { id: modelId, name: modelName, provider: 'openrouter', adapter: 'openai', ApiKey: relayKey,
        baseUrl: `http://127.0.0.1:${relayPort}/v1`, maxTokens: test.model });
      await api('/api/mcp/servers', { name, transport: 'streamable', serverUrl: `http://127.0.0.1:${referencePort}/${generation}`,
        disabled: false, sampling: { enabled: true, modelId, maxTokens: test.policy, maxCallsPerMinute: 10 } });
      activeCase = { ...test, key }; const before = receipt.providerRequests.length;
      const called = await api(`/api/mcp/servers/${name}/tools/sample`, { args: { caseId: test.id }, timeout: 100_000 });
      assert.equal(called.success, true, `Sampling tool failed for ${key}`);
      const sampled = samples.get(key), attempts = receipt.providerRequests.slice(before), wire = attempts.filter(value => value.httpStatus === 200);
      assert.ok(sampled); assert.equal(sampled.model, modelName); assert.equal(sampled.content.type, 'text');
      assert.equal(wire.length, 1, 'Each sampling call must produce one successful generation');
      assert.equal(wire[0].httpStatus, 200); assert.ok(wire[0].outputTokens <= test.expected);
      assert.equal(sampled.stopReason, wire[0].finishReason === 'length' ? 'maxTokens' : 'endTurn');
      if (test.natural) { assert.equal(wire[0].finishReason, 'stop'); assert.ok(sampled.content.text.trim()); }
      else { assert.equal(wire[0].finishReason, 'length'); assert.equal(sampled.stopReason, 'maxTokens'); }
      receipt.cases.push({ generation, case: test.id, requestCap: test.request, policyCap: test.policy, modelCap: test.model,
        effectiveCap: test.expected, outputTokens: wire[0].outputTokens, finishReason: wire[0].finishReason,
        providerAttempts: attempts.length, stopReason: sampled.stopReason, textCharacters: sampled.content.text.length });
      console.log(JSON.stringify({ samplingCase: receipt.cases.at(-1) }));
      await api(`/api/mcp/servers/${name}`, { disabled: true }, 'PUT'); activeCase = undefined;
    }
    receipt.generations.push(generation);
  }
  for (const secret of [apiKey, relayKey, password, operator.token]) assert.ok(!serverLog.includes(secret), 'No credentials may enter application logs');
} catch (error) {
  failure = error;
  let diagnostic = `${error.stack ?? error}\n${serverLog.slice(-6000)}`;
  for (const secret of [apiKey, relayKey, password, operator?.token]) if (secret) diagnostic = diagnostic.split(secret).join('[redacted]');
  console.error(diagnostic);
} finally {
  if (child?.connected && child.exitCode === null && child.signalCode === null) child.send('stop');
  if (childClosed) {
    const exit = await Promise.race([childClosed, delay(15_000, undefined, { ref: false }).then(() => { throw new Error('Owned app closure timeout; private profile retained'); })]);
    assert.ok(exit.code === 0 || exit.code === 143 || exit.signal === 'SIGTERM'); receipt.appClosed = true;
  }
  const cleanupErrors = [];
  for (const session of sessions.values()) { try { await session.server.close(); } catch (error) { cleanupErrors.push(error); } }
  try { await modern.close(); } catch (error) { cleanupErrors.push(error); }
  for (const server of [reference, relay]) {
    try { server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); }
    catch (error) { cleanupErrors.push(error); }
  }
  if (operator) {
    try { await operator.restore(); receipt.privateProfileRemoved = true; }
    catch (error) { cleanupErrors.push(error); }
  }
  if (cleanupErrors.length) throw new AggregateError(failure ? [failure, ...cleanupErrors] : cleanupErrors, 'Sampling acceptance cleanup failed');
}
console.log(JSON.stringify({ samplingReceipt: { ...receipt, success: !failure, node: process.version, platform: process.platform } }));
if (failure) process.exitCode = 1;
