const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { readFileSync } = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const OpenAI = require('openai');
const ts = require('typescript');

// Compile the production factory and its two actual configuration imports.
// Native Node processes preserve the SDK's native abort/error identities.
const root = path.resolve(__dirname, '..');
const aliases = {
  '@/shared/config/timeouts': 'src/shared/config/timeouts.ts',
  '@/shared/types/model/provider': 'src/shared/types/model/provider.ts',
};
function loadSource(relative) {
  const filename = path.join(root, relative);
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const nativeRequire = loaded.require.bind(loaded);
  loaded.require = name => aliases[name] ? loadSource(aliases[name]) : nativeRequire(name);
  const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), {
    fileName: filename, reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  });
  assert.ok(!compiled.diagnostics?.some(item => item.category === ts.DiagnosticCategory.Error));
  loaded._compile(compiled.outputText, filename);
  return loaded.exports;
}
const { createOpenAIClient } = loadSource('src/backend/services/model/openaiClient.ts');

describe(`production OpenAI transport on actual Node ${process.version}`, () => {
  const requests = [];
  const pending = new Set();
  let mode = 'reply';
  let client;
  const server = createServer(async (request, response) => {
    pending.add(response);
    response.once('close', () => pending.delete(response));
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ connection: request.headers.connection, body: JSON.parse(body) });
    if (mode === 'timeout') return;
    if (mode === 'retry' && requests.length === 1) {
      response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' });
      response.end(JSON.stringify({ error: { message: 'fixture rate limit', type: 'rate_limit_error' } }));
      return;
    }
    if (mode === 'invalid') {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'fixture invalid request', type: 'invalid_request_error' } }));
      return;
    }
    if (mode === 'stream' || mode === 'stop') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const event = content => `data: ${JSON.stringify({ id: 'fixture-stream', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`;
      response.write(event('hello'));
      if (mode === 'stop') return;
      response.end(`${event(' world')}data: [DONE]\n\n`);
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: 'fixture-reply', object: 'chat.completion', model: 'fixture', choices: [{ index: 0, message: { role: 'assistant', content: 'hello world' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } }));
  });

  before(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    client = createOpenAIClient({ apiKey: 'fixture-only', baseURL: `http://127.0.0.1:${address.port}/v1`, maxRetries: 0, timeout: 2_000 });
  });
  beforeEach(() => { requests.length = 0; mode = 'reply'; });
  afterEach(() => { for (const response of pending) response.destroy(); });
  after(async () => {
    for (const response of pending) response.destroy();
    await client.fetchOptions.dispatcher.close();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const input = { model: 'fixture', messages: [{ role: 'user', content: 'hello' }] };

  it('sends actual JSON with connection-close and preserves replies and usage', async () => {
    const reply = await client.chat.completions.create(input);
    assert.equal(reply.choices[0].message.content, 'hello world');
    assert.equal(reply.usage.total_tokens, 4);
    assert.deepEqual(requests, [{ connection: 'close', body: input }]);
  });
  it('reads an actual streamed reply to completion', async () => {
    mode = 'stream';
    const stream = await client.chat.completions.create({ ...input, stream: true });
    let reply = '';
    for await (const event of stream) reply += event.choices[0].delta.content ?? '';
    assert.equal(reply, 'hello world');
  });
  it('retries an actual 429 within the SDK retry budget', async () => {
    mode = 'retry';
    const reply = await client.chat.completions.create(input, { maxRetries: 1 });
    assert.equal(reply.choices[0].message.content, 'hello world');
    assert.equal(requests.length, 2);
  });
  it('reports a provider 400 without retrying', async () => {
    mode = 'invalid';
    await assert.rejects(client.chat.completions.create(input, { maxRetries: 1 }), { status: 400 });
    assert.equal(requests.length, 1);
  });
  it('reports the SDK timeout for a connected provider that never replies', async () => {
    mode = 'timeout';
    await assert.rejects(client.chat.completions.create(input, { timeout: 100 }), OpenAI.APIConnectionTimeoutError);
    assert.equal(requests.length, 1);
  });
  it('aborts the actual response stream when the caller stops reading', async () => {
    mode = 'stop';
    const stream = await client.chat.completions.create({ ...input, stream: true });
    for await (const event of stream) {
      assert.equal(event.choices[0].delta.content, 'hello');
      break;
    }
    assert.equal(stream.controller.signal.aborted, true);
    assert.equal(requests.length, 1);
  });
});
