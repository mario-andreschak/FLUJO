const rememberMemoryMock = jest.fn();
const searchPersonaMemoryMock = jest.fn();
const unpinMemoryFromCoreMock = jest.fn();
const suggestBehaviorInstructionImprovementMock = jest.fn();

jest.mock('@/backend/services/enduringAgents', () => ({
  correctMemory: jest.fn(),
  createPersonaWorkItem: jest.fn(),
  forgetMemory: jest.fn(),
  pinMemoryToCore: jest.fn(),
  promoteRunTodoToWorkItem: jest.fn(),
  rememberMemory: (...args: unknown[]) => rememberMemoryMock(...args),
  searchPersonaMemory: (...args: unknown[]) => searchPersonaMemoryMock(...args),
  suggestBehaviorInstructionImprovement: (...args: unknown[]) => (
    suggestBehaviorInstructionImprovementMock(...args)
  ),
  unpinMemoryFromCore: (...args: unknown[]) => unpinMemoryFromCoreMock(...args),
  updatePersonaWorkItem: jest.fn(),
}));

jest.mock('@/backend/services/enduringAgents/memoryKernel', () => ({
  correctMemory: jest.fn(),
  forgetMemory: jest.fn(),
  pinMemoryToCore: jest.fn(),
  rememberMemory: (...args: unknown[]) => rememberMemoryMock(...args),
  searchPersonaMemory: (...args: unknown[]) => searchPersonaMemoryMock(...args),
  unpinMemoryFromCore: (...args: unknown[]) => unpinMemoryFromCoreMock(...args),
}));

import type OpenAI from 'openai';

import { ModelHandler } from '@/backend/execution/flow/handlers/ModelHandler';
import {
  PERSONA_TOOL_NAMES,
  buildPersonaTools,
  executePersonaTool,
  isPersonaToolName,
} from '@/backend/execution/flow/handlers/personaTools';
import type { FlowExecutionAuthority } from '@/backend/execution/flow/types';
import { PERSONA_NATIVE_ABILITY_IDS } from '@/shared/types/enduringAgent';

function authority(): FlowExecutionAuthority {
  const commitPersonaMutation = jest.fn(async (task: (context: never) => Promise<unknown>) => (
    task({} as never)
  )) as unknown as NonNullable<FlowExecutionAuthority['commitPersonaMutation']>;
  return {
    signal: new AbortController().signal,
    assertCurrent: jest.fn(async () => undefined),
    commitPersonaMutation,
  };
}

describe('authored Persona tools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('advertises only explicitly authored fixed definitions in canonical order', () => {
    expect(buildPersonaTools(['work_item_create', 'remember', 'unknown', 'remember']))
      .toEqual([
        expect.objectContaining({ name: 'remember' }),
        expect.objectContaining({ name: 'work_item_create' }),
      ]);
    expect(buildPersonaTools(['unpin', 'pin'])).toEqual([
      expect.objectContaining({ name: 'pin' }),
      expect.objectContaining({ name: 'unpin' }),
    ]);
    expect(buildPersonaTools(undefined)).toEqual([]);
  });

  it('accepts every shared native ability in the backend without a second allow-list', () => {
    expect(PERSONA_TOOL_NAMES).toBe(PERSONA_NATIVE_ABILITY_IDS);
    expect(PERSONA_NATIVE_ABILITY_IDS.every(isPersonaToolName)).toBe(true);
    expect(buildPersonaTools(PERSONA_NATIVE_ABILITY_IDS).map((tool) => tool.name))
      .toEqual(PERSONA_NATIVE_ABILITY_IDS);
  });

  it.each([
    'remember',
    'recall',
    'correct',
    'forget',
    'pin',
    'unpin',
  ] as const)('fails closed for %s without trusted Persona attribution and mutation authority', async (toolName) => {
    await expect(executePersonaTool(toolName, {}, {})).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('trusted, fenced top-level Persona Activity'),
    });
    expect(rememberMemoryMock).not.toHaveBeenCalled();
    expect(searchPersonaMemoryMock).not.toHaveBeenCalled();
    expect(unpinMemoryFromCoreMock).not.toHaveBeenCalled();
  });

  it('forces remember into a provenance-bearing model candidate under the live fence', async () => {
    const executionAuthority = authority();
    rememberMemoryMock.mockResolvedValue({ id: 'memory_candidate', status: 'candidate' });
    const result = await executePersonaTool('remember', {
      content: 'Candidate fact',
      kind: 'semantic',
      scope: 'persona',
      confidence: 0.75,
      importance: 0.6,
    }, {
      conversationId: 'conversation_persona',
      executionAuthority,
      personaAttribution: {
        personaId: 'persona_test',
        activityId: 'activity_test',
        behaviorRevisionId: 'revision_test',
      },
    });

    expect(result).toMatchObject({ success: true, data: { proposed: true } });
    expect(rememberMemoryMock).toHaveBeenCalledWith(expect.objectContaining({
      personaId: 'persona_test',
      status: 'candidate',
      trust: 'model_inference',
      sourceRefs: [{
        kind: 'activity',
        id: 'activity_test',
        uri: 'flujo://conversation/conversation_persona',
      }],
    }), { executionAuthority });
  });

  it('dispatches an advertised Persona tool through ModelHandler with the same fence', async () => {
    const executionAuthority = authority();
    rememberMemoryMock.mockResolvedValue({ id: 'memory_dispatched', status: 'candidate' });
    const toolCall = {
      id: 'call_remember',
      type: 'function',
      function: {
        name: 'remember',
        arguments: JSON.stringify({ content: 'Dispatched candidate fact' }),
      },
    } as OpenAI.ChatCompletionMessageFunctionToolCall;

    const result = await ModelHandler.processToolCalls({
      conversationId: 'conversation_persona',
      toolCalls: [toolCall],
      executionAuthority,
      personaAttribution: {
        personaId: 'persona_test',
        activityId: 'activity_test',
        behaviorRevisionId: 'revision_test',
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.error.message);
    expect(result.value.toolCallMessages).toHaveLength(1);
    expect(result.value.toolCallMessages[0]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_remember',
      content: expect.stringContaining('memory_dispatched'),
    });
    expect(rememberMemoryMock).toHaveBeenCalledWith(expect.objectContaining({
      personaId: 'persona_test',
      content: 'Dispatched candidate fact',
      status: 'candidate',
      trust: 'model_inference',
    }), { executionAuthority });
  });

  it('unpins through the owning Activity mutation authority without deleting the record', async () => {
    const executionAuthority = authority();
    const remainingCore = [{ id: 'memory_remaining' }];
    unpinMemoryFromCoreMock.mockResolvedValue(remainingCore);

    await expect(executePersonaTool('unpin', { memory_id: 'memory_target' }, {
      executionAuthority,
      personaAttribution: {
        personaId: 'persona_test',
        activityId: 'activity_test',
        behaviorRevisionId: 'revision_test',
      },
    })).resolves.toEqual({
      success: true,
      data: { unpinned: true, core: remainingCore },
    });
    expect(unpinMemoryFromCoreMock).toHaveBeenCalledWith(
      'persona_test',
      'memory_target',
      { executionAuthority },
    );
  });

  it('fence-checks recall before and after reading active memory', async () => {
    const executionAuthority = authority();
    searchPersonaMemoryMock.mockResolvedValue([]);
    await expect(executePersonaTool('recall', { query: 'release', limit: 5 }, {
      executionAuthority,
      personaAttribution: {
        personaId: 'persona_test',
        activityId: 'activity_test',
        behaviorRevisionId: 'revision_test',
      },
    })).resolves.toMatchObject({ success: true, data: { memories: [] } });
    expect(executionAuthority.assertCurrent).toHaveBeenCalledTimes(2);
    expect(searchPersonaMemoryMock).toHaveBeenCalledWith('persona_test', {
      query: 'release',
      limit: 5,
      coreOnly: false,
      statuses: ['active'],
    });
  });

  it('turns a reusable lesson into a reviewable improvement under the live fence', async () => {
    const executionAuthority = authority();
    suggestBehaviorInstructionImprovementMock.mockResolvedValue({
      id: 'proposal_safe',
      status: 'awaiting_approval',
    });

    await expect(executePersonaTool('suggest_improvement', {
      behavior_slot: 'primary',
      rationale: 'The same validation step was missed twice.',
      instruction: 'Run the focused regression test before reporting completion.',
    }, {
      executionAuthority,
      personaAttribution: {
        personaId: 'persona_test',
        activityId: 'activity_test',
        behaviorRevisionId: 'revision_test',
      },
    })).resolves.toMatchObject({
      success: true,
      data: { proposed: true, applied: false },
    });

    expect(executionAuthority.assertCurrent).toHaveBeenCalledTimes(2);
    expect(suggestBehaviorInstructionImprovementMock).toHaveBeenCalledWith({
      personaId: 'persona_test',
      slotKey: 'primary',
      rationale: 'The same validation step was missed twice.',
      instruction: 'Run the focused regression test before reporting completion.',
      evidenceRefs: [{ kind: 'activity', id: 'activity_test' }],
    });
  });
});
