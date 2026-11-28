/**
 * Which finished Persona records unfinished work still points at (#481).
 * History cleanup never rewrites such a record, and finding one among the
 * records it would rewrite sends cleanup back to measuring only.
 */

import type {
  BehaviorMaintenanceRun,
  PersonaActivity,
  PersonaMailboxItem,
} from '@/shared/types/enduringAgent';

import type { BehaviorCallPin } from './behaviorCallPins';
import type { PersonaFlowDispatchRecord } from './personaDispatcher';

export interface PersonaRuntimeRecords {
  mailboxItems: readonly PersonaMailboxItem[];
  activities: readonly PersonaActivity[];
  flowDispatches: readonly PersonaFlowDispatchRecord[];
  behaviorCallPins: readonly BehaviorCallPin[];
  maintenanceRuns: readonly BehaviorMaintenanceRun[];
}

export interface PersonaRuntimeRecordsInUse {
  mailboxItems: ReadonlySet<string>;
  activities: ReadonlySet<string>;
  flowDispatches: ReadonlySet<string>;
  behaviorCallPins: ReadonlySet<string>;
}

const FINISHED_ACTIVITY = new Set(['completed', 'cancelled', 'error']);
const FINISHED_DISPATCH = new Set(['completed', 'cancelled', 'error']);
const FINISHED_MAINTENANCE = new Set(['completed', 'failed', 'cancelled']);

function mailboxItemFinished(item: PersonaMailboxItem): boolean {
  if (item.status === 'completed' || item.status === 'rejected') return true;
  return item.status === 'coalesced' && item.deliveryStatus !== 'pending';
}

/** A terminal dispatch is finished only once its projections are settled. */
function dispatchFinished(dispatch: PersonaFlowDispatchRecord): boolean {
  return FINISHED_DISPATCH.has(dispatch.state) && dispatch.terminalProjectionsSettledAt !== undefined;
}

function add(target: Set<string>, id: string | undefined): void {
  if (id !== undefined) target.add(id);
}

export function findPersonaRuntimeRecordsInUse(
  records: PersonaRuntimeRecords,
): PersonaRuntimeRecordsInUse {
  const unfinishedActivities = new Set(records.activities
    .filter((activity) => !FINISHED_ACTIVITY.has(activity.status))
    .map((activity) => activity.id));
  const mailboxItems = new Set<string>();
  const activities = new Set<string>();
  const flowDispatches = new Set<string>();
  const behaviorCallPins = new Set<string>();

  for (const item of records.mailboxItems) {
    const pointsAtUnfinishedActivity = [
      item.claimedActivityId,
      item.targetActivityId,
      item.interruptedActivityId,
    ].some((id) => id !== undefined && unfinishedActivities.has(id));
    if (item.deliveryStatus === 'pending' || pointsAtUnfinishedActivity) add(mailboxItems, item.id);
    if (mailboxItemFinished(item)) continue;
    add(mailboxItems, item.coalescedIntoId);
    add(activities, item.claimedActivityId);
    add(activities, item.targetActivityId);
    add(activities, item.interruptedActivityId);
  }

  for (const activity of records.activities) {
    if (FINISHED_ACTIVITY.has(activity.status)) continue;
    add(mailboxItems, activity.interruptionRequestedByMailboxItemId);
  }

  for (const dispatch of records.flowDispatches) {
    if (dispatch.activityId !== undefined && unfinishedActivities.has(dispatch.activityId)) {
      add(flowDispatches, dispatch.id);
    }
    if (dispatchFinished(dispatch)) continue;
    add(flowDispatches, dispatch.id);
    add(mailboxItems, dispatch.mailboxItemId);
    add(activities, dispatch.activityId);
    add(activities, dispatch.targetActivityId);
  }

  for (const run of records.maintenanceRuns) {
    if (FINISHED_MAINTENANCE.has(run.state)) continue;
    for (const id of run.sourceActivityIds) activities.add(id);
  }

  for (const pin of records.behaviorCallPins) {
    if (unfinishedActivities.has(pin.activityId)) add(behaviorCallPins, pin.id);
  }

  return { mailboxItems, activities, flowDispatches, behaviorCallPins };
}
