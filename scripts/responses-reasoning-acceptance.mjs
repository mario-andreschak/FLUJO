import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Run through flujo-bash in a task-owned profile. This exercises the emitted
// production adapters and real SDK HTTP serialization against a local fixture.
// It does not dispatch inference or qualify genuine provider opaque state.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const report = process.argv[2];
assert(report && path.isAbsolute(report), 'Pass a new absolute report path inside the owned run');
process.env.FLUJO_DATA_DIR = path.join(path.dirname(report), 'transport-profile');
process.env.NEXT_TELEMETRY_DISABLED = '1';
const require = createRequire(path.join(repo, 'package.json'));
const hash = value => createHash('sha256').update(value).digest('hex');
const evidence = { issue: 1091, startedUtc: new Date().toISOString(),
  kind: 'emitted-adapter-controlled-http', cases: [], requests: [], responses: [], providerCalls: 0,
  limits: ['Synthetic opaque strings and read-only tool history; no tool executes',
    'No genuine provider reasoning/signature, native compaction window or CLI resume qualification',
    'No browser, installed artifact, release or endurance qualification'] };

const runtime = require(path.join(repo, '.next/server/webpack-runtime.js'));
// Admit only the production Chat route's module graph. Other Next server
// layers contain separate compiled copies of the same adapter source.
require(path.join(repo, '.next/server/app/v1/chat/completions/route.js'));
function loadFactory(marker) {
  const factories = Object.entries(runtime.m).filter(([, factory]) => factory.toString().includes(marker));
  assert.equal(factories.length, 1, `Expected one emitted factory for ${marker}`);
  const [id, factory] = factories[0];
  return { exports: runtime(id), factoryId: id, factorySha256: hash(factory.toString()) };
}
const responses = loadFactory('backend/services/model/adapters/openaiResponsesAdapter');
const registry = loadFactory('OpenRouter Agent SDK does not support ultra reasoning effort');
assert.equal(typeof registry.exports.getCompletionAdapter, 'function');
const adapters = ['openai-responses', 'openrouter-agent'];
evidence.buildId = (await fs.readFile(path.join(repo, '.next/BUILD_ID'), 'utf8')).trim();
evidence.factories = [responses, registry].map(({ factoryId, factorySha256 }) => ({ factoryId, factorySha256 }));

const server = createServer(async (request, outgoing) => {
  try {
    assert(request.url.endsWith('/responses'), 'Only the local Responses fixture is permitted');
    let raw = '';
    for await (const bytes of request) raw += bytes;
    const body = JSON.parse(raw), index = evidence.requests.length;
    evidence.requests.push({ index, path: request.url, body });
    const output = [
      { type: 'reasoning', id: `fixture-reasoning-${index}`, summary: [], encrypted_content: `opaque-ñ-${index}-unchanged` },
      { type: 'message', id: `fixture-message-${index}`, status: 'completed', role: 'assistant', phase: 'commentary',
        content: [{ type: 'output_text', text: 'Checking.', annotations: [] }] },
      { type: 'function_call', id: `fixture-item-${index}`, status: 'completed', call_id: `fixture-call-${index}`,
        name: 'read_status', arguments: '{"record":"current"}' },
      { type: 'reasoning', id: `fixture-reasoning-tail-${index}`, summary: [], encrypted_content: `opaque-tail-ñ-${index}` },
      { type: 'function_call', id: `fixture-item-tail-${index}`, status: 'completed', call_id: `fixture-call-tail-${index}`,
        name: 'read_status', arguments: '{"record":"current"}' },
      { type: 'message', id: `fixture-message-tail-${index}`, status: 'completed', role: 'assistant', phase: 'final_answer',
        content: [{ type: 'output_text', text: 'Waiting.', annotations: [] }] },
    ].filter(item => fixtureMode === 'plain-final' ? item.type === 'message'
      : fixtureMode === 'final' ? item.type !== 'function_call' : true);
    const response = { id: `fixture-response-${index}`, created_at: 1700000000, model: body.model,
      completed_at: 1700000001, error: null, incomplete_details: null, instructions: null,
      frequency_penalty: null, presence_penalty: null, metadata: null,
      parallel_tool_calls: true, temperature: 0, top_p: 1, tool_choice: 'auto', tools: [],
      object: 'response', status: fixtureMode === 'incomplete' ? 'incomplete' : 'completed', output,
      ...(fixtureMode === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
      usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30,
        input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
    evidence.responses.push(response);
    if (body.stream) {
      outgoing.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = event => outgoing.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      send({ type: 'response.created', sequence_number: 0, response: { ...response, status: 'in_progress', output: [] } });
      response.output.forEach((item, output_index) => send({ type: 'response.output_item.done',
        sequence_number: output_index + 1, output_index, item }));
      send({ type: 'response.completed', sequence_number: 4, response });
      outgoing.end('data: [DONE]\n\n');
    } else outgoing.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(response));
  } catch (error) {
    evidence.fixtureError = error.message;
    outgoing.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: error.message } }));
  }
});
let fixtureMode = 'tool-loop';
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;
const modifications = [
  ['unchanged', () => undefined, true],
  ['model', next => { next.model = { ...next.model, name: 'fixture-b' }; }, false],
  ['connection', next => { next.model = { ...next.model, id: 'connection-b' }; }, false],
  ['endpoint', next => { next.model = { ...next.model, baseUrl: baseUrl.replace('/api/v1', '/other/v1') }; }, false],
  ['credential', next => { next.apiKey = 'second-local-fixture-key'; }, false],
  ['tools', next => { next.tools = []; }, false],
  ['instruction', next => { next.messages[0] = { role: 'system', content: 'Read only; ask before any change.' }; }, false],
  ['source', next => { next.messages[1] = { role: 'user', content: 'Read another record.' }; }, false],
  ['arguments', next => { next.messages[2].tool_calls[0].function.arguments = '{"record":"another"}'; }, false],
  ['summary-projection', next => { next.messages.splice(1, 1, { role: 'system', content: 'Summary of earlier work.' }); }, false],
];
try {
  for (const name of adapters) {
    for (const streaming of [false, true]) {
      for (const [change, modify, reuse] of modifications) {
        const before = evidence.requests.length;
        const input = { model: { id: 'connection-a', name: 'fixture-a', provider: 'openrouter',
          adapter: name, baseUrl, contextWindow: 32000 }, apiKey: 'local-fixture-key', temperature: 0,
          maxTokens: 200, conversationId: randomUUID(), nodeId: 'existing-node',
          messages: [{ role: 'system', content: 'Read only; do not send or change anything.' },
            { role: 'user', content: 'Read the current record.' }],
          tools: [{ type: 'function', function: { name: 'mcp:read:status', description: 'Read a record',
            parameters: { type: 'object', properties: { record: { type: 'string' } }, required: ['record'] } } }],
          toolNameMap: { 'mcp:read:status': { server: 'read', tool: 'status' } } };
        const adapter = registry.exports.getCompletionAdapter(input.model, name);
        const first = await adapter.createCompletion(input);
        const next = { ...input, messages: [...input.messages,
          structuredClone(first.completion.choices[0].message),
          ...first.completion.choices[0].message.tool_calls.map(call => ({ role: 'tool', tool_call_id: call.id,
            content: 'Current record is ready.' }))] };
        modify(next);
        await adapter[streaming ? 'createStreamCompletion' : 'createCompletion'](next);
        assert.equal(evidence.requests.length, before + 2, 'Exactly two local HTTP requests; no retry');
        const carried = evidence.requests[before + 1].body.input.filter(item => item.type === 'reasoning');
        assert.equal(carried.length, reuse ? 2 : 0, `${name}/${streaming}/${change}`);
        if (reuse) assert.deepEqual(evidence.requests[before + 1].body.input.slice(2, -2), evidence.responses[before].output,
          'SDK HTTP must preserve the complete native window, including interleaving, IDs, phases and aliases');
        evidence.cases.push({ adapter: name, streaming, change, reuse, outcome: 'passed', requestIndexes: [before, before + 1] });
      }
      for (const mode of ['final', 'plain-final', 'incomplete', 'three-turns']) {
        fixtureMode = mode;
        const before = evidence.requests.length;
        const input = { model: { id: 'connection-a', name: 'fixture-a', provider: 'openrouter', adapter: name,
          baseUrl, contextWindow: 32000 }, apiKey: 'local-fixture-key', temperature: 0, maxTokens: 200,
          conversationId: randomUUID(), nodeId: 'existing-node', messages: [{ role: 'user', content: 'Read only.' }],
          tools: [{ type: 'function', function: { name: 'read_status', parameters: { type: 'object', properties: {} } } }] };
        const adapter = registry.exports.getCompletionAdapter(input.model, name);
        const append = completion => {
          input.messages.push(structuredClone(completion.choices[0].message));
          for (const call of completion.choices[0].message.tool_calls ?? []) input.messages.push({ role: 'tool',
            tool_call_id: call.id, content: 'Read-only result ' + call.id });
        };
        const invoke = () => adapter[streaming ? 'createStreamCompletion' : 'createCompletion'](input);
        append((await invoke()).completion);
        if (mode === 'three-turns') append((await invoke()).completion);
        input.messages.push({ role: 'user', content: 'Continue without changes.' });
        const canonical = JSON.stringify(input.messages);
        await invoke();
        const request = evidence.requests.at(-1).body.input;
        if (mode === 'incomplete') assert(!request.some(item => item.id || item.type === 'reasoning'));
        else {
          const first = evidence.responses[before].output;
          assert.deepEqual(request.slice(1, 1 + first.length), first);
          if (mode === 'three-turns') assert.deepEqual(request.slice(1 + first.length + 2, -3), evidence.responses[before + 1].output);
        }
        assert.equal(JSON.stringify(input.messages), canonical, 'Replay must leave the canonical conversation intact');
        assert.equal(evidence.requests.length, before + (mode === 'three-turns' ? 3 : 2));
        evidence.cases.push({ adapter: name, streaming, change: mode, outcome: 'passed',
          requestIndexes: Array.from({ length: evidence.requests.length - before }, (_, index) => before + index) });
        fixtureMode = 'tool-loop';
      }
    }
  }
  evidence.outcome = 'passed';
} catch (error) {
  evidence.outcome = 'failed'; evidence.error = error.message; process.exitCode = 1;
} finally {
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  evidence.fixtureClosed = !server.listening;
  evidence.finishedUtc = new Date().toISOString();
  await fs.writeFile(report, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ outcome: evidence.outcome, cases: evidence.cases.length,
    localRequests: evidence.requests.length, providerCalls: 0, fixtureClosed: evidence.fixtureClosed, report }));
}
