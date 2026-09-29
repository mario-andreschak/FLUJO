import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import type { GeminiCliRuntime } from '@/backend/services/model/adapters/geminiCliRuntime';

const mockSpawn = jest.fn();
jest.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => mockSpawn(...args) }));
import { runGeminiCli, resolveGeminiCliEntry, prepareGeminiCliPrompt } from '@/backend/services/model/adapters/geminiCliProcess';

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
const runtime: GeminiCliRuntime = { home: 'private', workingDirectory: 'neutral', env: { GEMINI_API_KEY: 'private-key' }, cleanup: async () => {} };
let child: FakeChild;
beforeEach(() => {
  child = new FakeChild();
  mockSpawn.mockReset().mockImplementation(() => { setImmediate(() => child.emit('spawn')); return child; });
});
const run = (signal = new AbortController().signal, onEvent = jest.fn(), prompt = 'hello') => runGeminiCli({
  runtime, model: 'flash', prompt, signal, onEvent, hasBridge: true,
});

test('resolves the installed pinned JavaScript bin and sends large prompts through stdin', async () => {
  expect(await resolveGeminiCliEntry()).toBe(path.resolve('node_modules/@google/gemini-cli/bundle/gemini.js'));
  const prompt = 'long prompt '.repeat(3000);
  let sent = '';
  child.stdin.on('data', chunk => { sent += String(chunk); });
  child.stdin.on('finish', () => {
    child.stdout.write('{"type":"result","status":"success"}\n');
    setImmediate(() => child.emit('close', 0));
  });
  await run(undefined, undefined, prompt);
  const [command, args, options] = mockSpawn.mock.calls[0];
  expect(command).toBe(process.execPath);
  expect(args).toContain('--allowed-mcp-server-names');
  expect(args).not.toContain(prompt);
  expect(options).toMatchObject({ shell: false, windowsHide: true, cwd: 'neutral' });
  expect(sent).toBe(prepareGeminiCliPrompt(prompt));
});

test('rejects cancellation before creating a child', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(run(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(mockSpawn).not.toHaveBeenCalled();
});

test('headless prompt preprocessing cannot read @files or execute leading slash commands', () => {
  const prepared = prepareGeminiCliPrompt('/auth\n@/private/token.json literal\\@email.example');
  expect(prepared.startsWith('/')).toBe(false);
  expect(prepared).toContain('\\@/private/token.json');
  expect(prepared).toContain('literal\\@email.example');
  expect(prepareGeminiCliPrompt(prepared)).toBe(prepared);
});

test('cancellation of an active child rejects and terminates its process', async () => {
  const controller = new AbortController();
  child.stdin.on('finish', () => controller.abort());
  await expect(run(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(child.kill).toHaveBeenCalled();
});

test('malformed NDJSON terminates the child and never includes raw output in its error', async () => {
  child.stdin.on('finish', () => child.stdout.write('secret-output-that-is-not-json\n'));
  await expect(run()).rejects.toThrow('Gemini CLI returned malformed stream JSON.');
  expect(child.kill).toHaveBeenCalled();
});

test.each([
  ['OAuth credentials invalid secret-token', /Sign in with Google/],
  ['This client is no longer supported for Gemini Code Assist for individuals. Antigravity secret-token', /Google no longer supports personal Google accounts/],
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
  await runGeminiCli({ runtime, model: 'flash', prompt: 'input', signal: new AbortController().signal, onEvent: () => {}, hasBridge: false, onStarted: started });
  expect(started).toHaveBeenCalledTimes(1);
});
