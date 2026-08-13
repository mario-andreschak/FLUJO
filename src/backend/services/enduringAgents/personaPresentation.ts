import type {
  PersonaActivity,
  PersonaActivitySourceKind,
  PersonaHistoryEntry,
  PersonaMailboxItem,
  PersonaPresentationOrigin,
  PersonaPresentationOutcome,
  PersonaPresentationRecordLink,
  PersonaPresentationSummary,
  PersonaTaskDisplayState,
  PersonaWorkItem,
} from '@/shared/types/enduringAgent';

import { stableEnduringAgentId } from './ids';
import type { PersonaBundle } from './store';

function isPendingMailboxItem(item: PersonaMailboxItem): boolean {
  return item.status === 'queued'
    || item.status === 'claimed'
    || item.deliveryStatus === 'pending';
}

function presentationOrigin(source: PersonaActivitySourceKind): PersonaPresentationOrigin {
  switch (source) {
    case 'chat': return 'user_chat';
    case 'assignment': return 'assignment';
    case 'schedule': return 'automation';
    case 'trigger': return 'trigger';
    case 'meeting': return 'meeting';
    case 'voice': return 'voice';
    case 'api': return 'api';
    case 'maintenance': return 'maintenance';
    default: return 'unknown';
  }
}

function presentationOutcome(activity: PersonaActivity): PersonaPresentationOutcome {
  switch (activity.status) {
    case 'queued': return 'queued';
    case 'running': return 'working';
    case 'waiting': return 'waiting';
    case 'completed': return 'completed';
    case 'cancelled': return 'cancelled';
    case 'error': return 'needs_attention';
  }
}

function activityTime(activity: PersonaActivity): number {
  return activity.completedAt ?? activity.startedAt ?? activity.updatedAt ?? activity.createdAt;
}

function activitySummary(activity: PersonaActivity): string {
  switch (activity.kind) {
    case 'interactive_chat': return 'Conversation';
    case 'assignment': return 'Assigned task';
    case 'scheduled': return 'Scheduled work';
    case 'triggered': return 'Triggered work';
    case 'meeting': return 'Meeting';
    case 'voice': return 'Voice conversation';
    case 'maintenance': return 'Maintenance';
  }
}

function recordLinks(activity: PersonaActivity): PersonaPresentationRecordLink[] {
  return [
    ...(activity.conversationId
      ? [{ kind: 'conversation' as const, id: activity.conversationId }]
      : []),
    ...(activity.meetingId
      ? [{ kind: 'meeting' as const, id: activity.meetingId }]
      : []),
  ];
}

function historyEntry(activity: PersonaActivity): PersonaHistoryEntry {
  return {
    key: stableEnduringAgentId('history', {
      purpose: 'persona-history-presentation-v1',
      personaId: activity.personaId,
      activityId: activity.id,
    }),
    kind: activity.kind,
    origin: presentationOrigin(activity.source.kind),
    outcome: presentationOutcome(activity),
    occurredAt: activityTime(activity),
    summary: activitySummary(activity),
    recordLinks: recordLinks(activity),
    advanced: {
      activityKind: activity.kind,
      sourceKind: activity.source.kind,
      status: activity.status,
    },
  };
}

function taskDisplayState(
  item: PersonaWorkItem,
  byId: ReadonlyMap<string, PersonaWorkItem>,
  mailboxItems: readonly PersonaMailboxItem[],
  now: number,
): PersonaTaskDisplayState {
  if (item.status === 'completed') return 'completed';
  if (item.status === 'cancelled') return 'cancelled';
  if (
    item.status === 'blocked'
    || item.dependencyIds.some((id) => byId.get(id)?.status !== 'completed')
  ) return 'blocked';
  if (item.deadline !== undefined && item.deadline < now) return 'overdue';
  if (item.status === 'in_progress') return 'in_progress';
  if (mailboxItems.some((mailboxItem) => (
    mailboxItem.source.kind === 'assignment'
    && mailboxItem.source.sourceId === item.id
    && isPendingMailboxItem(mailboxItem)
  ))) return 'waiting';
  return 'ready';
}

/**
 * Build the default Persona product view from an explicit allowlist.
 *
 * Raw Activity ids, mailbox ids/sequences/payloads, leases, fencing data,
 * revisions, trace material, and internal error strings never enter this DTO.
 */
export function projectPersonaPresentation(
  bundle: PersonaBundle,
  options: { activeActivityId?: string; now?: number } = {},
): PersonaPresentationSummary {
  const now = options.now ?? Date.now();
  const byWorkItemId = new Map(bundle.workItems.map((item) => [item.id, item]));
  const history = bundle.activities
    .map(historyEntry)
    .sort((left, right) => right.occurredAt - left.occurredAt || left.key.localeCompare(right.key));

  const currentActivity = options.activeActivityId
    ? bundle.activities.find((activity) => activity.id === options.activeActivityId)
    : bundle.activities.find((activity) => (
      activity.status === 'running' || activity.status === 'waiting'
    ));
  const current = currentActivity ? historyEntry(currentActivity) : null;

  const latestByConversation = new Map<string, PersonaActivity>();
  for (const activity of bundle.activities) {
    if (!activity.conversationId) continue;
    const currentConversation = latestByConversation.get(activity.conversationId);
    if (!currentConversation || activityTime(activity) > activityTime(currentConversation)) {
      latestByConversation.set(activity.conversationId, activity);
    }
  }

  const conversations = [...latestByConversation.entries()].map(([conversationId, activity]) => ({
    conversationId,
    origin: presentationOrigin(activity.source.kind),
    outcome: presentationOutcome(activity),
    occurredAt: activityTime(activity),
    active: currentActivity?.conversationId === conversationId,
    queuedInputCount: bundle.mailboxItems.filter((item) => (
      item.source.kind === 'chat'
      && item.source.sourceId === conversationId
      && isPendingMailboxItem(item)
    )).length,
  })).sort((left, right) => right.occurredAt - left.occurredAt);

  const tasks = bundle.workItems.map((item) => ({
    id: item.id,
    title: item.title,
    ...(item.description ? { description: item.description } : {}),
    state: taskDisplayState(item, byWorkItemId, bundle.mailboxItems, now),
    priority: item.priority,
    ...(item.nextAction ? { nextAction: item.nextAction } : {}),
    ...(item.deadline !== undefined ? { deadline: item.deadline } : {}),
    blockerTitles: item.dependencyIds
      .filter((id) => byWorkItemId.get(id)?.status !== 'completed')
      .map((id) => byWorkItemId.get(id)?.title ?? 'Unavailable task'),
    ...(item.completedAt !== undefined ? { completedAt: item.completedAt } : {}),
    expectedUpdatedAt: item.updatedAt,
  })).sort((left, right) => (
    Number(left.state === 'completed' || left.state === 'cancelled')
      - Number(right.state === 'completed' || right.state === 'cancelled')
    || right.expectedUpdatedAt - left.expectedUpdatedAt
  ));

  return {
    conversations,
    tasks,
    history,
    current,
    queuedInputCount: bundle.mailboxItems.filter((item) => (
      item.source.kind === 'chat' && isPendingMailboxItem(item)
    )).length,
  };
}
