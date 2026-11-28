import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { BIG_FILE, END_MARKER, FULL_REPLY, MOVED_REPLY, STAGES, bigLog, planLimitCompletion } from './tool-result-limit-check.mjs';

const tool = (name) => ({ type: 'function', function: { name, parameters: { type: 'object', properties: {} } } });
const tools = [tool('filesystem__get_allowed_directories'), tool('filesystem__read_text_file'), tool('filesystem__write_file')];
const question = { role: 'user', content: `Read ${BIG_FILE} with read_file and tell me how it ends.` };

test('the big log is over the 32 KB the check sets once it is JSON text in a tool message', () => {
  const asToolMessage = JSON.stringify({ content: [{ type: 'text', text: bigLog() }] });
  assert.ok(Buffer.byteLength(asToolMessage) > 40 * 1024);
  assert.ok(bigLog().trimEnd().endsWith(END_MARKER));
});

test('reads the big log in the folder the app may read, then says how the result arrived', () => {
  const first = planLimitCompletion({ tools, messages: [question] }, 'C:\\sandbox');
  assert.equal(first.tool_calls[0].function.name, 'filesystem__read_text_file');
  assert.deepEqual(JSON.parse(first.tool_calls[0].function.arguments), { path: path.join('C:\\sandbox', BIG_FILE) });

  const moved = planLimitCompletion({ tools, messages: [question, first, { role: 'tool', content: 'head\n…[stored as run resource flujo://run/conv-1/res-2]…\ntail' }] }, 'C:\\sandbox');
  assert.equal(moved.content, `${MOVED_REPLY} \`flujo://run/conv-1/res-2\``);

  const whole = planLimitCompletion({ tools, messages: [question, first, { role: 'tool', content: JSON.stringify({ text: bigLog() }) }] }, 'C:\\sandbox');
  assert.ok(whole.content.startsWith(FULL_REPLY));
  assert.ok(whole.content.includes(END_MARKER));
});

test('leaves every other request to the first-use journey\'s stand-in', () => {
  const other = planLimitCompletion({ tools, messages: [{ role: 'user', content: 'Hello' }] }, 'C:\\sandbox');
  assert.ok(!other.tool_calls || other.tool_calls[0].function.name !== 'filesystem__read_text_file');
});

test('checks the Settings page, a moved result, the step\'s own choice, and switches the limit off again', () => {
  assert.deepEqual(STAGES.map((stage) => stage.id), ['settings-limit', 'connect-ai', 'big-result-moved', 'step-keeps-full', 'settings-off-again']);
});
