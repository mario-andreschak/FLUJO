import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import {
  FILE_TEXT, STAGES, approvalPlan, claudeAgent, claudeReply, main, subflowParent, verdict,
} from './run.mjs';

const tools = [{ type: 'function', function: { name: 'mcp_write_file_ab12cd' } }, { type: 'function', function: { name: 'mcp_get_allowed_directories_ef34gh' } }];
const callsOf = (message) => message.tool_calls?.map((call) => [call.function.name, JSON.parse(call.function.arguments)]);

test('the journey covers each of the eleven steps that used to be clicked by hand', () => {
  const titles = STAGES.map((stage) => stage.title).join('\n');
  for (let step = 1; step <= 11; step += 1) assert.match(titles, new RegExp(`Step ${step}:`), `step ${step} has no stage`);
  assert.equal(new Set(STAGES.map((stage) => stage.id)).size, STAGES.length);
  assert.deepEqual(STAGES.slice(0, 2).map((stage) => stage.id), ['home', 'connect-ai']);
});

test('the stand-in model writes one file, two calls at once, or one file per turn', () => {
  const folder = path.join('tmp', 'journey');
  const user = (content) => ({ messages: [{ role: 'user', content }], tools });
  assert.deepEqual(callsOf(approvalPlan(user('WRITE-FILE a.txt'), folder)), [['mcp_write_file_ab12cd', { path: path.join(folder, 'a.txt'), content: FILE_TEXT }]]);
  assert.deepEqual(callsOf(approvalPlan(user('TWO-CALLS b.txt'), folder)).map(([name]) => name), ['mcp_get_allowed_directories_ef34gh', 'mcp_write_file_ab12cd']);
  const rounds = user('TWO-ROUNDS one.txt two.txt');
  assert.equal(callsOf(approvalPlan(rounds, folder))[0][1].path, path.join(folder, 'one.txt'));
  rounds.messages.push({ role: 'assistant', tool_calls: [] }, { role: 'tool', content: 'ok one' });
  assert.equal(callsOf(approvalPlan(rounds, folder))[0][1].path, path.join(folder, 'two.txt'));
  rounds.messages.push({ role: 'assistant', tool_calls: [] }, { role: 'tool', content: 'ok two' });
  assert.equal(approvalPlan(rounds, folder).content, 'Finished TWO-ROUNDS one.txt: ok one | ok two');
  const denied = user('TWO-CALLS c.txt');
  denied.messages.push({ role: 'assistant', tool_calls: [] }, { role: 'tool', content: '/tmp' }, { role: 'tool', content: 'tool denied' });
  assert.equal(approvalPlan(denied, folder).content, 'Finished TWO-CALLS c.txt: /tmp | tool denied');
  assert.equal(typeof approvalPlan(user('Hello'), folder).content, 'string');
});

test('the Claude stand-in asks for the write tool once, then answers', () => {
  const body = { tools: [{ name: 'mcp__flujo__mcp_write_file_ab12cd' }], messages: [{ role: 'user', content: [{ type: 'text', text: 'WRITE-FILE claude.txt' }] }] };
  const first = claudeReply(body, 'folder');
  assert.equal(first.type, 'tool_use');
  assert.equal(first.name, 'mcp__flujo__mcp_write_file_ab12cd');
  assert.deepEqual(first.input, { path: path.join('folder', 'claude.txt'), content: FILE_TEXT });
  body.messages.push({ role: 'assistant', content: [first] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] });
  assert.deepEqual(claudeReply(body, 'folder'), { type: 'text', text: 'Claude finished WRITE-FILE claude.txt.' });
});

test('the flows it saves connect their steps through the canvas handles', () => {
  const parent = subflowParent('parent', 'child');
  assert.equal(parent.nodes.find((node) => node.type === 'subflow').data.properties.subflowId, 'child');
  assert.deepEqual(parent.edges.map((edge) => [edge.sourceHandle, edge.targetHandle]), [['start-bottom', 'subflow-top'], ['subflow-bottom', 'finish-top']]);
  const claude = claudeAgent('flow', 'model');
  assert.equal(claude.nodes.find((node) => node.type === 'process').data.properties.boundModel, 'model');
  assert.ok(claude.edges.some((edge) => edge.source === 'mcp-1' && edge.data.edgeType === 'mcp'));
});

test('it fails on a failed stage, a missing stage or a page crash', () => {
  const all = STAGES.map((stage) => ({ id: stage.id, ok: true }));
  assert.equal(verdict({ stages: all, problems: ['console error: noise'] }).passed, true);
  assert.equal(verdict({ stages: all.slice(1), problems: [] }).passed, false);
  assert.equal(verdict({ stages: [...all.slice(0, -1), { id: 'x', ok: false }], problems: [] }).passed, false);
  assert.equal(verdict({ stages: all, problems: ['page error: boom'] }).passed, false);
});

test('it refuses an evidence folder outside its own and prints how to run it', async () => {
  const lines = [];
  assert.equal(await main(['--help'], (line) => lines.push(line)), 0);
  assert.match(lines.join('\n'), /production build/);
  await assert.rejects(main(['--out', '../elsewhere'], () => {}, { start: async () => { throw new Error('must not start'); } }), /plain folder name/);
});
