import type {
  PlannedExecution,
  PlannedExecutionStatus,
  RunRecord,
} from '@/shared/types/plannedExecution';
import {
  matchesPlannedExecutionSearch,
  matchesPlannedExecutionStatus,
  plannedExecutionStateGroup,
  plannedExecutionTriggerGroup,
  sortPlannedExecutions,
  type PlannedExecutionGroupingItem,
} from '@/utils/shared/plannedExecutionGrouping';

const status = (patch: Partial<PlannedExecutionStatus> = {}): PlannedExecutionStatus => ({
  armed: true,
  running: false,
  ...patch,
});

const execution = (
  id: string,
  patch: Partial<PlannedExecution> = {},
): PlannedExecution => ({
  id,
  name: id,
  enabled: true,
  flowId: `flow-${id}`,
  prompt: '',
  trigger: { type: 'schedule', cron: '0 * * * *' },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...patch,
});

const run = (firedAt: string, statusValue: RunRecord['status'] = 'completed'): RunRecord => ({
  runId: firedAt,
  conversationId: firedAt,
  firedAt,
  status: statusValue,
  triggerSummary: 'Schedule',
});

const item = (
  id: string,
  patch: Partial<PlannedExecutionGroupingItem> = {},
): PlannedExecutionGroupingItem => ({
  execution: execution(id),
  status: status(),
  lastRun: null,
  ...patch,
});

describe('planned execution browser grouping', () => {
  it('sorts by name, creation time, and most recent run without mutating input', () => {
    const rows = [
      item('beta', {
        execution: execution('beta', { createdAt: '2026-03-01T00:00:00.000Z' }),
        lastRun: run('2026-03-03T00:00:00.000Z'),
      }),
      item('Alpha', {
        execution: execution('Alpha', { createdAt: '2026-02-01T00:00:00.000Z' }),
        lastRun: run('2026-03-04T00:00:00.000Z'),
      }),
      item('never', {
        execution: execution('never', { createdAt: '2026-04-01T00:00:00.000Z' }),
      }),
    ];

    expect(sortPlannedExecutions(rows, 'name-asc').map(row => row.execution.id))
      .toEqual(['Alpha', 'beta', 'never']);
    expect(sortPlannedExecutions(rows, 'newest').map(row => row.execution.id))
      .toEqual(['never', 'beta', 'Alpha']);
    expect(sortPlannedExecutions(rows, 'last-run').map(row => row.execution.id))
      .toEqual(['Alpha', 'beta', 'never']);
    expect(rows.map(row => row.execution.id)).toEqual(['beta', 'Alpha', 'never']);
  });

  it('searches names, folders, prompts, flow ids, and trigger labels', () => {
    const webhook = item('daily', {
      execution: execution('daily', {
        name: 'Daily digest',
        folder: 'Operations',
        prompt: 'Summarize incidents',
        flowId: 'digest-flow',
        trigger: { type: 'webhook', token: 'secret-token' },
      }),
    });

    expect(matchesPlannedExecutionSearch(webhook, 'digest')).toBe(true);
    expect(matchesPlannedExecutionSearch(webhook, 'operations')).toBe(true);
    expect(matchesPlannedExecutionSearch(webhook, 'incidents')).toBe(true);
    expect(matchesPlannedExecutionSearch(webhook, 'webhook')).toBe(true);
    expect(matchesPlannedExecutionSearch(webhook, 'secret-token')).toBe(false);
  });

  it('filters and groups operational states with errors taking precedence over active', () => {
    const active = item('active');
    const off = item('off', { execution: execution('off', { enabled: false }) });
    const running = item('running', { status: status({ running: true }) });
    const failed = item('failed', { lastRun: run('2026-03-01T00:00:00.000Z', 'error') });

    expect(matchesPlannedExecutionStatus(active, 'enabled')).toBe(true);
    expect(matchesPlannedExecutionStatus(off, 'disabled')).toBe(true);
    expect(matchesPlannedExecutionStatus(running, 'running')).toBe(true);
    expect(matchesPlannedExecutionStatus(failed, 'attention')).toBe(true);
    expect(plannedExecutionStateGroup(failed).label).toBe('Needs attention');
    expect(plannedExecutionStateGroup(running).label).toBe('Running');
  });

  it('derives stable trigger groups', () => {
    const webhook = item('hook', {
      execution: execution('hook', {
        trigger: { type: 'webhook', token: 'token' },
      }),
    });
    expect(plannedExecutionTriggerGroup(webhook)).toEqual({
      key: 'trigger:webhook',
      label: 'Webhook',
    });
  });
});
