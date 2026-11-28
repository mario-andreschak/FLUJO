/**
 * The in-app checks #1096, #1092 and #756 asked a person to do with a real
 * Claude subscription, done through FLUJO itself: a saved one-step flow on a
 * saved Claude subscription model, sent turns through the real
 * /v1/chat/completions route, flow engine, storage and model request records.
 * The Agent SDK runs in its own Node process with the Claude Code bundled with
 * it, in FLUJO's own isolated Claude home, and talks to
 * `scripts/anthropic-stand-in.mjs`, a local stand-in of Anthropic's service.
 * No account, key or internet is needed.
 *
 *   #1096 a step on "use current instructions each turn" whose instructions come
 *         from `${kv:...}`: the language changes, the ticket is remembered, and
 *         the request record says why the session was resumed and what was sent
 *   #1096 the same step on stable instructions: an unchanged turn reads the
 *         cache, the conversation keeps its instructions, and an edit applies
 *         to the next conversation
 *   #1092 a refused token ends the chat turn with an error, never an answer
 *   #756  after the runs, the allowance bar of the model shows Claude's numbers
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { createClaudeSdkRelay } from '../model/fixtures/claudeSdkStandIn';
import { stopBackgroundWorkers } from '../helpers/backgroundWorkers';
import { startAnthropicStandIn, systemTextOf, textOf } from '../../scripts/anthropic-stand-in.mjs';

jest.mock('@/utils/logger', () => ({ createLogger: () => ({ debug: () => {}, verbose: () => {}, info: () => {}, warn: () => {}, error: () => {} }) }));
const queryMock = jest.fn();
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...a: unknown[]) => queryMock(...(a as [])),
  prewarm: jest.fn(),
  createSdkMcpServer: (cfg: unknown) => ({ __server: cfg }),
  tool: (name: string, description: string, shape: unknown, handler: unknown) => ({ name, description, shape, handler }),
}));

jest.setTimeout(300_000);

type StandIn = Awaited<ReturnType<typeof startAnthropicStandIn>>;
type Body = { system?: unknown; messages: Array<{ role: string; content: unknown }> };

const TOKEN = 'sk-ant-oat01-flujo-flow-stand-in-not-a-token';
const REFUSED = 'sk-ant-oat01-invalid-flow-stand-in';
const ENGLISH = 'Always answer in English.';
const SPANISH = 'Responde siempre en español.';
const ENV = ['FLUJO_DATA_DIR', 'FLUJO_ENCRYPTION_SECRET_FILE'] as const;

let root: string;
let previous: Array<string | undefined>;
let hostClaudeEnv: Array<[string, string]>;
let standIn: StandIn;
const relay = createClaudeSdkRelay({ baseUrl: () => standIn.baseUrl, auth: 'oauth', streamInput: true });

/** The stand-in model: names the remembered ticket in the language the instructions ask for. */
function planReply({ body: raw, index }: { body: unknown; index: number }) {
  const body = raw as Body;
  const question = textOf([...body.messages].reverse().find(message => message.role === 'user')!.content);
  if (!question.includes('Which ticket?')) return { blocks: [{ type: 'text', text: `Noted (${index}).` }] };
  const ticket = body.messages.flatMap(message => [...textOf(message.content).matchAll(/ticket (\d+)/gi)].map(match => match[1]))[0];
  return { blocks: [{ type: 'text', text: systemTextOf(body.system).includes(SPANISH) ? `Tu ticket es ${ticket}.` : `Your ticket is ${ticket}.` }] };
}

const node = (id: string, type: string, properties: Record<string, unknown> = {}) =>
  ({ id, type, position: { x: 0, y: 0 }, data: { type, label: `${type} node`, properties } });
const edge = (source: { id: string; type: string }, target: { id: string; type: string }) => ({
  id: `${source.id}:${source.type}-bottom->${target.id}:${target.type}-top`, source: source.id, target: target.id,
  sourceHandle: `${source.type}-bottom`, targetHandle: `${target.type}-top`, type: 'custom', data: { edgeType: 'standard' } });

/** start -> one Claude step -> finish; the step's instructions include a kv value the test changes between turns. */
function flow(name: string, model: string, policy: 'per-turn' | 'stable') {
  const nodes = [
    node('start', 'start'),
    node('step', 'process', { boundModel: model, inputMode: 'full-history', allowQuestion: false, systemPromptPolicy: policy,
      promptTemplate: `Help with support tickets. Keep each answer to one short sentence and name facts exactly. ${'Be precise. '.repeat(200)}\n\${kv:global/LANG_RULE}` }),
    node('finish', 'finish'),
  ];
  return { id: name.toLowerCase(), name, nodes, edges: [edge(nodes[0], nodes[1]), edge(nodes[1], nodes[2])], updatedAt: Date.now() };
}

async function inWorkspace<T>(task: () => Promise<T>): Promise<T> {
  const { runWithWorkspace } = await import('@/utils/workspace');
  return runWithWorkspace('default-workspace', task);
}

async function setLanguage(rule: string) {
  const { kvSet } = await import('@/backend/services/kvStore');
  expect(await inWorkspace(() => kvSet('global', 'LANG_RULE', rule))).not.toHaveProperty('skipped');
}

/** One chat turn through the real route; a failed run is returned as `error`, never as an answer. */
async function chat(flowName: string, content: string, conversationId?: string) {
  const { POST } = await import('@/app/v1/chat/completions/route');
  const payload = JSON.stringify({ model: `flow-${flowName}`, stream: false,
    metadata: { flujo: 'true', ...(conversationId ? { conversationId, appendMessages: 'true' } : {}) },
    messages: [{ id: randomUUID(), role: 'user', content }] });
  const from = standIn.requests.length;
  const response = await POST(new NextRequest('http://localhost/v1/chat/completions', { method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }, body: payload }));
  const parsed = JSON.parse(await response.text());
  await relay.settled();
  await settle();
  return { status: response.status, answer: String(parsed.choices?.[0]?.message?.content ?? ''), error: parsed.error,
    conversationId: String(parsed.conversation_id ?? conversationId ?? ''),
    requests: standIn.requests.slice(from).filter(request => request.path === '/v1/messages' && request.body) };
}

/** Runs keep saving briefly after the reply ends; let them finish. */
async function settle(): Promise<void> {
  const { getFlowRunAdmissionDiagnostics } = await import('@/backend/execution/flow/runAdmission');
  for (let wait = 0; wait < 400 && getFlowRunAdmissionDiagnostics().activeRuns > 0; wait++) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

/** The model request records of a conversation, newest last, as the request inspector reads them. */
async function requestRecords(conversationId: string) {
  const { GET } = await import('@/app/v1/chat/conversations/[conversationId]/model-turns/route');
  const { readModelTurnSnapshot } = await import('@/backend/execution/flow/modelTurnArchive');
  const response = await GET(new NextRequest(`http://localhost/v1/chat/conversations/${conversationId}/model-turns`, { headers: { host: 'localhost' } }),
    { params: Promise.resolve({ conversationId }) });
  const { turns } = await response.json() as { turns: Array<{ id: string }> };
  return Promise.all(turns.map(async turn => {
    const snapshot = await inWorkspace(() => readModelTurnSnapshot(conversationId, turn.id));
    const request = (snapshot as unknown as { sdkRequest?: { sessionLifecycle?: Record<string, unknown>; prompt?: { message?: { content?: unknown } } } })?.sdkRequest;
    return { lifecycle: request?.sessionLifecycle ?? {}, sent: textOf(request?.prompt?.message?.content ?? '') };
  }));
}

beforeAll(async () => {
  previous = ENV.map(name => process.env[name]);
  // Claude Code settings of the machine running the test must not reach the bundled Claude Code.
  hostClaudeEnv = Object.entries(process.env).filter((entry): entry is [string, string] =>
    /^(CLAUDE|ANTHROPIC_)/.test(entry[0]) && typeof entry[1] === 'string');
  for (const [name] of hostClaudeEnv) delete process.env[name];
  root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'flujo-claude-flow-'));
  process.env.FLUJO_DATA_DIR = path.join(root, 'data');
  const secret = path.join(root, 'secret');
  await fs.writeFile(secret, randomBytes(32).toString('base64url'));
  process.env.FLUJO_ENCRYPTION_SECRET_FILE = secret;
  standIn = await startAnthropicStandIn({ reply: planReply, subscription: { fiveHour: 0.12, sevenDay: 0.31 } });
  queryMock.mockImplementation(relay.relayQuery);

  const { ensureWorkspaceDirs } = await import('@/utils/workspace');
  const { modelService } = await import('@/backend/services/model');
  const { saveCollectionItem } = await import('@/utils/storage/backend');
  await inWorkspace(async () => {
    await ensureWorkspaceDirs();
    for (const [id, token] of [['claude-sub', TOKEN], ['claude-refused', REFUSED]]) {
      const saved = await modelService.addModel({ id, name: 'sonnet', displayName: id, provider: 'claude-subscription', adapter: 'claude-cli', ApiKey: token });
      expect(saved.success).toBe(true);
    }
    for (const saved of [flow('PerTurnTickets', 'claude-sub', 'per-turn'), flow('StableTickets', 'claude-sub', 'stable'),
      flow('RefusedTickets', 'claude-refused', 'stable')]) {
      await saveCollectionItem('flows', saved.id, saved);
    }
  });
});

afterAll(async () => {
  await relay.settled();
  await settle();
  await stopBackgroundWorkers();
  const { closeAllClaudeSpares } = await import('@/backend/services/model/adapters/claudeWarmProcess');
  const { retireIdleModelCatalogReader, retireIdleWorkspaceWriterRegistration } = await import('@/backend/services/enduringAgents/runtimeLock');
  const { flushStatisticsEvents } = await import('@/backend/services/statistics');
  closeAllClaudeSpares();
  await flushStatisticsEvents();
  await inWorkspace(async () => {
    await retireIdleModelCatalogReader();
    await retireIdleWorkspaceWriterRegistration();
  });
  await standIn.close();
  ENV.forEach((name, index) => {
    if (previous[index] === undefined) delete process.env[name];
    else process.env[name] = previous[index];
  });
  for (const [name, value] of hostClaudeEnv) process.env[name] = value;
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

beforeEach(() => standIn.cache.entries.clear());

it('#1096: a step on "use current instructions each turn" follows each turn\'s kv language, remembers the ticket and records why it resumed', async () => {
  await setLanguage(ENGLISH);
  const first = await chat('PerTurnTickets', 'Remember ticket 4821.');
  expect(first.error).toBeUndefined();
  await setLanguage(SPANISH);
  const second = await chat('PerTurnTickets', 'Which ticket?', first.conversationId);
  expect(second.answer).toBe('Tu ticket es 4821.');
  await setLanguage(ENGLISH);
  const third = await chat('PerTurnTickets', 'Which ticket?', first.conversationId);
  expect(third.answer).toBe('Your ticket is 4821.');

  const records = await requestRecords(first.conversationId);
  expect(records).toHaveLength(3);
  for (const record of records.slice(1)) {
    expect(record.lifecycle).toMatchObject({ requestedPromptPolicy: 'per-turn', snapshot: false, resumeReason: 'compatible-history-and-transcript' });
    expect(record.sent).toBe('Which ticket?');
  }
  expect(records[2].lifecycle.resumedSession).toBe(records[1].lifecycle.resumedSession);
  // What reached Claude: each turn's own language only, and the conversation once.
  expect(systemTextOf((second.requests[0].body as Body).system)).toContain(SPANISH);
  expect(JSON.stringify(third.requests[0].body)).not.toContain(SPANISH);
  expect(JSON.stringify((third.requests[0].body as Body).messages).split('Remember ticket 4821.').length - 1).toBe(1);
});

it('#1096: a stable step keeps the instructions of a conversation and reads its cache; an edit applies to the next conversation', async () => {
  await setLanguage(ENGLISH);
  const first = await chat('StableTickets', 'Remember ticket 5150.');
  const second = await chat('StableTickets', 'Which ticket?', first.conversationId);
  expect(second.answer).toBe('Your ticket is 5150.');
  // The resumed turn reads everything the first one cached and pays full price only for what is new.
  expect(first.requests[0].usage!.cache_read_input_tokens).toBe(0);
  expect(second.requests[0].usage!.cache_read_input_tokens).toBeGreaterThanOrEqual(first.requests[0].usage!.cache_creation_input_tokens);

  // Without "use current instructions each turn", a running conversation keeps its instructions,
  // as the switch's help text says: neither a changed kv value nor an edited step changes them.
  await setLanguage(SPANISH);
  const { saveCollectionItem } = await import('@/utils/storage/backend');
  const edited = flow('StableTickets', 'claude-sub', 'stable');
  (edited.nodes[1].data.properties as Record<string, unknown>).promptTemplate = `Help with support tickets. ${SPANISH}`;
  await inWorkspace(() => saveCollectionItem('flows', edited.id, edited));
  const kept = await chat('StableTickets', 'Which ticket? Again.', first.conversationId);
  expect(kept.answer).toBe('Your ticket is 5150.');
  expect(systemTextOf((kept.requests[0].body as Body).system)).toContain(ENGLISH);
  expect(kept.requests[0].usage!.cache_read_input_tokens).toBeGreaterThan(second.requests[0].usage!.cache_read_input_tokens);
  const records = await requestRecords(first.conversationId);
  expect(records.map(record => record.lifecycle.resumeReason)).toEqual(['no-session', 'compatible-history-and-transcript', 'compatible-history-and-transcript']);
  expect(records.map(record => record.lifecycle.snapshot)).toEqual([true, true, true]);
  expect(new Set(records.map(record => record.lifecycle.requestedPromptHash)).size).toBe(1);

  // A new conversation starts with the edited instructions.
  const next = await chat('StableTickets', 'Remember ticket 6000. Which ticket?');
  expect(next.answer).toBe('Tu ticket es 6000.');
  expect(JSON.stringify(next.requests[0].body)).not.toContain(ENGLISH);
});

it('#1092: a refused token ends the chat turn with an error, and Claude Code\'s own message is never stored as an answer', async () => {
  await setLanguage(ENGLISH);
  const refused = await chat('RefusedTickets', 'Remember ticket 9.');
  expect(refused.requests.every(request => request.status === 401)).toBe(true);
  expect(refused.answer).not.toMatch(/OAuth token has expired|Invalid API key|Please run \/login/);
  expect(refused.status === 200 ? refused.answer : refused.error).toBeTruthy();
  if (refused.conversationId) {
    const { loadItem } = await import('@/utils/storage/backend');
    const stored = await inWorkspace(() => loadItem<{ messages?: Array<{ role: string; content?: unknown }> }>(
      `conversations/${refused.conversationId}` as never, undefined as never));
    const answers = (stored?.messages ?? []).filter(message => message.role === 'assistant').map(message => JSON.stringify(message.content));
    expect(answers.filter(text => /OAuth token has expired|Invalid API key/.test(text))).toEqual([]);
  }
});

it('#756: after a run, the allowance bar of the Claude model shows Claude\'s five-hour and weekly numbers', async () => {
  await setLanguage(ENGLISH);
  await chat('PerTurnTickets', 'Remember ticket 1.');
  const { GET } = await import('@/app/api/model/allowance/route');
  const response = await GET(new NextRequest('http://localhost/api/model/allowance', { headers: { host: 'localhost' } }));
  expect(response.status).toBe(200);
  const body = await response.json() as { models?: Array<{ modelId: string; status: string; billing: string; windows: Array<{ id: string; remainingPercent: number | null }> }> };
  const row = body.models?.find(model => model.modelId === 'claude-sub');
  expect(row).toMatchObject({ status: 'available', billing: 'subscription' });
  expect(row!.windows.map(window => [window.id, window.remainingPercent])).toEqual([['five_hour', 88], ['seven_day', 69]]);
});
