import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { AntigravityCliRuntime } from '@/backend/services/model/adapters/antigravityCliRuntime';

const mockSpawn = jest.fn();
jest.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => mockSpawn(...args) }));
import { runAntigravityCli, resolveAntigravityCliEntry, prepareAntigravityCliPrompt, readAntigravityCliCommand, parseAntigravityModels } from '@/backend/services/model/adapters/antigravityCliProcess';
jest.mock('node:module', () => ({ createRequire: () => () => ({ findBinary: () => '/official/agy', resolveBinary: async () => '/official/agy', supportedVersion: () => true }) }));

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill = jest.fn(() => {
    this.killed = true;
    setImmediate(() => this.emit('close', null));
    return true;
  });
}
const runtime: AntigravityCliRuntime = { home: 'private', workingDirectory: 'neutral', env: { GEMINI_API_KEY: 'private-key' }, cleanup: async () => {} };
let child: FakeChild;
beforeEach(() => {
  child = new FakeChild();
  mockSpawn.mockReset().mockImplementation(() => { setImmediate(() => child.emit('spawn')); return child; });
});
const run = (signal = new AbortController().signal, onEvent = jest.fn(), prompt = 'hello') => runAntigravityCli({
  runtime, model: 'default', prompt, signal, onEvent,
});

test('native TSV catalogs accept new IDs and reject malformed or duplicate records', () => {
  expect(JSON.parse(parseAntigravityModels('gemini-new-model\tNew Gemini\n'))).toEqual({
    models: [{ id: 'gemini-new-model', name: 'New Gemini' }], entitlementVerified: false,
  });
  for (const invalid of ['', 'unexpected output', 'model\tName\nmodel\tDuplicate', 'bad id\tName']) {
    expect(() => parseAntigravityModels(invalid)).toThrow(/model catalog/);
  }
});

test('resolves the verified native executable and sends large prompts through one JSON stdin record', async () => {
  const binary = await resolveAntigravityCliEntry();
  expect(binary).toBe('/official/agy');
  expect(binary).not.toContain('.cache');
  const prompt = 'long prompt '.repeat(3000);
  let sent = '';
  child.stdin.on('data', chunk => { sent += String(chunk); });
  child.stdin.on('finish', () => {
    child.stdout.write('{"event":"result","result":{"conversation_id":"id","status":"SUCCESS","response":"done"}}\n');
    setImmediate(() => child.emit('close', 0));
  });
  await run(undefined, undefined, prompt);
  const [command, args, options] = mockSpawn.mock.calls[0];
  expect(command).toBe(binary);
  expect(args).toContain('--disable-slash-commands');
  expect(args).toContain('--input-format');
  expect(args).not.toContain('--model');
  expect(args).not.toContain(prompt);
  expect(options).toMatchObject({ shell: false, windowsHide: true, cwd: 'neutral' });
  expect(JSON.parse(sent)).toEqual({ event: 'user', message: { content: prepareAntigravityCliPrompt(prompt) } });
  expect(sent.split('\n')).toHaveLength(2);
});

test('rejects cancellation before creating a child', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(run(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(mockSpawn).not.toHaveBeenCalled();
});

test('frames conversation text inertly without changing ordinary literal @ content', () => {
  const prepared = prepareAntigravityCliPrompt('/auth\n@/private/token.json literal\\@email.example');
  expect(prepared.startsWith('/')).toBe(false);
  expect(prepared).toContain('@/private/token.json');
  expect(prepared).toContain('literal\\@email.example');
  expect(prepareAntigravityCliPrompt(prepared)).toBe(prepared);
});

test('cancellation of an active child rejects and terminates its process', async () => {
  const controller = new AbortController();
  child.stdin.on('finish', () => controller.abort());
  await expect(run(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(child.kill).toHaveBeenCalled();
});

test('malformed NDJSON terminates the child and never includes raw output in its error', async () => {
  child.stdin.on('finish', () => child.stdout.write('secret-output-that-is-not-json\n'));
  await expect(run()).rejects.toThrow('Antigravity CLI returned malformed stream JSON.');
  expect(child.kill).toHaveBeenCalled();
});

test.each([
  ['OAuth credentials invalid secret-token', /complete Google sign-in/],
  ['Google account requires phone verification secret-token', /Google account eligibility or verification/],
  ['generic failure secret-token', /exited with code 1/],
])('sanitizes nonzero exit diagnostics: %s', async (diagnostic, expected) => {
  child.stdin.on('finish', () => {
    child.stderr.write(diagnostic);
    setImmediate(() => child.emit('close', 1));
  });
  let failure: unknown;
  try { await run(); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toMatch(expected);
  expect((failure as Error).message).not.toContain('secret-token');
});

test('steering acknowledgement runs only after stdin is accepted', async () => {
  let accepted = false;
  child.stdin.on('data', () => { accepted = true; });
  child.stdin.on('finish', () => { setImmediate(() => child.emit('close', 0)); });
  const started = jest.fn(async () => { expect(accepted).toBe(true); });
  await runAntigravityCli({ runtime, model: 'default', prompt: 'input', signal: new AbortController().signal, onEvent: () => {}, onStarted: started });
  expect(started).toHaveBeenCalledTimes(1);
});

test('explicit deadline terminates a run even when it emitted partial assistant text', async () => {
  child.stdin.on('finish', () => child.stdout.write('{"event":"step_update","step_update":{"conversation_id":"id","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"partial"}}\n'));
  await expect(runAntigravityCli({ runtime, model: 'default', prompt: 'input', signal: new AbortController().signal, onEvent: () => {}, timeoutMs: 10 })).rejects.toThrow(/deadline exceeded/);
  expect(child.kill).toHaveBeenCalled();
});

test.each(['version', 'models'] as const)('runs %s as a separate closed command without a prompt or stream flags', async command => {
  child.stdin.on('finish', () => {
    child.stdout.write(command === 'version' ? '1.3.3\n' : 'custom\tCustom\n');
    setImmediate(() => child.emit('close', 0));
  });
  const result = await readAntigravityCliCommand(runtime, command);
  const [entry, args, options] = mockSpawn.mock.calls[0];
  expect(options).toMatchObject({ shell: false, windowsHide: true, cwd: 'neutral' });
  if (command === 'version') { expect(entry).toMatch(/agy(?:\.exe)?$/); expect(args).toEqual(['--version']); }
  else { expect(entry).toBe('/official/agy'); expect(args).toEqual(['models']); }
  expect(result).toContain(command === 'version' ? '1.3.3' : 'custom');
});

test('catalog cancellation kills its child and sanitized command failures omit native secrets', async () => {
  const controller = new AbortController();
  child.stdin.on('finish', () => controller.abort());
  await expect(readAntigravityCliCommand(runtime, 'models', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(child.kill).toHaveBeenCalled();
  child = new FakeChild();
  child.stdin.on('finish', () => { child.stderr.write('private-account-cache-and-token'); setImmediate(() => child.emit('close', 1)); });
  await expect(readAntigravityCliCommand(runtime, 'models')).rejects.toThrow('Antigravity model discovery failed. Check the connection authentication and runtime.');
});

test('rejects an oversized catalog and terminates before retaining more output', async () => {
  child.stdin.on('finish', () => child.stdout.write('x'.repeat(1024 * 1024 + 1)));
  await expect(readAntigravityCliCommand(runtime, 'models')).rejects.toThrow('Antigravity model catalog exceeded its limit.');
  expect(child.kill).toHaveBeenCalled();
});
