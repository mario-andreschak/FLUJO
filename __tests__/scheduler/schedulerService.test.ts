/**
 * Tests for the SchedulerService (Planned Executions #10).
 *
 * The storage layer is mocked with an in-memory map (below the service, so the
 * envelope/ring-buffer/state logic runs through real code), and runFlow is
 * mocked at the module boundary the service lazy-imports. Croner is real; all
 * schedules used here fire far in the future, so nothing fires by timer during
 * a test — fires are driven via runNow()/reconcile() (catch-up).
 */
import { SchedulerService } from '@/backend/services/scheduler';
import type {
  PlannedExecutionsFile,
  PlannedExecutionState,
  RunRecord,
} from '@/shared/types/plannedExecution';

// --- in-memory storage --------------------------------------------------

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

// --- runFlow mock ---------------------------------------------------------

const runFlowMock = jest.fn();
jest.mock('@/backend/execution/flow/runFlow', () => ({
  runFlow: (...args: unknown[]) => runFlowMock(...args),
}));

const completedResult = {
  status: 'completed',
  outputText: 'All done',
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, costUsd: 0, byNode: {} },
  messages: [],
  conversationId: 'x',
  sharedState: {},
};

// --- helpers ----------------------------------------------------------------

const scheduleInput = (overrides: Record<string, unknown> = {}) => ({
  name: 'Daily digest',
  enabled: true,
  flowId: 'flow-1',
  prompt: 'Summarize the news',
  trigger: { type: 'schedule' as const, cron: '0 9 * * *' },
  ...overrides,
});

const readFile = () => store.get('planned_executions') as PlannedExecutionsFile | undefined;
const readRuns = (id: string) => (store.get(`planned-execution-runs/${id}`) as RunRecord[]) ?? [];
const readState = (id: string) => store.get(`planned-execution-state/${id}`) as PlannedExecutionState | undefined;

describe('SchedulerService', () => {
  let scheduler: SchedulerService;

  beforeEach(() => {
    store.clear();
    runFlowMock.mockReset();
    runFlowMock.mockResolvedValue(completedResult);
    scheduler = new SchedulerService();
  });

  it('creates an execution, persists the envelope, and arms the schedule', async () => {
    const { execution, error } = await scheduler.create(scheduleInput());
    expect(error).toBeUndefined();
    expect(execution?.id).toBeTruthy();

    const file = readFile();
    expect(file?.executions).toHaveLength(1);
    expect(file?.paused).toBe(false);

    const status = scheduler.getStatus(execution!);
    expect(status.armed).toBe(true);
    expect(status.nextRun).toBeTruthy();

    // A fresh schedule primes the catch-up baseline without firing.
    expect(readState(execution!.id)?.lastScheduledFireAt).toBeTruthy();
    expect(runFlowMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid cron pattern', async () => {
    const { error } = await scheduler.create(
      scheduleInput({ trigger: { type: 'schedule', cron: 'not a cron' } })
    );
    expect(error).toMatch(/Invalid schedule/);
    expect(readFile()).toBeUndefined();
  });

  it('does not arm disabled executions or anything while paused', async () => {
    const { execution } = await scheduler.create(scheduleInput({ enabled: false }));
    expect(scheduler.getStatus(execution!).armed).toBe(false);

    await scheduler.update(execution!.id, { enabled: true });
    expect(scheduler.getStatus((await scheduler.get(execution!.id))!).armed).toBe(true);

    await scheduler.setPaused(true);
    expect(scheduler.getStatus((await scheduler.get(execution!.id))!).armed).toBe(false);
  });

  it('runNow runs the flow headlessly (ephemeral, no approvals) and records the outcome', async () => {
    const { execution } = await scheduler.create(scheduleInput());
    const { record } = await scheduler.runNow(execution!.id);

    expect(runFlowMock).toHaveBeenCalledTimes(1);
    const input = runFlowMock.mock.calls[0][0];
    expect(input.flowId).toBe('flow-1');
    expect(input.mode).toBe('ephemeral');
    expect(input.requireApproval).toBe(false);
    expect(input.userTurn).toBe(true);
    // The user prompt leads; run info (timing metadata) is appended after it.
    expect(input.prompt).toMatch(/^Summarize the news\n\n\[Run info/);

    expect(record?.status).toBe('completed');
    expect(record?.outputText).toBe('All done');
    expect(record?.usage?.totalTokens).toBe(15);

    const runs = readRuns(execution!.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('completed');
  });

  it('uses conversation mode when saveConversations is on', async () => {
    const { execution } = await scheduler.create(scheduleInput({ saveConversations: true }));
    await scheduler.runNow(execution!.id);
    expect(runFlowMock.mock.calls[0][0].mode).toBe('conversation');
  });

  it('appends run info (timing + trigger data) to the prompt as a fenced block', async () => {
    const { execution } = await scheduler.create(scheduleInput());
    await scheduler.fire(execution!, {
      kind: 'webhook',
      summary: 'Webhook',
      context: { hello: 'world' },
    });
    const prompt = runFlowMock.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('Summarize the news');
    expect(prompt).toContain('Run info');
    // Trigger data nested under "data", labeled untrusted.
    expect(prompt).toContain('"hello": "world"');
    expect(prompt).toContain('"data"');
    // Timing metadata: current time, trigger kind, no previous run yet, and
    // the armed schedule's next occurrence.
    expect(prompt).toContain('"now"');
    expect(prompt).toContain('"trigger": "webhook"');
    expect(prompt).toContain('"lastRun": null');
    expect(prompt).toMatch(/"nextPlannedRun": "\d{4}-/);
  });

  it('reports the previous run in the next run info', async () => {
    const { execution } = await scheduler.create(scheduleInput());
    const first = await scheduler.runNow(execution!.id);
    await scheduler.runNow(execution!.id);

    const secondPrompt = runFlowMock.mock.calls[1][0].prompt as string;
    expect(secondPrompt).toContain(`"at": "${first.record!.firedAt}"`);
    expect(secondPrompt).toContain('"status": "completed"');
  });

  it('records an error run when the flow ends non-completed or throws', async () => {
    const { execution } = await scheduler.create(scheduleInput());

    runFlowMock.mockResolvedValueOnce({ ...completedResult, status: 'error', error: { message: 'boom' } });
    const first = await scheduler.runNow(execution!.id);
    expect(first.record?.status).toBe('error');
    expect(first.record?.error).toBe('boom');

    runFlowMock.mockRejectedValueOnce(new Error('crashed'));
    const second = await scheduler.runNow(execution!.id);
    expect(second.record?.status).toBe('error');
    expect(second.record?.error).toBe('crashed');

    expect(readRuns(execution!.id)).toHaveLength(2);
  });

  it('skips an overlapping fire and records it', async () => {
    const { execution } = await scheduler.create(scheduleInput());

    let release!: () => void;
    runFlowMock.mockImplementationOnce(
      () => new Promise(resolve => { release = () => resolve(completedResult); })
    );

    const firstRun = scheduler.fire(execution!, { kind: 'schedule', summary: 'Schedule' });
    // Give the first fire a tick to take the running lock.
    await new Promise(r => setTimeout(r, 10));
    const skipped = await scheduler.fire(execution!, { kind: 'schedule', summary: 'Schedule' });

    expect(skipped.status).toBe('skipped');
    expect(runFlowMock).toHaveBeenCalledTimes(1);

    release();
    const first = await firstRun;
    expect(first.status).toBe('completed');
    const statuses = readRuns(execution!.id).map(r => r.status).sort();
    expect(statuses).toEqual(['completed', 'skipped']);
  });

  it('catch-up: fires once at arm time when a run was missed and catchUp is on', async () => {
    const { execution } = await scheduler.create(
      scheduleInput({ trigger: { type: 'schedule', cron: '0 9 * * *', catchUp: true } })
    );
    // Simulate "FLUJO was closed for two days": backdate the last fire stamp.
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    store.set(`planned-execution-state/${execution!.id}`, { lastScheduledFireAt: twoDaysAgo });

    await scheduler.reconcile();
    // The catch-up fire is deliberately not awaited by reconcile; let it land.
    await new Promise(r => setTimeout(r, 20));

    expect(runFlowMock).toHaveBeenCalledTimes(1);
    const runs = readRuns(execution!.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].triggerSummary).toMatch(/missed while FLUJO was closed/);

    // The stamp advanced, so a second reconcile must NOT fire again.
    await scheduler.reconcile();
    await new Promise(r => setTimeout(r, 20));
    expect(runFlowMock).toHaveBeenCalledTimes(1);
  });

  it('catch-up off: a missed run is skipped silently', async () => {
    const { execution } = await scheduler.create(scheduleInput());
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    store.set(`planned-execution-state/${execution!.id}`, { lastScheduledFireAt: twoDaysAgo });

    await scheduler.reconcile();
    await new Promise(r => setTimeout(r, 20));
    expect(runFlowMock).not.toHaveBeenCalled();
  });

  it('delete removes the execution, its run history and trigger state', async () => {
    const { execution } = await scheduler.create(scheduleInput());
    await scheduler.runNow(execution!.id);
    expect(readRuns(execution!.id)).toHaveLength(1);

    const result = await scheduler.delete(execution!.id);
    expect(result.success).toBe(true);
    expect(readFile()?.executions).toHaveLength(0);
    expect(store.has(`planned-execution-runs/${execution!.id}`)).toBe(false);
    expect(store.has(`planned-execution-state/${execution!.id}`)).toBe(false);
    expect(scheduler.getStatus(execution!).armed).toBe(false);
  });

  it('update rejects unknown ids and invalid patches', async () => {
    const missing = await scheduler.update('nope', { name: 'x' });
    expect(missing.error).toMatch(/No planned execution/);

    const { execution } = await scheduler.create(scheduleInput());
    const invalid = await scheduler.update(execution!.id, {
      trigger: { type: 'schedule', cron: '?????garbage' },
    });
    expect(invalid.error).toMatch(/Invalid schedule/);
    // The stored config is unchanged.
    expect((await scheduler.get(execution!.id))?.trigger).toEqual({
      type: 'schedule',
      cron: '0 9 * * *',
    });
  });

  it('accepts a client-supplied UUID id and rejects duplicates and non-UUIDs', async () => {
    const id = 'a388f4f8-132c-44d8-a412-ed082456b029';
    const { execution } = await scheduler.create(scheduleInput({ id }));
    expect(execution?.id).toBe(id);

    const dup = await scheduler.create(scheduleInput({ id }));
    expect(dup.error).toMatch(/already exists/);

    const bad = await scheduler.create(scheduleInput({ id: '../evil' }));
    expect(bad.error).toMatch(/must be a UUID/);
  });

  it('generates a webhook token server-side when absent', async () => {
    const { execution } = await scheduler.create(
      scheduleInput({ trigger: { type: 'webhook', token: '' } })
    );
    const trigger = execution!.trigger;
    expect(trigger.type).toBe('webhook');
    if (trigger.type === 'webhook') {
      expect(trigger.token.length).toBeGreaterThan(10);
    }
  });

  it('run history is a ring buffer capped at 100 records', async () => {
    const { execution } = await scheduler.create(scheduleInput());
    const { appendRunRecord } = await import('@/backend/services/scheduler/runHistory');
    for (let i = 0; i < 105; i++) {
      await appendRunRecord(execution!.id, {
        runId: `run-${i}`,
        conversationId: '',
        firedAt: new Date().toISOString(),
        status: 'completed',
        triggerSummary: 'Test',
      });
    }
    const runs = readRuns(execution!.id);
    expect(runs).toHaveLength(100);
    expect(runs[0].runId).toBe('run-5');
    expect(runs[99].runId).toBe('run-104');
  });

  it('concurrent history appends do not lose records', async () => {
    const { appendRunRecord } = await import('@/backend/services/scheduler/runHistory');
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        appendRunRecord('exec-x', {
          runId: `run-${i}`,
          conversationId: '',
          firedAt: new Date().toISOString(),
          status: 'completed',
          triggerSummary: 'Test',
        })
      )
    );
    expect(readRuns('exec-x')).toHaveLength(10);
  });
});
