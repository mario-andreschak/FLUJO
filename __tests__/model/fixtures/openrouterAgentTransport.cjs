// Run outside Jest's module transformer so the installed Agent SDK and its
// generated request/response validators execute unchanged against loopback HTTP.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const http = require('node:http');
const assert = require('node:assert/strict');
const root = path.resolve(process.argv[2]);
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'flujo-agent-transport-'));
process.env.FLUJO_DATA_DIR = data;
const ts = require(path.join(root, 'node_modules/typescript'));
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request.startsWith('@/')) request = path.join(root, 'src', request.slice(2));
  return resolve.call(this, request, parent, ...rest);
};
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, file);
const { OpenRouterAgentAdapter } = require(path.join(root, 'src/backend/services/model/adapters/openrouterAgentAdapter.ts'));
const { FlowExecutionAuthorityError } = require(path.join(root, 'src/backend/execution/flow/executionAuthority.ts'));
const { ModelTurnArchiveMemoryError } = require(path.join(root, 'src/backend/execution/flow/modelTurnArchiveWriteBudget.ts'));
let scenario = 'completed';
const requests = [];
const schema = JSON.parse('{"type":"object","properties":{"snake_name":{"type":"string"},"constructor":{"type":"string"},"__proto__":{"type":"string"}},"anyOf":[{"required":["snake_name"]},{"required":["constructor"]}]}');
const calls = [0, 1].map(index => ({ type: 'function_call', id: `fc_${index}`, call_id: `call_${index}`,
  name: 'bash_run', arguments: '{"snake_name":"kept","constructor":"kept"}', status: 'completed' }));
const result = status => ({ id: 'resp_1', object: 'response', model: 'test/model', created_at: 100, completed_at: 101,
  status, error: null, incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
  instructions: null, metadata: null, frequency_penalty: null, presence_penalty: null,
  parallel_tool_calls: true, temperature: null, top_p: null, tool_choice: 'auto', tools: [], output: calls,
  usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120,
    input_tokens_details: { cached_tokens: 80 }, output_tokens_details: { reasoning_tokens: 10 } } });
const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  requests.push({ path: req.url, body: JSON.parse(body) });
  if (scenario === 'http-error') { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":{"message":"fixture unavailable","code":503}}'); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = value => res.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
  calls.forEach((item, index) => {
    event({ type: 'response.output_item.added', sequence_number: index * 2, output_index: index,
      item: { ...item, arguments: '' } });
    event({ type: 'response.function_call_arguments.delta', sequence_number: index * 2 + 1,
      output_index: index, item_id: item.id, delta: item.arguments });
  });
  event({ type: 'response.completed', sequence_number: 5, response: result(scenario) });
  res.end('data: [DONE]\n\n');
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const input = () => ({ apiKey: 'fixture-only', model: { id: 'fixture', provider: 'openrouter', adapter: 'openrouter-agent',
    name: 'test/model', baseUrl: `http://127.0.0.1:${server.address().port}/api/v1` },
    messages: [{ role: 'user', content: 'fixture' }],
    tools: [{ type: 'function', function: { name: 'mcp:bash:run', parameters: schema } }],
    toolNameMap: { 'mcp:bash:run': { server: 'bash', tool: 'run' } } });
  const adapter = new OpenRouterAgentAdapter();
  const archived = [], settled = [], deltas = [];
  const answer = await adapter.createStreamCompletion({ ...input(), onModelDelta: delta => deltas.push(delta),
    onSdkRequest: async request => { archived.push(request); return 'dispatch'; },
    onSdkRequestResult: async value => { settled.push(value); } });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/api/v1/responses');
  assert.deepEqual(requests[0].body.tools[0].parameters, schema);
  assert.equal(requests[0].body.stream, true);
  assert.equal(requests[0].body.store, false);
  assert.equal(requests[0].body.prompt_cache_options, undefined);
  assert.equal(answer.completion.choices[0].message.tool_calls.length, 2);
  assert.equal(answer.completion.choices[0].message.tool_calls[0].function.name, 'mcp:bash:run');
  assert.equal(answer.completion.usage.prompt_tokens, 100);
  assert.deepEqual([...new Set(deltas.map(delta => delta.toolCallDelta?.index))], [0, 1]);
  assert.deepEqual(settled, [{ dispatchId: 'dispatch', outcome: 'completed' }]);
  assert.ok(!JSON.stringify(archived).includes('fixture-only'));
  for (const refusal of [new FlowExecutionAuthorityError('fixture authority'), new ModelTurnArchiveMemoryError('MODEL_TURN_ARCHIVE_MEMORY_LIMIT')]) {
    const before = requests.length;
    await assert.rejects(adapter.createCompletion({ ...input(), onSdkRequest: async () => { throw refusal; } }), error => error === refusal);
    assert.equal(requests.length, before);
  }
  const abort = new AbortController(); abort.abort(new Error('fixture stopped'));
  const before = requests.length;
  await assert.rejects(adapter.createCompletion({ ...input(), signal: abort.signal }), /fixture stopped/);
  assert.equal(requests.length, before);
  const duringAdmission = new AbortController();
  const cancellation = new Error('fixture admission cancelled');
  const admissionOutcomes = [];
  await assert.rejects(adapter.createCompletion({ ...input(), signal: duringAdmission.signal,
    onSdkRequest: async () => { duringAdmission.abort(cancellation); return 'admitted'; },
    onSdkRequestResult: async value => { admissionOutcomes.push(value); },
  }), error => error === cancellation);
  assert.equal(requests.length, before);
  assert.deepEqual(admissionOutcomes, [{ dispatchId: 'admitted', outcome: 'cancelled' }]);
  const duringStream = new AbortController();
  const streamCancellation = new Error('fixture stream cancelled');
  const streamOutcomes = [];
  await assert.rejects(adapter.createStreamCompletion({ ...input(), signal: duringStream.signal,
    onModelDelta: () => duringStream.abort(streamCancellation),
    onSdkRequest: async () => 'stream',
    onSdkRequestResult: async value => { streamOutcomes.push(value); },
  }), error => error === streamCancellation);
  assert.deepEqual(streamOutcomes, [{ dispatchId: 'stream', outcome: 'cancelled' }]);
  scenario = 'incomplete';
  assert.equal((await adapter.createCompletion(input())).completion.choices[0].finish_reason, 'length');
  for (const status of ['failed', 'cancelled', 'in_progress', 'queued']) {
    scenario = status;
    const outcomes = [];
    await assert.rejects(adapter.createCompletion({ ...input(), onSdkRequest: async () => 'status',
      onSdkRequestResult: async value => { outcomes.push(value.outcome); } }));
    assert.deepEqual(outcomes, [status === 'cancelled' ? 'cancelled' : 'error']);
  }
  scenario = 'http-error';
  const beforeFailure = requests.length;
  await assert.rejects(adapter.createCompletion(input()));
  assert.equal(requests.length, beforeFailure + 1, 'SDK must not retry a provider turn');
  console.log(JSON.stringify({ contract: 'real-sdk-loopback', assertions: 'passed', requests: requests.length }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  fs.rmSync(data, { recursive: true, force: true });
});
