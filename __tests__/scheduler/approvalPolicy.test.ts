/**
 * Tests for the headless approval policy (issue #115) at the scheduler layer.
 *
 * A scheduled run has no interactive approver. `approvalPolicy` decides what a
 * run does when it reaches a tool that needs approval:
 *   - 'auto'  (default) — runFlow is called with requireApproval:false, tools
 *                         run without a gate (legacy behavior).
 *   - 'fail'  — runFlow is called with requireApproval:true + onApprovalRequired
 *               'fail'; a runFlow error tagged approval_required becomes a
 *               `needs_approval` RunRecord and NOTHING is written to the inbox.
 *   - 'pause' — runFlow runs in conversation mode with onApprovalRequired
 *               'pause'; an awaiting_tool_approval result becomes a
 *               `needs_approval` RunRecord AND a durable approval-inbox entry.
 *
 * Storage is mocked in-memory (below the service); runFlow is mocked at the
 * boundary the service lazy-imports; encryption is unlocked.
 */
import { SchedulerService } from '@/backend/services/scheduler';
import type { RunRecord } from '@/shared/types/plannedExecution';
import type { PendingApprovalEntry } from '@/backend/services/scheduler/pendingApprovals';

const store = new Map<string, unknown>();

jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(async (key: string, defaultValue: unknown) =>
    store.has(key) ? JSON.parse(JSON.stringify(store.get(key))) : defaultValue
  ),
  saveItem: jest.fn(async (key: string, value: unknown) => {
    store.set(key, JSON.parse(JSON.stringify(value)));
  }),
  clearItem: jest.fn(async (key: string) => {
    store.delete(key);
  }),
}));

const runFlowMock = jest.fn();
jest.mock('@/backend/execution/flow/runFlow', () => ({
  runFlow: (...args: unknown[]) => runFlowMock(...args),
}));

jest.mock('@/utils/encryption/secure', () => ({
  isEncryptionLocked: jest.fn(async () => false),
}));

const completedResult = {
  status: 'completed',
  outputText: 'All done',
  usage: undefined,
  messages: [],
  conversationId: 'x',
  sharedState: {},
};

const pausedResult = {
  status: 'awaiting_tool_approval',
  outputText: '',
  messages: [],
  conversationId: 'x',
  sharedState: {},
  pendingToolCalls: [
    { id: 'call_1', type: 'function', function: { name: 'send_email', arguments: '{}' } },
  ],
};

const failFastResult = {
  status: 'error',
  outputText: '',
  messages: [],
  conversationId: 'x',
  sharedState: {},
  error: {
    message: 'Headless run requires approval for tool "send_email"',
    details: { type: 'approval_required', name: 'send_email' },
    statusCode: 500,
  },
};

const input = (overrides: Record<string, unknown> = {}) => ({
  name: 'Nightly ops',
  enabled: true,
  flowId: 'flow-1',
  prompt: 'do the thing',
  trigger: { type: 'schedule' as const, cron: '0 9 * * *' },
  ...overrides,
});

const readRuns = (id: string) => (store.get(`planned-execution-runs/${id}`) as RunRecord[]) ?? [];
const readInbox = () => (store.get('pending_approvals') as Record<string, PendingApprovalEntry>) ?? {};

describe('headless approval policy (#115) — scheduler', () => {
  let scheduler: SchedulerService;

  beforeEach(() => {
    store.clear();
    runFlowMock.mockReset();
    scheduler = new SchedulerService();
  });

  it("policy 'auto' (default) runs tools without a gate (legacy behavior)", async () => {
    runFlowMock.mockResolvedValue(completedResult);
    const { execution } = await scheduler.create(input());

    const record = await scheduler.fire(execution!, { kind: 'schedule', summary: 'Schedule' });

    expect(record.status).toBe('completed');
    expect(runFlowMock).toHaveBeenCalledTimes(1);
    const args = runFlowMock.mock.calls[0][0];
    expect(args.requireApproval).toBe(false);
    expect(args.onApprovalRequired).toBe('auto');
    // Nothing written to the approval inbox.
    expect(Object.keys(readInbox())).toHaveLength(0);
  });

  it("policy 'fail' fails fast: needs_approval record, no inbox entry", async () => {
    runFlowMock.mockResolvedValue(failFastResult);
    const { execution } = await scheduler.create(input({ approvalPolicy: 'fail' }));

    const record = await scheduler.fire(execution!, { kind: 'schedule', summary: 'Schedule' });

    // Sent tools to the gate but told runFlow to fail fast.
    const args = runFlowMock.mock.calls[0][0];
    expect(args.requireApproval).toBe(true);
    expect(args.onApprovalRequired).toBe('fail');

    expect(record.status).toBe('needs_approval');
    expect(record.pendingApproval?.tool).toBe('send_email');
    // A fail-fast run is terminal and not resumable → no inbox entry.
    expect(Object.keys(readInbox())).toHaveLength(0);

    const runs = readRuns(execution!.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('needs_approval');
  });

  it("policy 'pause' parks the run: needs_approval record + durable inbox entry", async () => {
    runFlowMock.mockResolvedValue(pausedResult);
    const { execution } = await scheduler.create(input({ approvalPolicy: 'pause' }));

    const record = await scheduler.fire(execution!, { kind: 'schedule', summary: 'Schedule' });

    const args = runFlowMock.mock.calls[0][0];
    expect(args.requireApproval).toBe(true);
    expect(args.onApprovalRequired).toBe('pause');
    // A pause must persist so it can be resumed later.
    expect(args.mode).toBe('conversation');

    expect(record.status).toBe('needs_approval');
    expect(record.pendingApproval?.pendingToolCalls).toEqual([{ id: 'call_1', name: 'send_email' }]);

    // Durable inbox entry keyed by the run's conversationId.
    const inbox = readInbox();
    const entry = inbox[record.conversationId];
    expect(entry).toBeDefined();
    expect(entry.plannedExecutionId).toBe(execution!.id);
    expect(entry.runId).toBe(record.runId);
    expect(entry.pendingToolCalls).toEqual([{ id: 'call_1', name: 'send_email' }]);
  });

  it('a needs_approval outcome is never treated as completed (baseline discipline)', async () => {
    // fire() returns the record to poll/url-watch onFire, which only advances a
    // change baseline on 'completed'. needs_approval must therefore not equal
    // 'completed' so paused/failed work stays re-observable.
    runFlowMock.mockResolvedValue(pausedResult);
    const { execution } = await scheduler.create(input({ approvalPolicy: 'pause' }));
    const record = await scheduler.fire(execution!, { kind: 'schedule', summary: 'Schedule' });
    expect(record.status).not.toBe('completed');
  });
});
