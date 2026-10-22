import { guardHarnessAdapter, getHarnessExecution, harnessResourceSnapshot, replayHarnessTool, withHarnessExecution, type HarnessExecutionScope } from '@/backend/services/harness/executionScope';
import type { CompletionAdapter, CompletionInput } from '@/backend/services/model/adapters/types';
import type { HarnessRuntimeSnapshot } from '@/shared/types/harnessIntegration';

const input = { model: { id: 'model', name: 'gpt-6-luna', provider: 'codex', ApiKey: '' }, apiKey: '', nodeId: 'agent',
  messages: [{ role: 'system', content: 'Actual FLUJO system prompt' }, { role: 'user', content: 'Task' }],
  tools: [{ type: 'function', function: { name: 'write_document', parameters: { type: 'object' } } }] } as CompletionInput;
const response = () => ({ completion: { model: 'gpt-6-luna', choices: [{ message: { content: 'done' }, finish_reason: 'stop' }], usage: { total_tokens: 7 } } });
function context(): HarnessExecutionScope {
  return { runtime: { maxModelCallsPerProbe: 2 } as HarnessRuntimeSnapshot, tools: [], calls: 0, replayed: 0,
    prompts: [], trace: [], signal: new AbortController().signal, authorize: jest.fn(async () => {}),
    beforeCall: jest.fn(async () => {}), afterCall: jest.fn(async () => {}) };
}

it('replays exact tool arguments at the adapter boundary without running a live executor', async () => {
  const scope = context(), live = jest.fn();
  scope.tools.push({ name: 'write_document', arguments: { text: 'x' }, output: 'recorded result' });
  const adapter = { createCompletion: jest.fn(async (actual: CompletionInput) => {
    expect(actual.messages).toEqual(input.messages);
    expect(await actual.localToolExecutors!.write_document({ text: 'x' })).toBe('recorded result');
    return response();
  }) } as unknown as CompletionAdapter;
  await withHarnessExecution(scope, () => guardHarnessAdapter(adapter).createCompletion({ ...input, localToolExecutors: { write_document: live } }));
  expect(live).not.toHaveBeenCalled();
  expect(scope.prompts[0].text).toBe('Actual FLUJO system prompt');
  expect(scope.trace).toEqual([{ name: 'write_document', arguments: { text: 'x' }, matched: true }]);
  expect(scope.afterCall).toHaveBeenCalledWith(7, 1);
  expect(getHarnessExecution()).toBeUndefined();
});

it('refuses unrecorded arguments and does not consume a different fixture', async () => {
  const scope = context();
  scope.tools.push({ name: 'write_document', arguments: { text: 'x' }, output: 'recorded result' });
  await withHarnessExecution(scope, async () => {
    expect(() => replayHarnessTool('write_document', { text: 'changed' })).toThrow('refused');
  });
  expect(scope.failureKind).toBe('tool-evidence');
  expect(scope.tools).toHaveLength(1);
});

it('never retries a provider after an uncertain failure even when the engine invokes the adapter again', async () => {
  const scope = context();
  const dispatch = jest.fn(async () => { throw new Error('transport closed'); });
  await withHarnessExecution(scope, async () => {
    const adapter = guardHarnessAdapter({ createCompletion: dispatch });
    await expect(adapter.createCompletion(input)).rejects.toThrow('transport closed');
    await expect(adapter.createCompletion(input)).rejects.toThrow('evaluation dispatch failed');
  });
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(scope.beforeCall).toHaveBeenCalledTimes(1);
});

it('consumes all aliases of one recorded tool call together', async () => {
  const scope = context();
  scope.tools = ['encoded_tool', 'server::tool'].map(name => ({ name, arguments: {}, output: 'one call', recordingId: 'same' }));
  await withHarnessExecution(scope, async () => {
    expect(replayHarnessTool('encoded_tool', {})).toBe('one call');
    expect(() => replayHarnessTool('server::tool', {})).toThrow('refused');
  });
});

it('counts native continuations and enforces the probe-wide call limit before dispatch', async () => {
  const scope = context();
  const adapter = { createCompletion: jest.fn(async (actual: CompletionInput) => {
    await actual.beforeModelDispatch!();
    return response();
  }) } as unknown as CompletionAdapter;
  await withHarnessExecution(scope, async () => {
    await guardHarnessAdapter(adapter).createCompletion(input);
    await expect(guardHarnessAdapter(adapter).createCompletion(input)).rejects.toThrow('limit');
  });
  expect(scope.beforeCall).toHaveBeenCalledTimes(2);
  expect(scope.afterCall).toHaveBeenCalledWith(7, 2);
  expect(adapter.createCompletion).toHaveBeenCalledTimes(1);
});

it('freezes resource responses across probes and does not share scope with ordinary execution', async () => {
  const snapshots = {}, read = jest.fn(async () => ({ value: 'first' }));
  const first = { ...context(), resourceSnapshots: snapshots };
  await withHarnessExecution(first, async () => {
    const result = await harnessResourceSnapshot('resource', read);
    result.value = 'mutated';
  });
  await withHarnessExecution({ ...context(), resourceSnapshots: snapshots }, async () => {
    expect(await harnessResourceSnapshot('resource', read)).toEqual({ value: 'first' });
  });
  expect(read).toHaveBeenCalledTimes(1);
  await harnessResourceSnapshot('resource', read);
  expect(read).toHaveBeenCalledTimes(2);
});
