/**
 * The checks #1092, #1096 and #756 used to leave to a person with a real
 * Claude subscription, done by the real bundled Claude Code instead.
 *
 * Each turn runs FLUJO's Claude adapter. It hands its options to the installed
 * Agent SDK in its own Node process (Jest cannot load the SDK's ESM build); the
 * SDK starts the Claude Code that ships with it, with FLUJO's subscription
 * token, and every callback (approval, hooks, tools) is answered by the
 * adapter's own. Claude Code talks to `scripts/anthropic-stand-in.mjs`, a local
 * stand-in of Anthropic's service that answers in the documented formats:
 * streamed messages, prompt-cache usage, the subscription rate-limit headers,
 * the usage page and errors. No account, key or internet is needed.
 *
 * What a person was asked to try, and where it is checked here:
 *   #1092 benchmark (answer, tool, continue)       -> "answers, calls a tool once, continues"
 *   #1092 approve / reject / Stop on the card      -> "tool approvals"
 *   #1092 three messages reuse one session         -> "continues one Claude session"
 *   #1092 `/clear @path` comes back unchanged      -> "prompt text stays text"
 *   #1092 wrong token shows an error, not an answer-> "errors are errors"
 *   #1092 compaction, steering, forks, concurrent sessions, process exit
 *   #1096 instructions per turn with retained facts, request record, cache use, earlier thinking
 *   #756  the subscription numbers after a run, near a limit, at the limit, and from the usage page
 * Re-run on every Agent SDK update: the shapes come from the bundled Claude Code itself.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type OpenAI from 'openai';
import type { CompletionInput } from '@/backend/services/model/adapters/types';
import type { FlujoChatMessage } from '@/shared/types/chat';
import { createClaudeSdkRelay } from './fixtures/claudeSdkStandIn';
import { startAnthropicStandIn, systemTextOf, textOf } from '../../scripts/anthropic-stand-in.mjs';

const queryMock = jest.fn();
const prewarmMock = jest.fn();
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...a: unknown[]) => queryMock(...(a as [])),
  prewarm: (...a: unknown[]) => prewarmMock(...(a as [])),
  createSdkMcpServer: (cfg: unknown) => ({ __server: cfg }),
  tool: (name: string, description: string, shape: unknown, handler: unknown) => ({ name, description, shape, handler }),
}));
const callToolMock = jest.fn();
jest.mock('@/backend/services/mcp', () => ({ mcpService: { callTool: (...a: unknown[]) => callToolMock(...a) } }));
const mockClaude = { home: '' };
jest.mock('@/backend/services/model/adapters/claudeRuntimeHome', () => ({
  prepareClaudeRuntimeEnvironment: jest.fn(async () => ({
    home: mockClaude.home, workingDirectory: `${mockClaude.home}/workspace`, env: {},
  })),
}));

import { ClaudeSubscriptionAdapter } from '@/backend/services/model/adapters/claudeSubscriptionAdapter';
import { _clearAllSessionsForTests } from '@/backend/services/model/adapters/claudeSessionStore';
import { closeAllClaudeSpares } from '@/backend/services/model/adapters/claudeWarmProcess';
import { readClaudeOAuthAllowance } from '@/backend/services/model/allowance/claudeAccount';
import { allowanceAccountKey, readAllowanceSnapshot } from '@/backend/services/model/allowance/store';
import { projectModelAllowance } from '@/backend/services/model/allowance/projection';
import type { Model } from '@/shared/types/model/model';

jest.setTimeout(240_000);

type StandIn = Awaited<ReturnType<typeof startAnthropicStandIn>>;
type Body = { model: string; system?: unknown; messages: Array<{ role: string; content: unknown }>; tools?: Array<{ name: string }> };
type Block = { type: string; text?: string; content?: unknown; signature?: string; [key: string]: unknown };
type Reply = Parameters<StandIn['reply']>[0];
type Lifecycle = Record<string, unknown>;

const TOKEN = 'sk-ant-oat01-flujo-stand-in-not-a-token';
const SPANISH = 'Responde siempre en español.';
const ENGLISH = 'Always answer in English.';
const COMPACTION = /CRITICAL: Respond with TEXT ONLY/;

let root: string;
let standIn: StandIn;
let prompts: unknown[];
let pids: number[];
let forkNext = false;
const relay = createClaudeSdkRelay({
  baseUrl: () => standIn.baseUrl,
  home: () => mockClaude.home,
  auth: 'oauth',
  streamInput: true,
  onPrompt: message => prompts.push(message),
  onSpawn: pid => pids.push(pid),
  takeOptionOverrides: () => {
    if (!forkNext) return undefined;
    forkNext = false;
    return { forkSession: true };
  },
});

const blocksOf = (content: unknown): Block[] => (typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content as Block[] : []);
/** Every ticket number the conversation names, in order. */
const ticketsIn = (body: Body) => body.messages.flatMap(message => [...textOf(message.content).matchAll(/ticket (\d+)/gi)].map(match => match[1]));

/**
 * The stand-in model: it calls the order tool when asked, answers from a tool
 * result, names the remembered ticket in the language the instructions ask for,
 * repeats a message word for word, and summarises when Claude Code compacts.
 * Claude Code sends its environment note as a system message after the user's
 * words, so the question is the last user message, not the last message.
 */
function planReply({ body: raw, index }: Reply) {
  const body = raw as Body;
  const lastUser = [...body.messages].reverse().find(message => message.role === 'user')!;
  const result = blocksOf(lastUser.content).find(block => block.type === 'tool_result');
  const latest = textOf(lastUser.content);
  const system = systemTextOf(body.system);
  if (result) return { blocks: [{ type: 'text', text: `The tool said: ${JSON.stringify(result.content)}` }] };
  if (COMPACTION.test(latest)) return { blocks: [{ type: 'text', text: `<summary>The user asked me to remember ticket ${ticketsIn(body)[0]}.</summary>` }] };
  const tool = (body.tools ?? []).find(entry => entry.name.includes('lookup_order'));
  if (latest.includes('Look up order A-1') && tool) return { blocks: [{ type: 'tool_use', name: tool.name, input: { order_id: 'A-1' } }] };
  if (latest.includes('Which ticket?')) {
    const ticket = ticketsIn(body)[0];
    return { blocks: [{ type: 'thinking', thinking: '' }, { type: 'text', text: system.includes(SPANISH) ? `Tu ticket es ${ticket}.` : `Your ticket is ${ticket}.` }] };
  }
  const repeat = /Repeat my message: (.*)$/m.exec(latest);
  if (repeat) return { blocks: [{ type: 'text', text: `You said: ${repeat[1]}` }] };
  return { blocks: [{ type: 'thinking', thinking: '' }, { type: 'text', text: `Noted (${index}).` }] };
}

const model = (token = TOKEN): Model => ({ id: 'claude-model', name: 'sonnet', provider: 'claude-subscription', adapter: 'claude-cli', ApiKey: token } as Model);
const modelRequests = (from: number) => standIn.requests.slice(from).filter(request => request.path === '/v1/messages' && request.body);
const bodyOf = (request: StandIn['requests'][number]) => request.body as Body;

async function turn(messages: OpenAI.ChatCompletionMessageParam[], extra: Partial<CompletionInput> = {}) {
  const from = { requests: standIn.requests.length, prompts: prompts.length };
  const events: Array<{ kind: string; state?: string; accounting?: { partial?: boolean; usage?: Record<string, number> } }> = [];
  let lifecycle: Lifecycle | undefined;
  const token = extra.apiKey ?? TOKEN;
  try {
    const result = await new ClaudeSubscriptionAdapter().createCompletion({
      model: model(token), apiKey: token, messages,
      onSessionEvent: event => events.push(event),
      onSdkRequest: async snapshot => {
        lifecycle = (snapshot.request as { sessionLifecycle?: Lifecycle }).sessionLifecycle;
        return 'dispatch';
      },
      onSdkRequestResult: async () => undefined,
      ...extra,
    } as CompletionInput);
    return { result, answer: String(result.completion.choices[0].message.content ?? ''), events, lifecycle,
      requests: modelRequests(from.requests), prompts: prompts.slice(from.prompts) };
  } finally {
    // Every Claude Code process of the turn has exited before anything is judged.
    await relay.settled();
  }
}

/** One conversation of one step: each turn sends the step's instructions and the whole history. */
function conversation(id: string, policy: 'stable' | 'per-turn' = 'stable') {
  const history: OpenAI.ChatCompletionMessageParam[] = [];
  return async (instructions: string, user: string, extra: Partial<CompletionInput> = {}) => {
    history.push({ role: 'user', content: user });
    const done = await turn([{ role: 'system', content: instructions }, ...history],
      { conversationId: id, nodeId: 'step', sessionResume: true, systemPromptPolicy: policy, ...extra });
    history.push(...(done.result.transcript ?? []) as OpenAI.ChatCompletionMessageParam[]);
    return done;
  };
}

/** What FLUJO handed the SDK as the user's message, as text. */
const sentText = (message: unknown) => {
  const content = (message as { message?: { content?: unknown } }).message?.content;
  return typeof content === 'string' ? content : textOf(content);
};

const ORDER_TOOL: OpenAI.ChatCompletionFunctionTool = { type: 'function', function: { name: 'orders__lookup_order',
  description: 'Look up an order by its id.', parameters: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] } } };
const withOrderTool: Partial<CompletionInput> = { tools: [ORDER_TOOL], toolNameMap: { orders__lookup_order: { server: 'orders', tool: 'lookup_order' } } };

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-claude-stand-in-'));
  standIn = await startAnthropicStandIn({ reply: planReply });
});
afterAll(async () => {
  closeAllClaudeSpares();
  await relay.settled();
  await standIn.close();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
beforeEach(async () => {
  _clearAllSessionsForTests();
  prompts = [];
  pids = [];
  forkNext = false;
  standIn.reply = planReply;
  standIn.subscription = {};
  standIn.cache.entries.clear();
  callToolMock.mockReset().mockResolvedValue({ success: true, data: { content: [{ type: 'text', text: 'Order A-1 ships today.' }] } });
  mockClaude.home = await fs.mkdtemp(path.join(root, 'home-'));
  queryMock.mockReset().mockImplementation(relay.relayQuery);
  prewarmMock.mockReset();
});
afterEach(async () => {
  // #1092 process shutdown: no Claude Code process outlives its turn, stopped or not.
  await relay.settled();
  const deadline = Date.now() + 10_000;
  while (pids.some(alive) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 200));
  expect(pids.filter(alive)).toEqual([]);
});

describe('#1092: answers, calls a tool once and continues, through the bundled Claude Code', () => {
  it('answers with the subscription token and reports the turn\'s own usage', async () => {
    const done = await turn([{ role: 'user', content: 'Hello there.' }]);
    expect(done.answer).toBe('Noted (0).');
    expect(done.requests).toHaveLength(1);
    expect(done.requests[0]).toMatchObject({ credential: 'oauth', status: 200 });
    expect(bodyOf(done.requests[0]).model).toMatch(/^claude-/);
    const usage = done.requests[0].usage!;
    expect(done.result.completion.usage).toMatchObject({ completion_tokens: usage.output_tokens,
      prompt_tokens: usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens });
    expect(pids.length).toBeGreaterThan(0);
  });

  it('offers only FLUJO\'s tools, calls the MCP tool exactly once and answers from its result', async () => {
    const done = await turn([{ role: 'user', content: 'Look up order A-1, please.' }], withOrderTool);
    expect(callToolMock).toHaveBeenCalledTimes(1);
    expect(callToolMock.mock.calls[0].slice(0, 3)).toEqual(['orders', 'lookup_order', { order_id: 'A-1' }]);
    expect(done.requests).toHaveLength(2);
    // No built-in tool (Bash, Task, Agent, ...) is offered, so nothing can start background work.
    // DeferredToolPlaceholder is Claude Code's own "never call this tool" marker for lazily loaded tools.
    for (const request of done.requests) {
      expect((bodyOf(request).tools ?? []).map(tool => tool.name).filter(name => name !== 'DeferredToolPlaceholder'))
        .toEqual([expect.stringMatching(/^mcp__flujo__.*lookup_order$/)]);
    }
    expect(done.answer).toContain('ships today');
  });

  it('continues one Claude session over three turns: later answers remember, only the new message is sent, each turn is counted once', async () => {
    const step = conversation('benchmark');
    const first = await step(ENGLISH, 'Remember ticket 4821.');
    const second = await step(ENGLISH, 'Which ticket?');
    const third = await step(ENGLISH, 'Which ticket? Once more.');
    expect(second.answer).toBe('Your ticket is 4821.');
    expect(third.answer).toBe('Your ticket is 4821.');
    for (const later of [second, third]) {
      expect(later.lifecycle).toMatchObject({ resumeReason: 'compatible-history-and-transcript' });
      expect(later.lifecycle!.resumedSession).toBe(second.lifecycle!.resumedSession);
      expect(later.prompts.map(sentText)).toEqual([expect.not.stringContaining('Remember ticket 4821.')]);
      expect(later.requests).toHaveLength(1);
      // The session brought the earlier turns, each exactly once.
      const sent = JSON.stringify(bodyOf(later.requests[0]).messages);
      expect(sent.split('Remember ticket 4821.').length - 1).toBe(1);
      // This turn's usage is this turn's request only, never the session's running total.
      const usage = later.requests[0].usage!;
      expect(later.result.completion.usage).toMatchObject({ completion_tokens: usage.output_tokens,
        prompt_tokens: usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens });
    }
    expect(first.prompts.map(sentText).join('\n')).toContain('Remember ticket 4821.');
    expect(third.prompts.map(sentText)).toEqual(['Which ticket? Once more.']);
  });
});

describe('#1092: tool approvals', () => {
  it('runs an approved tool once, after asking once', async () => {
    const asked: unknown[] = [];
    const done = await turn([{ role: 'user', content: 'Look up order A-1, please.' }],
      { ...withOrderTool, requestToolApproval: async call => { asked.push(call); return true; } });
    expect(asked).toEqual([expect.objectContaining({ name: expect.stringContaining('lookup_order'), args: { order_id: 'A-1' } })]);
    expect(callToolMock).toHaveBeenCalledTimes(1);
    expect(done.answer).toContain('ships today');
  });

  it('never runs a rejected tool and tells the model "tool denied"', async () => {
    const done = await turn([{ role: 'user', content: 'Look up order A-1, please.' }], { ...withOrderTool, requestToolApproval: async () => false });
    expect(callToolMock).not.toHaveBeenCalled();
    expect(done.requests).toHaveLength(2);
    expect(JSON.stringify(bodyOf(done.requests[1]).messages.filter(message => message.role === 'user').at(-1))).toContain('tool denied');
    expect(done.answer).toContain('tool denied');
  });

  it('runs nothing and asks the model nothing more when Stop is pressed while the approval is open', async () => {
    const controller = new AbortController();
    let asked!: () => void;
    const open = new Promise<void>(resolve => { asked = resolve; });
    const from = standIn.requests.length;
    const running = turn([{ role: 'user', content: 'Look up order A-1, please.' }], { ...withOrderTool, signal: controller.signal,
      requestToolApproval: () => { asked(); return new Promise<boolean>(() => undefined); } });
    await open;
    const requestsWhenStopped = modelRequests(from).length;
    controller.abort();
    await expect(running).rejects.toThrow(/cancel/i);
    expect(callToolMock).not.toHaveBeenCalled();
    expect(modelRequests(from)).toHaveLength(requestsWhenStopped);
  });
});

describe('#1092: prompt text stays text', () => {
  it('sends /clear, @paths, @server:resource mentions and slash words to the model unchanged', async () => {
    const literal = '/clear @notes.txt @orders:order://A-1 /compact please';
    const done = await turn([{ role: 'user', content: `Repeat my message: ${literal}` }]);
    expect(done.answer).toBe(`You said: ${literal}`);
    expect(done.requests).toHaveLength(1);
    expect(JSON.stringify(bodyOf(done.requests[0]).messages.filter(message => message.role === 'user'))).toContain(`Repeat my message: ${literal}`);
  });
});

describe('#1092: errors are errors, never answers', () => {
  it('fails a turn with a refused token and reports an API error instead of saving Claude Code\'s message as the answer', async () => {
    const events: Array<{ kind: string; state?: string }> = [];
    const transcript: FlujoChatMessage[] = [];
    await expect(turn([{ role: 'user', content: 'Hello there.' }], { apiKey: 'sk-ant-oat01-invalid-token',
      onSessionEvent: event => events.push(event), onTranscriptMessage: message => transcript.push(message) })).rejects.toThrow(/401 OAuth token has expired/);
    expect(standIn.requests.at(-1)).toMatchObject({ status: 401, credential: 'oauth' });
    expect(events).toContainEqual(expect.objectContaining({ kind: 'api_error' }));
    expect(transcript.filter(message => message.role === 'assistant')).toEqual([]);
  });
});

describe('#1092 and #1096: compaction, steering, forks, concurrent sessions', () => {
  it('keeps each turn\'s instructions and the remembered facts across a compaction inside a live session', async () => {
    const step = conversation('compaction', 'per-turn');
    standIn.reply = request => ({ ...planReply(request), usage: { input_tokens: 985_000, output_tokens: 20 } });
    await step(ENGLISH, 'Remember ticket 4821.');
    standIn.reply = planReply;
    const after = await step(SPANISH, 'Which ticket?');
    expect(after.events).toContainEqual(expect.objectContaining({ kind: 'compact_boundary' }));
    const [summary, answer] = after.requests;
    expect(after.requests).toHaveLength(2);
    expect(JSON.stringify(bodyOf(summary).messages)).toMatch(COMPACTION);
    // After the compaction the session runs on the summary, with this turn's instructions only.
    expect(systemTextOf(bodyOf(answer).system)).toContain(SPANISH);
    expect(JSON.stringify(bodyOf(answer))).not.toContain(ENGLISH);
    expect(JSON.stringify(bodyOf(answer).messages)).toContain('remember ticket 4821');
    expect(after.answer).toBe('Tu ticket es 4821.');
    // The summary request is paid for too: the turn's accounting covers both requests, once.
    const sum = (field: 'input_tokens' | 'output_tokens') => after.requests.reduce((total, request) => total + request.usage![field], 0);
    expect(after.events.find(event => event.kind === 'accounting')?.accounting).toMatchObject({ partial: false,
      usage: { input_tokens: sum('input_tokens'), output_tokens: sum('output_tokens') } });
  });

  it('keeps stable instructions after a compaction', async () => {
    const step = conversation('stable-compaction', 'stable');
    standIn.reply = request => ({ ...planReply(request), usage: { input_tokens: 985_000, output_tokens: 20 } });
    await step(SPANISH, 'Remember ticket 4821.');
    standIn.reply = planReply;
    const after = await step(SPANISH, 'Which ticket?');
    expect(after.events).toContainEqual(expect.objectContaining({ kind: 'compact_boundary' }));
    expect(systemTextOf(bodyOf(after.requests.at(-1)!).system)).toContain(SPANISH);
    expect(after.answer).toBe('Tu ticket es 4821.');
  });

  it('hands a message sent while Claude is working to the running session, once', async () => {
    let steer: FlujoChatMessage[] = [];
    let first = true;
    standIn.reply = async request => {
      if (first) {
        first = false;
        steer = [{ id: 'steer-1', role: 'user', content: 'Also remember ticket 77.' } as FlujoChatMessage];
        await new Promise(resolve => setTimeout(resolve, 1_500));
      }
      return planReply(request);
    };
    const done = await turn([{ role: 'user', content: 'Hello there.' }], { consumeSteeringMessages: () => {
      const taken = steer;
      steer = [];
      return taken;
    } });
    expect(done.prompts.map(sentText)).toEqual([expect.stringContaining('Hello there.'), 'Also remember ticket 77.']);
    expect(done.requests).toHaveLength(2);
    expect(JSON.stringify(bodyOf(done.requests[1]).messages).split('Also remember ticket 77.').length - 1).toBe(1);
    expect(done.result.transcript).toContainEqual(expect.objectContaining({ role: 'user', content: 'Also remember ticket 77.' }));
  });

  it('fails a resumed turn that comes back as a different session, and starts the next one fresh with the whole conversation', async () => {
    const step = conversation('fork');
    await step(ENGLISH, 'Remember ticket 4821.');
    forkNext = true;
    await expect(step(ENGLISH, 'Which ticket?')).rejects.toThrow(/session/i);
    const fresh = await step(ENGLISH, 'Which ticket? Again.');
    expect(fresh.lifecycle!.resumeReason).not.toBe('compatible-history-and-transcript');
    expect(fresh.prompts.map(sentText).join('\n')).toContain('Remember ticket 4821.');
    expect(fresh.answer).toBe('Your ticket is 4821.');
  });

  it('keeps two conversations running at the same time in their own sessions', async () => {
    const one = conversation('one');
    const two = conversation('two');
    const from = standIn.requests.length;
    await Promise.all([one(ENGLISH, 'Remember ticket 1111.'), two(ENGLISH, 'Remember ticket 2222.')]);
    const [first, second] = await Promise.all([one(ENGLISH, 'Which ticket?'), two(ENGLISH, 'Which ticket?')]);
    expect([first.answer, second.answer]).toEqual(['Your ticket is 1111.', 'Your ticket is 2222.']);
    expect(first.lifecycle).toMatchObject({ resumeReason: 'compatible-history-and-transcript' });
    expect(second.lifecycle).toMatchObject({ resumeReason: 'compatible-history-and-transcript' });
    expect(first.lifecycle!.resumedSession).not.toBe(second.lifecycle!.resumedSession);
    // The turns overlapped, so requests are told apart by what they carry: never both conversations.
    const sent = modelRequests(from).map(request => JSON.stringify(bodyOf(request).messages));
    expect(sent).toHaveLength(4);
    expect(sent.filter(text => text.includes('1111'))).toHaveLength(2);
    expect(sent.filter(text => text.includes('2222'))).toHaveLength(2);
    expect(sent.filter(text => text.includes('1111') && text.includes('2222'))).toEqual([]);
  });
});

describe('#1096: instructions per turn on a resumed session, with the cache and earlier thinking measured', () => {
  const longRules = (language: string) => `${language} ${'Keep each answer to one short sentence and name facts exactly. '.repeat(120)}`;
  const cacheRead = (done: { requests: StandIn['requests'] }) => done.requests.at(-1)!.usage!.cache_read_input_tokens;

  it('answers in each turn\'s language with the remembered ticket, sends only the new message, and records why it resumed', async () => {
    const step = conversation('per-turn', 'per-turn');
    await step(longRules(ENGLISH), 'Remember ticket 4821.');
    const spanish = await step(longRules(SPANISH), 'Which ticket?');
    expect(spanish.answer).toBe('Tu ticket es 4821.');
    expect(spanish.lifecycle).toMatchObject({ requestedPromptPolicy: 'per-turn', snapshot: false, resumeReason: 'compatible-history-and-transcript' });
    expect(spanish.prompts.map(sentText)).toEqual(['Which ticket?']);
    // New instructions read nothing from the prompt cache: the whole conversation is paid again.
    expect(cacheRead(spanish)).toBe(0);
    expect(spanish.requests[0].usage!.cache_creation_input_tokens).toBeGreaterThan(0);
    // The same instructions again keep the cache: the next turn reads the conversation so far.
    const again = await step(longRules(SPANISH), 'Which ticket? Again.');
    expect(cacheRead(again)).toBeGreaterThanOrEqual(spanish.requests[0].usage!.cache_creation_input_tokens);
    expect(again.result.completion.usage).toMatchObject({ prompt_tokens_details: { cached_tokens: cacheRead(again) } });
    // Back to the first instructions: only their own earlier cache entry is found, not the conversation since.
    const english = await step(longRules(ENGLISH), 'Which ticket? Third time.');
    expect(english.answer).toBe('Your ticket is 4821.');
    expect(JSON.stringify(bodyOf(english.requests[0]).system)).not.toContain(SPANISH);
    expect(english.lifecycle).toMatchObject({ resumeReason: 'compatible-history-and-transcript' });
    expect(cacheRead(english)).toBeLessThan(cacheRead(again));
  });

  it('reads the cached conversation on an unchanged stable turn, and starts a new session that still knows the ticket after an edit', async () => {
    const step = conversation('stable', 'stable');
    const first = await step(longRules(ENGLISH), 'Remember ticket 4821.');
    const second = await step(longRules(ENGLISH), 'Which ticket?');
    expect(cacheRead(first)).toBe(0);
    expect(first.requests[0].usage!.cache_creation_input_tokens).toBeGreaterThan(0);
    expect(second.lifecycle).toMatchObject({ snapshot: true, resumeReason: 'compatible-history-and-transcript' });
    // The resumed turn reads everything the first one cached, and pays full price only for what is new.
    expect(cacheRead(second)).toBeGreaterThanOrEqual(first.requests[0].usage!.cache_creation_input_tokens);
    expect(second.result.completion.usage).toMatchObject({ prompt_tokens_details: { cached_tokens: cacheRead(second) } });
    const edited = await step(longRules(SPANISH), 'Which ticket? Again.');
    expect(edited.lifecycle).toMatchObject({ resumeReason: 'instructions-tools-or-settings-changed' });
    expect(edited.answer).toBe('Tu ticket es 4821.');
  });

  it.each(['stable', 'per-turn'] as const)('hands earlier thinking back unchanged on a %s resume (the service decides whether it still applies)', async policy => {
    const step = conversation(`thinking-${policy}`, policy);
    const first = await step(ENGLISH, 'Remember ticket 4821.');
    const written = (first.requests[0].reply as Block[]).find(block => block.type === 'thinking')!;
    const second = await step(policy === 'per-turn' ? SPANISH : ENGLISH, 'Which ticket?');
    expect(second.lifecycle).toMatchObject({ resumeReason: 'compatible-history-and-transcript' });
    const thinking = bodyOf(second.requests[0]).messages.filter(message => message.role === 'assistant')
      .flatMap(message => blocksOf(message.content)).filter(block => block.type === 'thinking');
    expect(thinking).toEqual([expect.objectContaining({ signature: written.signature })]);
  });
});

describe('#756: what is left of the subscription, from a real run', () => {
  const projected = (token: string) => {
    const key = allowanceAccountKey('claude', token);
    return projectModelAllowance(model(token), key, readAllowanceSnapshot(key));
  };
  const numbers = (allowance: ReturnType<typeof projected>) => allowance.windows.map(window => [window.id, window.remainingPercent]);

  it('shows both windows after any run, far from every limit, and the usage page agrees', async () => {
    const token = 'sk-ant-oat01-far-from-limits';
    standIn.subscription = { fiveHour: 0.12, sevenDay: 0.31 };
    await turn([{ role: 'user', content: 'Hello there.' }], { apiKey: token });
    const allowance = projected(token);
    expect(allowance).toMatchObject({ status: 'available', source: 'claude-rate-limit-event', billing: 'subscription' });
    expect(numbers(allowance)).toEqual([['five_hour', 88], ['seven_day', 69]]);

    const realFetch = global.fetch;
    global.fetch = ((input: string | URL | Request, init?: RequestInit) =>
      realFetch(String(input).replace('https://api.anthropic.com', standIn.baseUrl), init)) as typeof fetch;
    try {
      const page = await readClaudeOAuthAllowance(token, new AbortController().signal);
      expect(page.source).toBe('claude-oauth-usage');
      expect(page.windows.map(window => [window.id, window.remainingPercent])).toEqual([['five_hour', 88], ['seven_day', 69]]);
    } finally {
      global.fetch = realFetch;
    }
    expect(standIn.requests.at(-1)).toMatchObject({ path: '/api/oauth/usage', credential: 'oauth', betas: ['oauth-2025-04-20'] });
  });

  it('shows the weekly warning number near a limit', async () => {
    const token = 'sk-ant-oat01-near-the-weekly-limit';
    standIn.subscription = { fiveHour: 0.4, sevenDay: 0.88 };
    await turn([{ role: 'user', content: 'Hello there.' }], { apiKey: token });
    expect(numbers(projected(token))).toEqual([['five_hour', 60], ['seven_day', 12]]);
  });

  it('fails the turn at the limit, says why, and shows nothing left', async () => {
    const token = 'sk-ant-oat01-at-the-five-hour-limit';
    standIn.subscription = { fiveHour: 1, sevenDay: 0.5 };
    // The error keeps the 429, so a fallback policy moves on to its next model.
    await expect(turn([{ role: 'user', content: 'Hello there.' }], { apiKey: token })).rejects.toMatchObject({
      message: expect.stringMatching(/limit/i), status: 429, headers: { 'retry-after': expect.stringMatching(/^\d+$/) } });
    expect(standIn.requests.at(-1)).toMatchObject({ status: 429 });
    expect(numbers(projected(token))).toEqual([['five_hour', 0], ['seven_day', 50]]);
  });
});
