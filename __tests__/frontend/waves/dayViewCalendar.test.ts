import type { TriggerConfig } from '@/shared/types/plannedExecution';
import type {
  AutomationMapExecution,
  AutomationMapRelation,
  AutomationMapResponse,
} from '@/shared/types/waves/automationMap';
import {
  addCalendarDays,
  buildDaySchedule,
  buildMonthGrid,
  calendarDayBounds,
  calendarDayKey,
  describeCadence,
  downstreamNamesFor,
  enumerateCronForDay,
  layoutDayItems,
  normalizeCalendarDay,
} from '@/frontend/components/Waves/dayViewCalendar';

const DAY = new Date(2026, 7, 14, 12, 0, 0, 0);

function execution(
  id: string,
  trigger: TriggerConfig,
  overrides: Partial<AutomationMapExecution> = {},
): AutomationMapExecution {
  return {
    executionId: id,
    name: `Plan ${id}`,
    enabled: true,
    flowId: `flow-${id}`,
    packageNames: [],
    trigger,
    triggerKind: trigger.type,
    timezone: 'timezone' in trigger ? trigger.timezone : undefined,
    schedule: 'cron' in trigger
      ? { cron: trigger.cron, timezone: trigger.timezone, nextRun: null }
      : undefined,
    status: { armed: true, running: false },
    lastRun: null,
    isRoot: trigger.type !== 'flow-event',
    waveIds: trigger.type !== 'flow-event' ? [id] : [],
    ...overrides,
  };
}

function automationMap(
  executions: AutomationMapExecution[],
  overrides: Partial<AutomationMapResponse> = {},
): AutomationMapResponse {
  const flowNames = (overrides.flows ?? []).reduce<Record<string, string>>((acc, entry) => {
    acc[entry.flow.id] = entry.flow.name;
    return acc;
  }, {});
  const flows = [...new Set(executions.map((item) => item.flowId))].map((flowId) => ({
    flow: { id: flowId, name: flowNames[flowId] ?? flowId, nodes: [], edges: [] },
    packageNames: [],
    executionIds: executions.filter((item) => item.flowId === flowId).map((item) => item.executionId),
    waveIds: [],
    componentIds: [],
  }));
  return {
    paused: false,
    generatedAt: '2026-08-14T00:00:00.000Z',
    packages: [],
    executions,
    relations: [],
    waves: [],
    components: [],
    orphanExecutionIds: [],
    ...overrides,
    // Preserve explicitly named flows while filling in any missing ones.
    flows,
  };
}

function relation(
  id: string,
  producerExecutionId: string,
  consumerExecutionId: string,
  kind: 'signal' | 'completion' = 'signal',
): AutomationMapRelation {
  const producerFlowId = `flow-${producerExecutionId}`;
  const consumerFlowId = `flow-${consumerExecutionId}`;
  const base = {
    id,
    source: { kind: 'flow-boundary' as const, flowId: producerFlowId, boundary: 'completion' as const },
    target: { kind: 'execution' as const, executionId: consumerExecutionId },
    waveIds: ['root'],
    componentIds: ['component'],
    producerExecutionId,
    consumerExecutionId,
    producerFlowId,
    consumerFlowId,
  };
  return kind === 'signal'
    ? {
        ...base,
        kind: 'signal',
        topic: 'ready',
        direct: true,
        subflowPath: [],
      }
    : { ...base, kind: 'completion', on: ['completed'] };
}

describe('day calendar date helpers', () => {
  test('normalizes and navigates by local calendar date', () => {
    const normalized = normalizeCalendarDay(new Date(2026, 7, 14, 23, 59));
    expect(normalized.getHours()).toBe(12);
    expect(calendarDayKey(normalized)).toBe('2026-08-14');
    expect(calendarDayKey(addCalendarDays(normalized, 1))).toBe('2026-08-15');

    const bounds = calendarDayBounds(normalized);
    expect(new Date(bounds.startAt).getHours()).toBe(0);
    expect(calendarDayKey(bounds.startAt)).toBe('2026-08-14');
    expect(calendarDayKey(bounds.endAt)).toBe('2026-08-15');
  });

  test('mini month is six complete weeks and marks adjacent-month days', () => {
    const grid = buildMonthGrid(DAY);
    expect(grid).toHaveLength(42);
    expect(grid.some((cell) => !cell.inMonth)).toBe(true);
    expect(grid.filter((cell) => cell.inMonth).map((cell) => cell.date.getDate()))
      .toEqual(Array.from({ length: 31 }, (_, index) => index + 1));
  });
});

describe('cron occurrence projection', () => {
  test('returns sparse points for an hourly rhythm', () => {
    const { startAt, endAt } = calendarDayBounds(DAY);
    const result = enumerateCronForDay('0 * * * *', undefined, startAt, endAt, 30);
    expect(result.dense).toBe(false);
    // A DST transition may produce 23 or 25 local hours; an ordinary day has 24.
    expect(result.occurrences.length).toBeGreaterThanOrEqual(23);
    expect(result.occurrences.length).toBeLessThanOrEqual(25);
    expect(result.cadenceMs).toBe(60 * 60 * 1000);
  });

  test('establishes density without enumerating a full high-frequency day', () => {
    const { startAt, endAt } = calendarDayBounds(DAY);
    const result = enumerateCronForDay('*/5 * * * *', undefined, startAt, endAt, 24);
    expect(result.dense).toBe(true);
    expect(result.occurrences).toHaveLength(25);
    expect(result.cadenceMs).toBe(5 * 60 * 1000);
    expect(describeCadence(result.cadenceMs)).toBe('Every 5 minutes');
  });

  test('invalid schedules remain empty instead of breaking the calendar', () => {
    const { startAt, endAt } = calendarDayBounds(DAY);
    expect(enumerateCronForDay('not cron', undefined, startAt, endAt)).toEqual({
      occurrences: [],
      dense: false,
    });
  });
});

describe('buildDaySchedule', () => {
  test('labels guaranteed schedules as runs and polls/watchers as checks', () => {
    const schedule = buildDaySchedule({
      day: DAY,
      data: automationMap([
        execution('run', { type: 'schedule', cron: '0 12 * * *', timezone: 'UTC' }),
        execution('url', { type: 'url-watch', url: 'https://example.com', cron: '30 12 * * *', timezone: 'UTC' }),
        execution('poll', {
          type: 'mcp-poll',
          serverName: 'mail',
          toolName: 'unread',
          args: {},
          cron: '45 12 * * *',
          timezone: 'UTC',
          evaluate: { mode: 'on-change' },
        }),
      ]),
    });

    expect(schedule.timed).toHaveLength(3);
    expect(schedule.timed.find((item) => item.executionId === 'run')?.activity).toBe('run');
    expect(schedule.timed.find((item) => item.executionId === 'url')?.activity).toBe('check');
    expect(schedule.timed.find((item) => item.executionId === 'poll')?.activity).toBe('check');
  });

  test('collapses a dense recurrence into one truthful aggregate', () => {
    const schedule = buildDaySchedule({
      day: DAY,
      denseThreshold: 12,
      data: automationMap([execution('busy', { type: 'schedule', cron: '*/2 * * * *' })]),
    });
    expect(schedule.timed).toHaveLength(0);
    expect(schedule.scheduledRhythms).toHaveLength(1);
    expect(schedule.scheduledRhythms[0]).toMatchObject({
      executionId: 'busy',
      kind: 'aggregate',
      activity: 'run',
      countAtLeast: 13,
      cadenceLabel: 'Every 2 minutes',
    });
  });

  test('uses the Automation Map normalized schedule for a legacy poll', () => {
    const legacyPoll = execution('legacy-poll', {
      type: 'mcp-poll',
      serverName: 'mail',
      toolName: 'unread',
      args: {},
      evaluate: { mode: 'on-change' },
    }, {
      schedule: { cron: '0 12 * * *', timezone: 'UTC', nextRun: null },
    });
    const schedule = buildDaySchedule({ day: DAY, data: automationMap([legacyPoll]) });
    expect(schedule.timed).toHaveLength(1);
    expect(schedule.timed[0]).toMatchObject({ executionId: 'legacy-poll', activity: 'check' });
  });

  test('keeps organic listeners in the all-day row and folds linked flow events into downstream summaries', () => {
    const executions = [
      execution('root', { type: 'schedule', cron: '0 12 * * *', timezone: 'UTC' }, { waveIds: ['root'] }),
      execution('review', { type: 'flow-event', source: { topic: 'ready' } }, { waveIds: ['root'] }),
      execution('publish', { type: 'flow-event', source: { executionId: 'review' }, on: ['completed'] }, { waveIds: ['root'] }),
      execution('hook', { type: 'webhook', token: 'secret' }),
      execution('orphan', { type: 'flow-event', source: { topic: 'unknown' } }),
    ];
    const relations = [
      relation('root-review', 'root', 'review'),
      relation('review-publish', 'review', 'publish', 'completion'),
      relation('publish-review', 'publish', 'review'),
    ];
    const data = automationMap(executions, {
      relations,
      orphanExecutionIds: ['orphan'],
      flows: [
        { flow: { id: 'flow-root', name: 'Intake', nodes: [], edges: [] }, packageNames: [], executionIds: ['root'], waveIds: ['root'], componentIds: [] },
        { flow: { id: 'flow-review', name: 'Review', nodes: [], edges: [] }, packageNames: [], executionIds: ['review'], waveIds: ['root'], componentIds: [] },
        { flow: { id: 'flow-publish', name: 'Publish', nodes: [], edges: [] }, packageNames: [], executionIds: ['publish'], waveIds: ['root'], componentIds: [] },
      ],
    });
    const schedule = buildDaySchedule({
      day: DAY,
      data,
    });

    expect(schedule.alwaysListening.map((item) => item.executionId)).toEqual(['hook']);
    expect(schedule.timed[0].downstream).toEqual(['Review', 'Publish']);
    expect(downstreamNamesFor(data, 'root')).toEqual(['Review', 'Publish']);
  });

  test('keeps every organic listener available to the horizontal row', () => {
    const listeners = Array.from({ length: 8 }, (_, index) => (
      execution(`hook-${index}`, { type: 'webhook', token: `secret-${index}` })
    ));
    const schedule = buildDaySchedule({ day: DAY, data: automationMap(listeners) });
    expect(schedule.alwaysListening.map((item) => item.executionId)).toEqual(
      listeners.map((item) => item.executionId),
    );
  });

  test('uses package provenance without treating workspace folders as packages', () => {
    const explicit = execution('explicit', { type: 'webhook', token: 'a' }, { packageNames: ['Official package'] });
    const folder = execution('folder', { type: 'webhook', token: 'b' }, { folder: 'Folder package' });
    const workspace = execution('workspace', { type: 'webhook', token: 'c' }, { enabled: false });

    const schedule = buildDaySchedule({
      day: DAY,
      data: automationMap([workspace, explicit, folder], { paused: true }),
    });
    expect(schedule.packages).toEqual(['Official package', 'Workspace']);
    expect(schedule.alwaysListening.every((item) => item.subdued)).toBe(true);
  });
});

describe('point-event layout', () => {
  test('allocates a distinct lane to every simultaneous event without a three-lane cap', () => {
    const base = DAY.getTime();
    const common = {
      waveId: 'w',
      flowName: 'Flow',
      packageNames: ['Workspace'],
      packageName: 'Workspace',
      triggerType: 'schedule' as const,
      activity: 'run' as const,
      downstream: [],
      state: 'active' as const,
      subdued: false,
    };
    const layout = layoutDayItems(Array.from({ length: 5 }, (_, index) => ({
      ...common,
      key: `event-${index}`,
      kind: 'occurrence' as const,
      executionId: `event-${index}`,
      name: `Event ${index}`,
      at: base,
    })));

    expect(layout.map((entry) => entry.lane)).toEqual([0, 1, 2, 3, 4]);
    expect(layout.every((entry) => entry.laneCount === 5)).toBe(true);
  });

  test('reuses lanes for staggered events while preserving the cluster peak', () => {
    const base = DAY.getTime();
    const common = {
      flowName: 'Flow',
      packageNames: ['Workspace'],
      packageName: 'Workspace',
      triggerType: 'schedule' as const,
      activity: 'run' as const,
      downstream: [],
      state: 'active' as const,
      subdued: false,
    };
    const layout = layoutDayItems([
      { ...common, key: 'a', kind: 'occurrence' as const, executionId: 'a', name: 'A', at: base },
      { ...common, key: 'b', kind: 'occurrence' as const, executionId: 'b', name: 'B', at: base + 20 * 60_000 },
      { ...common, key: 'c', kind: 'occurrence' as const, executionId: 'c', name: 'C', at: base + 40 * 60_000 },
    ]);

    expect(layout.map(({ lane, laneCount }) => ({ lane, laneCount }))).toEqual([
      { lane: 0, laneCount: 2 },
      { lane: 1, laneCount: 2 },
      { lane: 0, laneCount: 2 },
    ]);
  });
});
