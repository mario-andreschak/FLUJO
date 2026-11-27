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
 * machine counts every model request. Re-check on every Agent SDK upgrade:
 * the stop relies on the SDK's PostToolBatch hook and its `continue: false`,
 * so each test also checks what that hook was asked and answered.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type OpenAI from 'openai';
import type { CompletionInput } from '@/backend/services/model/adapters/types';
import { createClaudeSdkRelay, startClaudeModelStandIn, type ClaudeModelStandIn, type StandInBlock, type StandInScript } from './fixtures/claudeSdkStandIn';

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

type Block = StandInBlock;
type Script = StandInScript;

const ANSWER = 'The pharmacy is open from 8:00 to 18:00.';
const EXTRA = 'An extra model turn after the hand-off.';
const OUTPUT_TOKENS = 7;
const tool = (name: string, input: Record<string, unknown> = {}): Block => ({ type: 'tool_use', name: `mcp__flujo__${name}`, input });
const text = (value: string): Block => ({ type: 'text', text: value });

let root: string;
let standIn: ClaudeModelStandIn;
/** Each model request's messages, as JSON. */
let requests: string[];
/** The tool-use ids of each PostToolBatch call and what the adapter answered. */
let batches: Array<{ toolUseIds: string[]; answer: unknown }>;
/** Why each Claude Code run ended, from its result message. */
let endings: Array<string | undefined>;
const relay = createClaudeSdkRelay({
  baseUrl: () => standIn.baseUrl,
  home: () => mockClaude.home,
  onResult: reason => endings.push(reason),
  onToolBatch: batch => batches.push(batch),
});

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-claude-handoff-'));
  standIn = await startClaudeModelStandIn(OUTPUT_TOKENS);
});
afterAll(async () => {
  await relay.settled();
  await standIn.close();
  await fs.rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  _clearAllSessionsForTests();
  standIn.requests = requests = [];
  batches = [];
  endings = [];
  mockClaude.home = await fs.mkdtemp(path.join(root, 'home-'));
  queryMock.mockReset().mockImplementation(relay.relayQuery);
});

const tools: OpenAI.ChatCompletionFunctionTool[] = [
  { type: 'function', function: { name: 'lookup', description: 'Look up the opening hours',
    parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'handoff_to_finish_node', description: 'Finish the flow',
    parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'handoff_to_worker', description: 'Spawn a worker for one task',
    parameters: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] } } },
];

async function runTurn(answer: Script, extra: Partial<CompletionInput> = {}) {
  standIn.script = answer;
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
  await relay.settled();
  const message = result.completion.choices[0].message;
  return { result, message, handoffs: (message.tool_calls ?? []).map(call =>
    [(call as OpenAI.ChatCompletionMessageFunctionToolCall).function.name,
      JSON.parse((call as OpenAI.ChatCompletionMessageFunctionToolCall).function.arguments) as unknown]), lookups };
}

const afterRequests = (...turns: Block[][]): Script => request => turns[request] ?? [text(EXTRA)];
/** The stand-in's id for the tool call at `position` of its `request`-th answer (1-based). */
const useId = (request: number, position: number) => `toolu_${request}_${position}`;
const STOP = { continue: false, stopReason: expect.any(String) };

describe('Claude subscription hand-off with the bundled Claude Code and a stand-in model service (#1414)', () => {
  it('sends no further model request after a plain hand-off', async () => {
    const { message, handoffs, result } = await runTurn(afterRequests([text(ANSWER), tool('handoff_to_finish_node')]));

    expect(requests).toHaveLength(1);
    // Stopped by the hook, not by luck: an SDK upgrade that stops asking
    // PostToolBatch for FLUJO's tools, or ignores its answer, fails here.
    expect(batches).toEqual([{ toolUseIds: [useId(1, 1)], answer: STOP }]);
    expect(endings).toEqual(['hook_stopped']);
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
    expect(batches).toEqual([{ toolUseIds: [useId(1, 0)], answer: {} }, { toolUseIds: [useId(2, 1)], answer: STOP }]);
    expect(endings).toEqual(['hook_stopped']);
    expect(message.content).toBe(ANSWER);
    expect(handoffs).toEqual([['handoff_to_finish_node', {}]]);
    expect(result.completion.usage).toMatchObject({ completion_tokens: 2 * OUTPUT_TOKENS });
  });

  it('lets a tool called beside the hand-off finish, then sends no further model request', async () => {
    const { handoffs, lookups } = await runTurn(afterRequests([tool('lookup'), tool('handoff_to_finish_node')]));

    expect(lookups).toEqual([1]);
    expect(requests).toHaveLength(1);
    expect(batches).toEqual([{ toolUseIds: [useId(1, 0), useId(1, 1)], answer: STOP }]);
    expect(endings).toEqual(['hook_stopped']);
    expect(handoffs).toEqual([['handoff_to_finish_node', {}]]);
  });

  it('leaves a turn without a hand-off unchanged', async () => {
    const { message, handoffs, lookups, result } = await runTurn(afterRequests([tool('lookup')], [text(ANSWER)]));

    expect(lookups).toEqual([1]);
    expect(requests).toHaveLength(2);
    expect(batches).toEqual([{ toolUseIds: [useId(1, 0)], answer: {} }]);
    expect(endings).toEqual(['completed']);
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
    expect(batches).toEqual([{ toolUseIds: [useId(1, 0)], answer: {} }, { toolUseIds: [useId(2, 0)], answer: {} }]);
    expect(handoffs).toEqual([['handoff_to_worker', { task: 'first' }], ['handoff_to_worker', { task: 'second' }]]);
  });

  it('answers the next turn of the step with the whole conversation after a plain hand-off', async () => {
    const step = { conversationId: 'conversation', nodeId: 'step', sessionResume: true };
    const question: OpenAI.ChatCompletionMessageParam = { role: 'user', content: 'When are you open?' };
    const first = await runTurn(afterRequests([text(ANSWER), tool('handoff_to_finish_node')]), { ...step, messages: [question] });
    expect(requests).toHaveLength(1);
    expect(endings).toEqual(['hook_stopped']);

    standIn.requests = requests = [];
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
