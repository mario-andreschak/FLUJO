import { createHash } from 'node:crypto';
const runMock = jest.fn(async (..._args: any[]): Promise<any> => undefined);
const persistMock = jest.fn(async (..._args: any[]): Promise<void> => undefined);
const readMock = jest.fn(async (..._args: any[]): Promise<any> => undefined);
const copyMock = jest.fn(async (..._args: any[]): Promise<any> => undefined);
const captureMock = jest.fn(async (..._args: any[]): Promise<any> => undefined);
const kvMock = jest.fn(async (..._args: any[]): Promise<any> => undefined);
jest.mock('@/backend/execution/flow/runFlow', () => ({ runFlow: (...args: any[]) => runMock(...args) }));
jest.mock('@/backend/execution/flow/FlowExecutor', () => ({ FlowExecutor: { conversationStates: new Map() } }));
// Live state is read through the dependency-free registry; share this suite's map.
jest.mock('@/backend/execution/flow/conversationStateRegistry', () => ({
  getConversationStates: () => jest.requireMock<{ FlowExecutor: { conversationStates: Map<string, unknown> } }>('@/backend/execution/flow/FlowExecutor').FlowExecutor.conversationStates,
}));
jest.mock('@/backend/execution/flow/subflowRecovery', () => ({
  persistSubflowParent: (...args: any[]) => persistMock(...args),
  readPersistedSubflowParent: (...args: any[]) => readMock(...args), syncLaneFromPersistedChild: jest.fn(async () => false),
}));
jest.mock('@/backend/services/flow/index', () => ({ flowService: { getFlow: jest.fn(async (id: string) => ({ id, name: id })) } }));
jest.mock('@/backend/services/runResources', () => ({
  copyRunResourceToConversation: (...args: any[]) => copyMock(...args),
  getRunResourceLocalPath: jest.fn(async (uri: string) => `/parent/${uri.split('/').at(-1)}.dat`),
  writeRunResource: (...args: any[]) => captureMock(...args),
}));
jest.mock('@/backend/execution/flow/resolveKvNodeRefs', () => ({
  resolveKvNodeRefs: jest.fn(async text => text), captureKvValue: (...args: any[]) => kvMock(...args),
}));
import { SubflowNode } from '@/backend/execution/flow/nodes/SubflowNode';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { getSubflowOutputDiagnostics, releaseSubflowOutput } from '@/backend/execution/flow/subflowOutputBudget';
import { reconcileSubflowFold } from '@/backend/execution/flow/subflowFoldFence';
import { FlowExecutionAuthorityError } from '@/backend/execution/flow/executionAuthority';
import type { SharedState, SubflowNodeParams, SubflowNodeExecResult } from '@/backend/execution/flow/types';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
function state(): SharedState {
  const shared = { conversationId: 'output-parent', logicalRunId: 'output-run', flowId: 'parent', status: 'running',
    title: 'Parent', createdAt: 1, updatedAt: 1, currentNodeId: 'sub',
    messages: [{ id: 'original', role: 'user', content: 'Original history', timestamp: 1 }],
    trackingInfo: { executionId: 'exec', startTime: 1, nodeExecutionTracker: [] },
  } as SharedState;
  FlowExecutor.conversationStates.set(shared.conversationId!, shared); return shared;
}
const params = (extra: Record<string, unknown> = {}): SubflowNodeParams => ({ id: 'sub', type: 'subflow', properties: {
  subflowId: 'child', inputMode: 'isolated', promptTemplate: 'work', spawnBriefs: ['first', 'second'], saveConversation: true,
  resultPresentation: 'separate', ...extra,
} } as SubflowNodeParams);
function node() { const instance = new SubflowNode(); instance.successors = new Map([['NEXT', {} as SubflowNode]]); return instance; }
let durable: SharedState | undefined;
beforeEach(() => {
  durable = undefined; FlowExecutor.conversationStates.clear();
  runMock.mockReset().mockImplementation(async ({ prompt, conversationId }) => ({ status: 'completed', outputText: `DONE:${prompt}`, conversationId, sharedState: {} }));
  persistMock.mockReset().mockImplementation(async shared => { durable = structuredClone(shared); });
  readMock.mockReset().mockImplementation(async () => durable && structuredClone(durable));
  copyMock.mockReset().mockImplementation(async ({ uri }) => ({ uri: `flujo://run/output-parent/${uri.split('/').at(-1)}`, id: uri.split('/').at(-1), conversationId: 'output-parent' }));
  captureMock.mockReset().mockResolvedValue({ skipped: 'size-cap' }); kvMock.mockReset().mockResolvedValue({});
});
afterEach(() => { expect(getSubflowOutputDiagnostics()).toMatchObject({ active: 0, reservedBytes: 0 }); jest.restoreAllMocks(); });

it('refuses separator multiplication before join/flatMap and retries completed lanes without redispatch', async () => {
  const shared = state(), instance = node(), config = params({ spawnBriefs: Array.from({ length: 100 }, (_, i) => `job-${i}`) });
  const prep = await instance.prep(shared, config);
  const before = digest(shared.messages);
  const identities = prep.lanes!.map(lane => [lane.laneId, lane.conversationId]);
  const separator = 's'.repeat(8 * 1024 * 1024);
  prep.joinSeparator = separator;
  const join = jest.spyOn(Array.prototype, 'join');
  const flat = jest.spyOn(Array.prototype, 'flatMap');
  await expect(instance.execCore(prep)).rejects.toMatchObject({ code: 'SUBFLOW_OUTPUT_TOO_LARGE', status: 413 });
  expect(join.mock.calls.some(args => args[0] === separator)).toBe(false);
  expect(flat).not.toHaveBeenCalled();
  expect(digest(shared.messages)).toBe(before); expect(captureMock).not.toHaveBeenCalled();
  const invocation = shared.subflowInvocations![prep.invocationId!];
  expect(invocation.lanes.every(lane => lane.status === 'completed' && lane.attempt === 1)).toBe(true);
  expect(invocation.lanes.map(lane => [lane.id, lane.conversationId])).toEqual(identities);
  expect(runMock).toHaveBeenCalledTimes(100);
  const retry = await instance.prep(shared, config), result = await instance.execCore(retry);
  await instance.post(retry, result, shared, config);
  expect(runMock).toHaveBeenCalledTimes(100);
  expect(shared.messages).toHaveLength(101);
  await instance.post(retry, { success: false, error: 'stale failure' }, shared, config);
  expect(shared.messages).toHaveLength(101); expect(shared.subflowInvocations![prep.invocationId!].status).toBe('folded');
});

it('keeps a large owned child output and identities intact when framing/capture admission refuses', async () => {
  const shared = state(), instance = node(), config = params({ spawnBriefs: ['one'], captureVariable: 'out', captureResource: 'out' });
  const original = 'owned'.repeat(2_000_000);
  runMock.mockResolvedValue({ status: 'completed', outputText: original, sharedState: {} });
  const prep = await instance.prep(shared, config), result = await instance.execCore(prep);
  const before = digest(shared.messages), invocation = shared.subflowInvocations![prep.invocationId!];
  await expect(instance.post(prep, result, shared, config)).rejects.toMatchObject({ code: 'SUBFLOW_OUTPUT_TOO_LARGE' });
  expect(invocation.lanes[0].outputText).toBe(original);
  expect(invocation.lanes[0]).toMatchObject({ status: 'completed', attempt: 1 });
  expect(digest(shared.messages)).toBe(before); expect(shared.variables).toBeUndefined();
  expect(shared.activeSubflowInvocationByNode!.sub).toBe(invocation.id); expect(invocation.foldedAt).toBeUndefined();
  expect(captureMock).not.toHaveBeenCalled(); expect(runMock).toHaveBeenCalledTimes(1);
});

it('admits serialized failure aliases before returning an all-failed result to tool consumers', async () => {
  const shared = state(), instance = node(), config = params({ spawnBriefs: ['one'] });
  const error = '\u0000'.repeat(4_000_000);
  runMock.mockResolvedValue({ status: 'error', outputText: '', error: { message: error }, sharedState: {} });
  const prep = await instance.prep(shared, config);
  await expect(instance.execCore(prep)).rejects.toMatchObject({ code: 'SUBFLOW_OUTPUT_TOO_LARGE' });
  const lane = shared.subflowInvocations![prep.invocationId!].lanes[0];
  expect(lane).toMatchObject({ status: 'error', attempt: 1, error });
  expect(shared.messages).toHaveLength(1); expect(captureMock).not.toHaveBeenCalled();
});

it.each(['before', 'after'] as const)('reconciles a %s-commit persistence failure without a duplicate fold', async phase => {
  const shared = state(), instance = node(), config = params({ captureVariable: 'out' });
  const prep = await instance.prep(shared, config), result = await instance.execCore(prep);
  const originalMessages = shared.messages;
  const failure = new Error(`${phase} snapshot failure`);
  persistMock.mockImplementationOnce(async staged => {
    expect(shared.messages).toBe(originalMessages); expect(shared.variables).toBeUndefined();
    expect(getSubflowOutputDiagnostics().reservedBytes).toBeGreaterThan(0);
    if (phase === 'after') durable = structuredClone(staged);
    throw failure;
  });
  if (phase === 'before') {
    await expect(instance.post(prep, result, shared, config)).rejects.toBe(failure);
    expect(shared.messages).toBe(originalMessages); expect(shared.subflowInvocations![prep.invocationId!].foldedAt).toBeUndefined();
    const retry = await instance.prep(shared, config), again = await instance.execCore(retry);
    await instance.post(retry, again, shared, config);
  } else await expect(instance.post(prep, result, shared, config)).resolves.toBe('NEXT');
  expect(runMock).toHaveBeenCalledTimes(2); expect(shared.messages).toHaveLength(3);
  expect(shared.subflowInvocations![prep.invocationId!].foldReceipt?.messageIds).toEqual(shared.messages.slice(1).map(message => message.id));
  expect(shared.variables?.out).toContain('DONE:first');
  // Crash after fold, before graph transition. Restored presentation and visit
  // receipt must skip child dispatch and all parent-side effects.
  const restored = structuredClone(durable!);
  FlowExecutor.conversationStates.set(restored.conversationId!, restored);
  const restoredPrep = await instance.prep(restored, config);
  expect(restoredPrep.invocationId).toBe(prep.invocationId); expect(restoredPrep.resultPresentation).toBe('separate');
  const restoredResult = await instance.execCore(restoredPrep);
  await instance.post(restoredPrep, restoredResult, restored, config);
  expect(restored.messages).toHaveLength(3); expect(runMock).toHaveBeenCalledTimes(2);
});

it('promotes each source once across joined/separate aliases with ordered references and four workers', async () => {
  const shared = state(), instance = node(), config = params({ captureVariable: 'out' });
  const refs = Array.from({ length: 7 }, (_, index) => ({ type: 'image' as const, resourceUri: `flujo://run/child/art-${index}` }));
  runMock.mockResolvedValue({ status: 'completed', outputText: '', outputMedia: refs, sharedState: {} });
  const prep = await instance.prep(shared, config), result = await instance.execCore(prep);
  let active = 0, peak = 0;
  copyMock.mockImplementation(async ({ uri }) => {
    active++; peak = Math.max(peak, active); await Promise.resolve(); active--;
    return { uri: uri.replace('/child/', '/output-parent/'), conversationId: 'output-parent', id: uri.split('/').at(-1) };
  });
  await instance.post(prep, result, shared, config);
  expect(copyMock).toHaveBeenCalledTimes(7); expect(peak).toBe(4);
  const uris = refs.map(part => part.resourceUri.replace('/child/', '/output-parent/'));
  expect(shared.messages[1].media?.map(part => part.resourceUri)).toEqual(uris);
  expect(shared.messages[2].media?.map(part => part.resourceUri)).toEqual(uris);
  expect(copyMock.mock.calls.every(([input]) => input.idempotencyKey.includes(prep.invocationId!))).toBe(true);
});

it('fences later checkpoint writes when a committed fold cannot yet be read back', async () => {
  const shared = state(), instance = node(), config = params();
  const prep = await instance.prep(shared, config), result = await instance.execCore(prep);
  persistMock.mockImplementationOnce(async staged => { durable = structuredClone(staged); throw new Error('ack failed'); });
  readMock.mockRejectedValueOnce(new Error('storage unavailable')).mockRejectedValueOnce(new Error('still unavailable'));
  await expect(instance.post(prep, result, shared, config)).rejects.toThrow('storage unavailable');
  expect(shared.messages).toHaveLength(1); expect(durable!.messages).toHaveLength(3);
  // persistConversationState calls this same fence before every write. Failed
  // readback remains fenced instead of overwriting a committed fold as error.
  await expect(reconcileSubflowFold(shared)).rejects.toThrow('still unavailable');
  await expect(reconcileSubflowFold(shared)).resolves.toBe(true);
  expect(shared.messages).toHaveLength(3); expect(shared.subflowInvocations![prep.invocationId!].status).toBe('folded');
  expect(runMock).toHaveBeenCalledTimes(2);
});

it('keeps output admission until delayed children settle after a sibling refusal', async () => {
  const shared = state(), instance = node(), config = params(), entered = deferred(), finish = deferred();
  runMock.mockImplementation(async ({ prompt }) => {
    if (prompt === 'first') return { status: 'completed', outputText: 'x'.repeat(33 * 1024 * 1024), sharedState: {} };
    entered.resolve(); await finish.promise; return { status: 'completed', outputText: 'second', sharedState: {} };
  });
  const prep = await instance.prep(shared, config);
  let settled = false;
  const running = instance.execCore(prep);
  void running.then(() => { settled = true; }, () => { settled = true; });
  await entered.promise; await Promise.resolve();
  expect(settled).toBe(false); expect(getSubflowOutputDiagnostics().active).toBe(1);
  finish.resolve(); await expect(running).rejects.toMatchObject({ code: 'SUBFLOW_OUTPUT_TOO_LARGE' });
  expect(runMock).toHaveBeenCalledTimes(2);
});

it('holds the permit and private fold until every started promotion drains after authority loss', async () => {
  const shared = state(), instance = node(), config = params(), entered = deferred(), finish = deferred();
  const refs = Array.from({ length: 5 }, (_, index) => ({ type: 'file' as const, resourceUri: `flujo://run/child/f-${index}` }));
  runMock.mockResolvedValue({ status: 'completed', outputText: 'done', outputMedia: refs, sharedState: {} });
  const prep = await instance.prep(shared, config), result = await instance.execCore(prep);
  const failure = new FlowExecutionAuthorityError('replaced lease');
  copyMock.mockImplementation(async ({ uri }) => {
    if (uri.endsWith('f-0')) { await Promise.resolve(); entered.resolve(); throw failure; }
    await finish.promise; return { uri: uri.replace('/child/', '/output-parent/'), id: uri.split('/').at(-1), conversationId: 'output-parent' };
  });
  let settled = false;
  const folding = instance.post(prep, result, shared, config);
  void folding.then(() => { settled = true; }, () => { settled = true; });
  await entered.promise; await Promise.resolve();
  expect(settled).toBe(false); expect(copyMock).toHaveBeenCalledTimes(4);
  expect(getSubflowOutputDiagnostics().active).toBe(1); expect(getSubflowOutputDiagnostics().reservedBytes).toBeGreaterThan(0);
  expect(shared.messages).toHaveLength(1); expect(shared.subflowInvocations![prep.invocationId!].foldedAt).toBeUndefined();
  finish.resolve(); await expect(folding).rejects.toBe(failure);
  expect(shared.messages).toHaveLength(1);
});

it('retains unresolved KV intent and refuses replay after an ambiguous effect outcome', async () => {
  const shared = state(), instance = node(), config = params({ captureKv: 'out' });
  const prep = await instance.prep(shared, config), result = await instance.execCore(prep);
  kvMock.mockRejectedValueOnce(new Error('KV committed but acknowledgement failed'));
  await expect(instance.post(prep, result, shared, config)).rejects.toThrow('acknowledgement failed');
  expect(shared.messages).toHaveLength(1); expect(shared.variables).toBeUndefined();
  expect(shared.subflowInvocations![prep.invocationId!].captureKvReceipt?.status).toBe('pending');
  const retry = await instance.prep(shared, config), again = await instance.execCore(retry);
  await expect(instance.post(retry, again, shared, config)).rejects.toThrow('unresolved durable receipt');
  expect(kvMock).toHaveBeenCalledTimes(1); expect(runMock).toHaveBeenCalledTimes(2);
});

it('refuses accessor output before promotion or captures', async () => {
  const getter = jest.fn(() => 'unexpected');
  const result = Object.defineProperty({ success: true }, 'outputText', { get: getter }) as SubflowNodeExecResult;
  await expect(node().post({ nodeId: 'sub', depth: 1, showSteps: false } as any, result, state(), params())).rejects.toThrow(/accessors/);
  expect(getter).not.toHaveBeenCalled(); expect(copyMock).not.toHaveBeenCalled(); expect(captureMock).not.toHaveBeenCalled();
  releaseSubflowOutput(result);
});
