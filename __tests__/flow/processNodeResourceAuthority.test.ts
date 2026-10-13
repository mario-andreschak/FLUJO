const findByName = jest.fn();
const readResource = jest.fn();
jest.mock('@/backend/services/runResources', () => ({
  ...jest.requireActual('@/backend/services/runResources'),
  findRunResourceByName: (...args: unknown[]) => findByName(...args),
  readRunResource: (...args: unknown[]) => readResource(...args),
}));

import { ProcessNode } from '@/backend/execution/flow/nodes/ProcessNode';
import { promptRenderer } from '@/backend/utils/PromptRenderer';
import { modelService } from '@/backend/services/model';
import type { ProcessNodeParams, SharedState } from '@/backend/execution/flow/types';
import type { Flow } from '@/shared/types/flow';

afterEach(() => { jest.restoreAllMocks(); findByName.mockReset(); readResource.mockReset(); });

it.each(['system', 'chat', 'isolated'] as const)(
  'fences the %s prompt resource read after a pending lookup loses its owner', async input => {
    let current = true;
    const assertCurrent = jest.fn(async () => {
      if (!current) throw new Error('Activity lease revoked');
    });
    const emit = jest.fn();
    const flowSnapshot = { id: 'pinned-flow', name: 'Pinned flow', nodes: [], edges: [] } as unknown as Flow;
    const state = {
      trackingInfo: { executionId: 'execution-1', startTime: 1, nodeExecutionTracker: [] },
      messages: input === 'chat' ? [{ id: 'user-1', role: 'user', content: '${res:report}', timestamp: 1 }] : [],
      flowId: flowSnapshot.id, flowSnapshot, conversationId: 'persona-resource-conversation',
      title: 'Pinned run', createdAt: 1, updatedAt: 1, emit,
      personaAttribution: { personaId: 'persona-1', activityId: 'activity-1' },
      executionAuthority: {
        assertCurrent, signal: new AbortController().signal,
        commitWhileCurrent: async (task: () => Promise<unknown>) => { await assertCurrent(); return task(); },
      },
    } as SharedState;
    jest.spyOn(promptRenderer, 'renderPrompt').mockResolvedValue(input === 'system' ? '${res:report}' : 'System prompt');
    jest.spyOn(promptRenderer, 'resolveChatMessageReferences').mockImplementation(async text => text);
    jest.spyOn(modelService, 'getModel').mockResolvedValue({ id: 'model-1', name: 'Model' } as Awaited<ReturnType<typeof modelService.getModel>>);
    findByName.mockImplementation(async () => {
      // Simulate ownership advancing while this asynchronous store lookup is
      // pending, before the durable readBy append and execution event.
      current = false;
      return { uri: 'flujo://run/persona-resource-conversation/report', kind: 'text', size: 7 };
    });
    const params: ProcessNodeParams = {
      id: 'process-1', label: 'Process', type: 'process',
      properties: {
        boundModel: 'model-1',
        ...(input === 'isolated' ? { inputMode: 'isolated' as const, isolatedPrompt: '${res:report}' } : {}),
      },
    };

    await expect(new ProcessNode().prep(state, params))
      .rejects.toMatchObject({ code: 'flow_execution_authority_lost' });
    expect(findByName).toHaveBeenCalledTimes(1);
    expect(readResource).not.toHaveBeenCalled();
    expect(emit.mock.calls.filter(([event]) => event.type === 'resource:read')).toEqual([]);
  },
);
