const listPersonasMock = jest.fn();
const listMemoryItemsMock = jest.fn();
const saveMemoryItemMock = jest.fn();
const withPersonaDomainMutationMock = jest.fn();
const assertActivationPolicyMock = jest.fn();

jest.mock('@/backend/services/enduringAgents/store', () => ({
  listPersonas: (...args: unknown[]) => listPersonasMock(...args),
  listMemoryItems: (...args: unknown[]) => listMemoryItemsMock(...args),
  saveMemoryItem: (...args: unknown[]) => saveMemoryItemMock(...args),
}));

jest.mock('@/backend/services/enduringAgents/domainMutation', () => ({
  PersonaDomainBusyError: class PersonaDomainBusyError extends Error {},
  withPersonaDomainMutation: (...args: unknown[]) => withPersonaDomainMutationMock(...args),
}));

jest.mock('@/backend/services/enduringAgents/memoryKernel', () => ({
  assertActivationPolicy: (...args: unknown[]) => assertActivationPolicyMock(...args),
}));

import { PersonaDomainBusyError } from '@/backend/services/enduringAgents/domainMutation';
import { backfillStoredMemoryDuplicates } from '@/backend/services/enduringAgents/memoryBackfill';
import type { MemoryItem, Persona } from '@/shared/types/enduringAgent';

const NOW = 20_000;

function memory(
  id: string,
  sourceIds: string[],
  overrides: Partial<MemoryItem> = {},
): MemoryItem {
  return {
    schemaVersion: 1,
    id,
    personaId: 'persona-1',
    kind: 'semantic',
    scope: 'persona',
    status: 'active',
    content: 'the release branch is stable',
    confidence: 0.5,
    importance: 0.5,
    sourceRefs: sourceIds.map((sourceId) => ({
      kind: 'user_statement',
      id: sourceId,
      observedAt: NOW,
    })),
    trust: 'explicit_user',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('stored memory duplicate backfill (issue #465)', () => {
  let persona: Persona;
  let records: Map<string, MemoryItem>;

  beforeEach(() => {
    jest.clearAllMocks();
    persona = {
      id: 'persona-1',
      coreMemoryItemIds: [],
      updatedAt: NOW,
    } as Persona;
    records = new Map();

    listPersonasMock.mockResolvedValue([persona]);
    listMemoryItemsMock.mockImplementation(async () => [...records.values()]);
    saveMemoryItemMock.mockImplementation(async (record: MemoryItem) => {
      records.set(record.id, record);
      return record;
    });
    withPersonaDomainMutationMock.mockImplementation(
      async (
        _personaId: string,
        _options: unknown,
        task: (context: {
          persona: Persona;
          updatePersona: (next: Persona) => Promise<Persona>;
        }) => Promise<unknown>,
      ) => task({
        persona,
        updatePersona: async (next) => {
          persona = next;
          return next;
        },
      }),
    );
  });

  it('reinforces one survivor, retires siblings, and is idempotent on rerun', async () => {
    records.set('survivor', memory('survivor', ['source-a'], { createdAt: NOW - 10 }));
    records.set('sibling', memory('sibling', ['source-b']));

    const first = await backfillStoredMemoryDuplicates({ now: NOW + 1 });

    expect(first).toMatchObject({
      personasScanned: 1,
      memoriesScanned: 2,
      duplicatePairsFound: 1,
      clustersMerged: 1,
      siblingsRemoved: 1,
      errors: 0,
    });
    expect(records.get('survivor')).toMatchObject({
      confidence: 0.55,
      importance: 0.52,
      backfillMerge: {
        version: 1,
        memberIds: ['sibling', 'survivor'],
      },
    });
    expect(records.get('survivor')?.sourceRefs).toHaveLength(2);
    expect(records.get('sibling')).toMatchObject({
      status: 'forgotten',
      backfillMergedInto: 'survivor',
    });

    saveMemoryItemMock.mockClear();
    const second = await backfillStoredMemoryDuplicates({ now: NOW + 2 });

    expect(second.clustersMerged).toBe(0);
    expect(second.siblingsRemoved).toBe(0);
    expect(saveMemoryItemMock).not.toHaveBeenCalled();
    expect(records.get('survivor')?.confidence).toBe(0.55);
  });

  it('finishes a partial retirement without reinforcing the marked survivor twice', async () => {
    records.set('survivor', memory('survivor', ['source-a', 'source-b'], {
      confidence: 0.55,
      importance: 0.52,
      createdAt: NOW - 10,
      backfillMerge: {
        version: 1,
        memberIds: ['sibling', 'survivor'],
        mergedAt: NOW,
      },
    }));
    records.set('sibling', memory('sibling', ['source-b']));

    const result = await backfillStoredMemoryDuplicates({ now: NOW + 1 });

    expect(result.clustersMerged).toBe(1);
    expect(result.siblingsRemoved).toBe(1);
    expect(records.get('survivor')?.confidence).toBe(0.55);
    expect(records.get('sibling')).toMatchObject({
      status: 'forgotten',
      backfillMergedInto: 'survivor',
    });
    expect(saveMemoryItemMock).toHaveBeenCalledTimes(1);
  });

  it('counts an active Persona lease as a busy skip', async () => {
    withPersonaDomainMutationMock.mockRejectedValueOnce(new PersonaDomainBusyError('persona-1'));

    const result = await backfillStoredMemoryDuplicates({ now: NOW + 1 });

    expect(result.skippedBusy).toBe(1);
    expect(result.personasScanned).toBe(0);
    expect(result.errors).toBe(0);
  });

  it('leaves an overflowing provenance component entirely unchanged', async () => {
    const sourceIds = Array.from({ length: 65 }, (_, index) => `source-${index}`);
    records.set('survivor', memory('survivor', sourceIds.slice(0, 33), { createdAt: NOW - 10 }));
    records.set('sibling', memory('sibling', sourceIds.slice(33)));

    const result = await backfillStoredMemoryDuplicates({ now: NOW + 1 });

    expect(result.duplicatePairsFound).toBe(1);
    expect(result.skippedProvenanceOverflow).toBe(1);
    expect(result.clustersMerged).toBe(0);
    expect(result.siblingsRemoved).toBe(0);
    expect(saveMemoryItemMock).not.toHaveBeenCalled();
    expect(records.get('sibling')?.status).toBe('active');
  });
});
