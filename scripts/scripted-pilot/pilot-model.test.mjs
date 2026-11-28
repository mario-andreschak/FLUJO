import assert from 'node:assert/strict';
import test from 'node:test';
import { STUB_TEST_REPLY } from '../first-journey/stub-model.mjs';
import { ANSWER_PREFIX, COULD_NOT_READ, PRACTICE_PHRASE, firstAllowedDirectory, joinPath, planPilotCompletion } from './pilot-model.mjs';

const tool = (name) => ({ type: 'function', function: { name, parameters: { type: 'object', properties: {} } } });
const tools = [tool('filesystem__get_allowed_directories'), tool('filesystem__read_file'), tool('filesystem__write_file')];
const question = { role: 'user', content: 'Read the practice note (practice-note.txt) using the connected tool. What is its receipt phrase?' };

function answer(previous, message, content) {
  return [...previous, message, { role: 'tool', tool_call_id: message.tool_calls[0].id, content }];
}

test('finds the allowed folder, reads the note there and quotes the phrase the tool returned', () => {
  const first = planPilotCompletion({ tools, messages: [question] });
  assert.equal(first.tool_calls[0].function.name, 'filesystem__get_allowed_directories');
  let messages = answer([question], first, JSON.stringify({ directories: ['C:\\Temp\\flujo-pilot-abc\\flujo-practice'] }));
  const second = planPilotCompletion({ tools, messages });
  assert.equal(second.tool_calls[0].function.name, 'filesystem__read_file');
  assert.deepEqual(JSON.parse(second.tool_calls[0].function.arguments), { path: 'C:\\Temp\\flujo-pilot-abc\\flujo-practice\\practice-note.txt' });
  messages = answer(messages, second, [{ type: 'text', text: `{"content":"Receipt phrase: ${PRACTICE_PHRASE}\\n"}` }]);
  const third = planPilotCompletion({ tools, messages });
  assert.match(third.content, new RegExp(`^${ANSWER_PREFIX} ${PRACTICE_PHRASE}\\.`));
});

test('never guesses: a refused or failed tool call is answered in words without the phrase', () => {
  const first = planPilotCompletion({ tools, messages: [question] });
  const refused = answer([question], first, 'The user rejected this tool call.');
  const reply = planPilotCompletion({ tools, messages: refused });
  assert.ok(reply.content.startsWith(COULD_NOT_READ), reply.content);
  assert.doesNotMatch(reply.content, new RegExp(PRACTICE_PHRASE));
});

test('starts a new attempt for every new question', () => {
  const first = planPilotCompletion({ tools, messages: [question] });
  const earlier = answer([question], first, 'The user rejected this tool call.');
  const again = planPilotCompletion({ tools, messages: [...earlier, { role: 'assistant', content: 'I could not read it.' }, question] });
  assert.equal(again.tool_calls[0].function.name, 'filesystem__get_allowed_directories');
});

test('reads the note by its name when the app cannot list folders, and says so when nothing reads files', () => {
  const direct = planPilotCompletion({ tools: [tool('read_file')], messages: [question] });
  assert.deepEqual(JSON.parse(direct.tool_calls[0].function.arguments), { path: 'practice-note.txt' });
  const none = planPilotCompletion({ tools: [tool('bash__run')], messages: [question] });
  assert.ok(none.content.startsWith(COULD_NOT_READ));
});

test('leaves every other request to the first-use stub, so AI Setup\'s test still passes', () => {
  assert.equal(planPilotCompletion({ messages: [{ role: 'user', content: 'Say hello' }] }).content, STUB_TEST_REPLY);
});

test('reads the allowed folder from JSON, structured content or plain text', () => {
  assert.equal(firstAllowedDirectory('{"directories":["/tmp/a","/tmp/b"]}'), '/tmp/a');
  assert.equal(firstAllowedDirectory([{ type: 'text', text: 'Allowed directories:\nC:\\data\\x' }]), 'C:\\data\\x');
  assert.equal(firstAllowedDirectory('{"structuredContent":{"directories":["/srv"]}}'), '/srv');
  assert.equal(firstAllowedDirectory('nothing here'), undefined);
  assert.equal(joinPath('/tmp/a/', 'n.txt'), '/tmp/a/n.txt');
  assert.equal(joinPath('C:\\a', 'n.txt'), 'C:\\a\\n.txt');
});
