const mockStorage = new Map<string, unknown>();
let mockLockTail: Promise<void> = Promise.resolve();

jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(async (key: string, fallback: unknown) => (
    mockStorage.has(key) ? structuredClone(mockStorage.get(key)) : fallback
  )),
  saveItem: jest.fn(async (key: string, value: unknown) => {
    mockStorage.set(key, structuredClone(value));
  }),
  clearItem: jest.fn(async (key: string) => { mockStorage.delete(key); }),
}));

jest.mock('@/backend/services/enduringAgents/runtimeLock', () => ({
  withPersonaRuntimeLock: jest.fn(async (
    _id: string,
    task: (lock: { assertOwned(): Promise<void> }) => Promise<unknown>,
  ) => {
    const predecessor = mockLockTail;
    let release!: () => void;
    mockLockTail = new Promise<void>((resolve) => { release = resolve; });
    await predecessor;
    try {
      return await task({ assertOwned: async () => undefined });
    } finally {
      release();
    }
  }),
}));

import {
  advanceLastScheduledFireAt,
  loadExecutionState,
} from '@/backend/services/scheduler/state';

describe('scheduler state durability', () => {
  beforeEach(() => {
    mockStorage.clear();
    mockLockTail = Promise.resolve();
  });

  it('never regresses the schedule cursor when N+1 admission settles before N', async () => {
    const executionId = 'execution_cursor';
    const older = '2026-08-09T12:00:00.000Z';
    const newer = '2026-08-09T12:01:00.000Z';

    await advanceLastScheduledFireAt(executionId, newer);
    await advanceLastScheduledFireAt(executionId, older);

    await expect(loadExecutionState(executionId)).resolves.toMatchObject({
      lastScheduledFireAt: newer,
    });
  });
});
