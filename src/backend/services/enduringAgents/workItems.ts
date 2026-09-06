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
  getPersonaFlowDispatch,
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
  clearPersonaGoalPending,
  initialPersonaGoalState,
  notifyPersonaGoalChanged,
  projectPersonaGoalOutcome,
} from './goalRuntime';
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

  // Goal completion waits for its children, and every child inherits the
  // root's prerequisites. Include both implicit edges in cycle detection:
  // ordinary dependencyIds alone misses impossible parent/child waits.
  const childrenByGoal = new Map<string, string[]>();
  for (const item of graph.values()) {
    if (item.parentGoalId) {
      childrenByGoal.set(item.parentGoalId, [...(childrenByGoal.get(item.parentGoalId) ?? []), item.id]);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      throw new PersonaDomainConflictError('WorkItem dependencies must remain acyclic, including ongoing goal completion and inherited prerequisites.');
    }
    if (visited.has(id)) return;
    visiting.add(id);
    const item = graph.get(id);
    const dependencies = [
      ...(item?.dependencyIds ?? []),
      ...(item?.goal ? childrenByGoal.get(item.id) ?? [] : []),
      ...(item?.parentGoalId ? graph.get(item.parentGoalId)?.dependencyIds ?? [] : []),
    ];
    for (const dependencyId of dependencies) visit(dependencyId);
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
  const created = await withPersonaDomainMutation(parsed.personaId, options, async ({ activity }) => {
    const now = Date.now();
    const id = parsed.id ?? randomEnduringAgentId('work');
    const existing = await getPersonaWorkItem(parsed.personaId, id);
    if (existing) throw new PersonaDomainConflictError(`WorkItem ${JSON.stringify(id)} already exists.`);
    if (parsed.createdByActivityId && activity && parsed.createdByActivityId !== activity.id) {
      throw new PersonaDomainConflictError('A Flow cannot attribute a WorkItem to another Activity.');
    }
    const assigned = activity?.kind === 'assignment' && activity.source.sourceId
      ? await getPersonaWorkItem(parsed.personaId, activity.source.sourceId) : null;
    const inheritedGoalId = assigned?.goal ? assigned.id : assigned?.parentGoalId;
    if (inheritedGoalId && parsed.parentGoalId && parsed.parentGoalId !== inheritedGoalId) {
      throw new PersonaDomainConflictError('Tasks created during an ongoing goal must belong to that goal.');
    }
    const parentGoalId = parsed.parentGoalId ?? inheritedGoalId;
    if (parentGoalId) {
      const parent = await getPersonaWorkItem(parsed.personaId, parentGoalId);
      if (!parent?.goal || parent.goal.state !== 'active' || parsed.goal) {
        throw new PersonaDomainConflictError('A child Task requires an active ongoing goal in this Persona.');
      }
    }
    const record = PersonaWorkItemSchema.parse({
      schemaVersion: ENDURING_AGENT_SCHEMA_VERSION,
      id,
      personaId: parsed.personaId,
      title: parsed.title,
      ...(parsed.description ? { description: parsed.description } : {}),
      ...(parentGoalId ? { parentGoalId } : {}),
      ...(parsed.goal ? { goal: initialPersonaGoalState(parsed.goal, now) } : {}),
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
  if (created.goal || created.parentGoalId) notifyPersonaGoalChanged(created.personaId);
  return created;
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
    const existing = requireOwnedWorkItem(await getPersonaWorkItem(personaId, workItemId), personaId);
    if (parsed.expectedUpdatedAt !== undefined && parsed.expectedUpdatedAt !== existing.updatedAt) {
      throw new PersonaDomainConflictError('WorkItem changed since it was inspected.');
    }
    if (existing.parentGoalId && existing.goalControlState && parsed.status !== undefined && parsed.status !== existing.status) {
      throw new PersonaDomainConflictError(
        `This goal Task was ${existing.goalControlState} by its owner. Only an explicit owner control can change its lifecycle.`,
        'PERSONA_GOAL_TASK_OWNER_CONTROLLED',
      );
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
    const status = existing.goal && options.executionAuthority && parsed.status === 'blocked'
      ? 'open' : parsed.status ?? existing.status;
    const records = await listStoredPersonaWorkItems(personaId);
    if (parsed.goal && !existing.goal) {
      throw new PersonaDomainConflictError('Only an ongoing goal has continuation settings.');
    }
    if (existing.goal && parsed.status !== undefined && parsed.status !== existing.status) {
      if (existing.goal.state === 'completed' || existing.goal.state === 'stopped') {
        throw new PersonaDomainConflictError('A completed or stopped ongoing goal cannot be reopened.');
      }
      if (!options.executionAuthority && parsed.status !== 'completed') {
        throw new PersonaDomainConflictError('Use the ongoing goal Pause, Stop, or Resume controls to change its lifecycle safely.');
      }
      if (options.executionAuthority && parsed.status === 'cancelled') {
        throw new PersonaDomainConflictError('Keep an ongoing goal active and report blockers. Only its owner can stop it.');
      }
      if (options.executionAuthority && parsed.status === 'completed') {
        throw new PersonaDomainConflictError('Report verified goal success with report_activity_outcome and finish the Activity. The runtime completes the goal only after the Activity ends successfully.');
      }
    }
    if (existing.goal && status === 'completed'
      && records.some((item) => item.parentGoalId === existing.id && !['completed', 'cancelled'].includes(item.status))) {
      throw new PersonaDomainConflictError('Finish or cancel this goal’s remaining Tasks before completing the goal.');
    }
    const patchedGoal = existing.goal ? {
      ...existing.goal,
      ...(parsed.goal ?? {}),
      maxRounds: parsed.goal?.maxRounds === null ? undefined : parsed.goal?.maxRounds ?? existing.goal.maxRounds,
    } : undefined;
    const goal = patchedGoal ? {
      ...patchedGoal,
      ...(parsed.status === 'completed' ? { ...clearPersonaGoalPending(patchedGoal), state: 'completed' as const, nextRunAt: undefined } : {}),
      ...(parsed.status === 'cancelled' ? { ...clearPersonaGoalPending(patchedGoal), state: 'stopped' as const, nextRunAt: undefined } : {}),
      ...(!options.executionAuthority && parsed.status === 'blocked' ? { state: 'paused' as const, nextRunAt: undefined } : {}),
      ...(!options.executionAuthority && parsed.status === 'open' ? { state: 'active' as const, nextRunAt: now } : {}),
    } : undefined;
    const candidate = PersonaWorkItemSchema.parse({
      ...existing,
      ...(parsed.title !== undefined ? { title: parsed.title } : {}),
      description: parsed.description === null ? undefined : parsed.description ?? existing.description,
      status,
      ...(goal ? { goal } : {}),
      ...(parsed.priority !== undefined ? { priority: parsed.priority } : {}),
      ...(parsed.dependencyIds !== undefined ? { dependencyIds: parsed.dependencyIds } : {}),
      nextAction: parsed.nextAction === null ? undefined : parsed.nextAction ?? existing.nextAction,
      deadline: parsed.deadline === null ? undefined : parsed.deadline ?? existing.deadline,
      ...(parsed.status !== undefined ? { deferredUntil: undefined } : {}),
      updatedAt: now,
      completedAt: status === 'completed' ? existing.completedAt ?? now : undefined,
    }) as PersonaWorkItem;
    assertDependencyGraph(personaId, candidate, records);
    return savePersonaWorkItem(candidate);
  });
  if (parsed.priority !== undefined) {
    await reprioritizePersonaWorkItemDispatches({
      personaId,
      workItemId,
      priority: updated.priority,
    });
  }
  if (updated.goal || updated.parentGoalId) notifyPersonaGoalChanged(personaId);
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
  const inspected = requireOwnedWorkItem(await getPersonaWorkItem(personaId, workItemId), personaId);
  if (inspected.goal || inspected.parentGoalId) {
    const workItem = await withPersonaRuntimeLock(personaId, async (lock) => {
      const current = requireOwnedWorkItem(await getPersonaWorkItem(personaId, workItemId), personaId);
      const records = await listStoredPersonaWorkItems(personaId);
      assertAssignableWorkItem(current, records, parsed.expectedUpdatedAt);
      const root = current.goal ? current : records.find((item) => item.id === current.parentGoalId);
      if (!root?.goal || root.goal.state !== 'active') {
        throw new PersonaDomainConflictError('Resume this ongoing goal before assigning its work.');
      }
      const now = Math.max(Date.now(), current.updatedAt + 1, root.updatedAt + 1);
      const selected = current.deferredUntil !== undefined
        ? { ...current, deferredUntil: undefined, updatedAt: now } : current;
      await lock.assertOwned();
      if (selected !== current) await savePersonaWorkItem(selected);
      if (!root.goal.pendingAttemptKey) {
        const awakened = await savePersonaWorkItem({ ...root, updatedAt: now, goal: { ...root.goal, nextRunAt: now } });
        return root.id === selected.id ? awakened : selected;
      }
      return selected;
    });
    notifyPersonaGoalChanged(personaId);
    return { workItem, admission: 'queued' };
  }
  let workItem: PersonaWorkItem | undefined;
  const validateAdmission = async (): Promise<void> => {
    const current = requireOwnedWorkItem(await getPersonaWorkItem(personaId, workItemId), personaId);
    const records = await listStoredPersonaWorkItems(personaId);
    assertAssignableWorkItem(current, records, parsed.expectedUpdatedAt);
    if (current.parentGoalId && records.find((item) => item.id === current.parentGoalId)?.goal?.state !== 'active') {
      throw new PersonaDomainConflictError('This Task belongs to a goal that is not active.');
    }
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
    const existing = requireOwnedWorkItem(await getPersonaWorkItem(personaId, workItemId), personaId);
    const root = existing.parentGoalId ? await getPersonaWorkItem(personaId, existing.parentGoalId) : null;
    const revokedDispatchId = (status === 'blocked' || status === 'cancelled') && root?.goal?.pendingTaskId === existing.id
      ? root.goal.pendingDispatchId : undefined;
    const goalControlState = existing.parentGoalId
      ? status === 'blocked' ? 'paused' : status === 'cancelled' ? 'stopped' : undefined
      : existing.goalControlState;
    if (existing.status === status && !revokedDispatchId && existing.goalControlState === goalControlState) return existing;
    if (existing.status !== status && (existing.status === 'completed' || existing.status === 'cancelled')) {
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
      ...(revokedDispatchId ? { revokedGoalDispatchId: revokedDispatchId } : {}),
      goalControlState,
      updatedAt: now,
      completedAt: undefined,
    }) as PersonaWorkItem;
    assertDependencyGraph(personaId, candidate, records);
    await lock.assertOwned();
    const saved = await savePersonaWorkItem(candidate);
    if (revokedDispatchId && root?.goal?.state === 'active') {
      // Child first: its exact revocation fences live commits even if the
      // process exits before releasing this pending round. Native Task updates
      // do not write this marker, so their outcome reporting remains valid.
      await savePersonaWorkItem({ ...root, updatedAt: Math.max(now, root.updatedAt + 1),
        goal: { ...clearPersonaGoalPending(root.goal), nextRunAt: now } });
    }
    return saved;
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

  const inspected = requireOwnedWorkItem(await getPersonaWorkItem(personaId, workItemId), personaId);
  if (inspected.goal && action !== 'move_earlier' && action !== 'move_later') {
    const { workItem, dispatches } = await withPersonaRuntimeLock(personaId, async (lock) => {
      const current = requireOwnedWorkItem(await getPersonaWorkItem(personaId, workItemId), personaId);
      if (!current.goal) throw new PersonaDomainConflictError('This ongoing goal no longer exists.');
      if ((current.goal.state === 'completed' || current.goal.state === 'stopped')
        && !(action === 'stop' && current.goal.state === 'stopped')) {
        throw new PersonaDomainConflictError('A completed or stopped goal cannot be resumed.');
      }
      const records = await listStoredPersonaWorkItems(personaId);
      const ownedTaskIds = new Set([workItemId, ...records.filter((item) => item.parentGoalId === workItemId).map((item) => item.id)]);
      const dispatches = (await listPersonaFlowDispatches(personaId)).filter((record) => (
        record.admission.kind === 'assignment' && ownedTaskIds.has(record.admission.source.sourceId ?? '')
        && !['completed', 'error', 'cancelled'].includes(record.state)
      ));
      if (dispatches.length === 0 && ((action === 'stop' && current.goal.state === 'stopped')
        || (action === 'pause' && current.goal.state === 'paused'))) return { workItem: current, dispatches };
      if (action === 'retry' && dispatches.length > 0) {
        if (current.goal.state === 'active') return { workItem: current, dispatches: [] };
        throw new PersonaDomainConflictError('The previous goal round is still stopping. Try again shortly.');
      }
      const now = Math.max(Date.now(), current.updatedAt + 1);
      const workItem = PersonaWorkItemSchema.parse({
        ...current,
        status: action === 'stop' ? 'cancelled' : action === 'pause' ? 'blocked' : 'open',
        goal: {
          ...clearPersonaGoalPending(current.goal),
          state: action === 'stop' ? 'stopped' : action === 'pause' ? 'paused' : 'active',
          nextRunAt: action === 'retry' ? now : undefined,
          ...(action === 'retry' ? { consecutiveFailures: 0, interventionReason: undefined } : {}),
        },
        updatedAt: now,
        completedAt: undefined,
      }) as PersonaWorkItem;
      await lock.assertOwned();
      await savePersonaWorkItem(workItem);
      return { workItem, dispatches };
    });
    if (action === 'pause' || action === 'stop') {
      await Promise.all(dispatches.map((dispatch) => cancelPersonaFlowDispatchById({
        personaId, dispatchId: dispatch.id,
        reason: action === 'pause' ? 'The ongoing goal was paused.' : 'The ongoing goal was stopped.',
      }, { waitForCompletion: true })));
    } else notifyPersonaGoalChanged(personaId);
    return { action, workItem, ...(action === 'retry' ? { admission: 'queued' as const } : {}) };
  }
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
    if (action === 'pause' && inspected.status === 'blocked' && activeDispatches.length === 0
      && (!inspected.parentGoalId || inspected.goalControlState === 'paused')) {
      return { action, workItem: inspected };
    }
    if (action === 'stop' && inspected.status === 'cancelled' && activeDispatches.length === 0
      && (!inspected.parentGoalId || inspected.goalControlState === 'stopped')) {
      return { action, workItem: inspected };
    }
    if (activeDispatches.length === 0 && !inspected.parentGoalId) {
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
    if (inspected.parentGoalId) notifyPersonaGoalChanged(personaId);
    const workItem = requireOwnedWorkItem(await getPersonaWorkItem(personaId, workItemId), personaId);
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
  const existing = await getPersonaWorkItem(activity.personaId, activity.source.sourceId!);
  if (!existing || existing.personaId !== activity.personaId) return null;
  if (existing.goal || existing.parentGoalId) {
    const root = existing.goal ? existing : await getPersonaWorkItem(activity.personaId, existing.parentGoalId!);
    if (!root?.goal || root.goal.state !== 'active' || root.goal.pendingTaskId !== existing.id) return existing;
    const dispatchId = root.goal.pendingDispatchId;
    if (!dispatchId || (activity.entryPointPayloadRef !== dispatchId
      && (await getPersonaFlowDispatch(dispatchId))?.activityId !== activity.id)) return existing;
    const records = await listStoredPersonaWorkItems(activity.personaId);
    const now = Math.max(Date.now(), root.updatedAt + 1, existing.updatedAt + 1, activity.completedAt ?? 0);
    const projected = projectPersonaGoalOutcome(root, existing, activity, records, now);
    if (projected.root === root) return existing;
    let task = existing;
    if (existing.id !== root.id && !['completed', 'cancelled', 'blocked'].includes(existing.status)) {
      task = PersonaWorkItemSchema.parse({ ...existing, status: projected.taskStatus,
        nextAction: activity.outcome?.nextAction ?? existing.nextAction,
        deferredUntil: projected.taskDeferredUntil,
        updatedAt: now, completedAt: projected.taskStatus === 'completed' ? now : undefined }) as PersonaWorkItem;
      assertDependencyGraph(activity.personaId, task, records);
      await savePersonaWorkItem(task);
    }
    // Child first, root last: replaying a crash prefix reuses the same pending dispatch.
    await savePersonaWorkItem(projected.root);
    notifyPersonaGoalChanged(activity.personaId);
    return existing.id === root.id ? projected.root : task;
  }
  if (
    existing.status === 'completed'
    || existing.status === 'cancelled'
    || existing.status === 'blocked'
  ) return existing;

  // Runtime completion is not product success. Only a trusted semantic success
  // may auto-complete an assignment; partial/blocked/failed/unknown outcomes
  // remain blocked until an explicit Task mutation or user decision wins.
  let status: PersonaWorkItemStatus = activity.status === 'completed'
    && activity.outcome?.resolution === 'succeeded'
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
    ...(status === 'blocked'
      ? {
          nextAction: activity.outcome?.nextAction
            ?? existing.nextAction
            ?? 'Review the Activity result and decide the next safe action.',
        }
      : {}),
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
  const inspected = await getPersonaWorkItem(activity.personaId, activity.source.sourceId!);
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
    const existing = requireOwnedWorkItem(await getPersonaWorkItem(personaId, workItemId), personaId);
    const root = existing.goal ? existing : existing.parentGoalId
      ? await getPersonaWorkItem(personaId, existing.parentGoalId) : null;
    if (existing.goal?.state === 'active' || root?.goal?.pendingTaskId === workItemId) {
      throw new PersonaDomainConflictError(
        'Stop this ongoing goal before deleting its active or reserved Task.',
        'PERSONA_WORK_ITEM_ACTIVE',
        { reason: 'active_goal_round' },
      );
    }
    if ((await listActiveWorkItemDispatches(personaId, workItemId)).length > 0) {
      throw new PersonaDomainConflictError(
        'This Task is still active. Stop it before deleting it.',
        'PERSONA_WORK_ITEM_ACTIVE',
        { reason: 'active_assignment' },
      );
    }
    const dependent = (await listStoredPersonaWorkItems(personaId)).find(
      (item) => item.id !== workItemId && (item.dependencyIds.includes(workItemId) || item.parentGoalId === workItemId),
    );
    if (dependent) {
      throw new PersonaDomainConflictError(
        `WorkItem is still a dependency of ${JSON.stringify(dependent.id)}.`,
      );
    }
    await deletePersonaWorkItemRecord(personaId, workItemId);
  });
}

export async function queryPersonaWorkItems(
  personaId: string,
  query: PersonaWorkItemListQuery = {},
): Promise<PersonaWorkItem[]> {
  EnduringAgentIdSchema.parse(personaId);
  const parsed = WorkItemListQuerySchema.parse(query) as PersonaWorkItemListQuery;
  const records = await listStoredPersonaWorkItems(personaId, {
    statuses: parsed.statuses,
    priorities: parsed.priorities,
    dueBefore: parsed.dueBefore,
  });
  const dependencyRecords = parsed.includeBlockedByDependencies === false
    ? await listStoredPersonaWorkItems(personaId)
    : records;
  const byId = new Map(dependencyRecords.map((item) => [item.id, item]));
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
    const activity = liveActivity ?? await getPersonaActivity(personaId, activityId);
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
    const existing = await getPersonaWorkItem(personaId, id);
    if (existing) return requireOwnedWorkItem(existing, personaId);

    const now = Date.now();
    const sourceRefs = normalizeMemorySourceRefs([{
      kind: 'activity',
      id: activity.id,
      uri: `flujo://activity/${activity.id}/todo/${todo.id}`,
      observedAt: todo.updatedAt,
    }], { now, producer: 'explicit-todo-promotion', digestMaterial: todo });
    const assigned = activity.kind === 'assignment' && activity.source.sourceId
      ? await getPersonaWorkItem(personaId, activity.source.sourceId) : null;
    const parentGoalId = assigned?.goal ? assigned.id : assigned?.parentGoalId;
    if (parentGoalId) {
      const parent = await getPersonaWorkItem(personaId, parentGoalId);
      if (parent?.goal?.state !== 'active') {
        throw new PersonaDomainConflictError('The ongoing goal is no longer active.');
      }
      notifyPersonaGoalChanged(personaId);
    }
    return savePersonaWorkItem(PersonaWorkItemSchema.parse({
      schemaVersion: ENDURING_AGENT_SCHEMA_VERSION,
      id,
      personaId,
      title: parsed.title ?? todo.content,
      ...(parentGoalId ? { parentGoalId } : {}),
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
