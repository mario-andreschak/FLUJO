import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { localhostHostValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import {
  CallToolRequestSchema, GetPromptRequestSchema, ListPromptsRequestSchema,
  ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema,
  ErrorCode, McpError,
} from '@modelcontextprotocol/sdk/types.js';

// Synthetic, read-only echo tools. No model, browser, file, shell or provider calls.
export const FIXTURE_VERSION = '1.0.0';
export const APP_URI = 'ui://feature-surface/receipt';
export const RECEIPT_URI = 'fixture://feature-surface/receipt';
const PAGE_SIZE = 32;
const MAX_RECEIPTS = 64;
const hash = value => createHash('sha256').update(value).digest('hex');

export const APP_HTML = `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Synthetic fixture receipt</title>
<style>body{font:16px system-ui;margin:16px;overflow-wrap:anywhere}pre{white-space:pre-wrap}</style>
<h1>Synthetic fixture receipt</h1><p>Mount: <code id="mount"></code></p>
<p id="status" role="status">Waiting for host initialization.</p><pre id="result">No tool result received.</pre>
<script>
(() => {
  document.getElementById('mount').textContent = crypto.randomUUID();
  const post = message => parent.postMessage(message, '*');
  window.addEventListener('message', event => {
    if (event.source !== parent) return;
    const message = event.data;
    if (!message || message.jsonrpc !== '2.0') return;
    if (message.id === 'fixture-init' && message.result) {
      document.getElementById('status').textContent = 'Initialized; no tool is called by this App.';
      post({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}});
      post({jsonrpc:'2.0',method:'ui/notifications/size-changed',params:{height:320}});
    } else if (message.id === 'fixture-init' && message.error) {
      document.getElementById('status').textContent = 'Host initialization failed.';
    } else if (message.method === 'ui/notifications/tool-result') {
      document.getElementById('result').textContent = JSON.stringify(message.params, null, 2);
    } else if (message.id !== undefined && ['ping','ui/resource-teardown'].includes(message.method)) {
      post({jsonrpc:'2.0',id:message.id,result:{}});
    }
  });
  post({jsonrpc:'2.0',id:'fixture-init',method:'ui/initialize',params:{
    appInfo:{name:'feature-surface-fixture',version:'${FIXTURE_VERSION}'},
    appCapabilities:{},protocolVersion:'2026-01-26'
  }});
})();
</script></html>`;

const urlSchema = {
  type: 'object', additionalProperties: false, required: ['url'], properties: {
    url: { type: 'string', minLength: 1, description: 'Synthetic URL; never fetched.' },
    options: { type: 'object', description: 'Nested JSON draft for form-retention checks.',
      additionalProperties: true, properties: { formats: { type: 'array', items: { type: 'string' } } } },
  },
};
const elementSchema = {
  type: 'object', additionalProperties: false, required: ['element', 'ref'], properties: {
    element: { type: 'string', minLength: 1, description: 'Synthetic element description.' },
    ref: { type: 'string', minLength: 1, description: 'Synthetic reference; never resolved.' },
    button: { type: 'string', enum: ['left', 'middle', 'right'], default: 'left' },
    modifiers: { type: 'array', items: { type: 'string' }, description: 'Array draft for form-retention checks.' },
    options: { type: 'object', additionalProperties: true },
    enabled: { type: 'boolean', default: true },
  },
};
export const TOOL_DEFINITIONS = Array.from({ length: 128 }, (_, index) => ({
  name: `fixture_tool_${String(index + 1).padStart(3, '0')}`,
  description: `Synthetic echo ${index + 1}/128; no external effects. ${index % 2 ? 'Element/ref' : 'URL/options'} schema.`,
  inputSchema: index % 2 ? elementSchema : urlSchema,
  outputSchema: { type: 'object', additionalProperties: false, required: ['toolName', 'arguments'],
    properties: { toolName: { type: 'string' }, arguments: { type: 'object' } } },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _meta: { ui: { resourceUri: APP_URI, visibility: ['model', 'app'] } },
}));
export const DEFINITION_SHA256 = hash(JSON.stringify({
  version: FIXTURE_VERSION, tools: TOOL_DEFINITIONS, app: APP_HTML,
}));
const validator = new AjvJsonSchemaValidator();
const validators = new Map(TOOL_DEFINITIONS.map(tool => [tool.name, validator.getValidator(tool.inputSchema)]));

export function createFixtureState() {
  const runId = randomUUID();
  let mode = 'normal';
  let delayMs = 0;
  let listRequests = 0;
  let toolCalls = 0;
  let acceptedCalls = 0;
  const recentCalls = [];
  return {
    snapshot: () => ({ runId, fixtureVersion: FIXTURE_VERSION, definitionSha256: DEFINITION_SHA256,
      mode, delayMs, listRequests, toolCalls, acceptedCalls, recentCalls: recentCalls.map(entry => ({ ...entry })) }),
    configure(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(key => !['mode', 'delayMs'].includes(key))
        || !['normal', 'fail-second-page', 'cycle', 'empty', 'delay'].includes(value.mode)
        || (value.delayMs !== undefined && (!Number.isInteger(value.delayMs) || value.delayMs < 0 || value.delayMs > 30000))) {
        throw new Error('Expected mode normal|fail-second-page|cycle|empty|delay and optional delayMs 0..30000.');
      }
      mode = value.mode;
      delayMs = value.delayMs ?? 0;
    },
    async list(cursor) {
      listRequests += 1;
      if (mode === 'delay' && delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
      const offset = cursor === undefined ? 0 : Number(cursor);
      if (!Number.isInteger(offset) || offset < 0 || offset >= 128 || offset % PAGE_SIZE
        || (cursor !== undefined && String(offset) !== cursor)) {
        throw new McpError(ErrorCode.InvalidParams, 'Unknown fixture cursor.');
      }
      if (mode === 'empty') return { tools: [] };
      if (mode === 'fail-second-page' && offset === PAGE_SIZE) {
        throw new McpError(ErrorCode.InternalError, 'Intentional fixture second-page failure.');
      }
      const nextCursor = mode === 'cycle' && offset === PAGE_SIZE ? String(PAGE_SIZE)
        : offset + PAGE_SIZE < 128 ? String(offset + PAGE_SIZE) : undefined;
      return { tools: TOOL_DEFINITIONS.slice(offset, offset + PAGE_SIZE), ...(nextCursor ? { nextCursor } : {}) };
    },
    call(name, args = {}) {
      const validate = validators.get(name);
      if (!validate) throw new McpError(ErrorCode.InvalidParams, 'Unknown fixture tool.');
      toolCalls += 1;
      const validation = validate(args);
      recentCalls.push({ sequence: toolCalls, toolName: name, argumentsSha256: hash(JSON.stringify(args)), accepted: validation.valid });
      if (recentCalls.length > MAX_RECEIPTS) recentCalls.shift();
      if (!validation.valid) return { isError: true, content: [{ type: 'text', text: `Invalid fixture arguments: ${validation.errorMessage}` }] };
      acceptedCalls += 1;
      const structuredContent = { toolName: name, arguments: args };
      return { structuredContent, content: [{ type: 'text', text: JSON.stringify(structuredContent) }] };
    },
  };
}

export function createFixtureServer(state) {
  const server = new Server({ name: 'feature-surface-fixture', version: FIXTURE_VERSION },
    { capabilities: { tools: {}, resources: {}, prompts: {} } });
  server.setRequestHandler(ListToolsRequestSchema, request => state.list(request.params?.cursor));
  server.setRequestHandler(CallToolRequestSchema, request => state.call(request.params.name, request.params.arguments));
  server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: [
    { uri: APP_URI, name: 'Synthetic receipt App', mimeType: 'text/html;profile=mcp-app' },
    { uri: RECEIPT_URI, name: 'Synthetic invocation receipt', mimeType: 'application/json' },
  ] }));
  server.setRequestHandler(ReadResourceRequestSchema, request => {
    const uri = request.params.uri;
    if (uri === APP_URI) return { contents: [{ uri, mimeType: 'text/html;profile=mcp-app', text: APP_HTML,
      _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } } }] };
    if (uri === RECEIPT_URI) return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(state.snapshot()) }] };
    throw new McpError(ErrorCode.InvalidParams, 'Unknown fixture resource.');
  });
  server.setRequestHandler(ListPromptsRequestSchema, () => ({ prompts: [{
    name: 'fixture-summary', description: 'Synthetic echo task; no human or model-quality acceptance.',
    arguments: [{ name: 'marker', required: true, description: 'Non-secret synthetic marker.' }],
  }] }));
  server.setRequestHandler(GetPromptRequestSchema, request => {
    if (request.params.name !== 'fixture-summary' || !request.params.arguments?.marker) {
      throw new McpError(ErrorCode.InvalidParams, 'Expected fixture-summary and marker.');
    }
    return { messages: [{ role: 'user', content: { type: 'text', text:
      `Call fixture_tool_128 with element "synthetic receipt" and ref "${request.params.arguments.marker}". Summarize the actual echo result. This is a synthetic protocol task.` } }] };
  });
  return server;
}

export async function startHttpFixture({ port = 0, state = createFixtureState() } = {}) {
  const app = express();
  const controlToken = randomUUID();
  app.use(localhostHostValidation());
  // No CORS permission. Reject browser origins other than this exact loopback service.
  app.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin && origin !== `http://${req.get('host')}`) return res.status(403).json({ error: 'Cross-origin fixture request refused.' });
    next();
  });
  app.use(express.json({ limit: '64kb' }));
  app.get('/receipt', (_req, res) => res.json(state.snapshot()));
  app.post('/control', (req, res) => {
    if (req.get('x-fixture-control') !== controlToken) return res.status(403).json({ error: 'Fixture control token required.' });
    try { state.configure(req.body); res.json(state.snapshot()); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  const clients = new Set();
  const sessions = new Map();
  const closeClient = async server => { clients.delete(server); await server.close(); };
  const fail = (res, error) => {
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', id: null,
      error: { code: ErrorCode.InternalError, message: String(error.message) } });
  };
  app.post('/mcp', async (req, res) => {
    const server = createFixtureServer(state);
    clients.add(server);
    res.once('close', () => { void closeClient(server); });
    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) { fail(res, error); await closeClient(server); }
  });
  app.all('/mcp', (_req, res) => res.status(405).json({ error: 'Stateless fixture accepts POST only.' }));
  // Legacy SSE is intentionally covered because FLUJO advertises it; new setups should use /mcp.
  app.get('/sse', async (_req, res) => {
    const server = createFixtureServer(state);
    const transport = new SSEServerTransport('/messages', res);
    clients.add(server);
    sessions.set(transport.sessionId, transport);
    res.once('close', () => { sessions.delete(transport.sessionId); void closeClient(server); });
    try { await server.connect(transport); }
    catch (error) { fail(res, error); await closeClient(server); }
  });
  app.post('/messages', async (req, res) => {
    const transport = sessions.get(req.query.sessionId);
    if (!transport) return res.status(404).json({ error: 'Unknown fixture SSE session.' });
    try { await transport.handlePostMessage(req, res, req.body); }
    catch (error) { fail(res, error); }
  });
  app.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(error.status ?? 500).json({ error: 'Invalid fixture request.' });
  });
  const http = createServer(app);
  const sockets = new Set();
  http.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { http.once('error', reject); http.listen(port, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${http.address().port}`;
  return { url, controlToken, state,
    async close() {
      await Promise.allSettled([...clients].map(closeClient));
      const closed = new Promise((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}

export async function main(args = process.argv.slice(2)) {
  let transport = 'http';
  let port = 9317;
  let controlPort;
  for (const arg of args) {
    if (arg === '--transport=stdio' || arg === '--transport=http') transport = arg.slice('--transport='.length);
    else if (/^--port=\d+$/.test(arg)) port = Number(arg.slice('--port='.length));
    else if (/^--control-port=\d+$/.test(arg)) controlPort = Number(arg.slice('--control-port='.length));
    else throw new Error(`Unknown fixture option: ${arg}`);
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be 0..65535.');
  if (controlPort !== undefined && (!Number.isInteger(controlPort) || controlPort < 0 || controlPort > 65535)) {
    throw new Error('Control port must be 0..65535.');
  }
  if (controlPort !== undefined && transport !== 'stdio') throw new Error('--control-port is for stdio fixtures only.');
  const printStartup = fixture => process.stderr.write(`${JSON.stringify({ fixture: 'feature-surface', url: fixture.url,
    controlToken: fixture.controlToken, definitionSha256: DEFINITION_SHA256 })}\n`);
  if (transport === 'stdio') {
    const state = createFixtureState();
    const controller = controlPort === undefined ? null : await startHttpFixture({ port: controlPort, state });
    if (controller) printStartup(controller);
    const server = createFixtureServer(state);
    try { await server.connect(new StdioServerTransport()); }
    catch (error) { await controller?.close(); throw error; }
    let closing = false;
    const close = () => {
      if (closing) return;
      closing = true;
      void Promise.all([server.close(), controller?.close()]).catch(error => {
        process.stderr.write(`Fixture cleanup failed: ${error.message}\n`);
        process.exitCode = 1;
      });
    };
    // The SDK client first ends stdin; release the optional listener at that boundary.
    process.stdin.once('end', close);
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    return;
  }
  const fixture = await startHttpFixture({ port });
  // Keep stdout reserved for MCP when using stdio. Never print tool arguments.
  printStartup(fixture);
  process.once('SIGINT', () => { void fixture.close(); });
  process.once('SIGTERM', () => { void fixture.close(); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
