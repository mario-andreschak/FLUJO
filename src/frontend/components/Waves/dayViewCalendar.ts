import { Cron } from 'croner';
import type {
  AutomationMapExecution,
  AutomationMapResponse,
  AutomationMapTrigger,
} from '@/shared/types/waves/automationMap';

/** A neutral bucket for workspace-owned content that is not grouped in a package folder. */
export const WORKSPACE_PACKAGE = 'Workspace';

/** Beyond this many points, a recurrence becomes one readable rhythm card. */
export const DEFAULT_DENSE_THRESHOLD = 24;

export type DayActivity = 'run' | 'check';

interface DayItemBase {
  key: string;
  executionId: string;
  waveId?: string;
  name: string;
  flowName: string;
  /** Exact package owners used by the filter; Workspace is the no-owner fallback. */
  packageNames: string[];
  /** Compact human-readable package presentation. */
  packageName: string;
  triggerType: AutomationMapTrigger['type'];
  activity: DayActivity;
  downstream: string[];
  state: 'active' | 'paused' | 'disabled';
  /** Disabled executions and every plan under a global pause remain visible but subdued. */
  subdued: boolean;
}

export interface DayOccurrence extends DayItemBase {
  kind: 'occurrence';
  at: number;
}

export interface DayRecurrenceAggregate extends DayItemBase {
  kind: 'aggregate';
  at: number;
  endAt: number;
  /** A truthful lower bound: enumeration stops once density is established. */
  countAtLeast: number;
  cadenceMs?: number;
  cadenceLabel: string;
}

export type DayTimedItem = DayOccurrence | DayRecurrenceAggregate;

export interface DayAlwaysListeningItem extends Omit<DayItemBase, 'activity'> {
  kind: 'always';
  activity: 'run';
  eventLabel: string;
}

export interface DaySchedule {
  startAt: number;
  endAt: number;
  /** Exact appointment points rendered on the scrollable 24-hour canvas. */
  timed: DayOccurrence[];
  /** Dense recurrences pinned above the canvas so scrolling cannot hide them. */
  scheduledRhythms: DayRecurrenceAggregate[];
  alwaysListening: DayAlwaysListeningItem[];
  packages: string[];
}

export interface MonthGridDay {
  date: Date;
  key: string;
  inMonth: boolean;
}

export interface EnumeratedDayCron {
  occurrences: number[];
  dense: boolean;
  cadenceMs?: number;
}

export interface LaidOutDayItem<T extends DayOccurrence = DayOccurrence> {
  item: T;
  lane: number;
  laneCount: number;
}

export function normalizeCalendarDay(value: Date | number): Date {
  const date = value instanceof Date ? value : new Date(value);
  // Noon is resilient when date navigation crosses a daylight-saving boundary.
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0, 0, 0);
}

export function startOfCalendarDay(value: Date | number): Date {
  const date = value instanceof Date ? value : new Date(value);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

export function calendarDayBounds(value: Date | number): { startAt: number; endAt: number } {
  const start = startOfCalendarDay(value);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1, 0, 0, 0, 0);
  return { startAt: start.getTime(), endAt: end.getTime() };
}

export function addCalendarDays(value: Date | number, amount: number): Date {
  const date = normalizeCalendarDay(value);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + amount, 12, 0, 0, 0);
}

export function addCalendarMonths(value: Date | number, amount: number): Date {
  const date = normalizeCalendarDay(value);
  return new Date(date.getFullYear(), date.getMonth() + amount, 1, 12, 0, 0, 0);
}

export function calendarDayKey(value: Date | number): string {
  const date = value instanceof Date ? value : new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function isSameCalendarDay(left: Date | number, right: Date | number): boolean {
  return calendarDayKey(left) === calendarDayKey(right);
}

/** Six complete Sunday-first weeks, matching the familiar Outlook mini month. */
export function buildMonthGrid(value: Date | number): MonthGridDay[] {
  const selected = normalizeCalendarDay(value);
  const monthStart = new Date(selected.getFullYear(), selected.getMonth(), 1, 12, 0, 0, 0);
  const gridStart = addCalendarDays(monthStart, -monthStart.getDay());
  return Array.from({ length: 42 }, (_, index) => {
    const date = addCalendarDays(gridStart, index);
    return {
      date,
      key: calendarDayKey(date),
      inMonth: date.getMonth() === selected.getMonth(),
    };
  });
}

export function activityForTrigger(trigger: AutomationMapTrigger): DayActivity | null {
  if (trigger.type === 'schedule') return 'run';
  if (trigger.type === 'mcp-poll' || trigger.type === 'url-watch') return 'check';
  return null;
}

function cronForExecution(execution: AutomationMapExecution): { cron: string; timezone?: string } | null {
  const { trigger } = execution;
  if (execution.schedule?.cron) {
    return {
      cron: execution.schedule.cron,
      timezone: execution.schedule.timezone ?? execution.timezone,
    };
  }
  if (trigger.type === 'schedule' || trigger.type === 'url-watch') {
    return { cron: trigger.cron, timezone: trigger.timezone };
  }
  if (trigger.type === 'mcp-poll') {
    return trigger.cron ? { cron: trigger.cron, timezone: trigger.timezone } : null;
  }
  return null;
}

/**
 * Enumerate only enough points to decide whether the day is sparse or dense.
 * This keeps a one-second schedule from creating 86,400 React nodes while the
 * first two points still provide a useful cadence label.
 */
export function enumerateCronForDay(
  cron: string,
  timezone: string | undefined,
  startAt: number,
  endAt: number,
  denseThreshold = DEFAULT_DENSE_THRESHOLD,
): EnumeratedDayCron {
  if (!cron.trim() || !Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) {
    return { occurrences: [], dense: false };
  }
  const limit = Math.max(1, Math.floor(denseThreshold)) + 1;
  let job: Cron | undefined;
  try {
    job = new Cron(cron.trim(), { timezone, paused: true });
    const occurrences: number[] = [];
    let cursor: Date | null = new Date(startAt - 1);
    for (let index = 0; index < limit; index += 1) {
      const next: Date | null = job.nextRun(cursor);
      if (!next) break;
      const at = next.getTime();
      if (at >= endAt) break;
      if (at >= startAt) occurrences.push(at);
      cursor = next;
    }
    const cadenceMs = occurrences.length >= 2
      ? occurrences[1] - occurrences[0]
      : undefined;
    return {
      occurrences,
      dense: occurrences.length > denseThreshold,
      ...(cadenceMs && cadenceMs > 0 ? { cadenceMs } : {}),
    };
  } catch {
    return { occurrences: [], dense: false };
  } finally {
    job?.stop();
  }
}

export function describeCadence(cadenceMs?: number): string {
  if (!cadenceMs || !Number.isFinite(cadenceMs) || cadenceMs <= 0) return 'Frequent schedule';
  const seconds = Math.max(1, Math.round(cadenceMs / 1000));
  if (seconds < 60) return `Every ${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `Every ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.max(1, Math.round(minutes / 60));
  return `Every ${hours} hour${hours === 1 ? '' : 's'}`;
}

export function packageNamesOf(execution: AutomationMapExecution): string[] {
  const owners = [...new Set(execution.packageNames.map((name) => name.trim()).filter(Boolean))].sort();
  if (owners.length > 0) return owners;
  return [WORKSPACE_PACKAGE];
}

export function packageNameOf(execution: AutomationMapExecution): string {
  const names = packageNamesOf(execution);
  return names.length === 1 ? names[0] : names.join(' + ');
}

/** Breadth-first, cycle-safe summary of everything this execution may trigger. */
export function downstreamNamesFor(
  data: AutomationMapResponse,
  executionId: string,
  limit = 8,
): string[] {
  if (limit <= 0) return [];
  const flowNames = new Map(data.flows.map((entry) => [entry.flow.id, entry.flow.name]));
  const namesById = new Map(data.executions.map((execution) => [
    execution.executionId,
    flowNames.get(execution.flowId)?.trim() || execution.name,
  ]));
  const successors = new Map<string, string[]>();
  for (const relation of data.relations) {
    if (relation.kind === 'subflow') continue;
    if (!relation.producerExecutionId) continue;
    const list = successors.get(relation.producerExecutionId) ?? [];
    if (!list.includes(relation.consumerExecutionId)) list.push(relation.consumerExecutionId);
    successors.set(relation.producerExecutionId, list);
  }

  const seen = new Set<string>([executionId]);
  const queue = [...(successors.get(executionId) ?? [])];
  const output: string[] = [];
  while (queue.length > 0 && output.length < limit) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const name = namesById.get(id);
    if (name && !output.includes(name)) output.push(name);
    for (const child of successors.get(id) ?? []) {
      if (!seen.has(child)) queue.push(child);
    }
  }
  return output;
}

function flowNameFor(execution: AutomationMapExecution, data: AutomationMapResponse): string {
  return data.flows.find((entry) => entry.flow.id === execution.flowId)?.flow.name.trim()
    || execution.flowId;
}

function eventLabelFor(trigger: AutomationMapTrigger): string {
  if (trigger.type === 'webhook') return 'Webhook';
  if (trigger.type === 'file-watch') return 'File watcher';
  if (trigger.type === 'flow-event') {
    if (trigger.source.topic?.trim()) return `Signal · ${trigger.source.topic.trim()}`;
    return 'Flow event';
  }
  return 'Event';
}

export function buildDaySchedule(input: {
  data: AutomationMapResponse;
  day: Date | number;
  denseThreshold?: number;
}): DaySchedule {
  const {
    data,
    day,
    denseThreshold = DEFAULT_DENSE_THRESHOLD,
  } = input;
  const { startAt, endAt } = calendarDayBounds(day);
  const timed: DayOccurrence[] = [];
  const scheduledRhythms: DayRecurrenceAggregate[] = [];
  const alwaysListening: DayAlwaysListeningItem[] = [];
  const packages = new Set<string>(data.packages.map((entry) => entry.name));

  for (const execution of data.executions) {
    const packageNames = packageNamesOf(execution);
    const packageName = packageNameOf(execution);
    packageNames.forEach((name) => packages.add(name));
    const waveId = execution.waveIds[0];
    const downstream = downstreamNamesFor(data, execution.executionId);
    const state: DayItemBase['state'] = !execution.enabled
      ? 'disabled'
      : data.paused
        ? 'paused'
        : 'active';
    const subdued = state !== 'active';
    const common = {
      executionId: execution.executionId,
      ...(waveId ? { waveId } : {}),
      name: execution.name,
      flowName: flowNameFor(execution, data),
      packageNames,
      packageName,
      triggerType: execution.trigger.type,
      downstream,
      state,
      subdued,
    };

    const activity = activityForTrigger(execution.trigger);
    const schedule = cronForExecution(execution);
    if (activity && schedule) {
      const enumerated = enumerateCronForDay(
        schedule.cron,
        schedule.timezone,
        startAt,
        endAt,
        denseThreshold,
      );
      if (enumerated.dense) {
        scheduledRhythms.push({
          ...common,
          key: `${execution.executionId}@${calendarDayKey(day)}:dense`,
          kind: 'aggregate',
          activity,
          at: enumerated.occurrences[0] ?? startAt,
          endAt,
          countAtLeast: enumerated.occurrences.length,
          cadenceMs: enumerated.cadenceMs,
          cadenceLabel: describeCadence(enumerated.cadenceMs),
        });
      } else {
        for (const at of enumerated.occurrences) {
          timed.push({
            ...common,
            key: `${execution.executionId}@${new Date(at).toISOString()}`,
            kind: 'occurrence',
            activity,
            at,
          });
        }
      }
      continue;
    }

    // Only organic event sources are truly listening. An unmatched flow-event
    // trigger is broken/unlinked, not an all-day listener, and remains surfaced
    // by the Playground's unlinked warning instead of being presented as armed.
    if (execution.trigger.type === 'webhook' || execution.trigger.type === 'file-watch') {
      alwaysListening.push({
        ...common,
        key: `${execution.executionId}:always`,
        kind: 'always',
        activity: 'run',
        eventLabel: eventLabelFor(execution.trigger),
      });
    }
  }

  timed.sort((left, right) => left.at - right.at || left.name.localeCompare(right.name));
  scheduledRhythms.sort((left, right) => left.name.localeCompare(right.name));
  alwaysListening.sort((left, right) => left.name.localeCompare(right.name));
  return {
    startAt,
    endAt,
    timed,
    scheduledRhythms,
    alwaysListening,
    packages: [...packages].sort((left, right) => {
      if (left === WORKSPACE_PACKAGE) return 1;
      if (right === WORKSPACE_PACKAGE) return -1;
      return left.localeCompare(right);
    }),
  };
}

/** Minute offset on a local 24-hour clock, intentionally independent of day length. */
export function minuteOfDay(at: Date | number): number {
  const date = at instanceof Date ? at : new Date(at);
  return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
}

/**
 * Give visually overlapping point events independent lanes. Lanes are reused
 * once a card's collision window ends, while each connected cluster reports
 * its peak lane count so every card receives enough horizontal space.
 */
export function layoutDayItems<T extends DayOccurrence>(
  items: readonly T[],
  collisionWindowMinutes = 38,
): LaidOutDayItem<T>[] {
  const collisionWindow = Math.max(1, collisionWindowMinutes);
  const sorted = [...items].sort((left, right) => (
    minuteOfDay(left.at) - minuteOfDay(right.at)
    || left.at - right.at
    || left.name.localeCompare(right.name)
  ));
  const result: LaidOutDayItem<T>[] = [];
  let index = 0;
  while (index < sorted.length) {
    const cluster: Array<{ item: T; lane: number }> = [];
    const laneEnds: number[] = [];
    let clusterEnd = minuteOfDay(sorted[index].at) + collisionWindow;
    let cursor = index;

    while (cursor < sorted.length && minuteOfDay(sorted[cursor].at) < clusterEnd) {
      const item = sorted[cursor];
      const startsAt = minuteOfDay(item.at);
      let lane = laneEnds.findIndex((endsAt) => endsAt <= startsAt);
      if (lane === -1) lane = laneEnds.length;
      laneEnds[lane] = startsAt + collisionWindow;
      clusterEnd = Math.max(clusterEnd, laneEnds[lane]);
      cluster.push({ item, lane });
      cursor += 1;
    }

    const laneCount = Math.max(1, laneEnds.length);
    cluster.forEach(({ item, lane }) => {
      result.push({ item, lane, laneCount });
    });
    index = cursor;
  }
  return result;
}
