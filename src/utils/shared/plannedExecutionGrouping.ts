import type {
  PlannedExecution,
  PlannedExecutionStatus,
  RunRecord,
  TriggerType,
} from '@/shared/types/plannedExecution';

/** Sort choices exposed by the Planned Executions browser. */
export type PlannedExecutionSortOption =
  | 'name-asc'
  | 'name-desc'
  | 'newest'
  | 'oldest'
  | 'last-run';

export const PLANNED_EXECUTION_SORT_LABELS: Record<PlannedExecutionSortOption, string> = {
  'name-asc': 'Name (A-Z)',
  'name-desc': 'Name (Z-A)',
  newest: 'Newest first',
  oldest: 'Oldest first',
  'last-run': 'Most recently run',
};

/** Status filters shown above the execution cards. */
export type PlannedExecutionFilter =
  | 'all'
  | 'enabled'
  | 'disabled'
  | 'running'
  | 'attention';

/** The list-entry shape returned by GET /api/planned-executions. */
export interface PlannedExecutionGroupingItem {
  execution: PlannedExecution;
  status: PlannedExecutionStatus;
  lastRun: RunRecord | null;
}

export const TRIGGER_TYPE_LABELS: Record<TriggerType, string> = {
  schedule: 'Schedule',
  webhook: 'Webhook',
  'file-watch': 'File watch',
  'mcp-poll': 'MCP poll',
  'url-watch': 'URL watch',
  'flow-event': 'Flow event',
};

function timestamp(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function stableTiebreak(
  a: PlannedExecutionGroupingItem,
  b: PlannedExecutionGroupingItem,
): number {
  return a.execution.name.localeCompare(b.execution.name) ||
    a.execution.id.localeCompare(b.execution.id);
}

/** Sort a copy of the API entries without mutating the poller's current state. */
export function sortPlannedExecutions<T extends PlannedExecutionGroupingItem>(
  entries: T[],
  option: PlannedExecutionSortOption,
): T[] {
  return [...entries].sort((a, b) => {
    switch (option) {
      case 'name-asc':
        return stableTiebreak(a, b);
      case 'name-desc':
        return b.execution.name.localeCompare(a.execution.name) ||
          b.execution.id.localeCompare(a.execution.id);
      case 'newest':
        return timestamp(b.execution.createdAt) - timestamp(a.execution.createdAt) ||
          stableTiebreak(a, b);
      case 'oldest':
        return timestamp(a.execution.createdAt) - timestamp(b.execution.createdAt) ||
          stableTiebreak(a, b);
      case 'last-run':
        return timestamp(b.lastRun?.firedAt) - timestamp(a.lastRun?.firedAt) ||
          stableTiebreak(a, b);
      default:
        return 0;
    }
  });
}

/** Whether an execution matches the selected operational-state filter. */
export function matchesPlannedExecutionStatus(
  item: PlannedExecutionGroupingItem,
  filter: PlannedExecutionFilter,
): boolean {
  switch (filter) {
    case 'enabled':
      return item.execution.enabled;
    case 'disabled':
      return !item.execution.enabled;
    case 'running':
      return item.status.running;
    case 'attention':
      return Boolean(
        item.status.lastTriggerError ||
        item.lastRun?.status === 'error' ||
        item.lastRun?.status === 'needs_approval',
      );
    case 'all':
    default:
      return true;
  }
}

/**
 * Search the useful, non-secret card metadata. Trigger tokens and tool args are
 * deliberately excluded: the browser should find cards, not secret values.
 */
export function matchesPlannedExecutionSearch(
  item: PlannedExecutionGroupingItem,
  search: string,
): boolean {
  const needle = search.trim().toLocaleLowerCase();
  if (!needle) return true;
  const execution = item.execution;
  return [
    execution.name,
    execution.folder,
    execution.prompt,
    execution.flowId,
    execution.trigger.type,
    TRIGGER_TYPE_LABELS[execution.trigger.type],
  ].some((value) => value?.toLocaleLowerCase().includes(needle));
}

/** Human-readable state bucket used by the group-by-state view. */
export function plannedExecutionStateGroup(
  item: PlannedExecutionGroupingItem,
): { key: string; label: string } {
  if (item.status.running) return { key: 'state:running', label: 'Running' };
  if (
    item.status.lastTriggerError ||
    item.lastRun?.status === 'error' ||
    item.lastRun?.status === 'needs_approval'
  ) {
    return { key: 'state:attention', label: 'Needs attention' };
  }
  if (!item.execution.enabled) return { key: 'state:disabled', label: 'Off' };
  return { key: 'state:enabled', label: 'Active' };
}

/** Human-readable trigger bucket used by the group-by-trigger view. */
export function plannedExecutionTriggerGroup(
  item: PlannedExecutionGroupingItem,
): { key: string; label: string } {
  const type = item.execution.trigger.type;
  return { key: `trigger:${type}`, label: TRIGGER_TYPE_LABELS[type] };
}
