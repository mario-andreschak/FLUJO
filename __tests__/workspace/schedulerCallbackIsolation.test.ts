import { getCurrentWorkspace, runWithWorkspace } from '@/utils/workspace';

const mockStores = new Map<string, Map<string, unknown>>();
const mockStorageAccesses: Array<{ workspace: string; key: string }> = [];
let mockScheduleCallback: ((occurrence: Date) => void | Promise<void>) | undefined;
const mockScheduleDispose = jest.fn();
const mockRunFlow = jest.fn();

function mockWorkspaceStore(): Map<string, unknown> {
  const workspace = getCurrentWorkspace();
  let store = mockStores.get(workspace);
  if (!store) {
    store = new Map();
    mockStores.set(workspace, store);
  }
  return store;
}

jest.mock('@/utils/storage/backend', () => {
  const actual = jest.requireActual('@/utils/storage/backend');
  return {
    ...actual,
    loadItem: jest.fn(async (key: string, defaultValue: unknown) => {
      mockStorageAccesses.push({ workspace: getCurrentWorkspace(), key });
      const store = mockWorkspaceStore();
      return store.has(key) ? store.get(key) : defaultValue;
    }),
    saveItem: jest.fn(async (key: string, value: unknown) => {
      mockStorageAccesses.push({ workspace: getCurrentWorkspace(), key });
      mockWorkspaceStore().set(key, value);
    }),
    clearItem: jest.fn(async (key: string) => {
      mockStorageAccesses.push({ workspace: getCurrentWorkspace(), key });
      mockWorkspaceStore().delete(key);
    }),
  };
});

jest.mock('@/utils/encryption/secure', () => ({
  isEncryptionLocked: jest.fn(async () => false),
}));

// Runtime-lock behavior is covered separately. Keeping it in this focused
// callback test would create a real workspace tree for a synthetic fixture
// name even though every scheduler storage operation below is mocked.
jest.mock('@/backend/services/enduringAgents/runtimeLock', () => ({
  withPersonaRuntimeLock: jest.fn(async (
    _personaId: string,
    task: (lock: { assertOwned: () => Promise<void> }) => Promise<unknown>,
  ) => task({ assertOwned: jest.fn(async () => undefined) })),
}));

jest.mock('@/backend/services/scheduler/triggers/schedule', () => ({
  validateSchedule: jest.fn(() => ({ valid: true })),
  isCatchUpDue: jest.fn(() => false),
  armSchedule: jest.fn((
    _config: unknown,
    onFire: (occurrence: Date) => void | Promise<void>,
  ) => {
    mockScheduleCallback = onFire;
    return { dispose: mockScheduleDispose, nextRun: () => null };
  }),
}));

jest.mock('@/backend/execution/flow/runFlow', () => ({
  runFlow: (...args: unknown[]) => mockRunFlow(...args),
}));

import { SchedulerService } from '@/backend/services/scheduler';

describe('scheduler callback workspace isolation', () => {
  let scheduler: SchedulerService | undefined;
  let schedulerWorkspace: string | undefined;

  const disposeScheduler = async () => {
    if (!scheduler || !schedulerWorkspace) return;
    const current = scheduler;
    const workspace = schedulerWorkspace;
    scheduler = undefined;
    schedulerWorkspace = undefined;
    await runWithWorkspace(workspace, () => current.setPaused(true));
  };

  beforeEach(() => {
    mockStores.clear();
    mockStorageAccesses.length = 0;
    mockScheduleCallback = undefined;
    mockScheduleDispose.mockReset();
    mockRunFlow.mockReset();
  });

  afterEach(disposeScheduler);

  it('re-enters the scheduler workspace before a timer reads or writes trigger state', async () => {
    const ownerWorkspace = 'scheduler-owner';
    const wrongAmbientWorkspace = 'scheduler-wrong-ambient';
    const currentScheduler = runWithWorkspace(ownerWorkspace, () => new SchedulerService());
    scheduler = currentScheduler;
    schedulerWorkspace = ownerWorkspace;

    await runWithWorkspace(ownerWorkspace, () => currentScheduler.create({
      name: 'Workspace-bound schedule',
      enabled: true,
      flowId: 'flow-1',
      prompt: 'Run it',
      trigger: { type: 'schedule', cron: '0 9 * * *' },
    }));
    expect(mockScheduleCallback).toBeDefined();

    mockStorageAccesses.length = 0;
    mockRunFlow.mockResolvedValueOnce({
      status: 'completed',
      outputText: 'done',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0, byNode: {} },
      messages: [],
      conversationId: 'child',
      sharedState: {},
    });

    await runWithWorkspace(
      wrongAmbientWorkspace,
      () => mockScheduleCallback!(new Date('2026-08-14T09:00:00.000Z')),
    );

    const triggerStateAccesses = mockStorageAccesses.filter(({ key }) =>
      key.startsWith('planned-execution-state/'),
    );
    expect(triggerStateAccesses.length).toBeGreaterThanOrEqual(2);
    expect(new Set(triggerStateAccesses.map(({ workspace }) => workspace)))
      .toEqual(new Set([ownerWorkspace]));
    const completedHistories = [...(mockStores.get(ownerWorkspace)?.entries() ?? [])]
      .filter(([key]) => key.startsWith('planned-execution-runs/'))
      .map(([, value]) => value);
    expect(completedHistories).toEqual([
      [expect.objectContaining({ status: 'completed' })],
    ]);

    await disposeScheduler();
    expect(mockScheduleDispose).toHaveBeenCalledTimes(1);
  });
});
