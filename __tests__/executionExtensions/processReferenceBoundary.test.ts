import { ProcessNode } from '@/backend/execution/flow/nodes';
import { modelService } from '@/backend/services/model';
import { flowService } from '@/backend/services/flow';
import { loadConversationState } from '@/backend/execution/flow/loadConversationState';
import type { SharedState } from '@/backend/execution/flow/types';
import { ModelHandler } from '@/backend/execution/flow/handlers/ModelHandler';
import { registerExecutionExtension } from '@/backend/execution/extensions';
import { fixtureAdapter, fixtureRun, mintFixture } from './fixtureAdapter';

jest.mock('@/utils/logger', () => ({ createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), verbose: jest.fn() }) }));
jest.mock('@/backend/execution/flow/loadConversationState', () => ({ loadConversationState: jest.fn() }));

describe('bound normal Process references and late provider results', () => {
  let restore: () => void;
  afterEach(() => { restore?.(); jest.restoreAllMocks(); jest.mocked(loadConversationState).mockClear(); });
  function setup() {
    const adapter = fixtureAdapter(); restore = registerExecutionExtension(adapter);
    const run = fixtureRun(); const context = mintFixture(adapter, run);
    const graph = { id: 'shared-graph', name: 'Shared', nodes: [{ id: 'process', type: 'process', position: { x: 0, y: 0 },
      data: { type: 'process', label: 'Process', properties: { boundModel: 'model-1' } } }], edges: [] };
    const state = { trackingInfo: { executionId: run.runId, startTime: 1, nodeExecutionTracker: [] },
      messages: [{ role: 'user', content: '@conversation[conversation-B].name @file[%2Fprivate%2Fbank.pem].name ${kv:other-owner}' }],
      flowId: graph.id, flowSnapshot: graph, conversationId: run.conversation, executionExtensionContext: context,
      title: 'Private', createdAt: 1, updatedAt: 1 } as unknown as SharedState;
    jest.spyOn(modelService, 'getModel').mockResolvedValue({ id: 'model-1', name: 'Fixture', adapter: 'openai' } as never);
    return { run, state };
  }
  test('foreign entity/file/shared-memory commands in customer text stay literal without any foreign state load', async () => {
    const { state } = setup();
    const flow = jest.spyOn(flowService, 'getFlow').mockRejectedValue(new Error('must use pinned graph'));
    const prepared = await new ProcessNode().prep(state, { id: 'process', label: 'Process', type: 'process', properties: { boundModel: 'model-1' } });
    expect(prepared.messages.some(message => String(message.content).includes('@conversation[conversation-B].name'))).toBe(true);
    expect(loadConversationState).not.toHaveBeenCalled(); expect(flow).not.toHaveBeenCalled();
  });
  test('revocation during provider execution blocks Process output before post/persistence', async () => {
    const { run, state } = setup();
    const prepared = await new ProcessNode().prep(state, { id: 'process', label: 'Process', type: 'process', properties: { boundModel: 'model-1' } });
    const callModel = jest.spyOn(ModelHandler, 'callModel').mockImplementation(async () => {
      run.revoked = true;
      return { success: true, value: { content: 'late customer data', messages: [{ role: 'assistant', content: 'late customer data' }] } } as never;
    });
    const result = await new ProcessNode().execCore(prepared, { id: 'process', label: 'Process', type: 'process', properties: { boundModel: 'model-1' } });
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(JSON.stringify(state.messages)).not.toContain('late customer data');
  });
});
