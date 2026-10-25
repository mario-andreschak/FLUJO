const persistMock = jest.fn(async (..._args: unknown[]) => undefined);
const resourceMock = jest.fn(async (text: string, ..._args: unknown[]) => text);
jest.mock('@/backend/execution/flow/subflowRecovery', () => ({
  persistSubflowParent: (...args: unknown[]) => persistMock(...args), syncLaneFromPersistedChild: jest.fn(async () => false),
}));
jest.mock('@/backend/execution/flow/resolveRunResourceRefs', () => ({
  resolveRunResourceRefs: (text: string, ...args: unknown[]) => resourceMock(text, ...args),
}));
jest.mock('@/backend/services/flow/index', () => ({ flowService: { getFlow: jest.fn(async (id: string) => ({ id, name: id })) } }));
jest.mock('@/backend/execution/flow/FlowExecutor', () => ({ FlowExecutor: { conversationStates: new Map() } }));
jest.mock('@/backend/execution/flow/sessionTranscriptPolicy', () => ({
  prepareResumedSessionTranscript: jest.fn(async () => ({ kind: 'valid', summarized: false, trimmedTurns: 0 })),
}));

import { SubflowNode, runSubflowLanes, buildSessionFollowupInput } from '@/backend/execution/flow/nodes/SubflowNode';
import { getSubflowPreparationDiagnostics, SUBFLOW_PREPARATION_LIMITS as LIMITS, withSubflowPreparationBudget } from '@/backend/execution/flow/subflowPreparationBudget';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import type { SharedState, SubflowNodeParams, SubflowNodePrepResult, SubflowInvocation } from '@/backend/execution/flow/types';
import { resolveSessionIdentity } from '@/backend/execution/flow/sessionManagement';

const MiB = 1024 ** 2;
const params = (properties: Record<string, unknown> = {}): SubflowNodeParams => ({
  id: 'sub-node', type: 'subflow', properties: { subflowId: 'child', inputMode: 'isolated', promptTemplate: 'DEFAULT', ...properties },
} as SubflowNodeParams);
const state = (): SharedState => ({ conversationId: 'prep-parent', logicalRunId: 'prep-run', flowId: 'parent', status: 'running',
  title: 'Preparation parent', createdAt: 1, updatedAt: 1,
  messages: [{ id: 'user', role: 'user', content: 'History', timestamp: 1 }],
  trackingInfo: { executionId: 'prep-execution', startTime: 1, nodeExecutionTracker: [] },
} as SharedState);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => { persistMock.mockClear(); resourceMock.mockReset().mockImplementation(async text => text); FlowExecutor.conversationStates.clear(); });
afterEach(() => {
  expect(getSubflowPreparationDiagnostics()).toMatchObject({ active: 0, reservedBytes: 0 });
  jest.restoreAllMocks();
});

it.each(['lines', 'json-array'] as const)('refuses excessive %s items before parsing, cloning, persistence or handoff consumption', async itemSplit => {
  const source = itemSplit === 'lines' ? 'job\n'.repeat(LIMITS.lanes + 1)
    : `[${'0,'.repeat(LIMITS.lanes)}0]`;
  const shared = state();
  const handoff = { targetNodeId: 'sub-node', prompt: source };
  shared.handoffInput = handoff;
  const parse = jest.spyOn(JSON, 'parse');
  const clone = jest.spyOn(global, 'structuredClone');
  await expect(new SubflowNode().prep(shared, params({ mapOverList: true, itemSplit })))
    .rejects.toMatchObject({ code: 'SUBFLOW_PREPARATION_TOO_LARGE', status: 413 });
  expect(parse.mock.calls.some(([text]) => text === source)).toBe(false);
  expect(clone).not.toHaveBeenCalled();
  expect(shared.handoffInput).toBe(handoff);
  expect(shared.subflowInvocations).toBeUndefined();
  expect(persistMock).not.toHaveBeenCalled();
});

it('refuses durable history multiplication before cloning or clearing pending tasks', async () => {
  const shared = state();
  shared.messages[0].content = 'H'.repeat(MiB);
  const handoff = { targetNodeId: 'sub-node', prompt: '', tasks: Array.from({ length: 1000 }, () => 'small task') };
  shared.handoffInput = handoff;
  const clone = jest.spyOn(global, 'structuredClone');
  await expect(new SubflowNode().prep(shared, params({ inputMode: 'full-history' })))
    .rejects.toMatchObject({ code: 'SUBFLOW_PREPARATION_TOO_LARGE' });
  expect(clone).not.toHaveBeenCalled();
  expect(shared.handoffInput).toBe(handoff);
  expect(shared.messages[0].content).toHaveLength(MiB);
  expect(shared.subflowInvocations).toBeUndefined();
  expect(persistMock).not.toHaveBeenCalled();
});

it('accepts and durably publishes all forty tasks without the legacy selector cap', async () => {
  const shared = state();
  shared.handoffInput = { targetNodeId: 'sub-node', prompt: '', tasks: Array.from({ length: 40 }, (_, index) => `job-${index}`) };
  const result = await new SubflowNode().prep(shared, params());
  expect(result.lanes).toHaveLength(40);
  expect(shared.subflowInvocations?.[result.invocationId!].lanes).toHaveLength(40);
  expect(shared.handoffInput).toBeUndefined();
  expect(persistMock).toHaveBeenCalledTimes(1);
});

it('admits the original520 two-million-character parent with eight full-history tasks', async () => {
  const shared = state();
  shared.messages[0].content = 'H'.repeat(2_000_000);
  const tasks = Array.from({ length: 8 }, (_, index) => `task-${index}`);
  shared.handoffInput = { targetNodeId: 'sub-node', prompt: '', tasks };
  const plan = await new SubflowNode().prep(shared, params({ inputMode: 'full-history' }));
  expect(plan.lanes).toHaveLength(8);
  const invocation = shared.subflowInvocations![plan.invocationId!];
  expect(invocation.lanes.map(lane => lane.input && 'messages' in lane.input ? lane.input.messages.at(-1)?.content : undefined)).toEqual(tasks);
  for (const lane of invocation.lanes) {
    expect(lane.input && 'messages' in lane.input ? lane.input.messages[0].content : undefined).toHaveLength(2_000_000);
  }
  expect(persistMock).toHaveBeenCalledTimes(1);
});

it('retries a rejected durable publication using the original invocation and lane identities', async () => {
  const shared = state();
  const tasks = ['original first', 'original second'];
  shared.handoffInput = { targetNodeId: 'sub-node', prompt: '', tasks };
  const failure = new Error('snapshot save failed');
  persistMock.mockRejectedValueOnce(failure);
  await expect(new SubflowNode().prep(shared, params())).rejects.toBe(failure);
  const invocationId = shared.activeSubflowInvocationByNode!['sub-node'];
  const invocation = shared.subflowInvocations![invocationId];
  const identities = invocation.lanes.map(lane => ({ id: lane.id, conversationId: lane.conversationId }));
  expect(invocation.lanes.map(lane => lane.input && 'prompt' in lane.input ? lane.input.prompt : undefined)).toEqual(tasks);
  const retry = await new SubflowNode().prep(shared, params({ spawnBriefs: ['replacement must not win'] }));
  expect(retry.invocationId).toBe(invocationId);
  expect(retry.lanes!.map(lane => ({ id: lane.laneId, conversationId: lane.conversationId }))).toEqual(identities);
  expect(shared.subflowInvocations![invocationId]).toBe(invocation);
  expect(Object.keys(shared.subflowInvocations!)).toEqual([invocationId]);
  expect(persistMock).toHaveBeenCalledTimes(1);
});

it('holds preparation admission through durable publication', async () => {
  const entered = deferred(), finish = deferred();
  persistMock.mockImplementationOnce(async () => { entered.resolve(); await finish.promise; });
  const shared = state();
  let settled = false;
  const preparation = new SubflowNode().prep(shared, params());
  void preparation.then(() => { settled = true; }, () => { settled = true; });
  try {
    await entered.promise;
    expect(settled).toBe(false);
    expect(getSubflowPreparationDiagnostics().active).toBe(1);
    expect(getSubflowPreparationDiagnostics().reservedBytes).toBeGreaterThan(0);
  } finally { finish.resolve(); await preparation; }
});

it('refuses an oversized restored invocation without replacing any durable identity', async () => {
  const shared = state();
  const invocation = { id: 'existing-invocation', status: 'running', parentNodeId: 'sub-node', concurrencyLimit: 4,
    sharedInput: { prompt: 'original' }, lanes: Array.from({ length: LIMITS.lanes + 1 }, (_, index) => ({
      id: `lane-${index}`, conversationId: `child-${index}`, subflowId: 'child', status: 'pending',
    })) } as SubflowInvocation;
  shared.subflowInvocations = { [invocation.id]: invocation };
  shared.activeSubflowInvocationByNode = { 'sub-node': invocation.id };
  const clone = jest.spyOn(global, 'structuredClone');
  await expect(new SubflowNode().prep(shared, params())).rejects.toMatchObject({ code: 'SUBFLOW_PREPARATION_TOO_LARGE' });
  expect(shared.subflowInvocations[invocation.id]).toBe(invocation);
  expect(shared.activeSubflowInvocationByNode['sub-node']).toBe(invocation.id);
  expect(invocation.lanes.at(-1)?.id).toBe(`lane-${LIMITS.lanes}`);
  expect(clone).not.toHaveBeenCalled();
  expect(persistMock).not.toHaveBeenCalled();
});

it('restores and schedules the exact original520 retained-history envelope without cloning lane inputs', async () => {
  const sizes = [3_600_000, 4_000_000, 4_400_000, 4_800_000, 5_200_000, 5_600_000, 3_800_000, 4_200_000];
  const shared = state();
  shared.messages[0].content = 'P'.repeat(2_000_000);
  const invocation = { version: 1, id: 'original520', status: 'running', parentConversationId: shared.conversationId,
    parentRunId: shared.conversationId, parentNodeId: 'sub-node', concurrencyLimit: 4, depth: 1,
    sharedInput: { messages: shared.messages },
    lanes: sizes.map((size, index) => ({ id: `original-lane-${index}`, conversationId: `original-child-${index}`,
      subflowId: `flow-${index}`, status: index < 3 ? 'completed' : index === 3 ? 'error' : 'pending', attempt: index < 4 ? 1 : 0,
      ...(index < 3 ? { outputText: `old-result-${index}` } : {}),
      input: { messages: [{ id: `history-${index}`, role: 'user', content: 'H'.repeat(size), timestamp: 1 }] },
    })),
  } as SubflowInvocation;
  shared.subflowInvocations = { [invocation.id]: invocation };
  shared.activeSubflowInvocationByNode = { 'sub-node': invocation.id };
  FlowExecutor.conversationStates.set(shared.conversationId!, shared);
  const clone = jest.spyOn(global, 'structuredClone');
  const restored = await new SubflowNode().prep(shared, params());
  expect(clone).toHaveBeenCalledTimes(1);
  expect(clone).toHaveBeenCalledWith(shared.messages);
  expect(restored.messages![0].content).toHaveLength(2_000_000);
  restored.lanes!.forEach((lane, index) => expect(lane.input).toBe(invocation.lanes[index].input));
  const child = jest.fn(async ({ flowId, messages, conversationId }: any) => {
    const index = Number(flowId.split('-')[1]);
    expect(messages).toBe((invocation.lanes[index].input as { messages: unknown[] }).messages);
    return { status: 'completed', conversationId, outputText: `result-${index}`, sharedState: {} };
  });
  const result = await runSubflowLanes(restored, child as any, { nodeId: 'sub-node', nodeType: 'subflow' }, { messages: shared.messages });
  expect(result.success).toBe(true);
  expect(result.lanes).toHaveLength(8);
  expect(child.mock.calls.map(([input]) => input.flowId).sort()).toEqual(['flow-3', 'flow-4', 'flow-5', 'flow-6', 'flow-7']);
  expect(invocation.lanes.map(lane => lane.conversationId)).toEqual(sizes.map((_, index) => `original-child-${index}`));
  expect(clone).toHaveBeenCalledTimes(1);
});

it('does not impose preparation source limits on existing child output fallback', async () => {
  const output = 'O'.repeat(4_500_000);
  const child = jest.fn(async () => ({ status: 'completed', outputText: '', sharedState: {},
    messages: [{ role: 'assistant', content: output }] }));
  const result = await runSubflowLanes({ nodeId: 'sub-node', lanes: [{ subflowId: 'child' }] } as SubflowNodePrepResult,
    child as any, { nodeId: 'sub-node', nodeType: 'subflow' }, { prompt: 'small input' });
  expect(result.success).toBe(true);
  expect(result.outputText).toBe(output);
});

it('charges follow-up multimodal joins and media clones while retaining large plain strings by reference', async () => {
  const plain = 'T'.repeat(5_600_000);
  await withSubflowPreparationBudget(async budget => {
    const scratch = budget.scratch();
    try {
      const result = buildSessionFollowupInput({ messages: [{ id: 'plain', timestamp: 1, role: 'user', content: plain }] }, scratch);
      expect('messages' in result ? result.messages[0].content : undefined).toBe(plain);
      expect(getSubflowPreparationDiagnostics().reservedBytes).toBeLessThan(MiB + 64 * 1024);
      buildSessionFollowupInput({ messages: [{ id: 'media', timestamp: 1, role: 'user', content: [{ type: 'text', text: plain }],
        media: [{ type: 'image', data: 'M'.repeat(MiB) }] }] }, scratch);
      expect(getSubflowPreparationDiagnostics().reservedBytes).toBeGreaterThan(plain.length * 4 + MiB * 4);
    } finally { scratch.release(); }
  });
});

it.each(['pending', 'completed'] as const)('refuses an unadmitted resumed media clone before lane mutation, while skipping %s-owned completed work', async status => {
  const shared = state();
  const identity = resolveSessionIdentity(shared.logicalRunId, 'sub-node', 'per-run', undefined)!;
  shared.subflowSessions = { [identity]: { version: 1, conversationId: 'existing-session', nodeId: 'sub-node', visits: 2,
    lastUsedAt: 1, status: 'idle' } };
  const media = [{ type: 'image' as const, data: 'M'.repeat(35_000_000) }];
  const lane = { id: 'stable-lane', conversationId: 'stable-child', subflowId: 'child', status, attempt: 0,
    input: { messages: [{ id: 'follow-up', timestamp: 1, role: 'user' as const, content: 'follow up', media }] }, outputText: status === 'completed' ? 'already done' : undefined };
  const invocation = { id: 'stable-invocation', status: 'running', parentNodeId: 'sub-node', concurrencyLimit: 1,
    lanes: [lane] } as SubflowInvocation;
  shared.subflowInvocations = { [invocation.id]: invocation };
  FlowExecutor.conversationStates.set(shared.conversationId!, shared);
  const child = jest.fn();
  const clone = jest.spyOn(global, 'structuredClone');
  const plan = { nodeId: 'sub-node', nodeType: 'subflow', depth: 1, showSteps: false,
    parentRunId: shared.conversationId, invocationId: invocation.id,
    persistConversation: true, sessionScope: 'per-run', lanes: [{ ...lane, laneId: lane.id }] } as SubflowNodePrepResult;
  const execution = runSubflowLanes(plan, child, { nodeId: 'sub-node', nodeType: 'subflow' }, { prompt: 'shared' });
  if (status === 'pending') {
    await expect(execution).rejects.toMatchObject({ code: 'SUBFLOW_PREPARATION_TOO_LARGE' });
    expect(shared.subflowSessions[identity]).toMatchObject({ conversationId: 'existing-session', status: 'idle', visits: 2 });
    expect(persistMock).not.toHaveBeenCalled();
  } else expect((await execution).outputText).toBe('already done');
  expect(lane).toMatchObject({ id: 'stable-lane', conversationId: 'stable-child', attempt: 0, status });
  expect(child).not.toHaveBeenCalled();
  expect(clone.mock.calls.some(([value]) => value === media)).toBe(false);
});

it('refuses synthetic inline lane plans before starting any child', async () => {
  const child = jest.fn();
  const plan = { nodeId: 'sub-node', lanes: Array.from({ length: LIMITS.lanes + 1 }, () => ({ subflowId: 'child' })) } as SubflowNodePrepResult;
  await expect(runSubflowLanes(plan, child, { nodeId: 'sub-node', nodeType: 'subflow' }, { prompt: 'input' }))
    .rejects.toMatchObject({ code: 'SUBFLOW_PREPARATION_TOO_LARGE' });
  expect(child).not.toHaveBeenCalled();
});

it('rejects excessive requested concurrency without discarding its handoff', async () => {
  const shared = state();
  const handoff = { targetNodeId: 'sub-node', prompt: '', tasks: ['one', 'two'], concurrencyLimit: 17 };
  shared.handoffInput = handoff;
  await expect(new SubflowNode().prep(shared, params())).rejects.toMatchObject({ code: 'SUBFLOW_PREPARATION_TOO_LARGE' });
  expect(shared.handoffInput).toBe(handoff);
  expect(persistMock).not.toHaveBeenCalled();
});

it('rejects repeated variable expansion before plan publication and preserves original tasks', async () => {
  const shared = state();
  shared.variables = { large: 'X'.repeat(MiB) };
  const handoff = { targetNodeId: 'sub-node', prompt: '', tasks: ['${var:large}'.repeat(5)] };
  shared.handoffInput = handoff;
  const clone = jest.spyOn(global, 'structuredClone');
  await expect(new SubflowNode().prep(shared, params())).rejects.toMatchObject({ code: 'SUBFLOW_PREPARATION_TOO_LARGE' });
  expect(shared.handoffInput).toBe(handoff);
  expect(clone).not.toHaveBeenCalled();
  expect(persistMock).not.toHaveBeenCalled();
});

it('charges variables against process capacity before dictionary copies or resolver work', async () => {
  const shared = state();
  shared.variables = { large: 'V'.repeat(3 * MiB) };
  const handoff = { targetNodeId: 'sub-node', prompt: '${res:item}', tasks: ['${var:large}'] };
  shared.handoffInput = handoff;
  await withSubflowPreparationBudget(async first => {
    first.reserve(120 * MiB);
    await withSubflowPreparationBudget(async second => {
      second.reserve(120 * MiB);
      const entries = jest.spyOn(Object, 'entries');
      const clone = jest.spyOn(global, 'structuredClone');
      await expect(new SubflowNode().prep(shared, params())).rejects.toMatchObject({ code: 'SUBFLOW_PREPARATION_MEMORY' });
      expect(entries.mock.calls.some(([value]) => Object.getOwnPropertyDescriptor(value, 'large')?.value === shared.variables!.large)).toBe(false);
      expect(clone).not.toHaveBeenCalled();
      expect(resourceMock).not.toHaveBeenCalled();
      expect(shared.handoffInput).toBe(handoff);
      expect(persistMock).not.toHaveBeenCalled();
    });
  });
});

it('bounds resolver fanout and drains live reads before releasing a failed preparation', async () => {
  const shared = state();
  const handoff = { targetNodeId: 'sub-node', prompt: '', tasks: Array.from({ length: 40 }, (_, index) => '${res:item-' + index + '}') };
  shared.handoffInput = handoff;
  const entered = deferred(), finish = deferred();
  let active = 0, started = 0, settled = false;
  const failure = new Error('resource read failed');
  resourceMock.mockImplementation(async text => {
    active++; started++;
    if (started === 4) entered.resolve();
    try {
      if (text === '${res:item-0}') { await entered.promise; throw failure; }
      await finish.promise;
      return text;
    } finally { active--; }
  });
  const preparation = new SubflowNode().prep(shared, params());
  void preparation.then(() => { settled = true; }, () => { settled = true; });
  const refused = expect(preparation).rejects.toBe(failure);
  try {
    await entered.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(started).toBe(4);
    expect(active).toBe(3);
    expect(settled).toBe(false);
    expect(getSubflowPreparationDiagnostics().active).toBe(1);
    expect(shared.handoffInput).toBe(handoff);
    expect(shared.subflowInvocations).toBeUndefined();
  } finally { finish.resolve(); await refused; }
});

it('holds lane admission through sibling execution after a durable publication failure', async () => {
  const shared = state();
  FlowExecutor.conversationStates.set(shared.conversationId!, shared);
  const plan = await new SubflowNode().prep(shared, params({ spawnBriefs: ['first', 'second'], concurrencyLimit: 2 }));
  const entered = deferred(), finish = deferred();
  const failure = new Error('durable lane save failed');
  let calls = 0, settled = false;
  const child = jest.fn(async ({ prompt, conversationId }: { prompt?: string; conversationId?: string }) => {
    if (++calls === 2) entered.resolve();
    await entered.promise;
    if (prompt === 'second') await finish.promise;
    return { status: 'completed', conversationId, outputText: `result:${prompt}`, sharedState: {} };
  });
  persistMock.mockImplementation(async () => {
    const first = shared.subflowInvocations![plan.invocationId!].lanes[0];
    if (first.status === 'completed' || first.status === 'error') throw failure;
  });
  const execution = runSubflowLanes(plan, child as any, { nodeId: 'sub-node', nodeType: 'subflow' }, { prompt: 'shared' });
  void execution.then(() => { settled = true; }, () => { settled = true; });
  const rejected = expect(execution).rejects.toBe(failure);
  try {
    await entered.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(getSubflowPreparationDiagnostics().active).toBe(1);
    expect(getSubflowPreparationDiagnostics().reservedBytes).toBeGreaterThan(0);
    expect(child).toHaveBeenCalledTimes(2);
  } finally { finish.resolve(); await rejected; persistMock.mockImplementation(async () => undefined); }
});
