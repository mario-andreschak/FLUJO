/**
 * Goals in chats with an agent (#1225), through the real chat path: the goal
 * route, the flow-run announcement, the goal runtime, runFlow, the flow engine
 * and the OpenAI-compatible adapter against a loopback stand-in model that
 * records what reaches it. Only the model's answers are scripted.
 */
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Flow, FlowNode } from '@/shared/types/flow';
import type { Model } from '@/shared/types/model';
import type { ChatGoal } from '@/shared/types/chatGoal';
import type { FlujoChatMessage } from '@/shared/types/chat';
import { makeLocalRequest } from '../utils/localRequest';

const mockFlows = new Map<string, Flow>();
let mockBaseUrl = '';
jest.mock('@/backend/services/flow', () => ({
  flowService: {
    getFlow: async (id: string) => mockFlows.get(id) ?? null,
    getFlowByName: async (name: string) => [...mockFlows.values()].find((flow) => flow.name === name) ?? null,
    loadFlows: async () => [...mockFlows.values()],
  },
}));
jest.mock('@/backend/services/model', () => ({
  modelService: {
    getModel: async (id: string): Promise<Model> => ({
      id, name: 'goal-fixture', provider: 'openai', adapter: 'openai', ApiKey: '', baseUrl: mockBaseUrl,
    }),
    loadModels: async () => [{ id: 'goal-model', name: 'goal-fixture' }],
    resolveAndDecryptApiKey: async () => 'loopback-fixture-key',
  },
}));
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: async () => undefined }));

import { runFlow } from '@/backend/execution/flow/runFlow';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { loadConversationState } from '@/backend/execution/flow/loadConversationState';
import { GET, PATCH, POST, DELETE } from '@/app/v1/chat/conversations/[conversationId]/goal/route';
import { POST as CANCEL } from '@/app/v1/chat/conversations/[conversationId]/cancel/route';
import { loadChatGoal, mutateChatGoal } from '@/backend/services/chatGoals/chatGoalStore';
import { checkChatGoal } from '@/backend/services/chatGoals/chatGoalRuntime';
import { saveCollectionItem, saveItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';

jest.setTimeout(90_000);

function node(id: string, type: string, properties: Record<string, unknown> = {}): FlowNode {
  return { id, type, position: { x: 0, y: 0 }, data: { label: id, type, properties } } as FlowNode;
}

/** Start -> Process, an agent with one model step and no tools. */
function agentFlow(id: string): Flow {
  const definition = {
    id,
    name: id,
    nodes: [
      node('start', 'start', { promptTemplate: 'You are a helpful agent.' }),
      node('process', 'process', { boundModel: 'goal-model', promptTemplate: 'Do what is asked.' }),
    ],
    edges: [{ id: 'start-process', source: 'start', target: 'process', data: { edgeType: 'standard' } }],
  } as unknown as Flow;
  mockFlows.set(id, definition);
  return definition;
}

type WireMessage = { role: string; content: unknown; [key: string]: unknown };
type WireBody = { stream?: boolean; stream_options?: { include_usage?: boolean }; messages?: WireMessage[] };

const text = (content: unknown) => (typeof content === 'string' ? content : JSON.stringify(content ?? ''));

/** The reply the stand-in model gives: to a goal turn (with its round) or to the person. */
type Planner = (lastUser: string, round: number | undefined) => string | { status: number; message: string };
let planner: Planner = () => 'ok';
/** While set, the model holds its answer until the promise settles. */
let hold: Promise<void> | undefined;
const requests: WireBody[] = [];

async function answer(response: ServerResponse, body: WireBody) {
  const lastUser = [...(body.messages ?? [])].reverse().find((message) => message.role === 'user');
  const userText = text(lastUser?.content);
  const round = /^Goal \(round (\d+)\):/.exec(userText)?.[1];
  if (hold) await hold;
  const planned = planner(userText, round ? Number(round) : undefined);
  if (typeof planned !== 'string') {
    response.writeHead(planned.status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: planned.message, type: 'invalid_request_error' } }));
    return;
  }
  const message = { role: 'assistant', content: planned, refusal: null };
  if (body.stream) {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'goal-fixture',
      choices: [{ index: 0, delta: message, finish_reason: 'stop' }] })}\n\n`);
    if (body.stream_options?.include_usage) {
      response.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'goal-fixture',
        choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`);
    }
    response.end('data: [DONE]\n\n');
    return;
  }
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ id: 'c', object: 'chat.completion', created: 1, model: 'goal-fixture',
    choices: [{ index: 0, message, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }));
}

let server: Server;

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as WireBody;
      requests.push(body);
      void answer(response, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  mockBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  await saveItem(StorageKey.MODELS, [{ id: 'goal-model', name: 'goal-fixture', provider: 'openai', adapter: 'openai', ApiKey: '', baseUrl: mockBaseUrl }]);
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  requests.length = 0;
  planner = () => 'ok';
  hold = undefined;
  FlowExecutor.clearFlowCache();
});

const params = (conversationId: string) => ({ params: Promise.resolve({ conversationId }) });
const setGoal = (conversationId: string, goalText: string) =>
  POST(makeLocalRequest({ body: { text: goalText } }) as never, params(conversationId));
const patchGoal = (conversationId: string, action: string) =>
  PATCH(makeLocalRequest({ body: { action } }) as never, params(conversationId));

/** A person's turn in the chat, the way the chat page sends it. */
const personTurn = (conversationId: string, prompt: string) => runFlow({
  conversationId, flowId: conversationId, messages: [{ role: 'user', content: prompt }],
  source: 'chat', mode: 'conversation', userTurn: true, resumeAsNewTurn: true,
});

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string, timeoutMs = 45_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T = await read();
  while (!done(last)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}; last value: ${JSON.stringify(last)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    last = await read();
  }
  return last;
}

const goalOf = (conversationId: string) => loadChatGoal(conversationId);
const settledIdle = async (conversationId: string) => {
  const state = await loadConversationState(conversationId);
  return state?.status !== 'running';
};
const goalTurns = (messages: FlujoChatMessage[]) => messages.filter((message) => message.goalTurn);

/** A chat with one finished exchange; only later requests are counted. */
async function startChat(conversationId: string) {
  agentFlow(conversationId);
  await personTurn(conversationId, 'Hello');
  await waitFor(() => settledIdle(conversationId), Boolean, 'the first turn to end');
  requests.length = 0;
}

describe('goals in a chat with an agent', () => {
  it('keeps the agent working, one turn after another, until it says the goal is met', async () => {
    const id = 'goal-reached';
    agentFlow(id);
    await startChat(id);
    planner = (_user, round) => (round === undefined ? 'ok'
      : round < 2 ? 'Made the first change.' : 'Checked every file.\nGOAL ACHIEVED');

    const response = await setGoal(id, 'Tidy up every file');
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ goal: { state: 'active', text: 'Tidy up every file' }, running: false });

    const goal = await waitFor(() => goalOf(id), (value) => value?.state === 'achieved', 'the goal to be reached');
    expect(goal).toMatchObject({ rounds: 2, quietRounds: 0, lastNote: 'Checked every file.' });

    // Only the person's turn and two goal turns reached the model.
    expect(requests).toHaveLength(2);
    const firstGoalTurn = text(requests[0].messages?.at(-1)?.content);
    expect(firstGoalTurn).toMatch(/^Goal \(round 1\): Tidy up every file/);
    expect(firstGoalTurn).toContain('GOAL ACHIEVED');
    expect(text(requests[1].messages?.at(-1)?.content)).toMatch(/^Goal \(round 2\):/);
    // The goal marker is display-only; it never reaches the model.
    expect(JSON.stringify(requests)).not.toContain('goalTurn');

    const state = await loadConversationState(id);
    expect(goalTurns(state!.messages).map((message) => message.goalTurn)).toEqual([
      { goalId: goal!.id, round: 1 },
      { goalId: goal!.id, round: 2 },
    ]);
    expect(state!.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Checked every file.\nGOAL ACHIEVED' });

    // A reached goal starts no more turns.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(requests).toHaveLength(2);
  });

  it('starts at once in a new chat with no messages', async () => {
    const id = 'goal-new-chat';
    agentFlow(id);
    await saveCollectionItem('conversations', id, {
      conversationId: id, title: 'New chat', flowId: id, messages: [], source: 'chat', createdAt: 1, updatedAt: 1,
      trackingInfo: { executionId: `exec-${id}`, startTime: 1, nodeExecutionTracker: [] },
    });
    planner = () => 'Done.\nGOAL ACHIEVED';
    expect((await setGoal(id, 'Say hello')).status).toBe(201);
    const goal = await waitFor(() => goalOf(id), (value) => value?.state === 'achieved', 'the goal to be reached');
    expect(goal?.rounds).toBe(1);
    const state = await loadConversationState(id);
    expect(state!.messages.filter((message) => message.role !== 'system').map((message) => message.role))
      .toEqual(['user', 'assistant']);
    expect(state!.messages.find((message) => message.role === 'user')?.goalTurn).toEqual({ goalId: goal!.id, round: 1 });
  });

  it('pauses after turns that do nothing, and goes on once the person writes', async () => {
    const id = 'goal-quiet';
    agentFlow(id);
    await startChat(id);
    planner = (_user, round) => (round === undefined ? 'Sure, I will try.' : 'Still thinking about it.');
    await setGoal(id, 'Write the report');

    const paused = await waitFor(() => goalOf(id), (value) => value?.state === 'paused', 'the goal to pause');
    expect(paused).toMatchObject({ rounds: 3, quietRounds: 3, pause: { reason: 'no_progress' } });
    // The later goal turns nudge the agent to act.
    expect(text(requests[1].messages?.at(-1)?.content)).toContain('Your last reply took no action.');
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(requests).toHaveLength(3);

    planner = (_user, round) => (round === undefined ? 'Sure, I will try.' : 'Report written and checked.\nGOAL ACHIEVED');
    await personTurn(id, 'Use the notes in the folder.');
    const reached = await waitFor(() => goalOf(id), (value) => value?.state === 'achieved', 'the goal to go on and be reached');
    expect(reached).toMatchObject({ rounds: 4, quietRounds: 0 });
  });

  it('waits for the person when the agent says it is blocked', async () => {
    const id = 'goal-blocked';
    agentFlow(id);
    await startChat(id);
    planner = (_user, round) => (round === undefined ? 'ok' : 'I cannot reach the server.\nGOAL BLOCKED: I need the server password');
    await setGoal(id, 'Deploy the site');
    const goal = await waitFor(() => goalOf(id), (value) => value?.state === 'paused', 'the goal to wait');
    expect(goal?.pause).toMatchObject({ reason: 'blocked', detail: 'I need the server password' });
    expect(goal?.rounds).toBe(1);
  });

  it('pauses with the error when a goal turn fails and cannot be retried', async () => {
    const id = 'goal-error';
    agentFlow(id);
    await startChat(id);
    planner = (_user, round) => (round === undefined ? 'ok' : { status: 400, message: 'The model rejected the request.' });
    await setGoal(id, 'Fix the build');
    const goal = await waitFor(() => goalOf(id), (value) => value?.state === 'paused', 'the goal to pause');
    expect(goal?.pause?.reason).toBe('error');
    expect(goal?.failedRounds).toBe(1);
  });

  it('retries a failed goal turn once its wait is over', async () => {
    const id = 'goal-retry';
    agentFlow(id);
    await startChat(id);
    // A transient failure was looked at already and FLUJO waits until retryAt.
    await mutateChatGoal(id, () => {
      const goal: ChatGoal = {
        id: 'goal_retry', conversationId: id, text: 'Count the files', state: 'active', createdAt: 1, updatedAt: 1,
        rounds: 1, quietRounds: 0, failedRounds: 1, retryAt: Date.now() + 60_000,
      };
      return { goal, result: undefined };
    });
    const state = await loadConversationState(id);
    await mutateChatGoal(id, (goal) => ({ goal: { ...goal!, reviewedMessageId: state!.messages.at(-1)!.id }, result: undefined }));
    expect(await checkChatGoal(id)).toBe('later');
    expect(requests).toHaveLength(0);

    planner = () => 'There are 3 files.\nGOAL ACHIEVED';
    await mutateChatGoal(id, (goal) => ({ goal: { ...goal!, retryAt: Date.now() - 1 }, result: undefined }));
    expect(await checkChatGoal(id)).toBe('started');
    const goal = await waitFor(() => goalOf(id), (value) => value?.state === 'achieved', 'the retried goal to be reached');
    expect(goal).toMatchObject({ rounds: 2, failedRounds: 0 });
  });

  it('holds the goal when the person presses Stop, and goes on after their next message', async () => {
    const id = 'goal-stop';
    agentFlow(id);
    await startChat(id);
    let release!: () => void;
    hold = new Promise<void>((resolve) => { release = resolve; });
    planner = (_user, round) => (round === undefined ? 'ok' : 'Working…');
    await setGoal(id, 'Rename the photos');
    await waitFor(async () => requests.length, (count) => count >= 1, 'the first goal turn to reach the model');

    const stopped = await CANCEL(makeLocalRequest() as never, params(id));
    expect(stopped.status).toBe(200);
    expect((await goalOf(id))?.pause?.reason).toBe('stopped');
    hold = undefined;
    release();
    await waitFor(() => settledIdle(id), Boolean, 'the stopped turn to end');
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(requests).toHaveLength(1);
    expect((await goalOf(id))?.state).toBe('paused');

    planner = (_user, round) => (round === undefined ? 'Got it.' : 'All photos renamed.\nGOAL ACHIEVED');
    await personTurn(id, 'Use the date as the name.');
    const goal = await waitFor(() => goalOf(id), (value) => value?.state === 'achieved', 'the goal to go on after the message');
    expect(goal?.rounds).toBe(2);
  });

  it('pauses on /goal pause until /goal resume, even when the person writes, and clears on /goal clear', async () => {
    const id = 'goal-controls';
    agentFlow(id);
    await startChat(id);
    let release!: () => void;
    hold = new Promise<void>((resolve) => { release = resolve; });
    planner = (_user, round) => (round === undefined ? 'ok' : 'Step done.');
    await setGoal(id, 'Sort the inbox');
    await waitFor(async () => requests.length, (count) => count >= 1, 'the first goal turn to reach the model');

    const pausedResponse = await patchGoal(id, 'pause');
    expect(pausedResponse.status).toBe(200);
    expect(await pausedResponse.json()).toMatchObject({ goal: { state: 'paused', pause: { reason: 'person' } } });
    hold = undefined;
    release();
    await waitFor(() => settledIdle(id), Boolean, 'the running goal turn to end');
    await personTurn(id, 'How is it going?');
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(requests).toHaveLength(2);
    expect((await goalOf(id))?.state).toBe('paused');

    planner = (_user, round) => (round === undefined ? 'ok' : 'Inbox sorted.\nGOAL ACHIEVED');
    const resumed = await patchGoal(id, 'resume');
    expect(await resumed.json()).toMatchObject({ goal: { state: 'active' } });
    await waitFor(() => goalOf(id), (value) => value?.state === 'achieved', 'the resumed goal to be reached');

    const shown = await GET(makeLocalRequest() as never, params(id));
    expect(await shown.json()).toMatchObject({ goal: { state: 'achieved', text: 'Sort the inbox' } });
    const cleared = await DELETE(makeLocalRequest() as never, params(id));
    expect(await cleared.json()).toMatchObject({ goal: { text: 'Sort the inbox' } });
    expect(await goalOf(id)).toBeNull();
    expect((await patchGoal(id, 'resume')).status).toBe(404);
  });

  it('refuses goals for Persona chats, unknown chats and empty or too long text', async () => {
    await saveCollectionItem('conversations', 'goal-persona', {
      conversationId: 'goal-persona', title: 'Persona chat', flowId: '', personaTargetId: 'persona_1', messages: [],
      createdAt: 1, updatedAt: 1, trackingInfo: { executionId: 'exec-goal-persona', startTime: 1, nodeExecutionTracker: [] },
    });
    const persona = await setGoal('goal-persona', 'Keep notes');
    expect(persona.status).toBe(409);
    expect(await persona.json()).toMatchObject({ reason: 'persona_owned' });
    expect((await setGoal('goal-missing', 'Anything')).status).toBe(404);

    agentFlow('goal-text');
    await personTurn('goal-text', 'Hello');
    expect((await setGoal('goal-text', '   ')).status).toBe(400);
    expect((await setGoal('goal-text', 'x'.repeat(4_001))).status).toBe(400);
    expect(await goalOf('goal-text')).toBeNull();
  });
});
