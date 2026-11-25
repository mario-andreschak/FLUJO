/**
 * #1414: a plain hand-off (`handoff_to_finish_node`) ends the model's work in
 * Claude Code too. Once the hand-off tool has answered, Claude Code must not
 * ask the model for another turn: on a Claude subscription every turn counts
 * against the allowance, even one FLUJO never reads.
 *
 * Each run hands FLUJO's adapter options to the installed Agent SDK with its
 * bundled Claude Code (in their own processes, as Jest cannot load the SDK's
 * ESM build). The adapter's own hooks, permission callback and tool handlers
 * answer Claude Code through a relay, and a stand-in model service on this
 * machine counts every model request. Re-check on every Agent SDK upgrade.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type OpenAI from 'openai';
import type { CompletionInput } from '@/backend/services/model/adapters/types';

const queryMock = jest.fn();
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...a: unknown[]) => queryMock(...(a as [])),
  prewarm: jest.fn(),
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

jest.setTimeout(120_000);

type Block = { type: 'text'; text: string } | { type: 'tool_use'; name: string; input: Record<string, unknown> };
/** What the stand-in model answers to its n-th request (0-based) of a test. */
type Script = (request: number) => Block[];

const ANSWER = 'The pharmacy is open from 8:00 to 18:00.';
const EXTRA = 'An extra model turn after the hand-off.';
const OUTPUT_TOKENS = 7;
const tool = (name: string, input: Record<string, unknown> = {}): Block => ({ type: 'tool_use', name: `mcp__flujo__${name}`, input });
const text = (value: string): Block => ({ type: 'text', text: value });

let root: string;
let server: http.Server;
let baseUrl: string;
let script: Script;
/** Each model request's messages, as JSON. */
let requests: string[];
const bridges: Array<Promise<void>> = [];

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-claude-handoff-'));
  server = http.createServer((request, response) => {
    if (request.method !== 'POST' || !request.url?.startsWith('/v1/messages') || request.url.includes('count_tokens')) {
      request.resume();
      response.writeHead(404).end('{}');
      return;
    }
    // Counted as soon as Claude Code sends it, even if it is stopped right after.
    const index = requests.length;
    requests.push('');
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const sent = JSON.parse(body) as { model: string; messages: unknown[] };
      requests[index] = JSON.stringify(sent.messages);
      const blocks = script(index);
      const events: Array<[string, unknown]> = [
        ['message_start', { type: 'message_start', message: { id: `msg_${index + 1}`, type: 'message', role: 'assistant',
          model: sent.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
      ];
      blocks.forEach((block, position) => {
        if (block.type === 'text') {
          events.push(['content_block_start', { type: 'content_block_start', index: position, content_block: { type: 'text', text: '' } }]);
          events.push(['content_block_delta', { type: 'content_block_delta', index: position, delta: { type: 'text_delta', text: block.text } }]);
        } else {
          events.push(['content_block_start', { type: 'content_block_start', index: position,
            content_block: { type: 'tool_use', id: `toolu_${index + 1}_${position}`, name: block.name, input: {} } }]);
          events.push(['content_block_delta', { type: 'content_block_delta', index: position,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } }]);
        }
        events.push(['content_block_stop', { type: 'content_block_stop', index: position }]);
      });
      const stopReason = blocks.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn';
      events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: OUTPUT_TOKENS } }]);
      events.push(['message_stop', { type: 'message_stop' }]);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [event, data] of events) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      response.end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await Promise.all(bridges);
  await new Promise<void>(resolve => server.close(() => resolve()));
  await fs.rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  _clearAllSessionsForTests();
  requests = [];
  mockClaude.home = await fs.mkdtemp(path.join(root, 'home-'));
  queryMock.mockReset().mockImplementation(relayQuery);
});

type Callback = (...args: unknown[]) => Promise<unknown>;
interface AdapterOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  abortController: AbortController;
  canUseTool?: Callback;
  hooks?: Record<string, Array<{ hooks: Callback[] }>>;
  mcpServers?: Record<string, { __server: { tools: Array<{ name: string; description: string; shape: Record<string, unknown>; handler: Callback }> } }>;
}

/**
 * The SDK's `query()` as the adapter sees it: the installed SDK runs the
 * bundled Claude Code in a bridge process; its frames stream back as they
 * arrive and every callback is answered by the adapter's own.
 */
function relayQuery({ prompt, options }: { prompt: AsyncIterable<unknown>; options: AdapterOptions }) {
  const { env, cwd: _cwd, abortController, canUseTool, hooks = {}, mcpServers = {}, ...plain } = options;
  const frames: unknown[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  let failure: Error | undefined;
  let bridge: ChildProcessWithoutNullStreams | undefined;
  const send = (line: unknown) => { if (bridge?.stdin.writable) bridge.stdin.write(`${JSON.stringify(line)}\n`); };
  const stop = () => send({ type: 'abort' });
  abortController.signal.addEventListener('abort', stop, { once: true });
  const flatHooks = Object.fromEntries(Object.entries(hooks).map(([event, matchers]) =>
    [event, matchers.flatMap(matcher => matcher.hooks)]));
  const tools = Object.fromEntries(Object.entries(mcpServers).map(([name, config]) => [name, config.__server.tools]));
  const answer = async (call: { target: string; event?: string; index?: number; server?: string; name?: string; args: unknown[] }) => {
    const signal = new AbortController().signal;
    if (call.target === 'canUseTool') {
      const [name, input, opts] = call.args as [string, unknown, Record<string, unknown>];
      return canUseTool!(name, input, { ...opts, signal });
    }
    if (call.target === 'hook') return flatHooks[call.event!][call.index!](call.args[0], call.args[1], { signal });
    return tools[call.server!].find(definition => definition.name === call.name)!.handler(call.args[0], {});
  };

  async function* run() {
    const first = await prompt[Symbol.asyncIterator]().next();
    const cwd = String(options.cwd);
    await fs.mkdir(cwd, { recursive: true });
    const { CLAUDE_CODE_OAUTH_TOKEN: _token, ...adapterEnv } = env;
    const config = {
      prompt: first.value,
      options: plain,
      runtime: { cwd, env: { ...adapterEnv,
        HOME: mockClaude.home, USERPROFILE: mockClaude.home, CLAUDE_CONFIG_DIR: mockClaude.home,
        ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_API_KEY: 'offline-stand-in-not-a-secret',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' } },
      callbacks: {
        canUseTool: typeof canUseTool === 'function',
        hooks: Object.fromEntries(Object.entries(flatHooks).map(([event, list]) => [event, list.length])),
        mcpServers: Object.fromEntries(Object.entries(tools).map(([name, list]) => [name, list.map(definition => ({
          name: definition.name, description: definition.description, properties: Object.keys(definition.shape ?? {}),
        }))])),
      },
    };
    const child = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'claudeRelaySdkBridge.mjs')], {
      cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { NODE_ENV: 'test', PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP },
    });
    bridge = child;
    child.stdin.on('error', () => undefined);
    const stderr: Buffer[] = [];
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
    bridges.push(new Promise<void>(resolve => child.once('close', (code) => {
      if (code !== 0 && !abortController.signal.aborted) failure = new Error(`SDK bridge exit ${code}: ${Buffer.concat(stderr).toString().slice(0, 2000)}`);
      ended = true;
      wake?.();
      resolve();
    })));
    createInterface({ input: child.stdout }).on('line', line => {
      const parsed = JSON.parse(line) as { type: string; id?: number; message?: unknown; target: string; args: unknown[] };
      if (parsed.type === 'frame') {
        frames.push(parsed.message);
        wake?.();
        return;
      }
      answer(parsed).then(
        result => send({ type: 'reply', id: parsed.id, result: result ?? {} }),
        (error: unknown) => send({ type: 'reply', id: parsed.id, error: error instanceof Error ? error.message : String(error) }),
      );
    });
    child.stdin.write(`${JSON.stringify(config)}\n`);
    if (abortController.signal.aborted) stop();
    for (;;) {
      if (frames.length) { yield frames.shift(); continue; }
      if (ended) break;
      await new Promise<void>(resolve => { wake = resolve; });
      wake = undefined;
    }
    if (failure) throw failure;
  }
  return Object.assign(run(), { close: stop });
}

const tools: OpenAI.ChatCompletionFunctionTool[] = [
  { type: 'function', function: { name: 'lookup', description: 'Look up the opening hours',
    parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'handoff_to_finish_node', description: 'Finish the flow',
    parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'handoff_to_worker', description: 'Spawn a worker for one task',
    parameters: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] } } },
];

async function runTurn(answer: Script, extra: Partial<CompletionInput> = {}) {
  script = answer;
  const lookups: number[] = [];
  const result = await new ClaudeSubscriptionAdapter().createCompletion({
    model: { id: 'm1', name: 'sonnet', provider: 'claude-subscription', ApiKey: '' },
    apiKey: 'oauth-token',
    messages: [{ role: 'user', content: 'When are you open?' }],
    tools,
    localToolExecutors: { lookup: async () => {
      lookups.push(requests.length);
      return { content: [{ type: 'text', text: 'opening hours: 8-18' }] };
    } },
    ...extra,
  } as CompletionInput);
  // Every Claude Code process of the turn has exited: no request can still come.
  await Promise.all(bridges);
  const message = result.completion.choices[0].message;
  return { result, message, handoffs: (message.tool_calls ?? []).map(call =>
    [(call as OpenAI.ChatCompletionMessageFunctionToolCall).function.name,
      JSON.parse((call as OpenAI.ChatCompletionMessageFunctionToolCall).function.arguments) as unknown]), lookups };
}

const afterRequests = (...turns: Block[][]): Script => request => turns[request] ?? [text(EXTRA)];

describe('Claude subscription hand-off with the bundled Claude Code and a stand-in model service (#1414)', () => {
  it('sends no further model request after a plain hand-off', async () => {
    const { message, handoffs, result } = await runTurn(afterRequests([text(ANSWER), tool('handoff_to_finish_node')]));

    expect(requests).toHaveLength(1);
    expect(message.content).toBe(ANSWER);
    expect(handoffs).toEqual([['handoff_to_finish_node', {}]]);
    expect(result.completion.usage).toMatchObject({ completion_tokens: OUTPUT_TOKENS });
    expect(JSON.stringify(result.transcript)).not.toContain(EXTRA);
  });

  it('sends no further model request after a plain hand-off that follows a tool call', async () => {
    const { message, handoffs, lookups, result } = await runTurn(afterRequests(
      [tool('lookup')],
      [text(ANSWER), tool('handoff_to_finish_node')],
    ));

    expect(lookups).toEqual([1]);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain('opening hours: 8-18');
    expect(message.content).toBe(ANSWER);
    expect(handoffs).toEqual([['handoff_to_finish_node', {}]]);
    expect(result.completion.usage).toMatchObject({ completion_tokens: 2 * OUTPUT_TOKENS });
  });

  it('leaves a turn without a hand-off unchanged', async () => {
    const { message, handoffs, lookups, result } = await runTurn(afterRequests([tool('lookup')], [text(ANSWER)]));

    expect(lookups).toEqual([1]);
    expect(requests).toHaveLength(2);
    expect(message.content).toBe(ANSWER);
    expect(handoffs).toEqual([]);
    expect(result.completion.usage).toMatchObject({ completion_tokens: 2 * OUTPUT_TOKENS });
  });

  it('keeps asking the model after a spawn hand-off, which waits for further calls', async () => {
    const { handoffs } = await runTurn(afterRequests(
      [tool('handoff_to_worker', { task: 'first' })],
      [tool('handoff_to_worker', { task: 'second' })],
      [text('Both workers are running.')],
    ));

    expect(requests).toHaveLength(3);
    expect(handoffs).toEqual([['handoff_to_worker', { task: 'first' }], ['handoff_to_worker', { task: 'second' }]]);
  });

  it('answers the next turn of the step with the whole conversation after a plain hand-off', async () => {
    const step = { conversationId: 'conversation', nodeId: 'step', sessionResume: true };
    const question: OpenAI.ChatCompletionMessageParam = { role: 'user', content: 'When are you open?' };
    const first = await runTurn(afterRequests([text(ANSWER), tool('handoff_to_finish_node')]), { ...step, messages: [question] });
    expect(requests).toHaveLength(1);

    requests = [];
    const handoffId = first.result.completion.choices[0].message.tool_calls![0].id;
    const second = await runTurn(afterRequests([text('You are welcome.')]), { ...step, messages: [
      question, ...first.result.transcript as OpenAI.ChatCompletionMessageParam[],
      { role: 'tool', tool_call_id: handoffId, content: 'Handed off to Finish.' },
      { role: 'user', content: 'Thanks, see you at nine.' },
    ] });

    expect(second.message.content).toBe('You are welcome.');
    expect(requests).toHaveLength(1);
    for (const part of ['When are you open?', ANSWER, 'Thanks, see you at nine.']) expect(requests[0]).toContain(part);
  });
});
