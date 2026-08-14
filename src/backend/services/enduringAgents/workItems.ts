import { z } from 'zod';

import { loadConversationState } from '@/backend/execution/flow/loadConversationState';
import {
  AssignPersonaWorkItemInputSchema,
  CreatePersonaWorkItemInputSchema,
  ENDURING_AGENT_SCHEMA_VERSION,
  EnduringAgentIdSchema,
  PERSONA_PRIORITIES,
  PERSONA_WORK_ITEM_STATUSES,
  PersonaWorkItemSchema,
  UpdatePersonaWorkItemInputSchema,
  type AssignPersonaWorkItemInput,
  type AssignPersonaWorkItemResult,
  type CreatePersonaWorkItemInput,
  type PersonaActivity,
  type PersonaPriority,
  type PersonaWorkItem,
  type PersonaWorkItemStatus,
  type UpdatePersonaWorkItemInput,
} from '@/shared/types/enduringAgent';
import { getCurrentWorkspace } from '@/utils/workspace';

import {
  cancelPersonaFlowDispatchById,
  listPersonaFlowDispatches,
  movePersonaWorkItemDispatch,
  reprioritizePersonaWorkItemDispatches,
  submitPersonaFlowDispatch,
  type PersonaFlowDispatchRecord,
} from './personaDispatcher';
import {
  PersonaDomainConflictError,
  PersonaDomainNotFoundError,
  type PersonaDomainMutationOptions,
  withPersonaDomainMutation,
} from './domainMutation';
import { randomEnduringAgentId, stableEnduringAgentId } from './ids';
import { normalizeMemorySourceRefs } from './provenance';
import {
  withPersonaRuntimeLock,
  type PersonaRuntimeLock,
} from './runtimeLock';
import {
  deletePersonaWorkItemRecord,
  getPersonaActivity,
  getPersonaWorkItem,
  listPersonaWorkItems as listStoredPersonaWorkItems,
  savePersonaWorkItem,
} from './store';

const WorkItemListQuerySchema = z.object({
  statuses: z.array(z.enum(PERSONA_WORK_ITEM_STATUSES)).optional(),
  priorities: z.array(z.enum(PERSONA_PRIORITIES)).optional(),
  dueBefore: z.number().int().nonnegative().optional(),
  includeBlockedByDependencies: z.boolean().optional(),
}).strict();

const PromoteRunTodoInputSchema = z.object({
  activityId: EnduringAgentIdSchema.optional(),
  todoId: z.string().trim().min(1).max(512),
  title: z.string().trim().min(1).max(500).optional(),
  description: z.string().trim().max(100_000).optional(),
  priority: z.enum(PERSONA_PRIORITIES).optional(),
  nextAction: z.string().trim().max(20_000).optional(),
  deadline: z.number().int().nonnegative().optional(),
}).strict();

export interface PersonaWorkItemListQuery {
  statuses?: PersonaWorkItemStatus[];
  priorities?: PersonaPriority[];
  dueBefore?: number;
  includeBlockedByDependencies?: boolean;
}

export interface PromoteRunTodoInput {
  activityId?: string;
  todoId: string;
  title?: string;
  description?: string;
  priority?: PersonaPriority;
  nextAction?: string;
  deadline?: number;
}

const PRIORITY_RANK: Record<PersonaPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

function requireOwnedWorkItem(item: PersonaWorkItem | null, personaId: string): PersonaWorkItem {
  if (!item || item.personaId !== personaId) {
    throw new PersonaDomainNotFoundError('PersonaWorkItem', item?.id ?? 'unknown');
  }
  return item;
}

function assertDependencyGraph(
  personaId: string,
  candidate: PersonaWorkItem,
  records: readonly PersonaWorkItem[],
): void {
  const graph = new Map(records.map((item) => [item.id, item]));
  graph.set(candidate.id, candidate);
  for (const dependencyId of candidate.dependencyIds) {
    const dependency = graph.get(dependencyId);
    if (!dependency || dependency.personaId !== personaId) {
      throw new PersonaDomainConflictError(
        `WorkItem dependency ${JSON.stringify(dependencyId)} is missing or belongs to another Persona.`,
      );
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      throw new PersonaDomainConflictError('WorkItem dependencies must remain acyclic.');
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependencyId of graph.get(id)?.dependencyIds ?? []) visit(dependencyId);
    visiting.delete(id);
    visited.add(id);
  };
  visit(candidate.id);

  if (candidate.status === 'in_progress' || candidate.status === 'completed') {
    const unfinished = candidate.dependencyIds.filter(
      (id) => graph.get(id)?.status !== 'completed',
    );
    if (unfinished.length > 0) {
      throw new PersonaDomainConflictError(
        `WorkItem cannot be ${candidate.status} while dependencies remain incomplete.`,
      );
    }
  }
}

export async function createPersonaWorkItem(
  input: CreatePersonaWorkItemInput,
  options: PersonaDomainMutationOptions = {},
): Promise<PersonaWorkItem> {
  const parsed = CreatePersonaWorkItemInputSchema.parse(input) as CreatePersonaWorkItemInput;
  return withPersonaDomainMutation(parsed.personaId, options, async ({ activity }) => {
    const now = Date.now();
    const id = parsed.id ?? randomEnduringAgentId('work');
    const existing = await getPersonaWorkItem(id);
    if (existing) throw new PersonaDomainConflictError(`WorkItem ${JSON.stringify(id)} already exists.`);
    if (parsed.createdByActivityId && activity && parsed.createdByActivityId !== activity.id) {
      throw new PersonaDomainConflictError('A Flow cannot attribute a WorkItem to another Activity.');
    }
    const record = PersonaWorkItemSchema.parse({
      schemaVersion: ENDURING_AGENT_SCHEMA_VERSION,
      id,
      personaId: parsed.personaId,
      title: parsed.title,
      ...(parsed.description ? { description: parsed.description } : {}),
      status: 'open',
      priority: parsed.priority ?? 'normal',
      dependencyIds: parsed.dependencyIds ?? [],
      ...(parsed.nextAction ? { nextAction: parsed.nextAction } : {}),
      ...(parsed.deadline !== undefined ? { deadline: parsed.deadline } : {}),
      ...(activity?.id || parsed.createdByActivityId
        ? { createdByActivityId: activity?.id ?? parsed.createdByActivityId }
        : {}),
      ...(activity?.behaviorRevisionId
        ? { behaviorRevisionId: activity.behaviorRevisionId }
        : {}),
      ...(parsed.sourceRefs?.length
        ? { sourceRefs: normalizeMemorySourceRefs(parsed.sourceRefs, { now }) }
        : {}),
      createdAt: now,
      updatedAt: now,
    }) as PersonaWorkItem;
    assertDependencyGraph(parsed.personaId, record, await listStoredPersonaWorkItems(parsed.personaId));
    return savePersonaWorkItem(record);
  });
}

export async function updatePersonaWorkItem(
  personaId: string,
  workItemId: string,
  patch: UpdatePersonaWorkItemInput,
  options: PersonaDomainMutationOptions = {},
): Promise<PersonaWorkItem> {
  EnduringAgentIdSchema.parse(personaId);
  EnduringAgentIdSchema.parse(workItemId);
  const parsed = UpdatePersonaWorkItemInputSchema.parse(patch) as UpdatePersonaWorkItemInput;
  const updated = await withPersonaDomainMutation(personaId, options, async () => {
    const existing = requireOwnedWorkItem(await getPersonaWorkItem(workItemId), personaId);
    if (parsed.expectedUpdatedAt !== undefined && parsed.expectedUpdatedAt !== existing.updatedAt) {
      throw new PersonaDomainConflictError('WorkItem changed since it was inspected.');
    }
    if (
      !options.executionAuthority
      && parsed.status !== undefined
      && parsed.status !== existing.status
      && (parsed.status === 'completed' || parsed.status === 'cancelled')
      && (await listActiveWorkItemDispatches(personaId, workItemId)).length > 0
    ) {
      throw new PersonaDomainConflictError(
        parsed.status === 'completed'
          ? 'This Task is still active. Let it finish normally, or Stop it first.'
          : 'This Task is still active. Use Stop so its work ends safely.',
        'PERSONA_WORK_ITEM_ACTIVE',
        { reason: 'active_assignment' },
      );
    }
    const now = Math.max(Date.now(), existing.updatedAt + 1);
    const status = parsed.status ?? existing.status;
    const candidate = PersonaWorkItemSchema.parse({
      ...existing,
      ...(parsed.title !== undefined ? { title: parsed.title } : {}),
      description: parsed.description === null ? undefined : parsed.description ?? existing.description,
      status,
      ...(parsed.priority !== undefined ? { priority: parsed.priority } : {}),
      ...(parsed.dependencyIds !== undefined ? { dependencyIds: parsed.dependencyIds } : {}),
      nextAction: parsed.nextAction === null ? undefined : parsed.nextAction ?? existing.nextAction,
      deadline: parsed.deadline === null ? undefined : parsed.deadline ?? existing.deadline,
      updatedAt: now,
      completedAt: status === 'completed' ? existing.completedAt ?? now : undefined,
    }) as PersonaWorkItem;
    assertDependencyGraph(personaId, candidate, await listStoredPersonaWorkItems(personaId));
    return savePersonaWorkItem(candidate);
  });
  if (parsed.priority !== undefined) {
    await reprioritizePersonaWorkItemDispatches({
      personaId,
      workItemId,
      priority: updated.priority,
    });
  }
  return updated;
}

function assignmentRelationKey(workItemId: string): string {
  return `persona-task:${workItemId}`;
}

function assertAssignableWorkItem(
  item: PersonaWorkItem,
  records: readonly PersonaWorkItem[],
  expectedUpdatedAt: number,
): void {
  if (item.updatedAt !== expectedUpdatedAt) {
    throw new PersonaDomainConflictError(
      'Task changed since it was inspected.',
      'PERSONA_WORK_ITEM_STALE',
      { reason: 'stale' },
    );
  }
  if (item.status === 'completed' || item.status === 'cancelled') {
    throw new PersonaDomainConflictError(
      'Completed or cancelled Tasks cannot be assigned.',
      'PERSONA_WORK_ITEM_NOT_ACTIONABLE',
      { reason: 'terminal' },
    );
  }
  if (item.status === 'blocked') {
    throw new PersonaDomainConflictError(
      'Blocked Tasks cannot be assigned.',
      'PERSONA_WORK_ITEM_BLOCKED',
      { reason: 'blocked' },
    );
  }
  const byId = new Map(records.map((record) => [record.id, record]));
  const incompleteDependencies = item.dependencyIds.filter(
    (id) => byId.get(id)?.status !== 'completed',
  );
  if (incompleteDependencies.length > 0) {
    throw new PersonaDomainConflictError(
      'Task dependencies must be completed before assignment.',
      'PERSONA_WORK_ITEM_BLOCKED',
      { reason: 'dependencies' },
    );
  }
}

function assignmentPrompt(item: PersonaWorkItem): string {
  const lines = [
    'Complete this saved Persona Task and keep its durable status current.',
    `Task ID: ${item.id}`,
    `Title: ${item.title}`,
    `Priority: ${item.priority}`,
  ];
  if (item.description) lines.push(`Description: ${item.description}`);
  if (item.nextAction) lines.push(`Next step: ${item.nextAction}`);
  if (item.deadline !== undefined) {
    const deadline = new Date(item.deadline);
    lines.push(`Deadline: ${Number.isNaN(deadline.getTime()) ? item.deadline : deadline.toISOString()}`);
  }
  return lines.join('\n');
}

/**
 * Admit one durable Task through the normal Persona Core dispatch path.
 * Validation runs under the Persona lock before the dispatch is persisted and
 * again immediately before mailbox admission. The WorkItem itself is never
 * marked in progress merely because assignment was requested.
 */
export async function assignPersonaWorkItem(
  personaId: string,
  workItemId: string,
  input: AssignPersonaWorkItemInput,
  options: AssignPersonaWorkItemOptions = {},
): Promise<AssignPersonaWorkItemResult> {
  EnduringAgentIdSchema.parse(personaId);
  EnduringAgentIdSchema.parse(workItemId);
  const parsed = AssignPersonaWorkItemInputSchema.parse(input) as AssignPersonaWorkItemInput;
  const inspected = requireOwnedWorkItem(await getPersonaWorkItem(workItemId), personaId);
  let workItem: PersonaWorkItem | undefined;
  const validateAdmission = async (): Promise<void> => {
    const current = requireOwnedWorkItem(await getPersonaWorkItem(workItemId), personaId);
    const records = await listStoredPersonaWorkItems(personaId);
    assertAssignableWorkItem(current, records, parsed.expectedUpdatedAt);
    workItem = current;
  };

  const submission = await submitPersonaFlowDispatch({
    personaId,
    idempotencyKey: stableEnduringAgentId('taskassign', {
      purpose: 'persona-work-item-assignment-v2',
      workspaceId: getCurrentWorkspace(),
      personaId,
      workItemId,
      attemptKey: options.attemptKey ?? 'initial',
    }),
    kind: 'assignment',
    priority: inspected.priority,
    source: {
      kind: 'assignment',
      sourceId: workItemId,
    },
    relationKey: assignmentRelationKey(workItemId),
    summary: inspected.title,
    flowInput: {
      messages: [{ role: 'user', content: assignmentPrompt(inspected) }],
      mode: 'conversation',
      title: inspected.title,
      source: 'internal',
      userTurn: true,
    },
  }, {
    waitForCompletion: false,
    validateAdmission,
  });

  if (!workItem) {
    throw new PersonaDomainConflictError('Task assignment validation did not complete.');
  }
  return {
    workItem,
    admission: submission.duplicate ? 'already_queued' : 'queued',
  };
}

export const PERSONA_WORK_ITEM_CONTROL_ACTIONS = [
  'pause',
  'stop',
  'retry',
  'move_earlier',
  'move_later',
] as const;
export type PersonaWorkItemControlAction =
  (typeof PERSONA_WORK_ITEM_CONTROL_ACTIONS)[number];

export interface PersonaWorkItemControlResult {
  action: PersonaWorkItemControlAction;
  workItem: PersonaWorkItem;
  admission?: AssignPersonaWorkItemResult['admission'];
  moved?: boolean;
}

interface AssignPersonaWorkItemOptions {
  /** Trusted attempt version; omitted for the original, forever-idempotent assignment. */
  attemptKey?: string;
}

function isActiveWorkItemDispatch(
  record: PersonaFlowDispatchRecord,
  personaId: string,
  workItemId: string,
): boolean {
  return record.personaId === personaId
    && record.admission.kind === 'assignment'
    && record.admission.source.kind === 'assignment'
    && record.admission.source.sourceId === workItemId
    && record.state !== 'completed'
    && record.state !== 'error'
    && record.state !== 'cancelled';
}

async function listActiveWorkItemDispatches(
  personaId: string,
  workItemId: string,
): Promise<PersonaFlowDispatchRecord[]> {
  return (await listPersonaFlowDispatches(personaId)).filter((record) => (
    isActiveWorkItemDispatch(record, personaId, workItemId)
  ));
}

async function persistWorkItemControlStatus(
  personaId: string,
  workItemId: string,
  status: 'open' | 'blocked' | 'cancelled',
): Promise<PersonaWorkItem> {
  return withPersonaRuntimeLock(personaId, async (lock) => {
    await lock.assertOwned();
    const existing = requireOwnedWorkItem(await getPersonaWorkItem(workItemId), personaId);
    if (existing.status === status) return existing;
    if (existing.status === 'completed' || existing.status === 'cancelled') {
      throw new PersonaDomainConflictError(
        'This Task is already finished and cannot be changed with a work control.',
        'PERSONA_WORK_ITEM_NOT_ACTIONABLE',
        { reason: 'terminal' },
      );
    }
    const records = await listStoredPersonaWorkItems(personaId);
    if (status === 'open') {
      const incompleteDependencies = existing.dependencyIds.filter((dependencyId) => (
        records.find((record) => record.id === dependencyId)?.status !== 'completed'
      ));
      if (incompleteDependencies.length > 0) {
        throw new PersonaDomainConflictError(
          'Finish this Task’s blockers before starting it again.',
          'PERSONA_WORK_ITEM_BLOCKED',
          { reason: 'dependencies' },
        );
      }
    }
    const now = Math.max(Date.now(), existing.updatedAt + 1);
    const candidate = PersonaWorkItemSchema.parse({
      ...existing,
      status,
      updatedAt: now,
      completedAt: undefined,
    }) as PersonaWorkItem;
    assertDependencyGraph(personaId, candidate, records);
    await lock.assertOwned();
    return savePersonaWorkItem(candidate);
  });
}

/**
 * Plain Task controls backed by durable intent. Pause/Stop save the desired
 * Task state before cancelling execution, so terminal lifecycle projection
 * cannot undo the user's choice. The Resume or retry control uses the reopened
 * Task version as an idempotent identity and therefore starts a new run after failure.
 */
export async function controlPersonaWorkItem(
  personaId: string,
  workItemId: string,
  action: PersonaWorkItemControlAction,
): Promise<PersonaWorkItemControlResult> {
  EnduringAgentIdSchema.parse(personaId);
  EnduringAgentIdSchema.parse(workItemId);
  if (!PERSONA_WORK_ITEM_CONTROL_ACTIONS.includes(action)) {
    throw new TypeError('Unknown Task control.');
  }

  const inspected = requireOwnedWorkItem(await getPersonaWorkItem(workItemId), personaId);
  const activeDispatches = await listActiveWorkItemDispatches(personaId, workItemId);

  if (action === 'move_earlier' || action === 'move_later') {
    const movement = await movePersonaWorkItemDispatch({
      personaId,
      workItemId,
      direction: action === 'move_earlier' ? 'earlier' : 'later',
    });
    if (!movement.found) {
      throw new PersonaDomainConflictError(
        'Only a waiting Task can be moved.',
        'PERSONA_WORK_ITEM_NOT_ACTIONABLE',
        { reason: 'not_queued' },
      );
    }
    return { action, workItem: inspected, moved: movement.moved };
  }

  if (action === 'pause' || action === 'stop') {
    if (action === 'pause' && inspected.status === 'blocked' && activeDispatches.length === 0) {
      return { action, workItem: inspected };
    }
    if (action === 'stop' && inspected.status === 'cancelled') {
      return { action, workItem: inspected };
    }
    if (activeDispatches.length === 0) {
      throw new PersonaDomainConflictError(
        'This Task is no longer active. Refresh the desk to see its latest state.',
        'PERSONA_WORK_ITEM_NOT_ACTIONABLE',
        { reason: 'not_active' },
      );
    }

    const intendedStatus = action === 'pause' ? 'blocked' : 'cancelled';
    await persistWorkItemControlStatus(personaId, workItemId, intendedStatus);
    await Promise.all(activeDispatches.map((dispatch) => (
      cancelPersonaFlowDispatchById({
        personaId,
        dispatchId: dispatch.id,
        reason: action === 'pause'
          ? 'This Task was paused from the Persona desk.'
          : 'This Task was stopped from the Persona desk.',
      }, { waitForCompletion: true })
    )));
    const workItem = requireOwnedWorkItem(await getPersonaWorkItem(workItemId), personaId);
    return { action, workItem };
  }

  if (inspected.status === 'completed' || inspected.status === 'cancelled') {
    throw new PersonaDomainConflictError(
      'Only paused or blocked Tasks can be started again.',
      'PERSONA_WORK_ITEM_NOT_ACTIONABLE',
      { reason: 'terminal' },
    );
  }
  if (activeDispatches.length > 0) {
    if (inspected.status === 'open' || inspected.status === 'in_progress') {
      return { action, workItem: inspected, admission: 'already_queued' };
    }
    throw new PersonaDomainConflictError(
      'This Task is still stopping. Try again in a moment.',
      'PERSONA_WORK_ITEM_NOT_ACTIONABLE',
      { reason: 'stopping' },
    );
  }

  const reopened = inspected.status === 'blocked'
    ? await persistWorkItemControlStatus(personaId, workItemId, 'open')
    : inspected;
  const attemptKey = stableEnduringAgentId('taskattempt', {
    purpose: 'persona-work-item-control-attempt-v1',
    workspaceId: getCurrentWorkspace(),
    personaId,
    workItemId,
    reopenedAt: reopened.updatedAt,
  });
  const assignment = await assignPersonaWorkItem(personaId, workItemId, {
    expectedUpdatedAt: reopened.updatedAt,
    idempotencyKey: attemptKey,
  }, { attemptKey });
  return {
    action,
    workItem: assignment.workItem,
    admission: assignment.admission,
  };
}

/**
 * Project the terminal outcome of a Task assignment Activity back onto the
 * durable WorkItem that originated it. Generic assignment Activities are
 * intentionally ignored: only an existing, same-Persona WorkItem id carried
 * by the assignment source is eligible.
 *
 * A model may have already made a more specific terminal decision while it
 * held execution authority. Preserve completed, cancelled, and blocked Tasks
 * so this fallback can never regress an explicit tool update. Otherwise a
 * successful Activity completes the Task, a failed Activity blocks it for
 * review, and a cancelled Activity cancels it.
 */
function isTerminalWorkItemAssignment(activity: PersonaActivity): boolean {
  return activity.kind === 'assignment'
    && activity.source.kind === 'assignment'
    && Boolean(activity.source.sourceId)
    && (
      activity.status === 'completed'
      || activity.status === 'error'
      || activity.status === 'cancelled'
    );
}

async function synchronizeAssignedWorkItemRecord(
  activity: PersonaActivity,
): Promise<PersonaWorkItem | null> {
  const existing = await getPersonaWorkItem(activity.source.sourceId!);
  if (!existing || existing.personaId !== activity.personaId) return null;
  if (
    existing.status === 'completed'
    || existing.status === 'cancelled'
    || existing.status === 'blocked'
  ) return existing;

  let status: PersonaWorkItemStatus = activity.status === 'completed'
    ? 'completed'
    : activity.status === 'cancelled'
      ? 'cancelled'
      : 'blocked';
  const records = await listStoredPersonaWorkItems(activity.personaId);
  if (
    status === 'completed'
    && existing.dependencyIds.some((dependencyId) => (
      records.find((record) => record.id === dependencyId)?.status !== 'completed'
    ))
  ) {
    // A Task edited during its Activity may have acquired a new unfinished
    // dependency. Keep the dependency invariant and surface it as blocked.
    status = 'blocked';
  }

  const updatedAt = Math.max(
    Date.now(),
    existing.updatedAt + 1,
    activity.updatedAt,
    activity.completedAt ?? 0,
  );
  const completedAt = status === 'completed'
    ? Math.max(existing.createdAt, activity.completedAt ?? updatedAt)
    : undefined;
  const candidate = PersonaWorkItemSchema.parse({
    ...existing,
    status,
    updatedAt,
    completedAt,
  }) as PersonaWorkItem;
  assertDependencyGraph(activity.personaId, candidate, records);
  return savePersonaWorkItem(candidate);
}

export async function synchronizeAssignedWorkItemFromActivity(
  activity: PersonaActivity,
): Promise<PersonaWorkItem | null> {
  if (!isTerminalWorkItemAssignment(activity)) return null;
  const inspected = await getPersonaWorkItem(activity.source.sourceId!);
  if (!inspected || inspected.personaId !== activity.personaId) return null;
  return withPersonaDomainMutation(activity.personaId, {}, async () => (
    synchronizeAssignedWorkItemRecord(activity)
  ));
}

/** Same projection for callers that already hold the authoritative Persona lock. */
export async function synchronizeAssignedWorkItemFromActivityWithinRuntimeLock(
  activity: PersonaActivity,
  lock: PersonaRuntimeLock,
): Promise<PersonaWorkItem | null> {
  if (!isTerminalWorkItemAssignment(activity)) return null;
  await lock.assertOwned();
  return synchronizeAssignedWorkItemRecord(activity);
}

export async function deletePersonaWorkItem(
  personaId: string,
  workItemId: string,
  options: PersonaDomainMutationOptions = {},
): Promise<void> {
  EnduringAgentIdSchema.parse(personaId);
  EnduringAgentIdSchema.parse(workItemId);
  await withPersonaDomainMutation(personaId, options, async () => {
    requireOwnedWorkItem(await getPersonaWorkItem(workItemId), personaId);
    if ((await listActiveWorkItemDispatches(personaId, workItemId)).length > 0) {
      throw new PersonaDomainConflictError(
        'This Task is still active. Stop it before deleting it.',
        'PERSONA_WORK_ITEM_ACTIVE',
        { reason: 'active_assignment' },
      );
    }
    const dependent = (await listStoredPersonaWorkItems(personaId)).find(
      (item) => item.id !== workItemId && item.dependencyIds.includes(workItemId),
    );
    if (dependent) {
      throw new PersonaDomainConflictError(
        `WorkItem is still a dependency of ${JSON.stringify(dependent.id)}.`,
      );
    }
    await deletePersonaWorkItemRecord(workItemId);
  });
}

export async function queryPersonaWorkItems(
  personaId: string,
  query: PersonaWorkItemListQuery = {},
): Promise<PersonaWorkItem[]> {
  EnduringAgentIdSchema.parse(personaId);
  const parsed = WorkItemListQuerySchema.parse(query) as PersonaWorkItemListQuery;
  const records = await listStoredPersonaWorkItems(personaId);
  const byId = new Map(records.map((item) => [item.id, item]));
  return records.filter((item) => (
    (!parsed.statuses?.length || parsed.statuses.includes(item.status))
    && (!parsed.priorities?.length || parsed.priorities.includes(item.priority))
    && (parsed.dueBefore === undefined || (item.deadline !== undefined && item.deadline <= parsed.dueBefore))
    && (parsed.includeBlockedByDependencies !== false || item.dependencyIds.every(
      (id) => byId.get(id)?.status === 'completed',
    ))
  )).sort((left, right) => (
    PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority]
    || (left.deadline ?? Number.MAX_SAFE_INTEGER) - (right.deadline ?? Number.MAX_SAFE_INTEGER)
    || right.updatedAt - left.updatedAt
    || left.id.localeCompare(right.id)
  ));
}

/** Explicitly copy one scratch todo into durable Persona work; no automatic path exists. */
export async function promoteRunTodoToWorkItem(
  personaId: string,
  input: PromoteRunTodoInput,
  options: PersonaDomainMutationOptions = {},
): Promise<PersonaWorkItem> {
  EnduringAgentIdSchema.parse(personaId);
  const parsed = PromoteRunTodoInputSchema.parse(input) as PromoteRunTodoInput;
  return withPersonaDomainMutation(personaId, options, async ({ activity: liveActivity }) => {
    const activityId = liveActivity?.id ?? parsed.activityId;
    if (!activityId) {
      throw new PersonaDomainConflictError('Todo promotion requires an owning Activity.');
    }
    if (liveActivity && parsed.activityId && parsed.activityId !== liveActivity.id) {
      throw new PersonaDomainConflictError('A live Activity cannot promote another Activity\'s todo.');
    }
    const activity = liveActivity ?? await getPersonaActivity(activityId);
    if (!activity || activity.personaId !== personaId || !activity.conversationId) {
      throw new PersonaDomainNotFoundError('PersonaActivity', activityId);
    }
    const state = await loadConversationState(activity.conversationId);
    const todo = state?.todos?.find((item) => item.id === parsed.todoId);
    if (!todo || todo.status === 'done' || todo.status === 'cancelled') {
      throw new PersonaDomainNotFoundError('Promotable run todo', parsed.todoId);
    }
    const id = stableEnduringAgentId('work', {
      purpose: 'run-todo-promotion-v1',
      workspaceId: getCurrentWorkspace(),
      personaId,
      activityId: activity.id,
      todoId: todo.id,
    });
    const existing = await getPersonaWorkItem(id);
    if (existing) return requireOwnedWorkItem(existing, personaId);

    const now = Date.now();
    const sourceRefs = normalizeMemorySourceRefs([{
      kind: 'activity',
      id: activity.id,
      uri: `flujo://activity/${activity.id}/todo/${todo.id}`,
      observedAt: todo.updatedAt,
    }], { now, producer: 'explicit-todo-promotion', digestMaterial: todo });
    return savePersonaWorkItem(PersonaWorkItemSchema.parse({
      schemaVersion: ENDURING_AGENT_SCHEMA_VERSION,
      id,
      personaId,
      title: parsed.title ?? todo.content,
      ...(parsed.description ? { description: parsed.description } : {}),
      status: todo.status === 'in_progress' ? 'in_progress' : 'open',
      priority: parsed.priority ?? 'normal',
      dependencyIds: [],
      nextAction: parsed.nextAction ?? todo.content,
      ...(parsed.deadline !== undefined ? { deadline: parsed.deadline } : {}),
      createdByActivityId: activity.id,
      ...(activity.behaviorRevisionId ? { behaviorRevisionId: activity.behaviorRevisionId } : {}),
      sourceRefs,
      createdAt: now,
      updatedAt: now,
    }) as PersonaWorkItem);
  });
}
