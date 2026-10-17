import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { instruction, scenario, scoreAnswer, summarizeMatrix, assertPairing, treatments } from './compaction-semantic-protocol.mjs';

// Offline replay of saved real provider replies and paired canonical inputs.
// This does not make inference requests or turn a failed case into a pass.
const hash = value => createHash('sha256').update(value).digest('hex');
const filename = process.argv[2];
assert(filename, 'Provide the raw private report or published .json.gz trace');
const bytes = await fs.readFile(filename);
const document = JSON.parse((filename.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8'));
const variant = process.argv[3] ?? 'final';
const evidence = document.final ? document[variant] : document;
assert(evidence, 'Choose final, freeComparison or paidBaseline from the published trace');
if (document.harnessSnapshots) {
  for (const snapshot of document.harnessSnapshots) assert.equal(hash(snapshot.text), snapshot.sha256);
  assert(document.harnessSnapshots.some(snapshot => snapshot.sha256 === evidence.sourceSha256['scripts/compaction-semantic-acceptance.mjs']));
}
assert.equal(evidence.status, 'completed');
assert.equal(evidence.rounds.length, 10);
assert(evidence.allWorkersClosed);
assert.deepEqual([...new Set(evidence.rounds.map(round => round.position))].sort(), ['early', 'late', 'middle']);
const responses = new Map(evidence.calls.filter(call => call.responseWire?.trim().startsWith('{'))
  .map(call => ({ call, response: JSON.parse(call.responseWire) })).map(item => [item.response.id, item]));
let failedProviderRepliesRetained = 0;
function bindActualReply(reply, originalSystem, creditedAsSuccessful) {
  if (evidence.route.adapter === 'codex-cli') return;
  const captured = responses.get(reply.completionId), response = captured?.response;
  assert(response, 'Bind every adapter reply to an actual provider response');
  if (response.status !== 'completed') {
    assert.equal(creditedAsSuccessful, false, 'A failed/incomplete provider response cannot earn successful acceptance');
    failedProviderRepliesRetained++;
  }
  const text = response.output.filter(item => item.type === 'message')
    .flatMap(item => item.content ?? []).filter(part => part.type === 'output_text').map(part => part.text).join('');
  assert.equal(reply.text, text, 'The scored reply must be the unchanged provider output');
  const tools = response.output.filter(item => item.type === 'function_call').map(item => ({
    id: item.call_id ?? item.id, type: 'function', function: { name: item.name, arguments: item.arguments },
  }));
  assert.deepEqual(reply.toolCalls, tools, 'Tool identities and arguments must match actual provider output');
  if (originalSystem) {
    const input = captured.call.request.input;
    assert(Array.isArray(input));
    const textOf = content => typeof content === 'string' ? content
      : (content ?? []).map(part => part.text ?? '').join('\n');
    assert(input.some(item => item.role === 'user' && textOf(item.content) === instruction),
      'The original user prohibition must reach every actual continuation with its original authority');
    assert(input.some(item => item.role === 'system' && textOf(item.content) === originalSystem)
      || captured.call.request.instructions?.includes(originalSystem), 'Original system instruction disappeared');
    const pending = new Set(), seen = new Set();
    for (const item of input) {
      if (item.type === 'function_call') { assert(!seen.has(item.call_id)); seen.add(item.call_id); pending.add(item.call_id); }
      if (item.type === 'function_call_output') assert(pending.delete(item.call_id), 'Actual API input has an orphan or repeated result');
    }
    assert.equal(pending.size, 0, 'Actual API input has an unresolved historical tool call');
  }
}
let previousCanonical, previousRound;
for (const round of evidence.rounds) {
  const full = round.results.find(row => row.treatment === 'full');
  const canonical = full.projection.slice(0, -1), question = full.projection.at(-1), update = canonical.slice(-8);
  assert.equal(hash(JSON.stringify(canonical)), round.canonicalSha256);
  assert.equal(hash(JSON.stringify(question)), round.questionSha256);
  assert.equal(hash(JSON.stringify(update)), round.updateSha256);
  if (previousCanonical) assert.deepEqual(canonical.slice(0, previousCanonical.length), previousCanonical);
  assert.deepEqual(round.expected, scenario(round.round).expected);
  for (const treatment of treatments) {
    const row = round.results.find(item => item.treatment === treatment);
    assert(row && !row.error, `${treatment} has an infrastructure failure`);
    assert.equal(hash(JSON.stringify(row.projection)), row.wireSha256);
    assertPairing(row.projection);
    const prior = previousRound?.results.find(item => item.treatment === treatment);
    const source = !prior || treatment === 'full' || treatment === 'selective' ? full.projection
      : [...prior.projection.filter(message => message.id !== previousRound.results.find(item => item.treatment === 'full').projection.at(-1).id), ...update, question];
    assert.equal(hash(JSON.stringify(source)), row.sourceSha256, `${treatment} source chain changed`);
    if (treatment === 'full') assert.equal(row.transformed, false);
    if (treatment === 'selective') assert.equal(row.transformed, row.sourceSha256 !== row.wireSha256);
    if (treatment === 'anchored' || treatment === 'protected') assert.equal(row.transformed, Boolean(row.artifact));
    if (row.summary?.text.includes('## Recorded Source Observations')) assert.equal(row.transformed, false);
    if (row.summary) bindActualReply(row.summary, undefined, row.transformed);
    for (const reply of row.continuations) bindActualReply(reply, canonical[0].content, row.score.exact);
    if (!row.modelFailure) {
      const actual = scoreAnswer(row.continuations.at(-1).text, scenario(round.round).expected);
      assert.deepEqual(row.score, actual, `${treatment} score must reflect the unchanged actual answer`);
    } else assert.equal(row.score.exact, false);
    if (row.artifact) {
      assert.equal(row.artifact.sourceDigest, row.sourceSha256);
      assert.equal(row.artifact.modelId, evidence.route.model);
      const stored = evidence.archives.find(archive => archive.artifactId === row.artifact.artifactId);
      assert(stored && stored.sourceDigest === row.sourceSha256);
      if (document.storedSources) {
        const original = document.storedSources.find(source => source.uri === stored.uri);
        assert(original && original.sha256 === stored.sha256);
        const messages = JSON.parse(original.text);
        assert.equal(messages.length, row.artifact.sourceMessageCount);
        for (const message of messages) assert.deepEqual(message, source.find(item => item.id === message.id));
      }
    }
    for (const read of row.reads) {
      assert(read.exactOriginalRange && read.data.content.length <= 1200);
      assert.equal(read.data.sha256, read.sourceSha256);
      if (read.modelRequestedVerification) assert.equal(read.data.verification.ok, true);
      if (document.storedSources) {
        const original = document.storedSources.find(source => source.uri === read.args.uri);
        assert(original);
        assert.equal(hash(original.text), read.sourceSha256);
        assert.equal(read.data.content, original.text.slice(read.args.start_char ?? 0,
          (read.args.start_char ?? 0) + read.args.max_chars));
      }
    }
  }
  previousCanonical = canonical; previousRound = round;
}
assert.deepEqual(summarizeMatrix(evidence.rounds, 10), evidence.summary);
for (const call of evidence.calls) {
  assert.equal(call.request.model, evidence.route.model);
  assert(!call.request.previous_response_id && !call.request.conversation);
  if (call.responseWire?.trim().startsWith('{')) {
    const response = JSON.parse(call.responseWire);
    if (response.status === 'completed') {
      assert.equal(response.model, evidence.route.model);
      assert.deepEqual(response.usage, call.usage);
    }
  }
}
for (const source of document.storedSources ?? []) assert.equal(hash(source.text), source.sha256);
console.log(JSON.stringify({ status: 'verified', variant, rounds: 10, sourceChains: 40,
  failedProviderRepliesRetained,
  recordedRepliesRescored: evidence.rounds.reduce((sum, round) => sum + round.results.filter(row => !row.modelFailure).length, 0),
  storedSourcesVerified: document.storedSources?.length ?? 0, summary: evidence.summary }));
