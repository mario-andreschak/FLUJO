import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { APP_URI, RECEIPT_URI, DEFINITION_SHA256, startHttpFixture } from './fixture-server.mjs';

const fixturePath = fileURLToPath(new URL('./fixture-server.mjs', import.meta.url));
const client = () => new Client({ name: 'feature-surface-protocol-check', version: '1.0.0' });

async function collectPages(connection) {
  const tools = [];
  const cursors = new Set();
  let cursor;
  for (let page = 0; page < 8; page += 1) {
    const result = await connection.listTools(cursor === undefined ? undefined : { cursor });
    tools.push(...result.tools);
    if (result.nextCursor === undefined) return { tools, pageCount: page + 1 };
    assert.ok(!cursors.has(result.nextCursor), 'fixture sent a cursor cycle');
    cursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  assert.fail('fixture exceeded eight pages');
}

async function receipt(connection) {
  const resource = await connection.readResource({ uri: RECEIPT_URI });
  return JSON.parse(resource.contents[0].text);
}

async function checkProtocol(connection) {
  assert.deepEqual(connection.getServerCapabilities().extensions?.['io.modelcontextprotocol/ui'],
    { mimeTypes: ['text/html;profile=mcp-app'] });
  const initial = await receipt(connection);
  assert.equal(initial.toolCalls, 0);
  const { tools, pageCount } = await collectPages(connection);
  assert.equal(pageCount, 4);
  assert.equal(tools.length, 128);
  assert.equal(new Set(tools.map(tool => tool.name)).size, 128);
  assert.equal(tools[0].name, 'fixture_tool_001');
  assert.equal(tools.at(-1).name, 'fixture_tool_128');
  assert.deepEqual(tools.at(-1).inputSchema.required, ['element', 'ref']);
  assert.equal(tools.at(-1)._meta.ui.resourceUri, APP_URI);
  assert.equal(tools.at(-1).outputSchema.type, 'object');

  const resources = await connection.listResources();
  assert.ok(resources.resources.some(resource => resource.uri === APP_URI));
  const app = await connection.readResource({ uri: APP_URI });
  assert.equal(app.contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.match(app.contents[0].text, /ui\/initialize/);
  assert.deepEqual(app.contents[0]._meta.ui.csp.connectDomains, []);
  assert.equal((await connection.listPrompts()).prompts[0].name, 'fixture-summary');
  const prompt = await connection.getPrompt({ name: 'fixture-summary', arguments: { marker: 'synthetic-marker' } });
  assert.match(prompt.messages[0].content.text, /fixture_tool_128/);
  assert.equal((await receipt(connection)).toolCalls, 0, 'discovery/resources/prompts must never execute a tool');

  const firstArgs = { url: 'https://example.invalid/synthetic', options: { formats: ['markdown'], nested: { marker: 'fixture' } } };
  const lastArgs = { element: 'synthetic receipt', ref: 'synthetic-marker', modifiers: ['Shift'], options: { count: 1 }, enabled: false, button: 'right' };
  for (const [name, args] of [['fixture_tool_001', firstArgs], ['fixture_tool_128', lastArgs]]) {
    const result = await connection.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, { toolName: name, arguments: args });
  }
  const final = await receipt(connection);
  assert.equal(final.runId, initial.runId);
  assert.equal(final.definitionSha256, DEFINITION_SHA256);
  assert.equal(final.toolCalls, 2);
  assert.equal(final.acceptedCalls, 2);
  assert.equal(final.recentCalls.at(-1).toolName, 'fixture_tool_128');
  assert.equal(final.recentCalls.at(-1).argumentsSha256,
    createHash('sha256').update(JSON.stringify(lastArgs)).digest('hex'));
  assert.ok(!JSON.stringify(final).includes('synthetic-marker'), 'receipt must not contain raw arguments');

  const invalid = await connection.callTool({ name: 'fixture_tool_128', arguments: { element: 'missing ref' } });
  assert.equal(invalid.isError, true);
  const rejected = await receipt(connection);
  assert.equal(rejected.toolCalls, 3);
  assert.equal(rejected.acceptedCalls, 2);
  assert.equal(rejected.recentCalls.at(-1).accepted, false);
}

for (const protocol of ['Streamable HTTP', 'legacy SSE']) {
  test(`${protocol}: all 128 definitions, explicit early/late calls, resources and prompts`, { timeout: 15000 }, async t => {
    const fixture = await startHttpFixture();
    t.after(() => fixture.close());
    const connection = client();
    t.after(() => connection.close());
    const transport = protocol === 'Streamable HTTP'
      ? new StreamableHTTPClientTransport(new URL(`${fixture.url}/mcp`))
      : new SSEClientTransport(new URL(`${fixture.url}/sse`));
    await connection.connect(transport);
    await checkProtocol(connection);
  });
}

test('stdio child process: protocol-only stdout, all 128 definitions and explicit calls', { timeout: 15000 }, async t => {
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fixturePath, '--transport=stdio'], stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', data => { stderr = (stderr + data.toString()).slice(-8192); });
  const connection = client();
  const protocolErrors = [];
  connection.onerror = error => protocolErrors.push(error.message);
  t.after(() => connection.close());
  await connection.connect(transport);
  assert.ok(transport.pid > 0);
  await checkProtocol(connection);
  assert.equal(stderr, '');
  assert.deepEqual(protocolErrors, []);
});

test('stdio optional loopback controller changes the same child state without invoking tools', { timeout: 15000 }, async t => {
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fixturePath, '--transport=stdio', '--control-port=0'], stderr: 'pipe' });
  let startup = '';
  transport.stderr?.on('data', data => { startup = (startup + data.toString()).slice(-8192); });
  const connection = client();
  t.after(() => connection.close());
  await connection.connect(transport);
  const controller = JSON.parse(startup.trim());
  assert.match(controller.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const initial = await receipt(connection);
  assert.equal((await (await fetch(`${controller.url}/receipt`)).json()).runId, initial.runId);
  const configure = async mode => {
    const response = await fetch(`${controller.url}/control`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fixture-control': controller.controlToken }, body: JSON.stringify({ mode }) });
    assert.equal(response.status, 200);
  };
  await configure('fail-second-page');
  await assert.rejects(connection.listTools({ cursor: '32' }), /Intentional fixture second-page failure/);
  await configure('empty');
  assert.deepEqual((await connection.listTools()).tools, []);
  await configure('normal');
  assert.equal((await collectPages(connection)).tools.length, 128);
  assert.equal((await receipt(connection)).toolCalls, 0);
  const result = await connection.callTool({ name: 'fixture_tool_128', arguments: { element: 'controlled stdio', ref: 'synthetic' } });
  assert.equal(result.structuredContent.toolName, 'fixture_tool_128');
  assert.equal((await (await fetch(`${controller.url}/receipt`)).json()).toolCalls, 1);
  await connection.close();
  await assert.rejects(fetch(`${controller.url}/receipt`, { signal: AbortSignal.timeout(1000) }));
});

test('HTTP controls exercise page failure, cycles, empty and delayed discovery without tool calls', { timeout: 15000 }, async t => {
  const fixture = await startHttpFixture();
  t.after(() => fixture.close());
  const connection = client();
  t.after(() => connection.close());
  await connection.connect(new StreamableHTTPClientTransport(new URL(`${fixture.url}/mcp`)));
  const configure = async body => {
    const response = await fetch(`${fixture.url}/control`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fixture-control': fixture.controlToken }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
  };
  await configure({ mode: 'fail-second-page' });
  assert.equal((await connection.listTools()).tools.length, 32);
  await assert.rejects(connection.listTools({ cursor: '32' }), /Intentional fixture second-page failure/);
  await configure({ mode: 'cycle' });
  await assert.rejects(collectPages(connection), /cursor cycle/);
  await configure({ mode: 'empty' });
  assert.deepEqual((await connection.listTools()).tools, []);
  await configure({ mode: 'delay', delayMs: 100 });
  const before = performance.now();
  assert.equal((await connection.listTools()).tools.length, 32);
  assert.ok(performance.now() - before >= 80);
  await configure({ mode: 'normal' });
  assert.equal((await collectPages(connection)).tools.length, 128);
  assert.equal((await receipt(connection)).toolCalls, 0);
});

test('loopback controls reject missing tokens, foreign origins/hosts, invalid modes and oversized bodies', { timeout: 15000 }, async t => {
  const fixture = await startHttpFixture();
  t.after(() => fixture.close());
  const request = (path, options) => fetch(`${fixture.url}${path}`, options);
  // Node fetch rewrites Host; use the HTTP API to actually send the hostile header.
  const hostileHostStatus = await new Promise((resolve, reject) => {
    const outgoing = httpRequest(`${fixture.url}/receipt`, { headers: { host: 'untrusted.example' } }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    outgoing.once('error', reject);
    outgoing.end();
  });
  assert.equal(hostileHostStatus, 403);
  assert.equal((await request('/receipt', { headers: { origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await request('/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"mode":"empty"}' })).status, 403);
  const headers = { 'content-type': 'application/json', 'x-fixture-control': fixture.controlToken };
  for (const body of [{ mode: 'unknown' }, { mode: 'delay', delayMs: 30001 }, { mode: 'normal', extra: true }]) {
    assert.equal((await request('/control', { method: 'POST', headers, body: JSON.stringify(body) })).status, 400);
  }
  assert.equal((await request('/control', { method: 'POST', headers,
    body: JSON.stringify({ mode: 'normal', extra: 'x'.repeat(65536) }) })).status, 413);
  assert.equal((await request('/messages?sessionId=missing', { method: 'POST', headers, body: '{}' })).status, 404);
  assert.equal((await request('/mcp', {})).status, 405);
  assert.equal((await request('/receipt', {})).status, 200);
});
