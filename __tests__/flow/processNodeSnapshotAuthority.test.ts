import { ProcessNode } from '@/backend/execution/flow/nodes';
import type { SharedState } from '@/backend/execution/flow/types';
import { flowService } from '@/backend/services/flow';
import type { Flow } from '@/shared/types/flow';
import { saveItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { digestProjectedMessages } from '@/backend/execution/flow/compaction/digest';

beforeEach(async () => {
  await saveItem(StorageKey.MODELS, [{ id: 'model-1', name: 'Pinned model', provider: 'openai', adapter: 'openai', ApiKey: '', promptTemplate: 'Pinned Model instruction.' }]);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('ProcessNode immutable snapshot authority', () => {
  it('keeps generated system-message identity stable across steps and a saved-state roundtrip', async () => {
    const state = {
      trackingInfo: { executionId: 'execution-cache', startTime: 1, nodeExecutionTracker: [] },
      messages: [{ id: 'user-1', role: 'user', content: 'Never publish.', timestamp: 1 }],
      flowId: 'flow-cache', conversationId: 'conversation-cache', title: 'Cache continuity',
      createdAt: 1, updatedAt: 1,
      flowSnapshot: { id: 'flow-cache', name: 'Cache continuity', nodes: [], edges: [] },
    } as unknown as SharedState;
    const params = { id: 'process-cache', label: 'Process', type: 'process' as const,
      properties: { boundModel: 'model-1', promptTemplate: 'Never publish.' } };
    const first = await new ProcessNode().prep(state, params);
    const second = await new ProcessNode().prep(state, params);
    const restored = JSON.parse(JSON.stringify(state)) as SharedState;
    const afterRestart = await new ProcessNode().prep(restored, params);
    const systems = [first, second, afterRestart].map(prepared => prepared.messages.find(message => message.role === 'system')!);
    expect(systems[0]).toBeDefined();
    expect(systems[1]).toEqual(systems[0]);
    expect(systems[2]).toEqual(systems[0]);
    expect(digestProjectedMessages(second.messages)).toBe(digestProjectedMessages(first.messages));
    expect(digestProjectedMessages(afterRestart.messages)).toBe(digestProjectedMessages(first.messages));
    expect(state.messages).toEqual([{ id: 'user-1', role: 'user', content: 'Never publish.', timestamp: 1 }]);
    expect(digestProjectedMessages([{ ...systems[0], content: 'A changed prohibition.' }]))
      .not.toBe(digestProjectedMessages([systems[0]]));
  });

  it('renders prompts and enforces permission rules from a Persona-private snapshot with no live record', async () => {
    const denyQuestion = { action: 'question', resource: '*', effect: 'deny' as const };
    const flowSnapshot = {
      id: 'persona-private-flow',
      name: 'Pinned Persona Behavior',
      behaviorRules: [denyQuestion],
      nodes: [
        {
          id: 'start-1',
          type: 'start',
          position: { x: 0, y: 0 },
          data: {
            label: 'Start',
            type: 'start',
            properties: { promptTemplate: 'Pinned Start instruction.' },
          },
        },
        {
          id: 'process-1',
          type: 'process',
          position: { x: 100, y: 0 },
          data: {
            label: 'Process',
            type: 'process',
            properties: {
              boundModel: 'model-1',
              promptTemplate: 'Pinned Process instruction.',
            },
          },
        },
      ],
      edges: [],
    } as Flow;
    const state = {
      trackingInfo: { executionId: 'execution-1', startTime: 1, nodeExecutionTracker: [] },
      messages: [],
      flowId: flowSnapshot.id,
      flowSnapshot,
      conversationId: 'conversation-1',
      title: 'Persona conversation',
      createdAt: 1,
      updatedAt: 1,
      personaAttribution: {
        personaId: 'persona-1',
        activityId: 'activity-1',
        behaviorRevisionId: 'revision-1',
      },
    } as SharedState;

    const getFlow = jest.spyOn(flowService, 'getFlow').mockRejectedValue(
      new Error('Persona-private snapshot must not fall back to the mutable Flow store'),
    );

    const prepared = await new ProcessNode().prep(state, {
      id: 'process-1',
      label: 'Process',
      type: 'process',
      properties: {
        boundModel: 'model-1',
        allowQuestion: true,
      },
    });

    expect(prepared.behaviorRules).toEqual([denyQuestion]);
    expect(state.behaviorRules).toEqual([denyQuestion]);
    expect(prepared.availableTools?.some((tool) => tool.name === 'question')).toBe(false);
    expect(prepared.currentPrompt).toContain('Pinned Start instruction.');
    expect(prepared.currentPrompt).toContain('Pinned Model instruction.');
    expect(prepared.currentPrompt).toContain('Pinned Process instruction.');
    expect(getFlow).not.toHaveBeenCalled();
  });
});
