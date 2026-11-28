// Tests for the stand-in model and MCP tool used by the schedule and approval check.
import assert from 'node:assert/strict';
import test from 'node:test';
import { STAND_IN_MODEL_KEY, STAND_IN_REFUSAL, STAND_IN_TOOL, mcpReply, runOf, standInReply, startStandIns } from './stand-ins.mjs';
import { dockerStandInHost } from './targets.mjs';

const user = content => ({ role: 'user', content });
const scheduled = (marker, now) => user(`Acceptance marker: ${marker}.\n\n[Run info]\n\`\`\`json\n{\n  "executionName": "x",\n  "now": "${now}"\n}\n\`\`\``);
const tool = { type: 'function', function: { name: `mcp_${STAND_IN_TOOL}_12z47li`, parameters: {} } };

test('the marker and fire time come from the newest marked user message', () => {
  assert.deepEqual(runOf([scheduled('old', 'a'), { role: 'assistant', content: 'x' }, scheduled('schedule', '2026-11-27T12:00:05.043Z')]),
    { marker: 'schedule', firedAt: '2026-11-27T12:00:05.043Z' });
  assert.deepEqual(runOf([{ role: 'user', content: [{ type: 'text', text: 'Acceptance marker: approve.' }] }]), { marker: 'approve', firedAt: null });
  assert.deepEqual(runOf([user('no marker'), { role: 'system', content: 'Acceptance marker: system.' }]), { marker: null, firedAt: null });
  assert.deepEqual(runOf(undefined), { marker: null, firedAt: null });
});

test('the stand-in model asks for the tool until it ran, asks only once on a deny run, and gives up after five tries', () => {
  const state = { effects: [], proposals: [] };
  const ask = (marker, extra = []) => standInReply({ tools: [tool], messages: [scheduled(marker, 't'), ...extra] }, state);
  const first = ask('approve');
  assert.deepEqual(first.toolCall, { id: 'call-approve-1', type: 'function', function: { name: tool.function.name, arguments: '{"marker":"approve"}' } });
  state.proposals.push({ marker: 'approve' });
  assert.equal(ask('approve', [{ role: 'tool', content: 'Stale tool call: re-registered' }]).toolCall.id, 'call-approve-2', 'a refused stale call gets a fresh one');
  state.effects.push({ marker: 'approve' });
  assert.equal(ask('approve', [{ role: 'tool', content: 'Effect recorded: approve' }]).text, 'Stand-in answer for approve.');

  assert.ok(ask('deny').toolCall);
  assert.equal(ask('deny', [{ role: 'tool', content: 'The user denied this call.' }]).text, 'Stand-in answer for deny.');

  for (let index = 0; index < 5; index++) state.proposals.push({ marker: 'loop' });
  assert.equal(ask('loop').text, 'Stand-in answer for loop.');
  assert.equal(standInReply({ messages: [scheduled('schedule', 'now-time')] }, state).text, 'Stand-in answer for schedule.');
  assert.equal(standInReply({ tools: [tool], messages: [user('unmarked')] }, state).text, 'Stand-in answer for an unmarked request.');
  assert.equal(standInReply({ messages: [scheduled('schedule', 'now-time')] }, state).firedAt, 'now-time');
});

test('the stand-in MCP server answers the protocol and records each tool call', () => {
  const effects = [];
  assert.deepEqual(mcpReply({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28' } }, effects).result.protocolVersion, '2026-07-28');
  assert.equal(mcpReply({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, effects).result.protocolVersion, '2025-06-18');
  assert.equal(mcpReply({ jsonrpc: '2.0', method: 'notifications/initialized' }, effects), undefined);
  assert.deepEqual(mcpReply({ jsonrpc: '2.0', id: 2, method: 'ping' }, effects), { jsonrpc: '2.0', id: 2, result: {} });
  assert.equal(mcpReply({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, effects).result.tools[0].name, STAND_IN_TOOL);
  assert.deepEqual(mcpReply({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: STAND_IN_TOOL, arguments: { marker: 'approve' } } }, effects).result.content,
    [{ type: 'text', text: 'Effect recorded: approve' }]);
  assert.deepEqual(effects.map(effect => effect.marker), ['approve']);
  for (const call of [{ method: 'tools/call', params: { name: 'other', arguments: { marker: 'x' } } }, { method: 'tools/call', params: { name: STAND_IN_TOOL, arguments: {} } }, { method: 'resources/list' }]) {
    assert.equal(mcpReply({ jsonrpc: '2.0', id: 5, ...call }, effects).error.code, -32601);
  }
  assert.equal(effects.length, 1, 'only valid calls count as effects');
});

test('both stand-ins speak HTTP, check the model key and write down what they could not read', async t => {
  const standIns = await startStandIns();
  t.after(() => standIns.close());
  assert.match(standIns.modelUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  const chat = (body, key = STAND_IN_MODEL_KEY) => fetch(`${standIns.modelUrl}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  assert.equal((await chat({ messages: [] }, 'wrong')).status, 401);
  assert.equal((await fetch(`${standIns.modelUrl}/models`)).status, 404);
  const plain = await (await chat({ model: 'm', tools: [tool], messages: [scheduled('approve', 'fired')] })).json();
  assert.equal(plain.choices[0].finish_reason, 'tool_calls');
  assert.equal(plain.choices[0].message.tool_calls[0].id, 'call-approve-1');
  const stream = await (await chat({ model: 'm', stream: true, messages: [scheduled('schedule', 'fired-2')] })).text();
  assert.match(stream, /"content":"Stand-in answer for schedule\."[\s\S]*"finish_reason":"stop"[\s\S]*data: \[DONE\]/);
  assert.deepEqual(standIns.requestsFor('schedule').map(item => item.firedAt), ['fired-2']);
  assert.equal(standIns.proposals.length, 1);
  assert.equal((await chat('{not json')).status, 500);
  const refused = await chat({ model: 'm', messages: [scheduled('fail-nightly', 'fired-3')] });
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error.message, STAND_IN_REFUSAL);
  assert.equal(standIns.requestsFor('fail-nightly').length, 1);

  const rpc = (body, method = 'POST') => fetch(standIns.mcpUrl, { method, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: method === 'POST' ? JSON.stringify(body) : undefined });
  assert.equal((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  assert.equal((await rpc(undefined, 'GET')).status, 405);
  assert.equal((await fetch(standIns.mcpUrl.replace('/mcp', '/other'))).status, 404);
  const called = await (await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: STAND_IN_TOOL, arguments: { marker: 'approve' } } })).json();
  assert.equal(called.id, 9);
  assert.deepEqual(standIns.effectsFor('approve').length, 1);
  assert.equal((await fetch(standIns.mcpUrl, { method: 'POST', body: '{broken' })).status, 400);
  assert.deepEqual(standIns.failures.map(item => item.split(':')[0]), ['model', 'mcp']);
});

test('containers reach the stand-ins through the bridge gateway, or through loopback on Docker Desktop', async () => {
  const docker = answers => async args => answers[args[0]];
  assert.equal(await dockerStandInHost(docker({ info: 'Docker Desktop\n' })), '127.0.0.1');
  assert.equal(await dockerStandInHost(docker({ info: 'Ubuntu 24.04.3 LTS\n', network: 'fd00::1 172.17.0.1 \n' })), '172.17.0.1');
  await assert.rejects(dockerStandInHost(docker({ info: 'Ubuntu\n', network: '\n' })), /no IPv4 gateway/);
});
