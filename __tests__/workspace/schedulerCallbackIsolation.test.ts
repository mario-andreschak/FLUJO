import { getCurrentWorkspace, runWithWorkspace } from '@/utils/workspace';

const mockStores = new Map<string, Map<string, unknown>>();
const mockStorageAccesses: Array<{ workspace: string; key: string }> = [];
let mockScheduleCallback: (() => void) | undefined;
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

jest.mock('@/utils/storage/backend', () => ({
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
}));

jest.mock('@/utils/encryption/secure', () => ({
  isEncryptionLocked: jest.fn(async () => false),
}));

jest.mock('@/backend/services/scheduler/triggers/schedule', () => ({
  validateSchedule: jest.fn(() => ({ valid: true })),
  isCatchUpDue: jest.fn(() => false),
  armSchedule: jest.fn((_config: unknown, onFire: () => void) => {
    mockScheduleCallback = onFire;
    return { dispose: jest.fn(), nextRun: () => null };
  }),
}));

jest.mock('@/backend/execution/flow/runFlow', () => ({
  runFlow: (...args: unknown[]) => mockRunFlow(...args),
}));

import { SchedulerService } from '@/backend/services/scheduler';

describe('scheduler callback workspace isolation', () => {
  beforeEach(() => {
    mockStores.clear();
    mockStorageAccesses.length = 0;
    mockScheduleCallback = undefined;
    mockRunFlow.mockReset();
  });

  it('re-enters the scheduler workspace before a timer reads or writes trigger state', async () => {
    const ownerWorkspace = 'scheduler-owner';
    const wrongAmbientWorkspace = 'scheduler-wrong-ambient';
    const scheduler = runWithWorkspace(ownerWorkspace, () => new SchedulerService());

    await runWithWorkspace(ownerWorkspace, () => scheduler.create({
      name: 'Workspace-bound schedule',
      enabled: true,
      flowId: 'flow-1',
      prompt: 'Run it',
      trigger: { type: 'schedule', cron: '0 9 * * *' },
    }));
    expect(mockScheduleCallback).toBeDefined();

    mockStorageAccesses.length = 0;
    let observeRun!: () => void;
    const runObserved = new Promise<void>(resolve => { observeRun = resolve; });
    mockRunFlow.mockImplementationOnce(async () => {
      observeRun();
      return {
        status: 'completed',
        outputText: 'done',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0, byNode: {} },
        messages: [],
        conversationId: 'child',
        sharedState: {},
      };
    });

    runWithWorkspace(wrongAmbientWorkspace, () => mockScheduleCallback!());
    await runObserved;

    const triggerStateAccesses = mockStorageAccesses.filter(({ key }) =>
      key.startsWith('planned-execution-state/'),
    );
    expect(triggerStateAccesses.length).toBeGreaterThanOrEqual(2);
    expect(new Set(triggerStateAccesses.map(({ workspace }) => workspace)))
      .toEqual(new Set([ownerWorkspace]));
  });
});
