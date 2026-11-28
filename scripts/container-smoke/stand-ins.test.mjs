import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { VOICE_LIMITS, assertTurnsStored, assertVoiceLimits, claudeProcesses, describeVoiceLimits, median, smokeFlow } from './inside.mjs';
import { ANSWERS, CLASSIFY_INSTRUCTION, ORDER_TOOL, TOOL_MARKER, planClaudeReply, startClaudeStandIn, startMcpStandIn } from './stand-ins.mjs';

const tools = [{ name: `mcp__flujo__smoke__${ORDER_TOOL}` }];

test('the Claude stand-in calls the order tool once, then answers from its result', () => {
  const question = { role: 'user', content: [{ type: 'text', text: `${TOOL_MARKER} Where is my order A-1?` }] };
  assert.deepEqual(planClaudeReply({ messages: [question], tools }),
    { type: 'tool_use', name: tools[0].name, input: { order_id: 'A-1' } });
  const after = [question, { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: tools[0].name, input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ships today' }] }];
  assert.deepEqual(planClaudeReply({ messages: after, tools }), { type: 'text', text: ANSWERS.tool });
  assert.deepEqual(planClaudeReply({ system: [{ type: 'text', text: `Classify. ${CLASSIFY_INSTRUCTION}` }], messages: [{ role: 'user', content: 'Where?' }] }),
    { type: 'text', text: ANSWERS.classify });
  assert.deepEqual(planClaudeReply({ messages: [{ role: 'user', content: 'When does store 3 open?' }], tools }), { type: 'text', text: ANSWERS.plain });
});

test('the Claude stand-in streams Messages API events and records each model request', async (t) => {
  const standIn = await startClaudeStandIn();
  t.after(() => standIn.close());
  const response = await fetch(`${standIn.baseUrl}/v1/messages?beta=true`, {
    method: 'POST', headers: { authorization: 'Bearer sk-ant-oat01-placeholder', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'haiku', stream: true, tools, messages: [{ role: 'user', content: `${TOOL_MARKER} order?` }] }),
  });
  assert.equal(response.status, 200);
  const events = (await response.text()).split('\n\n').filter(Boolean).map((block) => block.split('\n')[0].slice('event: '.length));
  assert.deepEqual(events, ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  assert.equal(standIn.requests.length, 1);
  assert.equal(standIn.requests[0].oauth, true);
  assert.equal(standIn.requests[0].answer, 'tool_use');
  const plain = await fetch(`${standIn.baseUrl}/v1/messages`, { method: 'POST', body: JSON.stringify({ model: 'haiku', messages: [{ role: 'user', content: 'hi' }] }) });
  assert.equal((await plain.json()).content[0].text, ANSWERS.plain);
  assert.equal((await fetch(`${standIn.baseUrl}/v1/messages/count_tokens`, { method: 'POST', body: '{}' })).status, 404);
});

test('the MCP stand-in serves its order tool and records every method', async (t) => {
  const standIn = await startMcpStandIn();
  t.after(() => standIn.close());
  const client = new Client({ name: 'stand-in-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(standIn.url)));
  t.after(() => client.close());
  assert.equal(client.getServerCapabilities()?.tools?.listChanged, true);
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), [ORDER_TOOL]);
  const result = await client.callTool({ name: ORDER_TOOL, arguments: { order_id: 'A-1' } });
  assert.match(result.content[0].text, /ships today/);
  assert.deepEqual(standIn.methods.filter((method) => !method.startsWith('notifications/')), ['initialize', 'tools/list', 'tools/call']);
});

test('stored turns are found in order, and a missing answer is reported', () => {
  const turns = [{ question: 'Q1', answer: 'A1' }, { question: 'Q2', answer: 'A2' }];
  assertTurnsStored(['user: Q1', 'assistant: A1', 'user: Q2', 'assistant: A2'], turns, 'conversation');
  assert.throws(() => assertTurnsStored(['user: Q1', 'assistant: A1', 'user: Q2'], turns, 'conversation'), /turn 2 of 2 is not stored/);
  assert.throws(() => assertTurnsStored(['user: Q2', 'assistant: A2', 'user: Q1', 'assistant: A1'], turns, 'conversation'), /turn 2 of 2/);
});

test('the voice check holds the always-on path to the #1408 limits, judged by what was observed', () => {
  const measured = { direct: { mcpLists: 0, saves: 0 }, tool: { mcpLists: 1, saves: 3 }, continue: { mcpLists: 0, saves: 2 } };
  const series = ({ parked = 1, ...overrides } = {}) => ({
    scenarios: Object.fromEntries(Object.entries(measured).map(([scenario, counts]) => [scenario, {
      parkedAfter: parked,
      runs: Array.from({ length: 4 }, (_, index) => ({ claimed: index > 0 && scenario !== 'continue', ...counts, ...overrides[scenario] })),
    }])),
  });
  assert.deepEqual(VOICE_LIMITS, { readyProcessMissesAllowed: 1, mcpListsPerToolTurn: 1, saves: { tool: 3, continue: 2 } });
  assert.doesNotThrow(() => assertVoiceLimits(series()));
  assert.throws(() => assertVoiceLimits(series({ direct: { claimed: false } })), /only 0 of 3 later direct calls took the ready Claude Code process/);
  assert.throws(() => assertVoiceLimits(series({ tool: { mcpLists: 2 } })), /a tool turn sent 2 MCP list requests, the limit is 1/);
  assert.throws(() => assertVoiceLimits(series({ tool: { saves: 4 } })), /a tool turn saved the conversation 4 times, the limit is 3/);
  assert.throws(() => assertVoiceLimits(series({ continue: { saves: 3 } })), /a continued turn saved the conversation 3 times, the limit is 2/);
  assert.throws(() => assertVoiceLimits(series({ parked: 0 })), /no Claude Code process waited ready after the direct calls/);
  // Fewer lists or saves than measured pass; one missed ready process in three is allowed by design.
  assert.doesNotThrow(() => assertVoiceLimits(series({ tool: { mcpLists: 0, saves: 2 }, continue: { saves: 1 } })));
  const oneMiss = series();
  oneMiss.scenarios.tool.runs[2] = { ...oneMiss.scenarios.tool.runs[2], claimed: false, spareMiss: 'options' };
  assert.doesNotThrow(() => assertVoiceLimits(oneMiss));
  oneMiss.scenarios.tool.runs[3] = { ...oneMiss.scenarios.tool.runs[3], claimed: false, spareMiss: 'options' };
  assert.throws(() => assertVoiceLimits(oneMiss), /only 1 of 3 later tool turns .*\(differing: options\)/);
  // One list refresh in three later tool turns (the list's age limit) stays within the median.
  const refreshed = series();
  refreshed.scenarios.tool.runs[2] = { ...refreshed.scenarios.tool.runs[2], mcpLists: 2 };
  assert.doesNotThrow(() => assertVoiceLimits(refreshed));
  // A series without later runs never passes.
  const short = series();
  for (const scenario of Object.values(short.scenarios)) scenario.runs = scenario.runs.slice(0, 1);
  assert.throws(() => assertVoiceLimits(short), /only 0 of 0 later direct calls.*unmeasured number of MCP list requests.*unmeasured number of times/);
  assert.match(describeVoiceLimits(), /at most 1 MCP list request and saves at most 3 times; a continued turn saves at most 2 times/);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
});

test('Claude Code processes are counted from their command line', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flujo-proc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const add = async (pid, argv) => {
    await mkdir(path.join(root, pid));
    await writeFile(path.join(root, pid, 'cmdline'), `${argv.join('\0')}\0`);
  };
  await add('10', ['/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude', '--output-format', 'stream-json']);
  await add('11', ['node', 'scripts/launch-next.mjs', 'start']);
  await add('12', ['node', '/app/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs']);
  await mkdir(path.join(root, 'self'));
  assert.equal(await claudeProcesses(root), 1);
});

test('the smoke flow binds the model and, when given, the MCP server', () => {
  const plain = smokeFlow({ id: 'f', name: 'F', model: 'm' });
  assert.deepEqual(plain.nodes.map((node) => node.type), ['start', 'process', 'finish']);
  const withTools = smokeFlow({ id: 'f', name: 'F', model: 'm', server: 's' });
  assert.equal(withTools.nodes.find((node) => node.type === 'mcp').data.properties.boundServer, 's');
  assert.ok(withTools.edges.some((edge) => edge.data.edgeType === 'mcp' && edge.target === 'process'));
});
