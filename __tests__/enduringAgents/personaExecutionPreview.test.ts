const getPersonaMock = jest.fn();
const listBehaviorBindingsMock = jest.fn();
const getBehaviorRevisionMock = jest.fn();
const getRoleVersionMock = jest.fn();
const getCoreMemoryMock = jest.fn();
const buildPersonaInstructionContextMock = jest.fn();
const snapshotPersonaCoreAppRefsMock = jest.fn();
const createPersonaActivitySnapshotMock = jest.fn();
const getFlowMock = jest.fn();

jest.mock('@/backend/services/flow', () => ({
  flowService: { getFlow: (...args: unknown[]) => getFlowMock(...args) },
}));

jest.mock('@/backend/services/enduringAgents/store', () => ({
  getPersona: (...args: unknown[]) => getPersonaMock(...args),
  listBehaviorBindings: (...args: unknown[]) => listBehaviorBindingsMock(...args),
  getBehaviorRevision: (...args: unknown[]) => getBehaviorRevisionMock(...args),
  getRoleVersion: (...args: unknown[]) => getRoleVersionMock(...args),
}));

jest.mock('@/backend/services/enduringAgents/memoryKernel', () => ({
  getCoreMemory: (...args: unknown[]) => getCoreMemoryMock(...args),
}));

jest.mock('@/backend/services/enduringAgents/personaInstructionContext', () => ({
  buildPersonaInstructionContext: (...args: unknown[]) => (
    buildPersonaInstructionContextMock(...args)
  ),
}));

jest.mock('@/backend/services/enduringAgents/personaCoreApps', () => ({
  snapshotPersonaCoreAppRefs: (...args: unknown[]) => snapshotPersonaCoreAppRefsMock(...args),
}));

jest.mock('@/backend/services/enduringAgents/personaActivitySnapshot', () => ({
  createPersonaActivitySnapshot: (...args: unknown[]) => (
    createPersonaActivitySnapshotMock(...args)
  ),
}));

import { previewPersonaExecution } from '@/backend/services/enduringAgents/personaExecutionPreview';

describe('Persona execution preview', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    getPersonaMock.mockResolvedValue({
      id: 'persona_preview',
      name: 'Ada',
      roleVersionId: 'rolever_preview',
      updatedAt: 42,
      composition: {
        coreFlowRef: 'flow_ada_core',
        behaviors: [{
          ref: 'behavior_deep_research',
          slotKey: 'deep_research_internal',
          name: 'Deep research',
          description: 'Find and compare trustworthy evidence.',
        }],
      },
    });
    listBehaviorBindingsMock.mockResolvedValue([
      {
        id: 'behavior_primary',
        personaId: 'persona_preview',
        slotKey: 'primary',
        activeRevisionId: 'behaviorrev_primary',
      },
      {
        id: 'behavior_deep_research',
        personaId: 'persona_preview',
        slotKey: 'deep_research_internal',
        activeRevisionId: 'behaviorrev_research',
      },
      {
        id: 'behavior_quality',
        personaId: 'persona_preview',
        slotKey: 'quality-review',
        activeRevisionId: 'behaviorrev_quality',
      },
    ]);
    getBehaviorRevisionMock.mockResolvedValue({
      id: 'behaviorrev_primary',
      flowSnapshot: {
        id: 'flow_primary_snapshot',
        name: 'Primary',
        nodes: [
          {
            id: 'start',
            type: 'start',
            data: { label: 'Start', type: 'start' },
          },
          {
            id: 'work',
            type: 'process',
            data: {
              label: 'Work',
              type: 'process',
              properties: {
                personaTools: ['work_item_create', 'recall', 'unknown', 'recall'],
              },
            },
          },
          {
            id: 'learn',
            type: 'process',
            data: {
              label: 'Learn',
              type: 'process',
              properties: { personaTools: ['remember'] },
            },
          },
        ],
        edges: [],
      },
    });
    getRoleVersionMock.mockResolvedValue({
      id: 'rolever_preview',
      behaviorSlots: [{ key: 'primary', name: 'Main work' }],
    });
    getCoreMemoryMock.mockResolvedValue([]);
    buildPersonaInstructionContextMock.mockReturnValue({
      instruction: 'Friendly immutable context.',
    });
    snapshotPersonaCoreAppRefsMock.mockResolvedValue([
      'github-sarah',
      'notion-team',
    ]);
    createPersonaActivitySnapshotMock.mockReturnValue({
      coreFlowId: 'flow_primary_snapshot',
      coreFlowRevisionId: 'flowrev_primary_snapshot',
      instructionContext: { instruction: 'Friendly immutable context.' },
      instructionContextDigest: 'preview-context-digest',
      coreAppRefs: ['github-sarah', 'notion-team'],
    });
    getFlowMock.mockResolvedValue({
      id: 'flow_ada_core',
      name: 'Ada Core',
      nodes: [
        {
          id: 'work',
          type: 'process',
          data: {
            label: 'Work',
            type: 'process',
            properties: {
              personaTools: ['work_item_create', 'recall', 'unknown', 'recall'],
            },
          },
        },
        {
          id: 'learn',
          type: 'process',
          data: {
            label: 'Learn',
            type: 'process',
            properties: { personaTools: ['remember'] },
          },
        },
      ],
      edges: [],
    });
  });

  it('reports enabled native abilities, selected Apps, and friendly Behavior names', async () => {
    const preview = await previewPersonaExecution('persona_preview');

    expect(preview).not.toBeNull();
    expect(preview?.nativeAbilities).toEqual([
      'remember',
      'recall',
      'work_item_create',
    ]);
    expect(preview?.apps).toEqual(['github-sarah', 'notion-team']);
    expect(preview?.behaviors).toEqual([
      {
        slotKey: 'deep_research_internal',
        name: 'Deep research',
        description: 'Find and compare trustworthy evidence.',
      },
      {
        slotKey: 'quality-review',
        name: 'Quality Review',
      },
    ]);
    expect(preview?.behaviors.map((behavior) => behavior.name)).not.toContain('quality-review');
    expect(snapshotPersonaCoreAppRefsMock).toHaveBeenCalledWith(
      'persona_preview',
      expect.objectContaining({ id: 'persona_preview' }),
    );
    expect(getFlowMock).toHaveBeenCalledWith('flow_ada_core');
  });

  it('reports only memory recall when automatic learning is off', async () => {
    getPersonaMock.mockResolvedValue({
      id: 'persona_preview',
      name: 'Ada',
      roleVersionId: 'rolever_preview',
      updatedAt: 42,
      autonomyLevel: 'locked',
      composition: { coreFlowRef: 'flow_ada_core' },
    });

    await expect(previewPersonaExecution('persona_preview')).resolves.toMatchObject({
      nativeAbilities: ['recall', 'work_item_create'],
    });
  });
});
