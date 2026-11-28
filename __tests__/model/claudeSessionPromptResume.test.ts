/**
 * #1096: a step with per-turn instructions keeps Claude's own conversation
 * while each turn's instructions replace the previous ones; a step with stable
 * instructions keeps its recorded ones and starts a new conversation when they
 * change.
 *
 * Each turn runs FLUJO's adapter, hands the options it built to the installed
 * Agent SDK (in its own Node process, as Jest cannot load its ESM build), and
 * feeds the SDK's messages back to the adapter. The Claude Code process the SDK
 * starts is a fake that keeps sessions between processes and applies the
 * documented recording rule, so the test sees the model request each turn
 * would make. The last block uses the SDK's bundled Claude Code itself, with a
 * stand-in model service on this machine, to check that rule where it lives.
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type OpenAI from 'openai';
import type { CompletionInput } from '@/backend/services/model/adapters/types';

const queryMock = jest.fn();
const prewarmMock = jest.fn();
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...a: unknown[]) => queryMock(...(a as [])),
  prewarm: (...a: unknown[]) => prewarmMock(...(a as [])),
  createSdkMcpServer: (cfg: unknown) => ({ __server: cfg }),
  tool: (name: string, description: string, shape: unknown, handler: unknown) => ({ name, description, shape, handler }),
}));
jest.mock('@/backend/services/mcp', () => ({ mcpService: { callTool: jest.fn() } }));
const mockClaude = { home: '' };
jest.mock('@/backend/services/model/adapters/claudeRuntimeHome', () => ({
  prepareClaudeRuntimeEnvironment: jest.fn(async () => ({
    home: mockClaude.home, workingDirectory: `${mockClaude.home}/workspace`, env: {},
  })),
}));

import { ClaudeSubscriptionAdapter } from '@/backend/services/model/adapters/claudeSubscriptionAdapter';
import { _clearAllSessionsForTests } from '@/backend/services/model/adapters/claudeSessionStore';
import { _claudeSpareCountForTests, closeAllClaudeSpares } from '@/backend/services/model/adapters/claudeWarmProcess';

jest.setTimeout(120_000);

interface ModelRequest { system: string; messages: Array<{ role: string; content: unknown }> }
interface PeerRecord {
  argv: string[];
  resume?: string;
  sessionId: string;
  controlRequests: Array<{ subtype?: string; systemPrompt?: string[]; systemPromptSnapshot?: boolean }>;
  userMessages: Array<{ message: { content: unknown } }>;
  requests: ModelRequest[];
}

let root: string;
let records: PeerRecord[];
beforeAll(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-claude-prompt-resume-')); });
afterAll(async () => { await fs.rm(root, { recursive: true, force: true }); });
beforeEach(async () => {
  _clearAllSessionsForTests();
  records = [];
  mockClaude.home = await fs.mkdtemp(path.join(root, 'home-'));
  queryMock.mockReset().mockImplementation(({ prompt, options }: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) =>
    (async function* () {
      const first = await prompt[Symbol.asyncIterator]().next();
      const { messages, record } = await runInstalledSdk(options, first.value);
      records.push(record!);
      yield* messages;
    })());
});

/**
 * Run the installed SDK with the adapter's options against the session-keeping
 * fake, or with `runtime` against the SDK's bundled Claude Code.
 */
async function runInstalledSdk(options: Record<string, unknown>, prompt: unknown, runtime?: { cwd: string; env: Record<string, string> },
): Promise<{ messages: unknown[]; record?: PeerRecord }> {
  const { env: _env, cwd: _cwd, abortController: _abort, canUseTool, hooks, mcpServers, ...plain } = options;
  const runRoot = await fs.mkdtemp(path.join(root, 'run-'));
  const config = {
    root: runRoot, prompt, options: plain,
    ...(runtime ? { runtime } : { peer: 'claudePromptSessionCliPeer.cjs', peerArgs: [mockClaude.home] }),
    callbacks: {
      canUseTool: typeof canUseTool === 'function',
      hooks: Object.fromEntries(Object.entries((hooks ?? {}) as Record<string, Array<{ hooks: unknown[] }>>)
        .map(([event, matchers]) => [event, matchers.reduce((count, matcher) => count + matcher.hooks.length, 0)])),
      mcpServers: Object.keys((mcpServers ?? {}) as Record<string, unknown>),
    },
  };
  const bridge = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'claudeAuthoritySdkBridge.mjs')], {
    cwd: runRoot, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { NODE_ENV: 'test', PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
      HOME: runRoot, USERPROFILE: runRoot, CLAUDE_CONFIG_DIR: runRoot },
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  bridge.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
  bridge.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
  bridge.stdin.end(`${JSON.stringify(config)}\n`);
  const code = await new Promise<number | null>((resolve, reject) => {
    bridge.once('error', reject);
    bridge.once('close', resolve);
  });
  if (code !== 0) throw new Error(`SDK bridge exit ${code}: ${Buffer.concat(stderr).toString().slice(0, 2000)}`);
  const messages = Buffer.concat(stdout).toString().trim().split('\n').map(line => JSON.parse(line) as unknown);
  if (runtime) return { messages };
  const record = JSON.parse(await fs.readFile(path.join(runRoot, 'peer-record.json'), 'utf8')) as PeerRecord;
  return { messages, record };
}

type Policy = NonNullable<CompletionInput['systemPromptPolicy']>;

/** One conversation of a single step: each turn sends the step's instructions plus the whole history. */
function conversation(policy: Policy, conversationId = 'conversation') {
  const history: OpenAI.ChatCompletionMessageParam[] = [];
  return async (instructions: string, user: string, turnPolicy = policy) => {
    history.push({ role: 'user', content: user });
    let lifecycle: Record<string, unknown> | undefined;
    const result = await new ClaudeSubscriptionAdapter().createCompletion({
      model: { id: 'm1', name: 'sonnet', provider: 'claude-subscription', ApiKey: '' },
      apiKey: 'oauth-token', conversationId, nodeId: 'step',
      messages: [{ role: 'system', content: instructions }, ...history],
      sessionResume: true, systemPromptPolicy: turnPolicy,
      onSdkRequest: async snapshot => {
        lifecycle = (snapshot.request as { sessionLifecycle: Record<string, unknown> }).sessionLifecycle;
        return 'dispatch';
      },
      onSdkRequestResult: async () => undefined,
    } as CompletionInput);
    history.push(...(result.transcript ?? []) as OpenAI.ChatCompletionMessageParam[]);
    return { answer: result.completion.choices[0].message.content, peer: records.at(-1)!,
      options: queryMock.mock.calls.at(-1)![0].options as Record<string, unknown>, lifecycle: lifecycle! };
  };
}

const initializeOf = (peer: PeerRecord) => peer.controlRequests.filter(request => request.subtype === 'initialize');
/** Every place a prompt text could reach Claude Code: start-up arguments, setup requests and user messages. */
const everythingSent = (peer: PeerRecord) => JSON.stringify([peer.argv, peer.controlRequests, peer.userMessages]);
const occurrences = (text: string, part: string) => text.split(part).length - 1;

it('gives a resumed session each turn\'s own instructions exactly once, keeping its conversation (per-turn)', async () => {
  const turn = conversation('per-turn');

  const first = await turn('Answer in English.', 'Remember ticket 123.');
  expect(first.peer.resume).toBeUndefined();
  expect(first.lifecycle).toMatchObject({ requestedPromptPolicy: 'per-turn', snapshot: false, resumeReason: 'no-session' });
  expect(initializeOf(first.peer)).toEqual([expect.objectContaining({ systemPrompt: ['Answer in English.'], systemPromptSnapshot: false })]);
  expect(first.peer.requests).toEqual([{ system: 'Answer in English.', messages: [{ role: 'user', content: 'Remember ticket 123.' }] }]);

  const second = await turn('Responde en español.', 'Which ticket?');
  expect(second.options.resume).toBe(first.peer.sessionId);
  expect(second.peer.resume).toBe(first.peer.sessionId);
  expect(second.lifecycle).toMatchObject({ resumeReason: 'compatible-history-and-transcript', resumedSession: first.peer.sessionId });
  // Claude Code is started with this turn's instructions once, and only this
  // turn's message is sent: the session already holds the earlier ones.
  expect(initializeOf(second.peer)).toEqual([expect.objectContaining({ systemPrompt: ['Responde en español.'], systemPromptSnapshot: false })]);
  expect(occurrences(everythingSent(second.peer), 'Responde en español.')).toBe(1);
  expect(everythingSent(second.peer)).not.toContain('Answer in English.');
  expect(second.peer.userMessages.map(message => message.message.content)).toEqual(['Which ticket?']);
  expect(second.peer.requests).toEqual([{ system: 'Responde en español.', messages: [
    { role: 'user', content: 'Remember ticket 123.' }, { role: 'assistant', content: first.answer },
    { role: 'user', content: 'Which ticket?' },
  ] }]);

  // Back to the first instructions, then the same ones again: each turn uses
  // exactly its own, never the Spanish ones it replaced.
  const third = await turn('Answer in English.', 'Repeat it.');
  const fourth = await turn('Answer in English.', 'Once more.');
  for (const later of [third, fourth]) {
    expect(later.peer.resume).toBe(first.peer.sessionId);
    expect(initializeOf(later.peer)).toEqual([expect.objectContaining({ systemPrompt: ['Answer in English.'], systemPromptSnapshot: false })]);
    expect(occurrences(everythingSent(later.peer), 'Answer in English.')).toBe(1);
    expect(everythingSent(later.peer)).not.toContain('Responde en español.');
    expect(later.peer.requests).toHaveLength(1);
    expect(later.peer.requests[0].system).toBe('Answer in English.');
  }
  expect(fourth.peer.requests[0].messages.map(message => message.content)).toEqual([
    'Remember ticket 123.', first.answer, 'Which ticket?', second.answer, 'Repeat it.', third.answer, 'Once more.',
  ]);
});

it('keeps recorded instructions on a stable resume and starts a new session when they change', async () => {
  const turn = conversation('stable');
  const first = await turn('Stable rules v1.', 'Remember ticket 123.');
  expect(initializeOf(first.peer)).toEqual([expect.objectContaining({ systemPrompt: ['Stable rules v1.'], systemPromptSnapshot: true })]);

  const second = await turn('Stable rules v1.', 'Which ticket?');
  expect(second.peer.resume).toBe(first.peer.sessionId);
  expect(initializeOf(second.peer)).toEqual([expect.objectContaining({ systemPrompt: ['Stable rules v1.'], systemPromptSnapshot: true })]);
  expect(second.peer.requests[0].system).toBe('Stable rules v1.');
  expect(second.peer.userMessages.map(message => message.message.content)).toEqual(['Which ticket?']);

  // Resuming would keep the recorded v1 until Claude Code compacts the
  // session, so changed stable instructions start a new session that carries
  // the conversation in its first message.
  const third = await turn('Stable rules v2.', 'And now?');
  expect(third.options.resume).toBeUndefined();
  expect(third.peer.resume).toBeUndefined();
  expect(third.lifecycle).toMatchObject({ requestedPromptPolicy: 'stable', snapshot: true, resumeReason: 'instructions-tools-or-settings-changed' });
  expect(third.peer.sessionId).not.toBe(first.peer.sessionId);
  expect(third.peer.requests).toHaveLength(1);
  expect(third.peer.requests[0].system).toBe('Stable rules v2.');
  expect(everythingSent(third.peer)).not.toContain('Stable rules v1.');
  const flattened = String(third.peer.userMessages[0].message.content);
  for (const part of ['Remember ticket 123.', 'Which ticket?', 'And now?']) expect(occurrences(flattened, part)).toBe(1);
});

it('never resumes across a change of instruction policy', async () => {
  const turn = conversation('stable');
  await turn('Rules.', 'Remember ticket 123.');
  // The step switched to per-turn instructions, then back: a recorded session
  // is never continued with recording off, nor the other way round.
  const perTurn = await turn('Rules.', 'Which?', 'per-turn');
  const stableAgain = await turn('Rules.', 'And now?', 'stable');
  for (const switched of [perTurn, stableAgain]) {
    expect(switched.peer.resume).toBeUndefined();
    expect(switched.lifecycle).toMatchObject({ resumeReason: 'instructions-tools-or-settings-changed' });
    expect(switched.peer.requests).toEqual([expect.objectContaining({ system: 'Rules.' })]);
  }
});

it('starts a new session with this turn\'s instructions when the saved conversation is gone', async () => {
  const turn = conversation('per-turn');
  await turn('Answer in English.', 'Remember ticket 123.');
  await fs.rm(path.join(mockClaude.home, 'projects'), { recursive: true, force: true });
  const second = await turn('Responde en español.', 'Which ticket?');
  expect(second.peer.resume).toBeUndefined();
  expect(second.lifecycle).toMatchObject({ resumeReason: 'transcript-missing-or-changed' });
  expect(second.peer.requests).toHaveLength(1);
  expect(second.peer.requests[0].system).toBe('Responde en español.');
  expect(everythingSent(second.peer)).not.toContain('Answer in English.');
  const flattened = String(second.peer.userMessages[0].message.content);
  for (const part of ['Remember ticket 123.', 'Which ticket?']) expect(occurrences(flattened, part)).toBe(1);
});

describe('with parked Claude Code processes (#1408)', () => {
  interface FakeSpare { options: Record<string, unknown>; claim: jest.Mock; close: jest.Mock }
  let spares: FakeSpare[];
  beforeEach(() => {
    spares = [];
    prewarmMock.mockReset().mockImplementation(async ({ options }: { options: Record<string, unknown> }) => {
      const spare: FakeSpare = {
        options,
        claim: jest.fn(({ prompt }: { prompt: AsyncIterable<unknown> }) => (async function* () {
          await prompt[Symbol.asyncIterator]().next();
          yield { type: 'result', subtype: 'success', result: 'warm reply', session_id: 'warm-session',
            usage: { input_tokens: 1, output_tokens: 1 } };
        })()),
        close: jest.fn(),
      };
      spares.push(spare);
      return { ...spare, claimed: Promise.resolve({ sessionId: 'warm-session' }), exited: new Promise<void>(() => undefined) };
    });
  });
  afterEach(() => {
    closeAllClaudeSpares();
  });
  const settle = () => new Promise(resolve => setImmediate(resolve));

  it('resumes per-turn instructions itself, never through or at the cost of a parked process', async () => {
    const turn = conversation('per-turn');
    await turn('Answer in English.', 'Remember ticket 123.');
    await settle();
    // Another conversation on other instructions cannot take the process
    // parked for the first one: it was started with the English instructions.
    await conversation('per-turn', 'other')('Answer briefly.', 'Hello');
    await settle();
    expect(spares.map(spare => spare.options.systemPrompt)).toEqual([
      { type: 'custom', prompt: 'Answer in English.', snapshot: false },
      { type: 'custom', prompt: 'Answer briefly.', snapshot: false },
    ]);
    expect(spares[0].claim).not.toHaveBeenCalled();

    // The resumed turn starts its own process with its own instructions. The
    // processes parked for other requests stay ready for them.
    const resumed = await turn('Responde en español.', 'Which ticket?');
    await settle();
    expect(resumed.peer.resume).toBeDefined();
    expect(resumed.peer.requests[0].system).toBe('Responde en español.');
    // Same tools as the turn that started the session: no claude.ai connectors.
    expect((resumed.options.env as Record<string, string>).ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false');
    expect(spares.map(spare => [spare.claim.mock.calls.length, spare.close.mock.calls.length])).toEqual([[0, 0], [0, 0]]);
    expect(_claudeSpareCountForTests()).toBe(2);

    // A new conversation with the same instructions as the second one takes
    // its process, which was started with exactly those instructions.
    const third = await conversation('per-turn', 'third')('Answer briefly.', 'Hi again');
    expect(third.answer).toBe('warm reply');
    expect(spares[1].claim).toHaveBeenCalledTimes(1);
    expect(records).toHaveLength(3);
  });
});

describe('with the bundled Claude Code and a stand-in model service', () => {
  // What each model request carried: its system text and its messages' text.
  let calls: Array<{ system: string; messages: string[] }>;
  let served = 0;
  let server: http.Server;
  let baseUrl: string;
  beforeAll(async () => {
    server = http.createServer((request, response) => {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        if (!request.url?.startsWith('/v1/messages') || request.url.includes('count_tokens')) {
          response.writeHead(404).end('{}');
          return;
        }
        const sent = JSON.parse(body) as { model: string; stream?: boolean; system?: string | Array<{ text: string }>;
          messages: Array<{ content: string | Array<{ type: string; text?: string }> }> };
        calls.push({
          system: Array.isArray(sent.system) ? sent.system.map(block => block.text).join('\n') : sent.system ?? '',
          messages: sent.messages.map(message => typeof message.content === 'string' ? message.content
            : message.content.map(block => block.text ?? '').join('\n')),
        });
        const reply = `stand-in reply ${++served}.`;
        const events: Array<[string, unknown]> = [
          ['message_start', { type: 'message_start', message: { id: `msg_${served}`, type: 'message', role: 'assistant',
            model: sent.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
          ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
          ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } }],
          ['content_block_stop', { type: 'content_block_stop', index: 0 }],
          ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
          ['message_stop', { type: 'message_stop' }],
        ];
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const [event, data] of events) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        response.end();
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));
  beforeEach(async () => {
    calls = [];
    queryMock.mockImplementation(({ prompt, options }: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) =>
      (async function* () {
        const first = await prompt[Symbol.asyncIterator]().next();
        await fs.mkdir(String(options.cwd), { recursive: true });
        const { messages } = await runInstalledSdk(options, first.value, { cwd: String(options.cwd), env: {
          HOME: mockClaude.home, USERPROFILE: mockClaude.home, CLAUDE_CONFIG_DIR: mockClaude.home,
          ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_API_KEY: 'offline-stand-in-not-a-secret',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
        } });
        yield* messages;
      })());
  });
  const text = (call: { system: string; messages: string[] }) => [call.system, ...call.messages].join('\n');

  it('takes each turn\'s per-turn instructions on resume and keeps the conversation', async () => {
    const turn = conversation('per-turn');
    const first = await turn('INSTRUCTIONS-ONE: answer in English.', 'Remember ticket 123.');
    expect(calls).toHaveLength(1);
    expect(calls[0].system).toContain('INSTRUCTIONS-ONE');

    const resumed: unknown[] = [];
    for (const [instructions, other, user] of [
      ['INSTRUCTIONS-TWO: responde en español.', 'INSTRUCTIONS-ONE', 'Which ticket?'],
      ['INSTRUCTIONS-ONE: answer in English.', 'INSTRUCTIONS-TWO', 'Repeat it.'],
    ]) {
      calls = [];
      const next = await turn(instructions, user);
      expect(next.lifecycle).toMatchObject({ resumeReason: 'compatible-history-and-transcript' });
      resumed.push(next.options.resume);
      expect(calls).toHaveLength(1);
      expect(occurrences(calls[0].system, instructions)).toBe(1);
      expect(text(calls[0])).not.toContain(other);
      // The session brought the earlier turns; FLUJO sent only the new message.
      const conversationText = calls[0].messages.join('\n');
      for (const part of ['Remember ticket 123.', first.answer as string, user]) expect(occurrences(conversationText, part)).toBe(1);
    }
    expect(resumed).toEqual([expect.any(String), resumed[0]]);
  });

  it('starts a new session when stable instructions change, as a resumed one keeps the recorded ones', async () => {
    const turn = conversation('stable');
    await turn('STABLE-ONE rules.', 'Remember ticket 456.');
    calls = [];
    const changed = await turn('STABLE-TWO rules.', 'Which ticket?');
    expect(changed.options.resume).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].system).toContain('STABLE-TWO');
    expect(text(calls[0])).not.toContain('STABLE-ONE');
    expect(occurrences(calls[0].messages.join('\n'), 'Remember ticket 456.')).toBe(1);
  });
});
