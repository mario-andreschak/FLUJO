import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Replay a genuine HTTP-200 failure through the built SDK/adapter. All HTTP
// destinations are loopback; controlled success/opaque items are fixtures.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [report, failedReport, qualifiedReport, buildReport] = process.argv.slice(2);
assert(report && failedReport && qualifiedReport && buildReport && path.isAbsolute(report));
await assert.rejects(fs.access(report), { code: 'ENOENT' });
const hash = value => createHash('sha256').update(value).digest('hex');
const profile = path.join(path.dirname(report), 'semantic-profile-' + randomUUID());
process.env.FLUJO_DATA_DIR = profile;
process.env.FLUJO_PARENT_DATA_DIR = profile;
process.env.NEXT_TELEMETRY_DISABLED = '1';
const require = createRequire(path.join(repo, 'package.json'));
const runtime = require(path.join(repo, '.next/server/webpack-runtime.js'));
require(path.join(repo, '.next/server/app/v1/chat/completions/route.js'));
function factory(marker) {
  const found = Object.entries(runtime.m).filter(([, value]) => value.toString().includes(marker));
  assert.equal(found.length, 1, marker);
  return { exports: runtime(found[0][0]), id: found[0][0], sha256: hash(found[0][1].toString()) };
}
const translation = factory('backend/services/model/adapters/openaiResponsesAdapter');
const translators = Object.values(translation.exports).filter(value => typeof value === 'function'
  && value.toString().includes('chat.completion'));
assert.equal(translators.length, 1);
const fromResponse = translators[0];
const registry = factory('backend/services/model/adapters/codexAdapter').exports;
const original = JSON.parse(await fs.readFile(failedReport, 'utf8'));
const captured = original.calls.find(call => call.responseStatus === 'failed');
assert(captured && captured.httpStatus === 200);
const failed = JSON.parse(captured.responseWire);
assert.equal(failed.status, 'failed');
assert.equal(failed.error.code, 'server_error');
assert.equal(failed.model, 'nvidia/nemotron-3-super-120b-a12b:free');
const qualified = JSON.parse(await fs.readFile(qualifiedReport, 'utf8'));
assert.equal(qualified.status, 'completed');
assert.equal(qualified.summary.protected.exact, 10);
assert.equal(qualified.summary.protected.transformed, 10);
const packets = new Map(qualified.calls.map(call => {
  const response = JSON.parse(call.responseWire);
  assert.equal(response.status, 'completed');
  return [response.id, response];
}));
let replayed = 0;
for (const round of qualified.rounds) for (const row of round.results) {
  for (const reply of [...(row.summary ? [row.summary] : []), ...row.continuations]) {
    const response = packets.get(reply.completionId);
    assert(response);
    const translated = fromResponse(response, qualified.route.model).completion;
    const choice = translated.choices[0];
    assert.equal(translated.id, reply.completionId);
    assert.equal(choice.message.content ?? '', reply.text);
    assert.deepEqual(choice.message.tool_calls ?? [], reply.toolCalls);
    assert.deepEqual(JSON.parse(JSON.stringify(translated.usage)), reply.usage);
    replayed++;
  }
}
assert.equal(replayed, packets.size, 'Replay every real completed response in the qualified matrix');
assert.throws(() => fromResponse(failed, failed.model), /stream closed with reason: error/);

const token = randomBytes(32).toString('base64url');
const calls = [], messages = [{ role: 'user', content: 'Check the saved observation.' }];
let phase = 'seed', session;
const seed = { id: 'fixture-seed', object: 'response', created_at: 1700000000, model: failed.model, status: 'completed',
  error: null, output: [
    { type: 'reasoning', id: 'fixture-reasoning', summary: [], encrypted_content: 'SYNTHETIC-LOCAL-OPAQUE-ONLY' },
    { type: 'function_call', id: 'fixture-call-item', call_id: 'fixture-call', name: 'read_status', arguments: '{}' },
  ], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } };
const retry = { ...seed, id: 'fixture-retry', output: [{ type: 'message', id: 'fixture-message', role: 'assistant',
  content: [{ type: 'output_text', text: 'Recovered.' }] }] };
const server = createServer(async (incoming, outgoing) => {
  try {
    assert(incoming.url.endsWith('/responses'));
    assert.equal(incoming.headers.authorization, 'Bearer ' + token);
    let text = ''; for await (const bytes of incoming) text += bytes;
    const body = JSON.parse(text);
    assert.equal(body.model, failed.model);
    calls.push({ phase, body });
    if (phase === 'failed-stream') {
      assert.equal(body.stream, true);
      outgoing.writeHead(200, { 'Content-Type': 'text/event-stream' });
      outgoing.end('data: ' + JSON.stringify({ type: 'response.output_text.delta', delta: 'Partial preview', sequence_number: 0 })
        + '\n\ndata: ' + JSON.stringify({ type: 'response.failed', response: failed, sequence_number: 1 }) + '\n\n');
    } else {
      outgoing.writeHead(200, { 'Content-Type': 'application/json' });
      outgoing.end(phase === 'failed-json' ? captured.responseWire : JSON.stringify(phase === 'seed' ? seed : retry));
    }
  } catch (error) { outgoing.writeHead(500).end(JSON.stringify({ error: error.message })); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const model = { id: 'terminal-replay', name: failed.model, provider: 'OpenRouter', adapter: 'openai-responses',
  baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
const adapter = registry.getCompletionAdapter(model, 'openai-responses');
const input = () => ({ model, apiKey: token, messages, conversationId: 'terminal-' + path.basename(profile),
  nodeId: 'terminal', responsesSession: session, onResponsesSessionChange: value => { session = value; },
  signal: AbortSignal.timeout(30000) });
const evidence = { issue: 1091, kind: 'captured-failure-built-adapter-replay', profile,
  buildId: (await fs.readFile(path.join(repo, '.next/BUILD_ID'), 'utf8')).trim(),
  factory: { id: translation.id, sha256: translation.sha256 },
  actualProviderFailure: { responseId: failed.id, httpStatus: 200, status: failed.status,
    error: failed.error, rawSha256: hash(captured.responseWire) },
  realCompletedResponsesReplayed: replayed, originalQualifiedSourceTree: qualified.applicationSourceTree,
  upstreamRequests: 0, limits: ['Controlled SDK HTTP transports; synthetic seed/retry/opaque items',
    'Real inference/semantic fidelity belongs to the unchanged qualified matrix, not this local replay'] };
const build = JSON.parse(await fs.readFile(buildReport, 'utf8'));
assert.equal(build.exitCode, 0);
assert.equal(build.buildId, evidence.buildId);
evidence.finalApplicationSourceTree = build.sourceTree;
evidence.completedResponseTranslationUnchanged = true;
try {
  const first = await adapter.createCompletion(input());
  assert(session?.records.length > 0);
  const before = structuredClone(session);
  messages.push(first.completion.choices[0].message, { role: 'tool', tool_call_id: 'fixture-call', content: 'Observed.' },
    { role: 'user', content: 'Continue.' });
  const originalHash = hash(JSON.stringify(messages));
  phase = 'failed-json';
  await assert.rejects(adapter.createCompletion(input()), /stream closed with reason: error/);
  assert.deepEqual(session, before);
  phase = 'failed-stream';
  await assert.rejects(adapter.createStreamCompletion(input()), /stream closed with reason: error/);
  assert.deepEqual(session, before);
  phase = 'retry';
  const recovered = await adapter.createCompletion(input());
  assert.equal(recovered.completion.choices[0].message.content, 'Recovered.');
  assert.equal(hash(JSON.stringify(messages)), originalHash);
  assert.equal(calls.length, 4, 'No implicit retries of the failed provider output');
  assert(calls[3].body.input.some(item => item.type === 'reasoning' && item.encrypted_content === 'SYNTHETIC-LOCAL-OPAQUE-ONLY'));
  Object.assign(evidence, { status: 'passed', calls, checkpointPreservedThroughFailures: true,
    explicitRetryRecovered: true, canonicalInputUnchanged: true });
} catch (error) { evidence.status = 'failed'; evidence.error = error.stack.replaceAll(token, '[private]'); process.exitCode = 1; }
finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  evidence.finishedUtc = new Date().toISOString();
  await fs.writeFile(report, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ status: evidence.status, realCompletedResponsesReplayed: replayed, upstreamRequests: 0, error: evidence.error }));
}
