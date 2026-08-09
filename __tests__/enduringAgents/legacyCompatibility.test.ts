import legacyFlowFixture from '../fixtures/enduringAgents/legacy-flow.json';
import legacyMeetingFixture from '../fixtures/enduringAgents/legacy-meeting-record.json';
import legacyPlannedExecutionsFixture from '../fixtures/enduringAgents/legacy-planned-executions.json';
import legacySharedStateFixture from '../fixtures/enduringAgents/legacy-shared-state.json';

import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { loadConversationState } from '@/backend/execution/flow/loadConversationState';
import { persistConversationState } from '@/backend/execution/flow/persistConversationState';
import type { SharedState } from '@/backend/execution/flow/types';
import {
  snapshotBehaviorFlow,
} from '@/backend/services/enduringAgents/behaviorRevisions';
import { getMeeting, saveMeeting } from '@/backend/services/meetings/store';
import { SchedulerService } from '@/backend/services/scheduler';
import { FlowSnapshotSchema } from '@/shared/types/enduringAgent/schemas';
import type { Flow } from '@/shared/types/flow';
import type { MeetingRecord } from '@/shared/types/meeting';
import type { PlannedExecutionsFile } from '@/shared/types/plannedExecution';
import type { StorageKey } from '@/shared/types/storage';
import { validateFlow } from '@/utils/shared/flowValidation';

const mockPersistenceStore = new Map<string, unknown>();

function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function collectionKey(collection: string, id: string): string {
  return `${collection}/${id}`;
}

jest.mock('@/utils/storage/backend', () => {
  const requireSafeId = (id: string) => {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error(`Unsafe collection item id: ${id}`);
  };
  return {
    assertSafeCollectionId: jest.fn(requireSafeId),
    loadItem: jest.fn(async (key: string, defaultValue: unknown) => (
      mockPersistenceStore.has(key)
        ? jsonRoundTrip(mockPersistenceStore.get(key))
        : defaultValue
    )),
    saveItem: jest.fn(async (key: string, value: unknown) => {
      mockPersistenceStore.set(key, jsonRoundTrip(value));
    }),
    clearItem: jest.fn(async (key: string) => {
      mockPersistenceStore.delete(key);
    }),
    loadCollectionItem: jest.fn(async (
      collection: string,
      id: string,
      defaultValue: unknown,
    ) => {
      requireSafeId(id);
      const key = collectionKey(collection, id);
      return mockPersistenceStore.has(key)
        ? jsonRoundTrip(mockPersistenceStore.get(key))
        : defaultValue;
    }),
    saveCollectionItem: jest.fn(async (collection: string, id: string, value: unknown) => {
      requireSafeId(id);
      mockPersistenceStore.set(collectionKey(collection, id), jsonRoundTrip(value));
    }),
    deleteCollectionItem: jest.fn(async (collection: string, id: string) => {
      requireSafeId(id);
      mockPersistenceStore.delete(collectionKey(collection, id));
    }),
    listCollectionItems: jest.fn(async (collection: string) => (
      [...mockPersistenceStore.entries()]
        .filter(([key]) => key.startsWith(`${collection}/`))
        .map(([, value]) => jsonRoundTrip(value))
    )),
    listCollectionItemsWithStats: jest.fn(async (collection: string) => (
      [...mockPersistenceStore.entries()]
        .filter(([key]) => key.startsWith(`${collection}/`))
        .map(([, value]) => ({ item: jsonRoundTrip(value), mtimeMs: 1_700_000_000_000 }))
    )),
    migrateArrayFileToCollection: jest.fn(async () => undefined),
    runInWriteChain: jest.fn(async (_key: string, task: () => Promise<unknown>) => task()),
  };
});

jest.mock('@/backend/execution/flow/FlowExecutor', () => ({
  FlowExecutor: {
    conversationStates: new Map<string, SharedState>(),
  },
}));

jest.mock('@/backend/execution/flow/conversationLog', () => ({
  recoverMessagesFromLog: jest.fn(async () => undefined),
  repairDanglingToolCalls: jest.fn(() => []),
  appendRawForState: jest.fn(async () => undefined),
}));

jest.mock('@/backend/execution/flow/recoveryCheckpoint', () => ({
  markDanglingToolEffectsUnknown: jest.fn(),
  reconcileInterruptedRecovery: jest.fn(async () => undefined),
}));

jest.mock('@/backend/execution/flow/cancellation', () => ({
  isConversationDeleted: jest.fn(() => false),
}));

jest.mock('@/backend/execution/flow/conversationSummaryStore', () => ({
  persistConversationSummary: jest.fn(async () => undefined),
}));

const ATTRIBUTION_KEYS = new Set([
  'personaId',
  'activityId',
  'behaviorRevisionId',
]);

function attributionPaths(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => attributionPaths(entry, `${path}[${index}]`));
  }
  if (value === null || typeof value !== 'object') return [];

  return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => {
    const entryPath = `${path}.${key}`;
    return [
      ...(ATTRIBUTION_KEYS.has(key) ? [entryPath] : []),
      ...attributionPaths(entry, entryPath),
    ];
  });
}

function expectPersonaLess(value: unknown): void {
  expect(attributionPaths(value)).toEqual([]);
}

function flowNodeProperties(flow: Flow, nodeId: string): Record<string, unknown> {
  const node = flow.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error(`Missing fixture node ${nodeId}`);
  return node.data.properties ?? {};
}

describe('pre-Persona persistence compatibility', () => {
  beforeEach(() => {
    mockPersistenceStore.clear();
    FlowExecutor.conversationStates.clear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('keeps every immutable legacy fixture free of Persona attribution', () => {
    for (const fixture of [
      legacyFlowFixture,
      legacySharedStateFixture,
      legacyMeetingFixture,
      legacyPlannedExecutionsFixture,
    ]) {
      expectPersonaLess(fixture);
    }
  });

  it('parses and validates a legacy Flow while preserving its authored tool config exactly', () => {
    const fixture = jsonRoundTrip(legacyFlowFixture) as unknown as Flow;
    const parsed = FlowSnapshotSchema.parse(fixture);
    const validation = validateFlow(parsed, {
      models: [{ id: 'legacy-model', name: 'Legacy model' }],
      servers: [{ name: 'filesystem', status: 'connected' }],
      serverTools: { filesystem: ['read_file', 'list_directory'] },
    });

    expect(validation.isRunnable).toBe(true);
    expect(validation.errorCount).toBe(0);
    expect(parsed).toEqual(fixture);

    const expectedToolConfig = flowNodeProperties(fixture, 'filesystem-tools');
    expect(flowNodeProperties(parsed, 'filesystem-tools')).toEqual(expectedToolConfig);
    expect(flowNodeProperties(snapshotBehaviorFlow(parsed), 'filesystem-tools'))
      .toEqual(expectedToolConfig);

    const roundTripped = FlowSnapshotSchema.parse(jsonRoundTrip(parsed));
    expect(roundTripped).toEqual(fixture);
    expectPersonaLess(roundTripped);
  });

  it('loads and persists a legacy SharedState without adopting it into a Persona', async () => {
    const fixture = jsonRoundTrip(legacySharedStateFixture) as unknown as SharedState;
    const storageKey = 'conversations/legacy-conversation' as StorageKey;
    mockPersistenceStore.set(storageKey, jsonRoundTrip(fixture));

    const loaded = await loadConversationState('legacy-conversation');
    expect(loaded).toEqual(fixture);
    expectPersonaLess(loaded);

    await persistConversationState(storageKey, loaded!);
    expect(mockPersistenceStore.get(storageKey)).toEqual(fixture);

    FlowExecutor.conversationStates.clear();
    const reloaded = await loadConversationState('legacy-conversation');
    expect(reloaded).toEqual(fixture);
    expectPersonaLess(reloaded);
  });

  it('validates and round-trips a legacy MeetingRecord through the meeting store', async () => {
    const fixture = jsonRoundTrip(legacyMeetingFixture) as unknown as MeetingRecord;
    const key = collectionKey('meetings', fixture.id);
    mockPersistenceStore.set(key, jsonRoundTrip(fixture));

    const loaded = await getMeeting(fixture.id);
    expect(loaded).toEqual(fixture);
    expectPersonaLess(loaded);

    jest.spyOn(Date, 'now').mockReturnValue(fixture.updatedAt);
    await saveMeeting(loaded!);
    const reloaded = await getMeeting(fixture.id);

    expect(mockPersistenceStore.get(key)).toEqual(fixture);
    expect(reloaded).toEqual(fixture);
    expectPersonaLess(reloaded);
  });

  it('loads and round-trips a legacy PlannedExecutionsFile through SchedulerService', async () => {
    const fixture = jsonRoundTrip(legacyPlannedExecutionsFixture) as unknown as PlannedExecutionsFile;
    mockPersistenceStore.set('planned_executions', jsonRoundTrip(fixture));
    const scheduler = new SchedulerService();

    expect(await scheduler.isPaused()).toBe(false);
    expect(await scheduler.get('legacy-scheduled-run')).toEqual(fixture.executions[0]);

    // setPaused is the public scheduler write path; writing the existing value
    // gives this disabled fixture a side-effect-free storage round trip.
    await scheduler.setPaused(fixture.paused);

    expect(mockPersistenceStore.get('planned_executions')).toEqual(fixture);
    expect(await scheduler.get('legacy-scheduled-run')).toEqual(fixture.executions[0]);
    expectPersonaLess(mockPersistenceStore.get('planned_executions'));
  });
});
