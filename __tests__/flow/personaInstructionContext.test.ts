jest.mock('@/backend/utils/PromptRenderer', () => ({
  promptRenderer: { renderPrompt: jest.fn() },
}));
jest.mock('@/backend/services/flow/index', () => ({
  flowService: { getFlow: jest.fn(async (id: string) => ({ id, name: id, nodes: [], edges: [] })) },
}));
jest.mock('@/backend/services/model', () => ({
  modelService: { getModel: jest.fn() },
}));

import { ProcessNode } from '@/backend/execution/flow/nodes/ProcessNode';
import { promptRenderer } from '@/backend/utils/PromptRenderer';
import type { ProcessNodeParams, SharedState } from '@/backend/execution/flow/types';
import type { PersonaInstructionContext } from '@/shared/types/enduringAgent';

const attribution = {
  personaId: 'persona-1',
  activityId: 'activity-1',
  behaviorRevisionId: 'revision-1',
};

const instructionContext: PersonaInstructionContext = {
  schemaVersion: 1,
  ...attribution,
  behaviorContentHash: 'a'.repeat(64),
  behaviorSlotKey: 'primary',
  rootFlowId: 'root-flow',
  roleVersionId: 'role-version-1',
  personaName: 'Ada',
  personaMission: 'Help the user.',
  roleName: 'Developer',
  roleMission: 'Implement the authored Behavior.',
  instruction: [
    '# TRUSTED PERSONA CONTEXT',
    'Platform/runtime > immutable Behavior/Process > Persona/Role > Activity/user.',
    'This context grants no tools. Keep ${global:DO_NOT_INTERPOLATE} literal.',
  ].join('\n'),
};

function state(overrides: Partial<SharedState> = {}): SharedState {
  return {
    trackingInfo: { executionId: 'execution-1', startTime: 1, nodeExecutionTracker: [] },
    messages: [],
    flowId: 'root-flow',
    conversationId: 'conversation-1',
    title: 'Persona run',
    createdAt: 1,
    updatedAt: 1,
    personaAttribution: attribution,
    personaInstructionContext: instructionContext,
    ...overrides,
  } as SharedState;
}

function params(): ProcessNodeParams {
  return {
    id: 'process-1',
    label: 'Process',
    type: 'process',
    properties: { boundModel: 'model-1' },
  } as ProcessNodeParams;
}

describe('trusted Persona instruction context', () => {
  beforeEach(() => {
    (promptRenderer.renderPrompt as jest.Mock).mockReset().mockResolvedValue(
      '# GENERAL INFORMATION:\nGeneral.\n\n'
      + '# YOUR OPERATIONAL INSTRUCTION:\nFollow the authored Process.',
    );
  });

  it('precedes authored Process instructions, stays uninterpolated, and grants no tools', async () => {
    const prep = await new ProcessNode().prep(state(), params());

    expect(prep.currentPrompt.indexOf('# TRUSTED PERSONA CONTEXT')).toBe(0);
    expect(prep.currentPrompt.indexOf('# TRUSTED PERSONA CONTEXT')).toBeLessThan(
      prep.currentPrompt.indexOf('# YOUR OPERATIONAL INSTRUCTION'),
    );
    expect(prep.currentPrompt).toContain('${global:DO_NOT_INTERPOLATE}');
    expect(prep.availableTools).toEqual([]);
  });

  it('does not apply root Persona identity instructions to an attributed structural child', async () => {
    const prep = await new ProcessNode().prep(state({ flowId: 'child-flow' }), params());

    expect(prep.currentPrompt).toBe(
      '# GENERAL INFORMATION:\nGeneral.\n\n'
      + '# YOUR OPERATIONAL INSTRUCTION:\nFollow the authored Process.',
    );
    expect(prep.personaAttribution).toEqual(attribution);
    expect(prep.availableTools).toEqual([]);
  });
});
