import type { RunRecord } from '@/shared/types/plannedExecution';
import type { FlowRunEvent } from '@/backend/services/scheduler/flowRunEventBus';
import {
  drainStableTerminalPublications,
  upsertStableRunRecord,
  type StableTerminalPublicationReceipt,
} from '@/backend/services/scheduler/runHistory';

const storage = new Map<string, unknown>();
let failHistoryWrite = false;
let failOutboxAck = false;

jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(async (key: string, defaultValue: unknown) => (
    storage.has(key) ? structuredClone(storage.get(key)) : defaultValue
  )),
  saveItem: jest.fn(async (key: string, value: unknown) => {
    if (failHistoryWrite && key === 'planned-execution-runs/execution_outbox') {
      failHistoryWrite = false;
      throw new Error('crash after receipt before history');
    }
    if (failOutboxAck && key === 'scheduler-terminal-publication-outbox') {
      failOutboxAck = false;
      throw new Error('crash after publish before receipt ack');
    }
    storage.set(key, structuredClone(value));
  }),
  clearItem: jest.fn(async (key: string) => {
    storage.delete(key);
  }),
}));

jest.mock('@/backend/services/enduringAgents/runtimeLock', () => ({
  withPersonaRuntimeLock: async (
    _id: string,
    task: (lock: { assertOwned(): Promise<void> }) => Promise<unknown>,
  ) => task({ assertOwned: async () => undefined }),
}));

const record: RunRecord = {
  runId: 'delivery_run_outbox',
  conversationId: 'conversation_outbox',
  firedAt: '2026-08-09T12:00:00.000Z',
  finishedAt: '2026-08-09T12:00:05.000Z',
  status: 'completed',
  triggerSummary: 'Schedule',
  outputText: 'done',
  personaId: 'persona_outbox',
  activityId: 'activity_outbox',
  behaviorRevisionId: 'revision_outbox',
};

const event: FlowRunEvent = {
  flowId: 'flow_outbox',
  executionId: 'execution_outbox',
  runId: record.runId,
  conversationId: record.conversationId,
  status: 'completed',
  outputText: record.outputText,
  firedBy: 'schedule',
  chainDepth: 0,
  timestamp: record.finishedAt!,
  deliveryId: 'terminal-publication-outbox',
};

const receipt: StableTerminalPublicationReceipt = {
  id: event.deliveryId!,
  executionId: 'execution_outbox',
  runId: record.runId,
  event,
  record,
  createdAt: record.finishedAt!,
};

describe('stable scheduler terminal publication outbox', () => {
  beforeEach(() => {
    storage.clear();
    failHistoryWrite = false;
    failOutboxAck = false;
  });

  it('repairs and publishes a receipt-before-history crash without a source retry', async () => {
    failHistoryWrite = true;
    await expect(upsertStableRunRecord('execution_outbox', record, receipt))
      .rejects.toThrow('crash after receipt before history');

    expect(storage.has('planned-execution-runs/execution_outbox')).toBe(false);
    expect(storage.get('scheduler-terminal-publication-outbox')).toMatchObject({
      pending: { [receipt.id]: receipt },
    });

    const published: FlowRunEvent[] = [];
    await expect(drainStableTerminalPublications((candidate) => {
      published.push(candidate);
    })).resolves.toBe(1);

    expect(storage.get('planned-execution-runs/execution_outbox')).toEqual([record]);
    expect(published).toEqual([event]);
    expect(storage.get('scheduler-terminal-publication-outbox')).toEqual({
      version: 1,
      pending: {},
    });
  });

  it('replays the same stable identity after publish-before-ack crash', async () => {
    await upsertStableRunRecord('execution_outbox', record, receipt);
    const published: FlowRunEvent[] = [];
    failOutboxAck = true;

    await expect(drainStableTerminalPublications((candidate) => {
      published.push(candidate);
    })).rejects.toThrow('crash after publish before receipt ack');
    await expect(drainStableTerminalPublications((candidate) => {
      published.push(candidate);
    })).resolves.toBe(1);

    expect(published).toHaveLength(2);
    expect(published[0].deliveryId).toBe(event.deliveryId);
    expect(published[1]).toEqual(published[0]);
  });
});
