const getShardedCollectionItemStatsMock = jest.fn();
const listCollectionItemsWithStatsMock = jest.fn();
const getPersonaMock = jest.fn();
const listPersonaMailboxItemsMock = jest.fn();
const listPersonaActivitiesMock = jest.fn();
const listPersonaLeaseRecordsMock = jest.fn();
const getCurrentWorkspaceMock = jest.fn();

jest.mock('@/utils/storage/backend', () => ({
  ...jest.requireActual('@/utils/storage/backend'),
  getShardedCollectionItemStats: (...args: unknown[]) => (
    getShardedCollectionItemStatsMock(...args)
  ),
  listCollectionItemsWithStats: (...args: unknown[]) => listCollectionItemsWithStatsMock(...args),
}));

jest.mock('@/utils/workspace', () => ({
  ...jest.requireActual('@/utils/workspace'),
  getCurrentWorkspace: () => getCurrentWorkspaceMock(),
}));

jest.mock('@/backend/services/enduringAgents/store', () => ({
  ...jest.requireActual('@/backend/services/enduringAgents/store'),
  getPersona: (...args: unknown[]) => getPersonaMock(...args),
  listPersonaMailboxItems: (...args: unknown[]) => listPersonaMailboxItemsMock(...args),
  listPersonaActivities: (...args: unknown[]) => listPersonaActivitiesMock(...args),
  listPersonaLeaseRecords: (...args: unknown[]) => listPersonaLeaseRecordsMock(...args),
}));

import {
  ENDURING_AGENT_SCHEMA_VERSION,
  PERSONA_ACTIVITY_SCHEMA_VERSION,
} from '@/shared/types/enduringAgent';
import { ENDURING_AGENT_COLLECTIONS } from '@/backend/services/enduringAgents/collections';
import {
  PERSONA_FLOW_DISPATCH_SCHEMA_VERSION,
  type PersonaFlowDispatchRecord,
} from '@/backend/services/enduringAgents/personaDispatcher';
import {
  PersonaStorageStatsNotFoundError,
  PersonaStorageStatsUnavailableError,
  getPersonaStorageStats,
} from '@/backend/services/enduringAgents/runtimeStorageStats';

type StoredEntry = {
  id: string;
  item: unknown;
  mtimeMs: number;
  sizeBytes: number;
};

function dispatch(overrides: Partial<PersonaFlowDispatchRecord> = {}): PersonaFlowDispatchRecord {
  return {
    schemaVersion: PERSONA_FLOW_DISPATCH_SCHEMA_VERSION,
    id: 'dispatch_1',
    workspaceId: 'workspace_1',
    personaId: 'persona_1',
    idempotencyDigest: 'a'.repeat(64),
    requestHash: 'b'.repeat(64),
    state: 'completed',
    admission: {
      kind: 'assignment',
      priority: 'normal',
      source: { kind: 'assignment', sourceId: 'source_1' },
    },
    flowInput: { source: 'api', prompt: 'private prompt' },
    mailboxItemId: 'mailbox_1',
    activityId: 'activity_1',
    behaviorRevisionId: 'revision_1',
    targetActivityId: 'activity_1',
    createdAt: 30,
    updatedAt: 40,
    startedAt: 35,
    completedAt: 40,
    compactedAt: 50,
    ...overrides,
  };
}

function entry<T extends { id: string }>(
  item: T,
  sizeBytes = Buffer.byteLength(JSON.stringify(item), 'utf8'),
): StoredEntry {
  return { id: item.id, item, mtimeMs: 100, sizeBytes };
}

describe('Persona runtime storage statistics', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getPersonaMock.mockResolvedValue({ id: 'persona_1' });
    getCurrentWorkspaceMock.mockReturnValue('workspace_1');

    const mailbox = {
      schemaVersion: ENDURING_AGENT_SCHEMA_VERSION,
      id: 'mailbox_1',
      personaId: 'persona_1',
      idempotencyKey: 'c'.repeat(64),
      sequence: 1,
      kind: 'assignment',
      priority: 'normal',
      status: 'queued',
      source: { kind: 'assignment', sourceId: 'source_1' },
      summary: 'observación',
      createdAt: 10,
      updatedAt: 10,
    };
    const activity = {
      schemaVersion: PERSONA_ACTIVITY_SCHEMA_VERSION,
      id: 'activity_1',
      personaId: 'persona_1',
      kind: 'assignment',
      status: 'completed',
      source: { kind: 'assignment', sourceId: 'source_1' },
      createdAt: 20,
      updatedAt: 25,
      startedAt: 21,
      completedAt: 25,
      compactedAt: 50,
    };
    const lease = {
      schemaVersion: ENDURING_AGENT_SCHEMA_VERSION,
      id: 'lease_1',
      workspaceId: 'workspace_1',
      personaId: 'persona_1',
      activityId: 'activity_1',
      holderId: 'holder_1',
      status: 'released',
      fencingToken: 1,
      acquiredAt: 5,
      renewedAt: 6,
      expiresAt: 20,
      releasedAt: 7,
    };

    listPersonaMailboxItemsMock.mockResolvedValue([mailbox]);
    listPersonaActivitiesMock.mockResolvedValue([activity]);
    listPersonaLeaseRecordsMock.mockResolvedValue([lease]);
    const indexedSizes: Record<string, number> = {
      mailbox_1: 100,
      activity_1: 200,
      lease_1: 400,
    };
    getShardedCollectionItemStatsMock.mockImplementation(
      async (_collection: string, _personaId: string, id: string) => ({
        mtimeMs: 100,
        sizeBytes: indexedSizes[id] ?? 1,
      }),
    );

    const entries = new Map<string, StoredEntry[]>([
      [ENDURING_AGENT_COLLECTIONS.mailboxItems, [
        entry(mailbox),
        entry({ ...mailbox, id: 'mailbox_other', personaId: 'persona_other' }, 999),
      ]],
      [ENDURING_AGENT_COLLECTIONS.activities, [entry(activity, 200)]],
      [ENDURING_AGENT_COLLECTIONS.flowDispatches, [entry(dispatch(), 300)]],
      [ENDURING_AGENT_COLLECTIONS.leaseHistory, [entry(lease, 400)]],
    ]);
    listCollectionItemsWithStatsMock.mockImplementation(
      async (collection: string) => entries.get(collection) ?? [],
    );
  });

  it('reports all four kinds, native statuses, timestamps, compaction, and exact bytes', async () => {
    const stats = await getPersonaStorageStats('persona_1');
    expect(stats.kinds.mailboxItems).toEqual({
      total: 1,
      byStatus: { queued: 1 },
      compacted: 0,
      uncompacted: 1,
      oldestCreatedAt: 10,
      newestCreatedAt: 10,
      approxBytes: 100,
    });
    expect(stats.kinds.activities).toEqual(expect.objectContaining({
      total: 1,
      byStatus: { completed: 1 },
      compacted: 1,
      oldestCreatedAt: 20,
      newestCreatedAt: 20,
      approxBytes: 200,
    }));
    expect(stats.kinds.flowDispatches.byStatus).toEqual({ completed: 1 });
    expect(stats.kinds.leaseHistory).toEqual(expect.objectContaining({
      byStatus: { released: 1 },
      oldestCreatedAt: 5,
      newestCreatedAt: 5,
      approxBytes: 400,
    }));
    expect(stats.totals).toEqual({
      records: 4,
      compacted: 2,
      uncompacted: 2,
      approxBytes: 1_000,
    });
    expect(stats.retentionEnabled).toBe(false);
  });

  it('returns four zero-filled kinds for an existing Persona without runtime records', async () => {
    listCollectionItemsWithStatsMock.mockResolvedValue([]);
    listPersonaMailboxItemsMock.mockResolvedValue([]);
    listPersonaActivitiesMock.mockResolvedValue([]);
    listPersonaLeaseRecordsMock.mockResolvedValue([]);
    const stats = await getPersonaStorageStats('persona_1');

    expect(Object.keys(stats.kinds)).toEqual([
      'mailboxItems',
      'activities',
      'flowDispatches',
      'leaseHistory',
    ]);
    expect(stats.totals).toEqual({
      records: 0,
      compacted: 0,
      uncompacted: 0,
      approxBytes: 0,
    });
    for (const kind of Object.values(stats.kinds)) {
      expect(kind).toEqual({
        total: 0,
        byStatus: {},
        compacted: 0,
        uncompacted: 0,
        approxBytes: 0,
      });
    }
  });

  it('keeps foreign records outside the bounded indexed statistics inputs', async () => {
    listCollectionItemsWithStatsMock.mockResolvedValue([]);
    listPersonaMailboxItemsMock.mockResolvedValue([]);
    listPersonaActivitiesMock.mockResolvedValue([]);
    listPersonaLeaseRecordsMock.mockResolvedValue([]);

    await expect(getPersonaStorageStats('persona_1')).resolves.toMatchObject({
      totals: { records: 0, approxBytes: 0 },
    });
  });

  it('fails closed for unknown Personas, invalid records, and cross-workspace records', async () => {
    getPersonaMock.mockResolvedValueOnce(null);
    await expect(getPersonaStorageStats('persona_1'))
      .rejects.toBeInstanceOf(PersonaStorageStatsNotFoundError);

    getPersonaMock.mockResolvedValue({ id: 'persona_1' });
    listPersonaActivitiesMock.mockResolvedValueOnce([
      { id: 'invalid', personaId: 'persona_1' },
    ]);
    await expect(getPersonaStorageStats('persona_1'))
      .rejects.toBeInstanceOf(PersonaStorageStatsUnavailableError);

    listCollectionItemsWithStatsMock.mockImplementation(async (collection: string) => (
      collection === ENDURING_AGENT_COLLECTIONS.flowDispatches
        ? [entry(dispatch({ workspaceId: 'workspace_other' }), 10)]
        : []
    ));
    await expect(getPersonaStorageStats('persona_1'))
      .rejects.toBeInstanceOf(PersonaStorageStatsUnavailableError);
  });
});
