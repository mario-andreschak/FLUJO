const rememberMemoryMock = jest.fn();
const searchPersonaMemoryMock = jest.fn();

jest.mock('@/backend/services/enduringAgents', () => ({
  correctMemory: jest.fn(),
  createPersonaWorkItem: jest.fn(),
  forgetMemory: jest.fn(),
  pinMemoryToCore: jest.fn(),
  promoteRunTodoToWorkItem: jest.fn(),
  rememberMemory: (...args: unknown[]) => rememberMemoryMock(...args),
  searchPersonaMemory: (...args: unknown[]) => searchPersonaMemoryMock(...args),
  updatePersonaWorkItem: jest.fn(),
}));

import { buildPersonaTools, executePersonaTool } from '@/backend/execution/flow/handlers/personaTools';
import type { FlowExecutionAuthority } from '@/backend/execution/flow/types';

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
    expect(buildPersonaTools(undefined)).toEqual([]);
  });

  it('fails closed without trusted Persona attribution and mutation authority', async () => {
    await expect(executePersonaTool('remember', {
      content: 'Candidate',
      kind: 'semantic',
      scope: 'persona',
      confidence: 0.5,
      importance: 0.5,
    }, {})).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('trusted, fenced top-level Persona Activity'),
    });
    expect(rememberMemoryMock).not.toHaveBeenCalled();
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
});
