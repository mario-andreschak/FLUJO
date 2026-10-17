jest.mock('@/backend/execution/flow/handlers/nativeOriginalHost', () => {
  const actual = jest.requireActual('@/backend/execution/flow/handlers/nativeOriginalHost');
  const personaHost = Object.freeze({ process: {}, broker: {}, session: {} });
  const createPersonaNativeOriginalHost = jest.fn(async (_input: unknown) => personaHost);
  const createProcessNativeOriginalHost = jest.fn(async (input: { context?: object }) =>
    input.context ? undefined : createPersonaNativeOriginalHost(input));
  return { ...actual, createPersonaNativeOriginalHost, createProcessNativeOriginalHost,
    __testPersonaNativeHost: personaHost };
});

import { ProcessNode } from '@/backend/execution/flow/nodes';
import { ModelHandler } from '@/backend/execution/flow/handlers/ModelHandler';
import { createProcessNativeOriginalHost, createPersonaNativeOriginalHost } from '@/backend/execution/flow/handlers/nativeOriginalHost';
import { registerExecutionExtension } from '@/backend/execution/extensions';
import { fixtureAdapter, fixtureRun, mintFixture } from './fixtureAdapter';
import type { SharedState } from '@/backend/execution/flow/types';
import type { ProcessNodeParams } from '@/backend/execution/flow/types';
import { modelService } from '@/backend/services/model';
import { saveItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';

jest.mock('@/utils/logger', () => ({ createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), verbose: jest.fn() }) }));

describe('ProcessNode selects the native Original host from its execution context', () => {
  let restore: (() => void) | undefined;

  beforeEach(async () => {
    await saveItem(StorageKey.MODELS, [{ id: 'model-1', name: 'fixture', provider: 'openai', adapter: 'openai', ApiKey: '' }]);
    jest.mocked(createProcessNativeOriginalHost).mockClear();
    jest.mocked(createPersonaNativeOriginalHost).mockClear();
    jest.spyOn(modelService, 'getModel').mockResolvedValue({ id: 'model-1', name: 'fixture', provider: 'openai', adapter: 'openai', ApiKey: '' } as never);
  });

  afterEach(() => { restore?.(); restore = undefined; jest.restoreAllMocks(); });

  function setup() {
    const adapter = fixtureAdapter({ nativeWorkerRoot: async () => undefined });
    restore = registerExecutionExtension(adapter);
    const run = fixtureRun();
    const context = mintFixture(adapter, run);
    const graph = { id: 'native-host-selection', name: 'Host selection',
      nodes: [{ id: 'process', type: 'process', position: { x: 0, y: 0 },
        data: { type: 'process', label: 'Process', properties: { boundModel: 'model-1' } } }], edges: [] };
    const state = { trackingInfo: { executionId: run.runId, startTime: 1, nodeExecutionTracker: [] },
      messages: [{ role: 'user', content: 'run' }], flowId: graph.id, flowSnapshot: graph,
      conversationId: run.conversation, executionExtensionContext: context,
      title: 'Host selection', createdAt: 1, updatedAt: 1 } as unknown as SharedState;
    const params = (): ProcessNodeParams => ({ id: 'process', label: 'Process', type: 'process',
      properties: { boundModel: 'model-1' } } as ProcessNodeParams);
    return { state, params, context };
  }

  function successfulModelResult() {
    return { success: true, value: { content: 'ok', messages: [{ role: 'assistant', content: 'ok' }],
      toolCalls: [], fullResponse: {} } } as never;
  }

  test('Native-context dispatch uses the shared selector and does not pass a Persona host', async () => {
    const { state, params, context } = setup();
    const authority = { signal: new AbortController().signal, assertCurrent: async () => undefined };
    const attribution = { personaId: 'persona-1', activityId: 'activity-1', behaviorRevisionId: 'revision-1' };
    Object.assign(state, { executionAuthority: authority, personaAttribution: attribution });
    const callModel = jest.spyOn(ModelHandler, 'callModel').mockResolvedValue(successfulModelResult());
    const node = new ProcessNode();
    const prepared = await node.prep(state, params());

    const result = await node.execCore(prepared, params());

    expect(result.success).toBe(true);
    expect(createProcessNativeOriginalHost).toHaveBeenCalledWith(expect.objectContaining({ context,
      authority, personaAttribution: attribution }));
    expect(createPersonaNativeOriginalHost).not.toHaveBeenCalled();
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(callModel.mock.calls[0][0]).toMatchObject({ executionExtensionContext: context,
      executionAuthority: authority, personaAttribution: attribution, nativeOriginalHost: undefined });
  });

  test('contextless Persona dispatch keeps the Persona mint path through the selector', async () => {
    const { state, params } = setup();
    delete state.executionExtensionContext;
    const authority = { signal: new AbortController().signal, assertCurrent: async () => undefined };
    const attribution = { personaId: 'persona-1', activityId: 'activity-1', behaviorRevisionId: 'revision-1' };
    Object.assign(state, { executionAuthority: authority, personaAttribution: attribution });
    const callModel = jest.spyOn(ModelHandler, 'callModel').mockResolvedValue(successfulModelResult());
    const node = new ProcessNode();
    const prepared = await node.prep(state, params());

    const result = await node.execCore(prepared, params());

    expect(result.success).toBe(true);
    expect(createProcessNativeOriginalHost).toHaveBeenCalledWith(expect.objectContaining({
      authority, personaAttribution: attribution, context: undefined,
    }));
    expect(createPersonaNativeOriginalHost).toHaveBeenCalledTimes(1);
    expect(callModel.mock.calls[0][0].nativeOriginalHost).toMatchObject({ process: {}, broker: {}, session: {} });
  });
});
