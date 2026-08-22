import { ProcessNode } from '@/backend/execution/flow/nodes';
import type { SharedState } from '@/backend/execution/flow/types';
import { flowService } from '@/backend/services/flow';
import { modelService } from '@/backend/services/model';
import type { Flow } from '@/shared/types/flow';

afterEach(() => {
  jest.restoreAllMocks();
});

describe('ProcessNode immutable snapshot authority', () => {
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

    jest.spyOn(modelService, 'getModel').mockResolvedValue({
      id: 'model-1',
      name: 'Pinned model',
      promptTemplate: 'Pinned Model instruction.',
    } as Awaited<ReturnType<typeof modelService.getModel>>);
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
