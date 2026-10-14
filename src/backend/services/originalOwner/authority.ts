import { AsyncLocalStorage } from 'node:async_hooks';
import type { Flow } from '@/shared/types/flow';
import type { Model } from '@/shared/types/model';
import type { PersonaLease, PersonaWorkItem } from '@/shared/types/enduringAgent';
import type { FlowExecutionAuthority } from '@/backend/execution/flow/types';
import { modelService } from '@/backend/services/model';
import {
  getBehaviorRevision, getPersona, getPersonaActivity, getPersonaLease,
  getPersonaLeaseRecord, getPersonaWorkItem,
} from '@/backend/services/enduringAgents/store';
import { canonicalJson } from '@/backend/services/enduringAgents/behaviorRevisions';
import { personaCoreAppNodeId } from '@/backend/services/enduringAgents/personaCoreAppIdentity';
import { getPersonaRuntimeClock } from '@/backend/services/enduringAgents/runtimeClock';
import { getCurrentWorkspace } from '@/utils/workspace';
import { assertOriginalApproval } from './administration';
import { readOriginalOwnerBook, mutateOriginalOwnerBook, flushOriginalOwnerBook } from './store';
import {
  accountModelPlan, bytesDigest, ownerDigest, refuse,
  type OriginalOwnerAccount, type OriginalOwnerEnrollment, type OriginalOwnerRun,
} from './types';

export interface OriginalOwnerCaptureInput {
  personaId: string; activityId: string; dispatchId: string; taskId?: string;
  revisionId: string; leaseEpoch: string; conversationId: string; runId: string; flow: Flow;
}

export interface OriginalOwnerBinding {
  readonly workspace: string; readonly ownerId: string; readonly enrollmentId: string;
  readonly accountId: string; readonly modelId: string; readonly modelDigest: string;
  readonly originalRunId: string; readonly leaseId: string; readonly leaseEpoch: string;
  readonly personaId: string; readonly taskId: string; readonly goalId: string; readonly round: number;
  readonly activityId: string; readonly dispatchId: string; readonly revisionId: string;
  readonly conversationId: string; readonly runId: string; readonly flowId: string;
  readonly planDigest: string; readonly enrollmentDigest: string; readonly accountDigest: string;
}

export interface OriginalOwnerModelPlanInput {
  nodeId: string; modelId: string; flowId?: string; flowSnapshot?: Flow;
  conversationId?: string; runId?: string;
}

export interface OriginalOwnerRunPlanInput {
  flowId?: string; flowSnapshot?: Flow; conversationId?: string; runId?: string;
}

/** Runtime-only capability. Neither a saved enrollment nor JSON is this object. */
export interface OriginalOwnerAuthority {
  readonly binding: OriginalOwnerBinding;
  readonly signal: AbortSignal;
  assertCurrent(): Promise<void>;
  assertRunPlan(input: OriginalOwnerRunPlanInput): Promise<void>;
  assertModelPlan(input: OriginalOwnerModelPlanInput): Promise<void>;
  /** Hold the genuine Persona fence across a bounded claim and effect initiation. */
  commitWhileCurrent<T>(task: (binding: OriginalOwnerBinding) => Promise<T>): Promise<T>;
}

type Captured = {
  authority: FlowExecutionAuthority; input: OriginalOwnerCaptureInput; binding: OriginalOwnerBinding;
  lease: PersonaLease; revisionDigest: string; taskDigest: string; goalDigest: string;
  activityPlanDigest: string;
};
const registryRoot = globalThis as typeof globalThis & {
  __flujoOriginalOwnerAuthorities?: {
    roots: WeakMap<object, OriginalOwnerAuthority>; capabilities: WeakSet<object>;
  };
};
const registry = registryRoot.__flujoOriginalOwnerAuthorities ??= {
  roots: new WeakMap<object, OriginalOwnerAuthority>(), capabilities: new WeakSet<object>(),
};
type HeldOriginal = { authority: FlowExecutionAuthority; active: boolean };
const heldRoot = globalThis as typeof globalThis & { __flujoOriginalOwnerFence?: AsyncLocalStorage<HeldOriginal> };
const heldOriginal = heldRoot.__flujoOriginalOwnerFence ??= new AsyncLocalStorage<HeldOriginal>();
const digest = (value: unknown) => bytesDigest(canonicalJson(value));
const clock = getPersonaRuntimeClock();

export function assertOriginalOwnerAuthority(value: unknown): asserts value is OriginalOwnerAuthority {
  if (!value || typeof value !== 'object' || !registry.capabilities.has(value) || !Object.isFrozen(value)) {
    refuse('original_owner_runtime_authority_required');
  }
}

function freezePlan<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freezePlan);
    Object.freeze(value);
  }
  return value;
}

function taskPlan(task: PersonaWorkItem) {
  return { id: task.id, personaId: task.personaId, title: task.title, description: task.description,
    parentGoalId: task.parentGoalId, behaviorRevisionId: task.behaviorRevisionId,
    dependencyIds: task.dependencyIds };
}
function goalPlan(task: PersonaWorkItem) {
  return { ...taskPlan(task), successCriteria: task.goal?.successCriteria,
    completionPolicy: task.goal?.completionPolicy };
}
function sameLease(left: PersonaLease, right: PersonaLease) {
  return left.id === right.id && left.workspaceId === right.workspaceId && left.personaId === right.personaId
    && left.activityId === right.activityId && left.holderId === right.holderId
    && left.fencingToken === right.fencingToken;
}
function leaseEpoch(lease: PersonaLease) {
  return digest({ workspaceId: lease.workspaceId, personaId: lease.personaId, activityId: lease.activityId,
    leaseId: lease.id, holderId: lease.holderId, fencingToken: lease.fencingToken });
}
function assertRecords(enrollment: OriginalOwnerEnrollment | undefined, account: OriginalOwnerAccount | undefined,
  workspace: string, personaId: string, taskId: string) {
  if (!enrollment || enrollment.state !== 'active' || enrollment.workspace !== workspace
    || enrollment.personaId !== personaId || enrollment.taskId !== taskId
    || !account || account.state !== 'active' || enrollment.accountId !== account.id
    || enrollment.modelId !== account.modelId || enrollment.ownerId !== account.ownerId
    || enrollment.approval.ownerId !== enrollment.ownerId || account.approval.ownerId !== account.ownerId) {
    refuse('original_owner_enrollment_changed');
  }
  assertOriginalApproval(enrollment.approval);
  assertOriginalApproval(account.approval);
}
function assertSavedModel(model: Model | null | undefined, account: OriginalOwnerAccount) {
  if (!model || model.id !== account.modelId || model.fallbackPolicy || model.ApiKey !== ''
    || model.ownerCredentialBinding?.ownerId !== account.ownerId
    || model.ownerCredentialBinding?.credentialId !== account.id
    || ownerDigest(accountModelPlan(model)) !== account.modelDigest) {
    refuse('original_owner_saved_model_changed');
  }
}

async function assertIntrinsicCapture(authority: FlowExecutionAuthority, input: OriginalOwnerCaptureInput) {
  const { getPersonaFlowAuthorityIdentity } = await import('@/backend/services/enduringAgents/personaDispatcher');
  const identity = getPersonaFlowAuthorityIdentity(authority);
  if (!identity || identity.workspaceId !== getCurrentWorkspace() || identity.personaId !== input.personaId
    || identity.activityId !== input.activityId || identity.dispatchId !== input.dispatchId
    || identity.taskId !== input.taskId || identity.revisionId !== input.revisionId
    || identity.leaseEpoch !== input.leaseEpoch || identity.conversationId !== input.conversationId
    || identity.runId !== input.runId || identity.flowDigest !== ownerDigest(input.flow)) {
    refuse('original_owner_dispatcher_capture_changed');
  }
}

/** Strip only the dispatcher's known App projection for comparison with its
 * immutable saved revision. This never reconnects Apps or lists their tools. */
function authoredPlan(flow: Flow, appRefs: readonly string[]) {
  const copy = structuredClone(flow);
  const appIds = new Map(appRefs.map(name => [personaCoreAppNodeId(name), name]));
  for (const node of copy.nodes) {
    if (node.type !== 'process') continue;
    const properties = node.data.properties;
    if (!properties) continue;
    if (Array.isArray(properties.mcpNodes)) {
      const remaining = properties.mcpNodes.filter(item => {
        const name = appIds.get(item.id);
        if (!name) return true;
        if (item.properties.boundServer !== name) refuse('original_owner_plan_changed');
        return false;
      });
      if (remaining.length) properties.mcpNodes = remaining;
      else delete properties.mcpNodes;
    }
    if (!Object.keys(properties).length) delete node.data.properties;
  }
  return copy;
}

async function readJoined(input: OriginalOwnerCaptureInput) {
  const dispatcher = await import('@/backend/services/enduringAgents/personaDispatcher');
  const [persona, activity, dispatch, revision, task, head] = await Promise.all([
    getPersona(input.personaId), getPersonaActivity(input.personaId, input.activityId),
    dispatcher.getPersonaFlowDispatch(input.dispatchId), getBehaviorRevision(input.revisionId),
    getPersonaWorkItem(input.personaId, input.taskId!), getPersonaLease(input.personaId),
  ]);
  if (!persona || persona.id !== input.personaId
    || ['disabled', 'sleeping', 'error'].includes(persona.lifecycleState)
    || !activity || activity.id !== input.activityId || activity.personaId !== input.personaId
    || activity.status !== 'running' || activity.interruptionRequestedAt !== undefined
    || activity.source.kind !== 'assignment' || activity.source.sourceId !== input.taskId
    || activity.behaviorRevisionId !== input.revisionId || activity.conversationId !== input.conversationId
    || activity.runId !== input.runId || !activity.leaseId
    || (activity.coreFlowRevisionId !== undefined && activity.coreFlowRevisionId !== input.revisionId)
    || (activity.coreFlowId !== undefined && activity.coreFlowId !== input.flow.id)
    || !dispatch || dispatch.id !== input.dispatchId || dispatch.workspaceId !== getCurrentWorkspace()
    || dispatch.personaId !== input.personaId || dispatch.activityId !== input.activityId
    || dispatch.behaviorRevisionId !== input.revisionId || dispatch.state !== 'running'
    || dispatch.cancellationRequestedAt !== undefined || dispatch.admission.kind !== 'assignment'
    || dispatch.admission.source.kind !== 'assignment' || dispatch.admission.source.sourceId !== input.taskId
    || dispatch.flowInput?.conversationId !== input.conversationId || dispatch.flowInput?.runId !== input.runId
    || !revision || revision.id !== input.revisionId || revision.flowSnapshot.id !== input.flow.id
    || !task || task.id !== input.taskId || task.personaId !== input.personaId
    || !['open', 'in_progress'].includes(task.status) || task.goalControlState
    || task.revokedGoalDispatchId === input.dispatchId || (!task.goal && !task.parentGoalId)
    || !head || head.id !== activity.leaseId) refuse('original_owner_dispatch_not_current');
  const [goal, lease] = await Promise.all([
    task.goal ? Promise.resolve(task) : getPersonaWorkItem(input.personaId, task.parentGoalId!),
    getPersonaLeaseRecord(activity.leaseId),
  ]);
  if (!goal?.goal || goal.personaId !== input.personaId || goal.goal.state !== 'active'
    || goal.goal.pendingTaskId !== task.id || goal.goal.pendingDispatchId !== input.dispatchId
    || !['open', 'in_progress'].includes(goal.status) || goal.goalControlState
    || !lease || !sameLease(head, lease) || lease.workspaceId !== getCurrentWorkspace()
    || lease.personaId !== input.personaId || lease.activityId !== input.activityId
    || lease.status !== 'active' || head.status !== 'active' || lease.expiresAt <= clock.now()
    || head.expiresAt <= clock.now() || leaseEpoch(lease) !== input.leaseEpoch) {
    refuse('original_owner_lease_or_goal_changed');
  }
  if (digest(authoredPlan(input.flow, activity.coreAppRefs ?? []))
    !== digest(authoredPlan(revision.flowSnapshot, activity.coreAppRefs ?? []))) refuse('original_owner_plan_changed');
  return { activity, revision, task, goal, lease };
}

async function assertCaptured(captured: Captured): Promise<void> {
  captured.authority.signal.throwIfAborted();
  if (getCurrentWorkspace() !== captured.binding.workspace) refuse('original_owner_workspace_changed');
  await assertIntrinsicCapture(captured.authority, captured.input);
  const [joined, book, model] = await Promise.all([
    readJoined(captured.input), readOriginalOwnerBook(), modelService.getModel(captured.binding.modelId),
  ]);
  const enrollment = book.enrollments.find(item => item.id === captured.binding.enrollmentId);
  const account = book.accounts.find(item => item.id === captured.binding.accountId);
  assertRecords(enrollment, account, captured.binding.workspace, captured.binding.personaId, captured.binding.taskId);
  if (digest(enrollment) !== captured.binding.enrollmentDigest || digest(account) !== captured.binding.accountDigest
    || !sameLease(joined.lease, captured.lease) || joined.goal.id !== captured.binding.goalId
    || joined.goal.goal!.rounds !== captured.binding.round || digest(joined.revision) !== captured.revisionDigest
    || digest(taskPlan(joined.task)) !== captured.taskDigest || digest(goalPlan(joined.goal)) !== captured.goalDigest
    || digest([joined.activity.coreAppRefs, joined.activity.instructionContext,
      joined.activity.instructionContextDigest]) !== captured.activityPlanDigest) refuse('original_owner_binding_changed');
  assertSavedModel(model, account!);
  captured.authority.signal.throwIfAborted();
}

function originalRunClaim(binding: OriginalOwnerBinding): OriginalOwnerRun {
  return { id: binding.originalRunId, enrollmentId: binding.enrollmentId, ownerId: binding.ownerId,
    workspace: binding.workspace, personaId: binding.personaId, taskId: binding.taskId,
    activityId: binding.activityId, dispatchId: binding.dispatchId, revisionId: binding.revisionId,
    conversationId: binding.conversationId, runId: binding.runId, modelId: binding.modelId,
    modelDigest: binding.modelDigest, flowId: binding.flowId, planDigest: binding.planDigest,
    createdAt: clock.now() };
}

/** Only the dispatcher producer calls this with its actual claimed root. The
 * complete persisted join is checked again even for a genuine branded root. */
export async function bindOriginalOwnerAuthority(authority: FlowExecutionAuthority,
  source: OriginalOwnerCaptureInput): Promise<void> {
  if (!source.taskId) return;
  const dispatcher = await import('@/backend/services/enduringAgents/personaDispatcher');
  const assertPersona: (value: unknown) => asserts value is FlowExecutionAuthority = dispatcher.assertPersonaFlowExecutionAuthority;
  assertPersona(authority);
  if (!authority.commitWhileCurrent) refuse('original_owner_persona_fence_required');
  await assertIntrinsicCapture(authority, source);
  const workspace = getCurrentWorkspace();
  const book = await readOriginalOwnerBook();
  const matches = book.enrollments.filter(item => item.state === 'active' && item.workspace === workspace
    && item.personaId === source.personaId && item.taskId === source.taskId);
  if (!matches.length) return;
  if (matches.length !== 1 || registry.roots.has(authority)) refuse('original_owner_capture_conflict');
  const enrollment = matches[0], account = book.accounts.find(item => item.id === enrollment.accountId);
  assertRecords(enrollment, account, workspace, source.personaId, source.taskId);
  // Native account execution retains its existing host contract. This producer
  // admits only the implemented Original model sender.
  if (account!.kind !== 'openai') return;
  const input = freezePlan(structuredClone(source));
  await authority.commitWhileCurrent(async () => {
    const joined = await readJoined(input);
    assertSavedModel(await modelService.getModel(account!.modelId), account!);
    const binding: OriginalOwnerBinding = Object.freeze({ workspace, ownerId: enrollment.ownerId,
      enrollmentId: enrollment.id, accountId: account!.id, modelId: account!.modelId, modelDigest: account!.modelDigest,
      originalRunId: ownerDigest([workspace, enrollment.id, source.dispatchId, source.activityId,
        source.conversationId, source.runId]), leaseId: joined.lease.id, leaseEpoch: source.leaseEpoch,
      personaId: source.personaId, taskId: source.taskId!, goalId: joined.goal.id, round: joined.goal.goal!.rounds,
      activityId: source.activityId, dispatchId: source.dispatchId, revisionId: source.revisionId,
      conversationId: source.conversationId, runId: source.runId, flowId: input.flow.id,
      planDigest: digest(input.flow), enrollmentDigest: digest(enrollment), accountDigest: digest(account) });
    const captured: Captured = { authority, input, binding, lease: structuredClone(joined.lease),
      revisionDigest: digest(joined.revision), taskDigest: digest(taskPlan(joined.task)),
      goalDigest: digest(goalPlan(joined.goal)), activityPlanDigest: digest([joined.activity.coreAppRefs,
        joined.activity.instructionContext, joined.activity.instructionContextDigest]) };
    const capability: OriginalOwnerAuthority = Object.freeze({ binding, signal: authority.signal,
      assertCurrent: async () => {
        const held = heldOriginal.getStore();
        if (held?.active && held.authority === authority) {
          await assertCaptured(captured);
          if (!held.active) refuse('original_owner_fence_expired');
          return;
        }
        await authority.assertCurrent();
        await assertCaptured(captured);
        await authority.assertCurrent();
      },
      assertRunPlan: async (plan: OriginalOwnerRunPlanInput) => {
        await capability.assertCurrent();
        if (plan.conversationId !== binding.conversationId || plan.runId !== binding.runId
          || (plan.flowId !== undefined && plan.flowId !== binding.flowId)
          || !plan.flowSnapshot || digest(plan.flowSnapshot) !== binding.planDigest) {
          refuse('original_owner_run_plan_changed');
        }
      },
      assertModelPlan: async (plan: OriginalOwnerModelPlanInput) => {
        await capability.assertCurrent();
        const node = input.flow.nodes.find(item => item.id === plan.nodeId && item.type === 'process');
        if (!node || node.data.properties?.boundModel !== plan.modelId || plan.modelId !== binding.modelId
          || (plan.flowId !== undefined && plan.flowId !== binding.flowId)
          || (plan.conversationId !== undefined && plan.conversationId !== binding.conversationId)
          || (plan.runId !== undefined && plan.runId !== binding.runId)
          || (plan.flowSnapshot !== undefined && digest(plan.flowSnapshot) !== binding.planDigest)) {
          refuse('original_owner_model_plan_changed');
        }
      },
      commitWhileCurrent: <T>(task: (value: OriginalOwnerBinding) => Promise<T>) => {
        const run = async () => {
          const held = heldOriginal.getStore();
          if (!held?.active || held.authority !== authority) refuse('original_owner_fence_required');
          await assertCaptured(captured);
          if (!held.active) refuse('original_owner_fence_expired');
          const result = await task(binding);
          await assertCaptured(captured);
          if (!held.active) refuse('original_owner_fence_expired');
          return result;
        };
        const current = heldOriginal.getStore();
        if (current?.active && current.authority === authority) return run();
        return authority.commitWhileCurrent!(async () => {
          const held: HeldOriginal = { authority, active: true };
          try { return await heldOriginal.run(held, run); }
          finally { held.active = false; }
        });
      },
    });
    // Historical provenance is durable before a runtime capability or any Flow
    // effect exists. Neither administration nor caller-supplied JSON writes it.
    // Persona owns the outer fence; private journal mutation always nests inside.
    await mutateOriginalOwnerBook(async current => {
      await assertCaptured(captured);
      const claim = originalRunClaim(binding);
      const previous = current.runs?.find(value => value.id === claim.id);
      if (previous && digest({ ...previous, createdAt: 0 }) !== digest({ ...claim, createdAt: 0 })) {
        refuse('original_owner_run_claim_changed');
      }
      if (!previous) (current.runs ??= []).push(claim);
      await flushOriginalOwnerBook();
      await assertCaptured(captured);
    });
    registry.capabilities.add(capability);
    registry.roots.set(authority, capability);
  });
}

/** No JSON lookup, task id or administrative grant can recover this capability. */
export async function getOriginalOwnerAuthority(value: unknown): Promise<OriginalOwnerAuthority | undefined> {
  if (!value || typeof value !== 'object') return undefined;
  const capability = registry.roots.get(value);
  if (!capability) return undefined;
  assertOriginalOwnerAuthority(capability);
  await capability.assertCurrent();
  return capability;
}
