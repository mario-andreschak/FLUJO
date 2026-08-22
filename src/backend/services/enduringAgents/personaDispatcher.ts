import { createHash, randomUUID } from 'crypto';

import { z } from 'zod';

import {
  runFlow,
  type FlowRunInput,
  type FlowRunResult,
} from '@/backend/execution/flow/runFlow';
import { readConversationLog } from '@/backend/execution/flow/conversationLog';
import { buildBehaviorToolRegistry } from '@/backend/execution/flow/handlers/behaviorToolInvocation';
import {
  enqueueSteeringMessage,
  peekSteeringMessages,
} from '@/backend/execution/flow/steeringInbox';
import {
  FLOW_INVOCATION_SOURCES,
  type FlowExecutionAuthority,
  type SharedState,
} from '@/backend/execution/flow/types';
import type { FlujoChatMessage } from '@/shared/types/chat';
import type { Flow } from '@/shared/types/flow';
import {
  PERSONA_MEMORY_GATEWAY_SERVER,
  PERSONA_MEMORY_MAINTENANCE_COMMIT_TOOL,
} from '@/shared/types/enduringAgent/personaMemoryGateway';
import {
  EnduringAgentIdSchema,
  MemorySourceRefSchema,
  PERSONA_ACTIVITY_KINDS,
  PERSONA_ACTIVITY_BLOCKER_KINDS,
  PERSONA_ACTIVITY_OUTCOME_RESOLUTIONS,
  PERSONA_ACTIVITY_SOURCE_KINDS,
  PERSONA_PRIORITIES,
  PersonaInstructionContextSchema,
  type BehaviorMaintenanceRun,
  type BehaviorRevision,
  type MemoryItem,
  type Persona,
  type PersonaActivity,
  type PersonaActivityKind,
  type PersonaActivityOutcome,
  type PersonaActivitySource,
  type PersonaAttribution,
  type PersonaInstructionContext,
  type PersonaLease,
  type PersonaMailboxItem,
  type PersonaPriority,
  type RoleVersion,
} from '@/shared/types/enduringAgent';
import {
  assertSafeCollectionId,
  listCollectionItemEntriesStrict,
  loadCollectionItem,
  saveCollectionItem,
} from '@/utils/storage/backend';
import { createLogger } from '@/utils/logger';
import {
  getCurrentWorkspace,
  runWithWorkspace,
} from '@/utils/workspace';

import {
  PersonaBusyError,
  acknowledgePersonaActivityDelivery,
  assertPersonaActivityLease,
  cancelPersonaMailboxItem,
  claimNextPersonaActivity,
  commitWithPersonaActivityLease,
  commitPersonaActivityMutation,
  completePersonaActivity,
  completePersonaActivityWithinRuntimeLock,
  listPendingPersonaActivityDeliveries,
  movePersonaMailboxItemWithinRuntimeLock,
  persistPersonaActivitySnapshot,
  reprioritizePersonaMailboxItemWithinRuntimeLock,
  observeYieldedPersonaActivity,
  releasePersonaActivityLease,
  rejectPersonaActivityDelivery,
  renewPersonaActivityLease,
  routePersonaMailboxItem,
  observeCompletedPersonaActivity,
  updatePersonaActivityReferences,
  yieldPersonaActivityForInterruption,
  yieldPersonaActivityForInterruptionWithinRuntimeLock,
  type PersonaActivityClaim,
  type CompletedPersonaActivity,
  type PersonaLeaseFence,
  type PersonaMailboxAdmissionOptions,
  type PersonaMailboxRouteDecision,
  type RoutePersonaMailboxResult,
} from './activityRuntime';
import { canonicalJson } from './behaviorRevisions';
import {
  admitBehaviorMaintenanceRun,
  reconcileBehaviorMaintenanceRuns,
} from './behaviorMaintenance';
import { recordBehaviorOutcomeSampleSafely } from './behaviorOutcome';
import { ENDURING_AGENT_COLLECTIONS } from './collections';
import {
  createPersonaActivitySnapshot,
  readPersonaActivityInstructionContext,
} from './personaActivitySnapshot';
import {
  authorizePersonaCoreAppAccess,
  isPersonaCoreAppNodeId,
  projectPersonaCoreAppsIntoFlow,
  snapshotPersonaCoreAppRefs,
} from './personaCoreApps';
import { stableEnduringAgentId } from './ids';
import { buildPersonaInstructionContext } from './personaInstructionContext';
import { getCoreMemory } from './memoryKernel';
import {
  MemoryMaintenancePlanSchema,
  MemoryMaintenanceResultSchema,
  aggregateMemoryMaintenanceResults,
  buildMemoryMaintenancePlan,
  persistMemoryMaintenanceOutput,
  persistMemoryMaintenanceProposal,
  renderMemoryMaintenanceConversationMessage,
  renderMemoryMaintenancePrompt,
  type MemoryMaintenancePlan,
  type MemoryMaintenanceResult,
} from './memoryMaintenance';
import { getPersonaRuntimeClock, type PersonaRuntimeTimer } from './runtimeClock';
import {
  withPersonaRuntimeLock,
  type PersonaRuntimeLock,
} from './runtimeLock';
import {
  getBehaviorRevision,
  getPersona,
  getPersonaActivity,
  getPersonaMailboxItem,
  getRoleVersion,
} from './store';

const runtimeClock = getPersonaRuntimeClock();

const log = createLogger('backend/services/enduringAgents/personaDispatcher');

/**
 * This is a private persistence contract. It deliberately does not reuse the
 * public enduring-agent schema version: a dispatcher envelope can evolve
 * without changing any public Persona record.
 */
export const PERSONA_FLOW_DISPATCH_SCHEMA_VERSION = 1 as const;
export const DEFAULT_PERSONA_FLOW_LEASE_TTL_MS = 30_000;
const MAX_OUTCOME_TEXT = 20_000;
const MAX_ERROR_TEXT = 4_000;
const PERSONA_OUTCOME_TAG = /<persona_activity_outcome>([\s\S]{1,12000}?)<\/persona_activity_outcome>/i;
const PersonaOutcomeClaimSchema = z.object({
  resolution: z.enum(PERSONA_ACTIVITY_OUTCOME_RESOLUTIONS),
  blockerKind: z.enum(PERSONA_ACTIVITY_BLOCKER_KINDS).optional(),
  summary: z.string().trim().min(1).max(2_000).optional(),
  nextAction: z.string().trim().min(1).max(2_000).optional(),
  evidenceRefs: z.array(MemorySourceRefSchema).max(24).default([]),
}).strict();

export function semanticOutcomeFromDispatch(input: {
  status: 'completed' | 'cancelled' | 'error';
  outcome?: PersonaFlowDispatchOutcome;
  activityId: string;
  decidedAt: number;
}): PersonaActivityOutcome {
  const fallbackResolution = input.status === 'error' ? 'failed' : 'unknown';
  const fallback = (summary: string): PersonaActivityOutcome => ({
    schemaVersion: 1,
    resolution: fallbackResolution,
    ...(input.status === 'error' ? { blockerKind: 'unknown' as const } : {}),
    summary,
    decisionSource: 'engine',
    evidenceRefs: [{ kind: 'activity', id: input.activityId }],
    decidedAt: input.decidedAt,
  });
  if (input.status !== 'completed' || !input.outcome?.outputText) {
    return fallback(input.status === 'error'
      ? 'The Activity ended with an execution error.'
      : 'The Activity ended without a trusted semantic outcome claim.');
  }
  const match = PERSONA_OUTCOME_TAG.exec(input.outcome.outputText);
  if (!match) {
    return fallback('The Activity completed without a trusted semantic outcome claim.');
  }
  try {
    const claim = PersonaOutcomeClaimSchema.parse(JSON.parse(match[1]));
    if (claim.evidenceRefs.some((ref) => ref.kind !== 'activity' || ref.id !== input.activityId)) {
      return fallback('The Activity outcome claim referenced evidence outside the owning Activity.');
    }
    return {
      schemaVersion: 1,
      resolution: claim.resolution,
      ...(claim.blockerKind ? { blockerKind: claim.blockerKind } : {}),
      ...(claim.summary ? { summary: claim.summary } : {}),
      ...(claim.nextAction ? { nextAction: claim.nextAction } : {}),
      decisionSource: 'persona_claim',
      evidenceRefs: claim.evidenceRefs.length > 0
        ? claim.evidenceRefs
        : [{ kind: 'activity', id: input.activityId }],
      decidedAt: input.decidedAt,
    };
  } catch {
    return fallback('The Activity outcome claim was malformed and was downgraded to unknown.');
  }
}

export const PERSONA_FLOW_DISPATCH_STATES = [
  'queued',
  'running',
  'waiting',
  'completed',
  'error',
  'cancelled',
] as const;
export type PersonaFlowDispatchState = (typeof PERSONA_FLOW_DISPATCH_STATES)[number];

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/**
 * The only FlowRunInput fields allowed onto disk. Resolution and authority are
 * intentionally absent: flowId/modelName/flowDefinition are replaced with the
 * Activity-pinned Behavior snapshot, while emit/abortSignal/executionAuthority
 * remain process-local capabilities.
 */
export type SerializablePersonaFlowRunInput = Pick<
  FlowRunInput,
  | 'messages'
  | 'mcpAppContexts'
  | 'prompt'
  | 'processNodeId'
  | 'variables'
  | 'mode'
  | 'conversationId'
  | 'runId'
  | 'title'
  | 'flujo'
  | 'requireApproval'
  | 'debug'
  | 'continueDebug'
  | 'userTurn'
  | 'parentRunId'
  | 'lane'
  | 'depth'
  | 'source'
  | 'plannedExecutionId'
  | 'plannedExecutionName'
  | 'chainDepth'
  | 'onApprovalRequired'
  | 'meetingParticipant'
  | 'meetingTurn'
>;

export interface PersonaFlowDispatchAdmission {
  kind: PersonaActivityKind;
  priority: PersonaPriority;
  source: Omit<PersonaActivitySource, 'idempotencyKey'>;
  behaviorSlotKey?: string;
  relationKey?: string;
  relatedAction?: 'steer' | 'coalesce';
  summary?: string;
  notBefore?: number;
}

export interface PersonaFlowDispatchOutcome {
  status:
    | FlowRunResult['status']
    | 'steered'
    | 'coalesced';
  conversationId?: string;
  runId?: string;
  outputText?: string;
  finalAction?: string;
  personaId: string;
  activityId: string;
  behaviorRevisionId: string;
}

export interface PersonaFlowDispatchError {
  code: string;
  message: string;
  at: number;
}

export interface PersonaFlowDispatchRecord {
  schemaVersion: typeof PERSONA_FLOW_DISPATCH_SCHEMA_VERSION;
  id: string;
  workspaceId: string;
  personaId: string;
  /** SHA-256 only. Raw retry tokens never enter the private envelope. */
  idempotencyDigest: string;
  /** Detects a changed retry without persisting the caller's raw key. */
  requestHash: string;
  state: PersonaFlowDispatchState;
  admission: PersonaFlowDispatchAdmission;
  flowInput?: SerializablePersonaFlowRunInput;
  mailboxItemId?: string;
  routingDecision?: PersonaMailboxRouteDecision;
  targetActivityId?: string;
  activityId?: string;
  behaviorRevisionId?: string;
  /** Frozen trusted identity/mission context for this exact Activity. */
  instructionContext?: PersonaInstructionContext;
  /** Private, bounded evidence plan for a restricted maintenance Activity. */
  maintenancePlan?: MemoryMaintenancePlan;
  /** Durable, inspectable validation and persistence outcome for maintenance output. */
  maintenanceResult?: MemoryMaintenanceResult;
  /** Frozen from the first-activation Role; zero means no authored maintenance Flow. */
  memoryCandidateLimit?: number;
  waitingReason?: 'delivery' | 'approval' | 'debug' | 'running' | 'interrupted';
  /** Durable, scoped lifecycle intent. No lease, holder, or fencing data lives here. */
  cancellationRequestedAt?: number;
  cancellationReason?: string;
  /** Resume metadata makes a lost process-local preparation fail closed. */
  resumeRequestedAt?: number;
  resumeSettledAt?: number;
  resumeReason?: 'approval' | 'debug' | 'manual';
  resumeFromWaitingReason?: 'approval' | 'debug' | 'running' | 'interrupted';
  resumePreparationRequired?: boolean;
  outcome?: PersonaFlowDispatchOutcome;
  error?: PersonaFlowDispatchError;
  /** A recoverable routing/startup error; unlike `error`, it is non-terminal. */
  lastError?: PersonaFlowDispatchError;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  compactedAt?: number;
}

export interface SubmitPersonaFlowDispatchInput {
  /** Optional assertion for callers already carrying a workspace identity. */
  workspaceId?: string;
  personaId: string;
  idempotencyKey: string;
  kind: PersonaActivityKind;
  priority?: PersonaPriority;
  source: PersonaActivitySource;
  behaviorSlotKey?: string;
  relationKey?: string;
  relatedAction?: 'steer' | 'coalesce';
  summary?: string;
  notBefore?: number;
  flowInput: SerializablePersonaFlowRunInput;
  /** Trusted orchestration only; ordinary callers leave this absent. */
  maintenancePlan?: MemoryMaintenancePlan;
}

export interface SubmitPersonaFlowDispatchOptions {
  waitForCompletion?: boolean;
  /** Persist and route the envelope without starting execution when false. */
  startPump?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Trusted domain precondition checked under the Persona lock before persistence and admission. */
  validateAdmission?: () => Promise<void>;
}

export interface WaitForPersonaFlowDispatchOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface PersonaFlowDispatchSubmission {
  dispatch: PersonaFlowDispatchRecord;
  decision: PersonaMailboxRouteDecision;
  /** True when this submission reused an existing durable mailbox admission. */
  duplicate?: boolean;
}

export interface PersonaFlowDispatchIdentity extends PersonaAttribution {
  workspaceId?: string;
  activityId: string;
  behaviorRevisionId: string;
  conversationId?: string;
}

export interface PersonaFlowResumeContext {
  /** A safe snapshot of dispatch attribution; it never contains a lease fence. */
  readonly dispatch: PersonaFlowDispatchRecord;
  /** Runtime-only authority suitable for guarded state persistence/tool dispatch. */
  readonly executionAuthority: FlowExecutionAuthority;
  /** Installs authority non-enumerably so persistence cannot serialize it. */
  installExecutionAuthority(state: SharedState): void;
}

export type PersonaFlowResumePreparationResult = 'resume' | 'yield' | void;

export interface ResumePersonaFlowDispatchInput extends PersonaFlowDispatchIdentity {
  reason?: 'approval' | 'debug' | 'manual';
  flowInputPatch?: Partial<SerializablePersonaFlowRunInput>;
  prepare?: (
    context: PersonaFlowResumeContext,
  ) => Promise<PersonaFlowResumePreparationResult> | PersonaFlowResumePreparationResult;
}

export interface ResumePersonaFlowDispatchOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CancelPersonaFlowDispatchInput extends PersonaFlowDispatchIdentity {
  reason?: string;
}

export interface CancelPersonaFlowDispatchByIdInput {
  personaId: string;
  dispatchId: string;
  reason?: string;
}

export interface ReprioritizePersonaWorkItemDispatchInput {
  personaId: string;
  workItemId: string;
  priority: PersonaPriority;
}

export interface MovePersonaWorkItemDispatchInput {
  personaId: string;
  workItemId: string;
  direction: 'earlier' | 'later';
}

export interface MovePersonaWorkItemDispatchResult {
  found: boolean;
  moved: boolean;
}

export interface CancelPersonaFlowDispatchOptions extends WaitForPersonaFlowDispatchOptions {
  waitForCompletion?: boolean;
}

export class PersonaFlowDispatchConflictError extends Error {
  readonly code = 'PERSONA_FLOW_DISPATCH_CONFLICT' as const;

  constructor(readonly dispatchId: string) {
    super(`Persona Flow dispatch ${JSON.stringify(dispatchId)} was retried with different content.`);
    this.name = 'PersonaFlowDispatchConflictError';
  }
}

export class PersonaFlowDispatchCorruptionError extends Error {
  readonly code = 'PERSONA_FLOW_DISPATCH_CORRUPT' as const;

  constructor(readonly dispatchId: string, message: string) {
    super(message);
    this.name = 'PersonaFlowDispatchCorruptionError';
  }
}

export class PersonaFlowDispatchTimeoutError extends Error {
  readonly code = 'PERSONA_FLOW_DISPATCH_TIMEOUT' as const;

  constructor(readonly dispatchId: string) {
    super(`Timed out waiting for Persona Flow dispatch ${JSON.stringify(dispatchId)}.`);
    this.name = 'PersonaFlowDispatchTimeoutError';
  }
}

export class PersonaFlowDispatcherQuiescedError extends Error {
  readonly code = 'PERSONA_FLOW_DISPATCHER_QUIESCED' as const;

  constructor(readonly personaId: string) {
    super(`Persona Flow dispatcher for ${JSON.stringify(personaId)} is quiesced.`);
    this.name = 'PersonaFlowDispatcherQuiescedError';
  }
}

export class PersonaFlowDispatchNotFoundError extends Error {
  readonly code = 'PERSONA_FLOW_DISPATCH_NOT_FOUND' as const;

  constructor(readonly identity: PersonaFlowDispatchIdentity) {
    super('No owning Persona Flow dispatch matches the persisted conversation attribution.');
    this.name = 'PersonaFlowDispatchNotFoundError';
  }
}

export class PersonaFlowDispatchIdNotFoundError extends Error {
  readonly code = 'PERSONA_FLOW_DISPATCH_NOT_FOUND' as const;

  constructor(
    readonly personaId: string,
    readonly dispatchId: string,
  ) {
    super('No matching Persona work run was found.');
    this.name = 'PersonaFlowDispatchIdNotFoundError';
  }
}

export class PersonaFlowDispatchAttributionError extends Error {
  readonly code = 'PERSONA_FLOW_DISPATCH_ATTRIBUTION_MISMATCH' as const;

  constructor(message: string) {
    super(message);
    this.name = 'PersonaFlowDispatchAttributionError';
  }
}

export class PersonaFlowDispatchStateError extends Error {
  readonly code = 'PERSONA_FLOW_DISPATCH_INVALID_STATE' as const;

  constructor(readonly dispatchId: string, readonly state: PersonaFlowDispatchState) {
    super(`Persona Flow dispatch ${JSON.stringify(dispatchId)} cannot be resumed from ${state}.`);
    this.name = 'PersonaFlowDispatchStateError';
  }
}

function isPlainJsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
  ) return true;
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.every((item) => isPlainJsonValue(item, seen));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Object.values(value).every((item) => isPlainJsonValue(item, seen));
  } finally {
    seen.delete(value);
  }
}

const JsonValueSchema = z.unknown().refine(isPlainJsonValue, {
  message: 'Value must be plain JSON without cycles, undefined values, or non-finite numbers.',
});

const SerializableFlowRunInputSchema = z.object({
  messages: z.array(JsonValueSchema).optional(),
  mcpAppContexts: JsonValueSchema.optional(),
  prompt: z.string().optional(),
  processNodeId: z.string().trim().min(1).optional(),
  variables: z.record(z.string(), JsonValueSchema).optional(),
  mode: z.enum(['ephemeral', 'conversation']).optional(),
  conversationId: EnduringAgentIdSchema.optional(),
  runId: EnduringAgentIdSchema.optional(),
  title: z.string().optional(),
  flujo: z.boolean().optional(),
  requireApproval: z.boolean().optional(),
  debug: z.boolean().optional(),
  continueDebug: z.boolean().optional(),
  userTurn: z.boolean().optional(),
  parentRunId: EnduringAgentIdSchema.optional(),
  lane: JsonValueSchema.optional(),
  depth: z.number().int().nonnegative().optional(),
  source: z.enum(FLOW_INVOCATION_SOURCES),
  plannedExecutionId: EnduringAgentIdSchema.optional(),
  plannedExecutionName: z.string().optional(),
  chainDepth: z.number().int().nonnegative().optional(),
  onApprovalRequired: z.enum(['auto', 'fail', 'pause']).optional(),
  meetingParticipant: JsonValueSchema.optional(),
  meetingTurn: JsonValueSchema.optional(),
}).strict().superRefine((input, ctx) => {
  if (input.source === 'meeting' && (!input.meetingParticipant || !input.meetingTurn)) {
    ctx.addIssue({
      code: 'custom',
      message: 'Meeting dispatches require meetingParticipant and meetingTurn.',
    });
  }
});

const DispatchAdmissionSchema = z.object({
  kind: z.enum(PERSONA_ACTIVITY_KINDS),
  priority: z.enum(PERSONA_PRIORITIES),
  source: z.object({
    kind: z.enum(PERSONA_ACTIVITY_SOURCE_KINDS),
    sourceId: z.string().trim().min(1).max(512).optional(),
  }).strict(),
  behaviorSlotKey: z.string().trim().min(1).max(128).optional(),
  relationKey: z.string().trim().min(1).max(512).optional(),
  relatedAction: z.enum(['steer', 'coalesce']).optional(),
  summary: z.string().trim().max(20_000).optional(),
  notBefore: z.number().int().nonnegative().optional(),
}).strict().superRefine((input, ctx) => {
  if (input.relatedAction && !input.relationKey) {
    ctx.addIssue({
      code: 'custom',
      message: 'relatedAction requires relationKey.',
      path: ['relationKey'],
    });
  }
});

const DispatchErrorSchema = z.object({
  code: z.string().trim().min(1).max(128),
  message: z.string().trim().min(1).max(MAX_ERROR_TEXT),
  at: z.number().int().nonnegative(),
}).strict();

const DispatchOutcomeSchema = z.object({
  status: z.enum([
    'completed',
    'error',
    'awaiting_tool_approval',
    'paused_debug',
    'running',
    'capped',
    'steered',
    'coalesced',
  ]),
  conversationId: EnduringAgentIdSchema.optional(),
  runId: EnduringAgentIdSchema.optional(),
  outputText: z.string().max(MAX_OUTCOME_TEXT).optional(),
  finalAction: z.string().max(512).optional(),
  personaId: EnduringAgentIdSchema,
  activityId: EnduringAgentIdSchema,
  behaviorRevisionId: EnduringAgentIdSchema,
}).strict();

const PersonaFlowDispatchRecordSchema = z.object({
  schemaVersion: z.literal(PERSONA_FLOW_DISPATCH_SCHEMA_VERSION),
  id: EnduringAgentIdSchema,
  workspaceId: z.string().trim().min(1).max(256),
  personaId: EnduringAgentIdSchema,
  idempotencyDigest: z.string().regex(/^[a-f0-9]{64}$/),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(PERSONA_FLOW_DISPATCH_STATES),
  admission: DispatchAdmissionSchema,
  flowInput: SerializableFlowRunInputSchema.optional(),
  mailboxItemId: EnduringAgentIdSchema.optional(),
  routingDecision: z.enum([
    'duplicate',
    'queued',
    'steered',
    'coalesced',
    'interrupt_requested',
  ]).optional(),
  targetActivityId: EnduringAgentIdSchema.optional(),
  activityId: EnduringAgentIdSchema.optional(),
  behaviorRevisionId: EnduringAgentIdSchema.optional(),
  instructionContext: PersonaInstructionContextSchema.optional(),
  maintenancePlan: MemoryMaintenancePlanSchema.optional(),
  maintenanceResult: MemoryMaintenanceResultSchema.optional(),
  memoryCandidateLimit: z.number().int().min(0).max(3).optional(),
  waitingReason: z.enum(['delivery', 'approval', 'debug', 'running', 'interrupted']).optional(),
  cancellationRequestedAt: z.number().int().nonnegative().optional(),
  cancellationReason: z.string().trim().min(1).max(512).optional(),
  resumeRequestedAt: z.number().int().nonnegative().optional(),
  resumeSettledAt: z.number().int().nonnegative().optional(),
  resumeReason: z.enum(['approval', 'debug', 'manual']).optional(),
  resumeFromWaitingReason: z.enum(['approval', 'debug', 'running', 'interrupted']).optional(),
  resumePreparationRequired: z.boolean().optional(),
  outcome: DispatchOutcomeSchema.optional(),
  error: DispatchErrorSchema.optional(),
  lastError: DispatchErrorSchema.optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  startedAt: z.number().int().nonnegative().optional(),
  completedAt: z.number().int().nonnegative().optional(),
}).strict().superRefine((record, ctx) => {
  if (!record.flowInput && record.state !== 'error') {
    ctx.addIssue({ code: 'custom', message: 'Only an error recovery record may omit flowInput.' });
  }
  if (record.state === 'running' && (!record.activityId || !record.behaviorRevisionId)) {
    ctx.addIssue({ code: 'custom', message: 'A running dispatch requires Activity and revision ids.' });
  }
  if (record.instructionContext && (
    record.instructionContext.personaId !== record.personaId
    || record.instructionContext.activityId !== record.activityId
    || record.instructionContext.behaviorRevisionId !== record.behaviorRevisionId
  )) {
    ctx.addIssue({
      code: 'custom',
      message: 'A frozen instruction context must match the dispatch attribution triple.',
      path: ['instructionContext'],
    });
  }
  if (record.maintenancePlan && (
    record.admission.kind !== 'maintenance'
    || record.admission.source.kind !== 'maintenance'
    || record.admission.source.sourceId !== record.maintenancePlan.sourceActivityId
  )) {
    ctx.addIssue({
      code: 'custom',
      message: 'A maintenance evidence plan must match its maintenance Activity source.',
      path: ['maintenancePlan'],
    });
  }
  if (record.maintenanceResult && record.admission.kind !== 'maintenance') {
    ctx.addIssue({
      code: 'custom',
      message: 'Only a maintenance dispatch may carry a maintenance result.',
      path: ['maintenanceResult'],
    });
  }
  if (record.state === 'waiting' && !record.waitingReason) {
    ctx.addIssue({ code: 'custom', message: 'A waiting dispatch requires waitingReason.' });
  }
  if (record.state !== 'waiting' && record.waitingReason) {
    ctx.addIssue({ code: 'custom', message: 'Only a waiting dispatch may carry waitingReason.' });
  }
  if (record.state === 'error' && !record.error) {
    ctx.addIssue({ code: 'custom', message: 'An errored dispatch requires a sanitized error.' });
  }
  if (record.state !== 'error' && record.error) {
    ctx.addIssue({ code: 'custom', message: 'Only an errored dispatch may carry error.' });
  }
  if (
    (record.state === 'completed' || record.state === 'error' || record.state === 'cancelled')
    && record.completedAt === undefined
  ) {
    ctx.addIssue({ code: 'custom', message: 'A terminal dispatch requires completedAt.' });
  }
  if (
    record.state !== 'completed'
    && record.state !== 'error'
    && record.state !== 'cancelled'
    && record.completedAt !== undefined
  ) {
    ctx.addIssue({ code: 'custom', message: 'A non-terminal dispatch cannot carry completedAt.' });
  }
});

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertInstructionContextMatchesClaim(
  record: PersonaFlowDispatchRecord,
  claim: PersonaActivityClaim,
  revision: BehaviorRevision,
): PersonaInstructionContext {
  const context = PersonaInstructionContextSchema.parse(record.instructionContext);
  if (
    context.personaId !== record.personaId
    || context.personaId !== claim.activity.personaId
    || context.activityId !== claim.activity.id
    || context.behaviorRevisionId !== revision.id
    || context.behaviorContentHash !== revision.contentHash
    || context.behaviorSlotKey !== revision.slotKey
    || context.rootFlowId !== revision.flowSnapshot.id
  ) {
    throw new PersonaFlowDispatchCorruptionError(
      record.id,
      'Frozen Persona instruction context does not match the claimed Activity and Behavior revision.',
    );
  }
  return context;
}

function assertActivityInstructionContextMatchesClaim(
  record: PersonaFlowDispatchRecord,
  claim: PersonaActivityClaim,
  revision: BehaviorRevision,
): PersonaInstructionContext {
  try {
    const context = readPersonaActivityInstructionContext(claim.activity, revision);
    if (!context) throw new Error('Activity has no immutable instruction context.');
    return context;
  } catch (error) {
    throw new PersonaFlowDispatchCorruptionError(
      record.id,
      error instanceof Error ? error.message : 'Activity Core snapshot is invalid.',
    );
  }
}

function cloneSerializableFlowInput(value: unknown): SerializablePersonaFlowRunInput {
  const parsed = SerializableFlowRunInputSchema.parse(value);
  // Parsing validates JSON. A JSON round-trip also removes any exotic object
  // identity before data crosses the durable boundary.
  return JSON.parse(JSON.stringify(parsed)) as SerializablePersonaFlowRunInput;
}

function sanitizeText(value: unknown, maxLength: number, fallback: string): string {
  const text = typeof value === 'string'
    ? value
    : value instanceof Error
      ? value.message
      : String(value ?? fallback);
  const cleaned = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim();
  return (cleaned || fallback).slice(0, maxLength);
}

function dispatchError(code: string, error: unknown, fallback: string): PersonaFlowDispatchError {
  return {
    code,
    message: sanitizeText(error, MAX_ERROR_TEXT, fallback),
    at: runtimeClock.now(),
  };
}

function leaseLostDispatchError(): PersonaFlowDispatchError {
  return {
    code: 'LEASE_LOST',
    // Never persist the runtime error: it can contain an opaque lease id.
    message: 'Persona execution authority was lost; uncertain work was not replayed.',
    at: runtimeClock.now(),
  };
}

function isTerminalDispatch(state: PersonaFlowDispatchState): boolean {
  return state === 'completed' || state === 'error' || state === 'cancelled';
}

function fenceForClaim(claim: PersonaActivityClaim): PersonaLeaseFence {
  return {
    workspaceId: claim.lease.workspaceId,
    personaId: claim.lease.personaId,
    activityId: claim.activity.id,
    leaseId: claim.lease.id,
    holderId: claim.lease.holderId,
    fencingToken: claim.lease.fencingToken,
  };
}

function normalizeAdmission(input: SubmitPersonaFlowDispatchInput): PersonaFlowDispatchAdmission {
  return DispatchAdmissionSchema.parse({
    kind: input.kind,
    priority: input.priority ?? 'normal',
    source: {
      kind: input.source.kind,
      ...(input.source.sourceId !== undefined ? { sourceId: input.source.sourceId } : {}),
    },
    ...(input.behaviorSlotKey !== undefined ? { behaviorSlotKey: input.behaviorSlotKey } : {}),
    ...(input.relationKey !== undefined ? { relationKey: input.relationKey } : {}),
    ...(input.relatedAction !== undefined ? { relatedAction: input.relatedAction } : {}),
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
    ...(input.notBefore !== undefined ? { notBefore: input.notBefore } : {}),
  }) as PersonaFlowDispatchAdmission;
}

function requestHash(
  workspaceId: string,
  personaId: string,
  admission: PersonaFlowDispatchAdmission,
  flowInput: SerializablePersonaFlowRunInput,
  maintenancePlan?: MemoryMaintenancePlan,
): string {
  return sha256(canonicalJson({
    workspaceId,
    personaId,
    admission,
    flowInput,
    maintenancePlan: maintenancePlan ?? null,
  }));
}

function parseDispatchRecord(id: string, value: unknown, workspaceId: string): PersonaFlowDispatchRecord {
  const parsed = PersonaFlowDispatchRecordSchema.safeParse(value);
  if (!parsed.success) {
    throw new PersonaFlowDispatchCorruptionError(
      id,
      `Persona Flow dispatch ${JSON.stringify(id)} failed strict version/schema validation.`,
    );
  }
  if (parsed.data.id !== id || parsed.data.workspaceId !== workspaceId) {
    throw new PersonaFlowDispatchCorruptionError(
      id,
      `Persona Flow dispatch ${JSON.stringify(id)} has mismatched storage identity or workspace.`,
    );
  }
  return parsed.data as PersonaFlowDispatchRecord;
}

async function loadDispatchRecord(
  workspaceId: string,
  id: string,
): Promise<PersonaFlowDispatchRecord | null> {
  assertSafeCollectionId(id);
  return runWithWorkspace(workspaceId, async () => {
    const value = await loadCollectionItem<unknown | null>(
      ENDURING_AGENT_COLLECTIONS.flowDispatches,
      id,
      null,
    );
    return value === null ? null : parseDispatchRecord(id, value, workspaceId);
  });
}

async function listDispatchRecords(workspaceId: string): Promise<PersonaFlowDispatchRecord[]> {
  return runWithWorkspace(workspaceId, async () => {
    const entries = await listCollectionItemEntriesStrict<unknown>(
      ENDURING_AGENT_COLLECTIONS.flowDispatches,
    );
    return entries
      .map(({ id, item }) => parseDispatchRecord(id, item, workspaceId))
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  });
}

async function appendPersonaConversationMessage(
  conversationId: string,
  message: FlujoChatMessage,
  executionAuthority: FlowExecutionAuthority,
): Promise<void> {
  const [
    { appendRawForState },
    { upsertMessageById },
    { loadConversationState },
    { persistConversationState },
  ] = await Promise.all([
    import('@/backend/execution/flow/conversationLog'),
    import('@/backend/execution/flow/conversationMessages'),
    import('@/backend/execution/flow/loadConversationState'),
    import('@/backend/execution/flow/persistConversationState'),
  ]);
  const state = await loadConversationState(conversationId);
  if (!state) {
    throw new Error(`Conversation ${JSON.stringify(conversationId)} was not available for a maintenance result update.`);
  }
  state.executionAuthority = executionAuthority;
  upsertMessageById(state.messages, message);
  state.lastResponse = typeof message.content === 'string' ? message.content : state.lastResponse;
  state.updatedAt = Math.max(runtimeClock.now(), state.updatedAt ?? 0);
  await appendRawForState(state, [{ type: 'message', message }]);
  await persistConversationState(
    `conversations/${conversationId}` as Parameters<typeof persistConversationState>[0],
    state,
  );
}

export interface PersonaFlowDispatcherDependencies {
  routePersonaMailboxItem: (
    value: unknown,
    options?: PersonaMailboxAdmissionOptions,
  ) => Promise<RoutePersonaMailboxResult>;
  claimNextPersonaActivity: (value: unknown) => Promise<PersonaActivityClaim | null>;
  assertPersonaActivityLease: (value: unknown) => Promise<PersonaLease>;
  commitWithPersonaActivityLease: <T>(value: unknown, task: () => Promise<T>) => Promise<T>;
  renewPersonaActivityLease: (value: unknown) => Promise<PersonaLease>;
  releasePersonaActivityLease: (value: unknown) => Promise<PersonaLease>;
  completePersonaActivity: (value: unknown) => Promise<CompletedPersonaActivity>;
  completePersonaActivityWithinRuntimeLock: (
    value: unknown,
    lock: PersonaRuntimeLock,
  ) => Promise<CompletedPersonaActivity>;
  observeCompletedPersonaActivity: (result: CompletedPersonaActivity) => Promise<void>;
  synchronizeAssignedWorkItemFromActivity: (activity: PersonaActivity) => Promise<unknown>;
  synchronizeAssignedWorkItemFromActivityWithinRuntimeLock: (
    activity: PersonaActivity,
    lock: PersonaRuntimeLock,
  ) => Promise<unknown>;
  updatePersonaActivityReferences: (value: unknown) => Promise<PersonaActivity>;
  persistPersonaActivitySnapshot: (value: unknown) => Promise<PersonaActivity>;
  listPendingPersonaActivityDeliveries: (value: unknown) => Promise<PersonaMailboxItem[]>;
  acknowledgePersonaActivityDelivery: (value: unknown) => Promise<PersonaMailboxItem>;
  rejectPersonaActivityDelivery: (value: unknown) => Promise<PersonaMailboxItem>;
  cancelPersonaMailboxItem: (value: unknown) => Promise<PersonaMailboxItem>;
  reprioritizePersonaMailboxItemWithinRuntimeLock:
    typeof reprioritizePersonaMailboxItemWithinRuntimeLock;
  movePersonaMailboxItemWithinRuntimeLock:
    typeof movePersonaMailboxItemWithinRuntimeLock;
  yieldPersonaActivityForInterruption: (value: unknown) => Promise<PersonaLease>;
  yieldPersonaActivityForInterruptionWithinRuntimeLock: (
    value: unknown,
    lock: PersonaRuntimeLock,
  ) => Promise<PersonaLease>;
  observeYieldedPersonaActivity: (value: unknown) => Promise<void>;
  getPersona: (id: string) => Promise<Persona | null>;
  getRoleVersion: (id: string) => Promise<RoleVersion | null>;
  getBehaviorRevision: (id: string) => Promise<BehaviorRevision | null>;
  getPersonaActivity: (personaId: string, id: string) => Promise<PersonaActivity | null>;
  getPersonaMailboxItem: (personaId: string, id: string) => Promise<PersonaMailboxItem | null>;
  getCoreMemory: (personaId: string) => Promise<MemoryItem[]>;
  snapshotPersonaCoreAppRefs: typeof snapshotPersonaCoreAppRefs;
  projectPersonaCoreAppsIntoFlow: typeof projectPersonaCoreAppsIntoFlow;
  readConversationLog: typeof readConversationLog;
  appendConversationMessage: typeof appendPersonaConversationMessage;
  runFlow: (input: FlowRunInput) => Promise<FlowRunResult>;
}

const DEFAULT_DEPENDENCIES: PersonaFlowDispatcherDependencies = {
  routePersonaMailboxItem,
  claimNextPersonaActivity,
  assertPersonaActivityLease,
  commitWithPersonaActivityLease,
  renewPersonaActivityLease,
  releasePersonaActivityLease,
  completePersonaActivity,
  completePersonaActivityWithinRuntimeLock,
  observeCompletedPersonaActivity,
  synchronizeAssignedWorkItemFromActivity: async (activity) => {
    const { synchronizeAssignedWorkItemFromActivity } = await import('./workItems');
    return synchronizeAssignedWorkItemFromActivity(activity);
  },
  synchronizeAssignedWorkItemFromActivityWithinRuntimeLock: async (activity, lock) => {
    const { synchronizeAssignedWorkItemFromActivityWithinRuntimeLock } = await import('./workItems');
    return synchronizeAssignedWorkItemFromActivityWithinRuntimeLock(activity, lock);
  },
  updatePersonaActivityReferences,
  persistPersonaActivitySnapshot,
  listPendingPersonaActivityDeliveries,
  acknowledgePersonaActivityDelivery,
  rejectPersonaActivityDelivery,
  cancelPersonaMailboxItem,
  reprioritizePersonaMailboxItemWithinRuntimeLock,
  movePersonaMailboxItemWithinRuntimeLock,
  yieldPersonaActivityForInterruption,
  yieldPersonaActivityForInterruptionWithinRuntimeLock,
  observeYieldedPersonaActivity,
  getPersona,
  getRoleVersion,
  getBehaviorRevision,
  getPersonaActivity,
  getPersonaMailboxItem,
  getCoreMemory,
  snapshotPersonaCoreAppRefs,
  projectPersonaCoreAppsIntoFlow,
  readConversationLog,
  appendConversationMessage: appendPersonaConversationMessage,
  runFlow,
};

export interface PersonaFlowDispatcherOptions {
  workspaceId?: string;
  leaseTtlMs?: number;
  heartbeatIntervalMs?: number;
  dependencies?: Partial<PersonaFlowDispatcherDependencies>;
}

interface PumpControl {
  promise: Promise<void>;
  rerunRequested: boolean;
  cancelRequested: boolean;
  activeAbort?: AbortController;
  activeDispatchId?: string;
}

interface HeartbeatControl {
  stop: () => Promise<void>;
  lost: () => boolean;
  interrupted: () => boolean;
  cancelled: () => boolean;
}

interface PendingResumePreparation {
  requestedAt: number;
  prepare?: ResumePersonaFlowDispatchInput['prepare'];
  failure?: unknown;
}

interface TerminalDispatchRequest {
  status: 'completed' | 'cancelled' | 'error';
  outcome?: PersonaFlowDispatchOutcome;
  maintenanceResult?: MemoryMaintenanceResult;
  error?: PersonaFlowDispatchError;
}

function isMemoryMaintenanceCommitNode(node: Flow['nodes'][number]): boolean {
  if (node.type !== 'static') return false;
  const entries = node.data.properties?.entries;
  return Array.isArray(entries) && entries.some((entry) => (
    entry
    && typeof entry === 'object'
    && entry.kind === 'toolCall'
    && entry.executionMode === 'real'
    && entry.serverName === PERSONA_MEMORY_GATEWAY_SERVER
    && entry.toolName === PERSONA_MEMORY_MAINTENANCE_COMMIT_TOOL
  ));
}

/**
 * Apply the platform-owned maintenance boundary to any frozen replacement Flow.
 * The model receives only the proposal-oriented `remember` tool. Legacy
 * captured-output/static-commit nodes are removed in-memory; immutable authored
 * snapshots are never rewritten.
 */
export function restrictedMaintenanceFlow(source: Flow): Flow {
  const flow = structuredClone(source);
  for (const node of flow.nodes) {
    if (node.type !== 'process') continue;
    const data = node.data as typeof node.data & {
      properties?: Record<string, unknown> & {
        personaTools?: unknown;
        captureVariable?: unknown;
      };
    };
    data.properties = {
      ...(data.properties ?? {}),
      personaTools: ['remember'],
    };
    delete data.properties.captureVariable;
  }

  const legacyCommitNodes = flow.nodes.filter(isMemoryMaintenanceCommitNode);
  for (const commitNode of legacyCommitNodes) {
    const outgoing = flow.edges.find((edge) => edge.source === commitNode.id);
    const fallbackFinish = flow.nodes.find((node) => node.type === 'finish');
    const targetId = outgoing?.target ?? fallbackFinish?.id;
    if (targetId) {
      for (const incoming of flow.edges.filter((edge) => edge.target === commitNode.id)) {
        incoming.target = targetId;
        incoming.targetHandle = outgoing?.targetHandle ?? 'finish-top';
      }
    }
    flow.edges = flow.edges.filter((edge) => edge.source !== commitNode.id);
  }
  flow.nodes = flow.nodes.filter((node) => !isMemoryMaintenanceCommitNode(node));
  return flow;
}

interface RunningDispatchTransition {
  record: PersonaFlowDispatchRecord;
  entered: boolean;
}

export class PersonaFlowDispatcher {
  readonly workspaceId: string;
  private readonly leaseTtlMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly dependencies: PersonaFlowDispatcherDependencies;
  private readonly pumps = new Map<string, PumpControl>();
  private readonly wakeTimers = new Map<string, PersonaRuntimeTimer>();
  private readonly quiescedPersonas = new Set<string>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly deliveryChains = new Map<string, Promise<void>>();
  private readonly resumePreparations = new Map<string, PendingResumePreparation>();

  constructor(options: PersonaFlowDispatcherOptions = {}) {
    this.workspaceId = options.workspaceId ?? getCurrentWorkspace();
    if (!this.workspaceId.trim()) throw new TypeError('workspaceId must not be empty.');
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_PERSONA_FLOW_LEASE_TTL_MS;
    if (!Number.isInteger(this.leaseTtlMs) || this.leaseTtlMs < 1_000) {
      throw new TypeError('leaseTtlMs must be an integer of at least 1000ms.');
    }
    const requestedHeartbeat = options.heartbeatIntervalMs ?? Math.floor(this.leaseTtlMs / 3);
    this.heartbeatIntervalMs = Math.max(
      1,
      Math.min(requestedHeartbeat, 5_000, this.leaseTtlMs - 1),
    );
    this.dependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
  }

  private inWorkspace<T>(task: () => T): T {
    return runWithWorkspace(this.workspaceId, task);
  }

  private notify(dispatchId: string): void {
    const listeners = this.waiters.get(dispatchId);
    if (!listeners) return;
    this.waiters.delete(dispatchId);
    for (const listener of listeners) listener();
  }

  private async save(record: PersonaFlowDispatchRecord): Promise<PersonaFlowDispatchRecord> {
    const parsed = PersonaFlowDispatchRecordSchema.parse(record) as PersonaFlowDispatchRecord;
    await this.inWorkspace(() => saveCollectionItem(
      ENDURING_AGENT_COLLECTIONS.flowDispatches,
      parsed.id,
      parsed,
    ));
    this.notify(parsed.id);
    return parsed;
  }

  /**
   * Serialize every transition into `running` with scoped cancellation. The
   * abort controller is installed before the Persona lock is released so a
   * cancellation that wins the next lock acquisition can always interrupt the
   * active execution. Activity-runtime mutation deliberately stays outside
   * this helper: its completion primitive shares the same Persona lock.
   */
  private async enterRunning(
    record: PersonaFlowDispatchRecord,
    transition: (latest: PersonaFlowDispatchRecord) => PersonaFlowDispatchRecord,
    activation?: { control: PumpControl; abortController: AbortController },
  ): Promise<RunningDispatchTransition> {
    return this.inWorkspace(() => withPersonaRuntimeLock(
      record.personaId,
      async () => {
        const latest = (await this.get(record.id)) ?? record;
        if (isTerminalDispatch(latest.state) || latest.cancellationRequestedAt) {
          return { record: latest, entered: false };
        }
        const running = await this.save(transition(latest));
        if (activation) {
          activation.control.activeAbort = activation.abortController;
          activation.control.activeDispatchId = running.id;
        }
        return { record: running, entered: true };
      },
    ));
  }

  async get(dispatchId: string): Promise<PersonaFlowDispatchRecord | null> {
    return loadDispatchRecord(this.workspaceId, dispatchId);
  }

  async list(personaId?: string): Promise<PersonaFlowDispatchRecord[]> {
    if (personaId !== undefined) EnduringAgentIdSchema.parse(personaId);
    const records = await listDispatchRecords(this.workspaceId);
    return personaId === undefined
      ? records
      : records.filter((record) => record.personaId === personaId);
  }

  private validateIdentity(identity: PersonaFlowDispatchIdentity): void {
    EnduringAgentIdSchema.parse(identity.personaId);
    EnduringAgentIdSchema.parse(identity.activityId);
    EnduringAgentIdSchema.parse(identity.behaviorRevisionId);
    if (identity.conversationId !== undefined) EnduringAgentIdSchema.parse(identity.conversationId);
    if (identity.workspaceId !== undefined && identity.workspaceId !== this.workspaceId) {
      throw new PersonaFlowDispatchAttributionError(
        `Persona lifecycle workspace ${JSON.stringify(identity.workspaceId)} does not match the active workspace.`,
      );
    }
  }

  private async findOwningDispatch(
    identity: PersonaFlowDispatchIdentity,
  ): Promise<PersonaFlowDispatchRecord> {
    this.validateIdentity(identity);
    const candidates = (await this.list(identity.personaId)).filter((record) => (
      record.activityId === identity.activityId
      // Steered/coalesced envelopes reference somebody else's Activity and are
      // deliveries, never owners of that conversation lifecycle.
      && record.routingDecision !== 'steered'
      && record.routingDecision !== 'coalesced'
    ));
    if (candidates.length !== 1) throw new PersonaFlowDispatchNotFoundError(identity);
    const record = candidates[0];
    if (record.behaviorRevisionId !== identity.behaviorRevisionId) {
      throw new PersonaFlowDispatchAttributionError(
        'Persisted conversation Behavior revision does not match its owning dispatch.',
      );
    }
    const dispatchConversationId = record.flowInput?.conversationId ?? record.outcome?.conversationId;
    if (
      identity.conversationId !== undefined
      && dispatchConversationId !== identity.conversationId
    ) {
      throw new PersonaFlowDispatchAttributionError(
        'Persisted conversation id does not match its owning dispatch.',
      );
    }
    return record;
  }

  async findByAttribution(
    identity: PersonaFlowDispatchIdentity,
  ): Promise<PersonaFlowDispatchRecord> {
    return this.findOwningDispatch(identity);
  }

  private async awaitPump(
    dispatchId: string,
    promise: Promise<void>,
    options: ResumePersonaFlowDispatchOptions,
  ): Promise<void> {
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)) {
      throw new TypeError('timeoutMs must be a non-negative finite number.');
    }
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new Error('Persona resume wait aborted.');
    }
    if (options.timeoutMs === undefined && !options.signal) {
      await promise;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: PersonaRuntimeTimer | undefined;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        if (timer) timer.clear();
        options.signal?.removeEventListener('abort', abort);
        if (error !== undefined) reject(error);
        else resolve();
      };
      const abort = () => finish(options.signal?.reason ?? new Error('Persona resume wait aborted.'));
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.timeoutMs !== undefined) {
        timer = runtimeClock.setTimer(
          () => finish(new PersonaFlowDispatchTimeoutError(dispatchId)),
          options.timeoutMs,
        );
        timer.unref();
      }
      promise.then(() => finish(), finish);
    });
  }

  async resume(
    input: ResumePersonaFlowDispatchInput,
    options: ResumePersonaFlowDispatchOptions = {},
  ): Promise<PersonaFlowDispatchRecord> {
    const existing = await this.findOwningDispatch(input);
    if (isTerminalDispatch(existing.state)) {
      throw new PersonaFlowDispatchStateError(existing.id, existing.state);
    }
    const queued = await this.inWorkspace(() => withPersonaRuntimeLock(
      input.personaId,
      async () => {
        const current = await this.get(existing.id);
        if (!current) throw new PersonaFlowDispatchNotFoundError(input);
        if (isTerminalDispatch(current.state) || current.state !== 'waiting') {
          throw new PersonaFlowDispatchStateError(current.id, current.state);
        }
        if (!current.flowInput) {
          throw new PersonaFlowDispatchCorruptionError(current.id, 'Dispatch has no resumable Flow input.');
        }
        const requestedAt = Math.max(runtimeClock.now(), current.updatedAt + 1);
        const flowInput = cloneSerializableFlowInput({
          ...current.flowInput,
          ...(input.flowInputPatch ?? {}),
          // The owning conversation is immutable across lifecycle resumes.
          ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        });
        return this.save({
          ...current,
          state: 'queued',
          waitingReason: undefined,
          flowInput,
          resumeRequestedAt: requestedAt,
          resumeSettledAt: undefined,
          resumeReason: input.reason ?? 'manual',
          resumeFromWaitingReason: current.waitingReason === 'delivery'
            ? 'running'
            : current.waitingReason,
          resumePreparationRequired: Boolean(input.prepare),
          lastError: undefined,
          updatedAt: requestedAt,
        });
      },
    ));
    const preparation: PendingResumePreparation = {
      requestedAt: queued.resumeRequestedAt!,
      prepare: input.prepare,
    };
    this.resumePreparations.set(queued.id, preparation);
    try {
      await this.awaitPump(queued.id, this.pump(queued.personaId), options);
      if (preparation.failure !== undefined) throw preparation.failure;
      const result = await this.get(queued.id);
      if (!result) throw new PersonaFlowDispatchNotFoundError(input);
      return result;
    } finally {
      if (this.resumePreparations.get(queued.id) === preparation) {
        this.resumePreparations.delete(queued.id);
      }
    }
  }

  private async cancelExisting(
    existing: PersonaFlowDispatchRecord,
    reason: string | undefined,
    options: CancelPersonaFlowDispatchOptions = {},
  ): Promise<PersonaFlowDispatchRecord> {
    if (isTerminalDispatch(existing.state)) return existing;
    const requested = await this.inWorkspace(() => withPersonaRuntimeLock(
      existing.personaId,
      async () => {
        const current = await this.get(existing.id);
        if (!current) {
          throw new PersonaFlowDispatchIdNotFoundError(existing.personaId, existing.id);
        }
        if (isTerminalDispatch(current.state)) return current;
        const requestedAt = current.cancellationRequestedAt
          ?? Math.max(runtimeClock.now(), current.updatedAt + 1);
        return this.save({
          ...current,
          ...(current.state === 'waiting'
            ? { state: 'queued' as const, waitingReason: undefined }
            : {}),
          cancellationRequestedAt: requestedAt,
          cancellationReason: sanitizeText(
            reason,
            512,
            'Execution was cancelled by the user.',
          ),
          resumePreparationRequired: false,
          resumeSettledAt: requestedAt,
          lastError: undefined,
          updatedAt: Math.max(runtimeClock.now(), current.updatedAt, requestedAt),
        });
      },
    ));
    if (isTerminalDispatch(requested.state)) return requested;
    const control = this.pumps.get(requested.personaId);
    if (control?.activeDispatchId === requested.id) control.activeAbort?.abort();
    const pump = this.pump(requested.personaId);
    if (options.waitForCompletion) {
      void pump.catch((error) => {
        log.error(`Persona cancellation pump failed for ${requested.personaId}:`, error);
      });
      return this.wait(requested.id, options);
    }
    await pump;
    return (await this.get(requested.id)) ?? requested;
  }

  async cancel(
    input: CancelPersonaFlowDispatchInput,
    options: CancelPersonaFlowDispatchOptions = {},
  ): Promise<PersonaFlowDispatchRecord> {
    const existing = await this.findOwningDispatch(input);
    return this.cancelExisting(existing, input.reason, options);
  }

  /**
   * Cancel a durable dispatch before it necessarily owns an Activity. Task
   * controls need this path because queued work has no Activity attribution
   * yet, while the dispatch id is already durable and Persona-scoped.
   */
  async cancelById(
    input: CancelPersonaFlowDispatchByIdInput,
    options: CancelPersonaFlowDispatchOptions = {},
  ): Promise<PersonaFlowDispatchRecord> {
    EnduringAgentIdSchema.parse(input.personaId);
    EnduringAgentIdSchema.parse(input.dispatchId);
    const existing = await this.get(input.dispatchId);
    if (!existing || existing.personaId !== input.personaId) {
      throw new PersonaFlowDispatchIdNotFoundError(input.personaId, input.dispatchId);
    }
    return this.cancelExisting(existing, input.reason, options);
  }

  /** Keep the durable dispatch and mailbox ordering bucket aligned with its Task. */
  async reprioritizeWorkItem(
    input: ReprioritizePersonaWorkItemDispatchInput,
  ): Promise<PersonaFlowDispatchRecord[]> {
    EnduringAgentIdSchema.parse(input.personaId);
    EnduringAgentIdSchema.parse(input.workItemId);
    z.enum(PERSONA_PRIORITIES).parse(input.priority);
    return this.inWorkspace(() => withPersonaRuntimeLock(input.personaId, async (lock) => {
      const matching = (await this.list(input.personaId)).filter((record) => (
        !isTerminalDispatch(record.state)
        && record.admission.kind === 'assignment'
        && record.admission.source.kind === 'assignment'
        && record.admission.source.sourceId === input.workItemId
        && Boolean(record.mailboxItemId)
      ));
      const updated: PersonaFlowDispatchRecord[] = [];
      for (const record of matching) {
        const current = (await this.get(record.id)) ?? record;
        if (isTerminalDispatch(current.state) || !current.mailboxItemId) continue;
        const mailbox = await this.dependencies.reprioritizePersonaMailboxItemWithinRuntimeLock({
          personaId: input.personaId,
          mailboxItemId: current.mailboxItemId,
          priority: input.priority,
        }, lock);
        if (
          mailbox.item.status !== 'queued'
          || (!mailbox.changed && current.admission.priority === input.priority)
        ) continue;
        await lock.assertOwned();
        updated.push(await this.save({
          ...current,
          admission: { ...current.admission, priority: input.priority },
          updatedAt: Math.max(runtimeClock.now(), current.updatedAt + 1, mailbox.item.updatedAt),
        }));
      }
      return updated;
    }));
  }

  /** Move queued Task work within its current priority bucket. */
  async moveWorkItem(
    input: MovePersonaWorkItemDispatchInput,
  ): Promise<MovePersonaWorkItemDispatchResult> {
    EnduringAgentIdSchema.parse(input.personaId);
    EnduringAgentIdSchema.parse(input.workItemId);
    z.enum(['earlier', 'later']).parse(input.direction);
    return this.inWorkspace(() => withPersonaRuntimeLock(input.personaId, async (lock) => {
      const matching = (await this.list(input.personaId))
        .filter((record) => (
          record.state === 'queued'
          && record.admission.kind === 'assignment'
          && record.admission.source.kind === 'assignment'
          && record.admission.source.sourceId === input.workItemId
          && Boolean(record.mailboxItemId)
        ))
        .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id));
      for (const record of matching) {
        const current = (await this.get(record.id)) ?? record;
        if (current.state !== 'queued' || !current.mailboxItemId) continue;
        const mailbox = await this.dependencies.getPersonaMailboxItem(input.personaId, current.mailboxItemId);
        if (!mailbox || mailbox.personaId !== input.personaId || mailbox.status !== 'queued') continue;
        const result = await this.dependencies.movePersonaMailboxItemWithinRuntimeLock({
          personaId: input.personaId,
          mailboxItemId: current.mailboxItemId,
          direction: input.direction,
        }, lock);
        return { found: true, moved: result.moved };
      }
      return { found: false, moved: false };
    }));
  }

  private routeInput(record: PersonaFlowDispatchRecord): Record<string, unknown> {
    return {
      personaId: record.personaId,
      // Stable private id; the Activity runtime hashes it before persistence.
      idempotencyKey: record.id,
      kind: record.admission.kind,
      priority: record.admission.priority,
      source: {
        ...record.admission.source,
        idempotencyKey: record.id,
      },
      ...(record.admission.behaviorSlotKey
        ? { behaviorSlotKey: record.admission.behaviorSlotKey }
        : {}),
      ...(record.admission.relationKey ? { relationKey: record.admission.relationKey } : {}),
      ...(record.admission.relatedAction ? { relatedAction: record.admission.relatedAction } : {}),
      ...(record.admission.summary ? { summary: record.admission.summary } : {}),
      ...(record.admission.notBefore !== undefined
        ? { notBefore: record.admission.notBefore }
        : {}),
      payloadRef: record.id,
    };
  }

  private async applyRouteResult(
    record: PersonaFlowDispatchRecord,
    routed: RoutePersonaMailboxResult,
  ): Promise<PersonaFlowDispatchRecord> {
    if (routed.item.personaId !== record.personaId || routed.item.payloadRef !== record.id) {
      throw new PersonaFlowDispatchCorruptionError(
        record.id,
        'Mailbox routing returned a foreign Persona or payload reference.',
      );
    }
    const coalesced = routed.decision === 'steered'
      || routed.decision === 'coalesced'
      || (routed.item.status === 'coalesced'
        && routed.item.deliveryStatus === 'pending'
        && (routed.item.routingDecision === 'steer'
          || routed.item.routingDecision === 'coalesce'));
    return this.inWorkspace(() => withPersonaRuntimeLock(record.personaId, async () => {
      const latest = (await this.get(record.id)) ?? record;
      if (isTerminalDispatch(latest.state)) return latest;
      const enterDeliveryWaiting = coalesced
        && latest.state === 'queued'
        && !latest.cancellationRequestedAt;
      const now = Math.max(runtimeClock.now(), latest.updatedAt, routed.item.updatedAt);
      return this.save({
        ...latest,
        state: enterDeliveryWaiting ? 'waiting' : latest.state,
        ...(enterDeliveryWaiting ? { waitingReason: 'delivery' as const } : {}),
        mailboxItemId: routed.item.id,
        routingDecision: routed.decision,
        ...(routed.targetActivityId ? { targetActivityId: routed.targetActivityId } : {}),
        lastError: undefined,
        updatedAt: now,
      });
    }));
  }

  private async routeStored(
    record: PersonaFlowDispatchRecord,
    options: Pick<SubmitPersonaFlowDispatchOptions, 'validateAdmission'> = {},
  ): Promise<{
    dispatch: PersonaFlowDispatchRecord;
    decision: PersonaMailboxRouteDecision;
  }> {
    try {
      const routed = await this.inWorkspace(() => this.dependencies.routePersonaMailboxItem(
        this.routeInput(record),
        { validateAdmission: options.validateAdmission },
      ));
      return {
        dispatch: await this.applyRouteResult(record, routed),
        decision: routed.decision,
      };
    } catch (error) {
      await this.inWorkspace(() => withPersonaRuntimeLock(record.personaId, async () => {
        const current = (await this.get(record.id)) ?? record;
        if (isTerminalDispatch(current.state)) return current;
        return this.save({
          ...current,
          lastError: dispatchError('ROUTING_FAILED', error, 'Mailbox routing failed.'),
          updatedAt: Math.max(runtimeClock.now(), current.updatedAt),
        });
      }));
      throw error;
    }
  }

  async submit(
    input: SubmitPersonaFlowDispatchInput,
    options: SubmitPersonaFlowDispatchOptions = {},
  ): Promise<PersonaFlowDispatchSubmission> {
    EnduringAgentIdSchema.parse(input.personaId);
    if (input.workspaceId !== undefined && input.workspaceId !== this.workspaceId) {
      throw new TypeError(
        `Dispatch workspace ${JSON.stringify(input.workspaceId)} does not match active workspace.`,
      );
    }
    if (this.quiescedPersonas.has(input.personaId)) {
      throw new PersonaFlowDispatcherQuiescedError(input.personaId);
    }
    const rawKey = input.idempotencyKey.trim();
    if (!rawKey || rawKey.length > 512) {
      throw new TypeError('idempotencyKey must contain 1-512 characters.');
    }
    const idempotencyDigest = sha256(rawKey);
    const admission = normalizeAdmission(input);
    const flowInput = cloneSerializableFlowInput(input.flowInput);
    const maintenancePlan = input.maintenancePlan
      ? MemoryMaintenancePlanSchema.parse(input.maintenancePlan)
      : undefined;
    if (maintenancePlan && input.kind !== 'maintenance') {
      throw new TypeError('Only a maintenance dispatch may carry a maintenance evidence plan.');
    }
    const hash = requestHash(
      this.workspaceId,
      input.personaId,
      admission,
      flowInput,
      maintenancePlan,
    );
    const id = stableEnduringAgentId('dispatch', {
      purpose: 'persona-flow-dispatch-v1',
      workspaceId: this.workspaceId,
      personaId: input.personaId,
      idempotencyDigest,
    });

    const record = await this.inWorkspace(() => withPersonaRuntimeLock(
      input.personaId,
      async () => {
        await options.validateAdmission?.();
        const persona = await this.dependencies.getPersona(input.personaId);
        if (!persona || persona.id !== input.personaId) {
          throw new Error(`Persona ${JSON.stringify(input.personaId)} not found in this workspace.`);
        }
        const existing = await this.get(id);
        if (existing) {
          if (existing.requestHash !== hash || existing.idempotencyDigest !== idempotencyDigest) {
            throw new PersonaFlowDispatchConflictError(id);
          }
          return existing;
        }
        const now = runtimeClock.now();
        return this.save({
          schemaVersion: PERSONA_FLOW_DISPATCH_SCHEMA_VERSION,
          id,
          workspaceId: this.workspaceId,
          personaId: input.personaId,
          idempotencyDigest,
          requestHash: hash,
          state: 'queued',
          admission,
          flowInput,
          ...(maintenancePlan ? { maintenancePlan } : {}),
          createdAt: now,
          updatedAt: now,
        });
      },
    ));

    let routed: PersonaFlowDispatchSubmission;
    if (record.mailboxItemId && record.routingDecision) {
      routed = { dispatch: record, decision: record.routingDecision, duplicate: true };
    } else {
      routed = await this.routeStored(record, {
        validateAdmission: options.validateAdmission,
      });
    }

    if (routed.decision === 'duplicate' && !routed.duplicate) {
      routed = { ...routed, duplicate: true };
    }
    if (routed.dispatch.state === 'queued' && options.startPump !== false) {
      void this.pump(input.personaId).catch((error) => {
        log.error(`Persona Flow pump failed for ${input.personaId}:`, error);
      });
    }
    if (options.waitForCompletion) {
      routed = {
        ...routed,
        dispatch: await this.wait(routed.dispatch.id, options),
      };
    }
    return routed;
  }

  private scheduleWake(personaId: string, at: number): void {
    if (this.quiescedPersonas.has(personaId)) return;
    const existing = this.wakeTimers.get(personaId);
    if (existing) existing.clear();
    const delay = Math.max(1, Math.min(at - runtimeClock.now() + 5, 0x7fffffff));
    const timer = runtimeClock.setTimer(() => {
      this.wakeTimers.delete(personaId);
      void this.pump(personaId).catch((error) => {
        log.error(`Deferred Persona Flow pump failed for ${personaId}:`, error);
      });
    }, delay);
    timer.unref();
    this.wakeTimers.set(personaId, timer);
  }

  private steeringMessage(record: PersonaFlowDispatchRecord): FlujoChatMessage | null {
    if (!record.flowInput) return null;
    const messages = record.flowInput.messages;
    if (Array.isArray(messages)) {
      const source = [...messages].reverse().find((message) => (
        typeof message === 'object'
        && message !== null
        && 'role' in message
        && message.role === 'user'
        && 'content' in message
      ));
      if (source && typeof source === 'object') {
        return {
          ...(source as FlujoChatMessage),
          id: record.id,
          timestamp: record.createdAt,
          role: 'user',
        } as FlujoChatMessage;
      }
    }
    if (record.flowInput.prompt !== undefined) {
      return {
        id: record.id,
        timestamp: record.createdAt,
        role: 'user',
        content: record.flowInput.prompt,
      };
    }
    return null;
  }

  private async serializeRelatedInputOperation(
    fence: PersonaLeaseFence,
    operation: () => Promise<void>,
  ): Promise<void> {
    const previous = this.deliveryChains.get(fence.activityId) ?? Promise.resolve();
    const delivery = previous
      .catch(() => undefined)
      .then(() => this.inWorkspace(operation));
    this.deliveryChains.set(fence.activityId, delivery);
    try {
      await delivery;
    } finally {
      if (this.deliveryChains.get(fence.activityId) === delivery) {
        this.deliveryChains.delete(fence.activityId);
      }
    }
  }

  /**
   * Materialize pending related inputs in the process-local steering inbox.
   * Polling is deliberately delivery-side-effect-free: the durable mailbox is
   * acknowledged only after runFlow has folded the stable message id into its
   * append-only transcript at a safe boundary.
   */
  private async pollRelatedInputs(
    fence: PersonaLeaseFence,
    conversationId: string,
  ): Promise<void> {
    await this.serializeRelatedInputOperation(fence, async () => {
      const pending = await this.dependencies.listPendingPersonaActivityDeliveries(fence);
      for (const item of pending) {
        const payloadRef = item.payloadRef;
        let dispatch: PersonaFlowDispatchRecord | null = null;
        try {
          dispatch = payloadRef?.startsWith('dispatch_')
            ? await this.get(payloadRef)
            : null;
        } catch (error) {
          log.error(`Corrupt routed Persona payload ${JSON.stringify(payloadRef)}:`, error);
          continue;
        }
        if (
          !dispatch
          || !dispatch.flowInput
          || dispatch.personaId !== fence.personaId
          || dispatch.mailboxItemId !== item.id
          || dispatch.targetActivityId !== fence.activityId
          || dispatch.state !== 'waiting'
          || dispatch.waitingReason !== 'delivery'
        ) {
          log.error(
            `Rejected invalid routed Persona payload ${JSON.stringify(payloadRef)} for Activity ${fence.activityId}.`,
          );
          continue;
        }
        const message = this.steeringMessage(dispatch);
        if (!message) {
          await this.dependencies.rejectPersonaActivityDelivery({
            ...fence,
            mailboxItemId: item.id,
          });
          try {
            await this.saveTerminalError(
              dispatch,
              dispatchError(
                'DELIVERY_UNSUPPORTED',
                'Routed input has neither a user message nor a prompt.',
                'Routed input cannot be delivered to the active Flow.',
              ),
            );
          } catch (error) {
            // The rejected mailbox item is the recovery marker. Do not fail the
            // target Activity because its private dispatch projection could not
            // be updated; reconciliation repairs this boundary.
            log.error(`Deferred rejected delivery projection for ${dispatch.id}:`, error);
          }
          continue;
        }
        if (!peekSteeringMessages(conversationId).some((candidate) => candidate.id === message.id)) {
          enqueueSteeringMessage(conversationId, message);
        }
      }
    });
  }

  private async completeRelatedDispatch(
    dispatch: PersonaFlowDispatchRecord,
    item: PersonaMailboxItem,
    conversationId?: string,
  ): Promise<void> {
    await withPersonaRuntimeLock(dispatch.personaId, async (lock) => {
      const latest = (await this.get(dispatch.id)) ?? dispatch;
      if (isTerminalDispatch(latest.state)) return;
      const now = Math.max(runtimeClock.now(), latest.updatedAt, item.updatedAt);
      if (latest.cancellationRequestedAt) {
        await this.save({
          ...latest,
          state: 'cancelled',
          waitingReason: undefined,
          error: undefined,
          lastError: undefined,
          updatedAt: now,
          completedAt: now,
        });
        return;
      }
      const targetId = latest.targetActivityId;
      const target = targetId
        ? await this.dependencies.getPersonaActivity(latest.personaId, targetId)
        : null;
      const revisionId = target?.behaviorRevisionId;
      if (
        !target
        || target.personaId !== latest.personaId
        || target.id !== targetId
        || !revisionId
      ) {
        await this.saveTerminalErrorWithinRuntimeLock(
          latest,
          dispatchError(
            'DELIVERY_TARGET_INVALID',
            'Routed input target lost its Behavior attribution.',
            'Routed input target is invalid.',
          ),
          lock,
        );
        return;
      }
      const deliveryStatus = item.routingDecision === 'steer'
        || latest.routingDecision === 'steered'
        ? 'steered' as const
        : 'coalesced' as const;
      const deliveredConversationId = target.conversationId ?? conversationId;
      await this.save({
        ...latest,
        state: 'completed',
        waitingReason: undefined,
        activityId: target.id,
        behaviorRevisionId: revisionId,
        outcome: {
          status: deliveryStatus,
          ...(deliveredConversationId ? { conversationId: deliveredConversationId } : {}),
          ...(target.runId ? { runId: target.runId } : {}),
          personaId: latest.personaId,
          activityId: target.id,
          behaviorRevisionId: revisionId,
        },
        error: undefined,
        lastError: undefined,
        updatedAt: now,
        completedAt: now,
      });
    });
  }

  /**
   * Mailbox acknowledgement follows transcript durability. The mailbox write
   * is the recovery marker and intentionally happens before the private
   * dispatch projection; reconciliation repairs a crash between those writes.
   */
  private async acknowledgeRelatedInputs(
    fence: PersonaLeaseFence,
    conversationId: string,
    messageIds: readonly string[],
  ): Promise<void> {
    const ids = [...new Set(messageIds)]
      .filter((id) => typeof id === 'string' && id.startsWith('dispatch_'));
    await this.serializeRelatedInputOperation(fence, async () => {
      for (const id of ids) {
        assertSafeCollectionId(id);
        const dispatch = await this.get(id);
        if (!dispatch || dispatch.personaId !== fence.personaId) continue;
        if (
          dispatch.targetActivityId !== fence.activityId
          || !dispatch.mailboxItemId
        ) {
          throw new PersonaFlowDispatchCorruptionError(
            dispatch.id,
            'Related input acknowledgement crossed an Activity boundary.',
          );
        }
        const item = await this.dependencies.getPersonaMailboxItem(fence.personaId, dispatch.mailboxItemId);
        if (
          !item
          || item.personaId !== fence.personaId
          || item.id !== dispatch.mailboxItemId
          || item.payloadRef !== dispatch.id
          || item.status !== 'coalesced'
          || item.targetActivityId !== fence.activityId
          || (item.routingDecision !== 'steer' && item.routingDecision !== 'coalesce')
          || (item.deliveryStatus !== 'pending' && item.deliveryStatus !== 'delivered')
        ) {
          throw new PersonaFlowDispatchCorruptionError(
            dispatch.id,
            'Related input mailbox ownership changed before acknowledgement.',
          );
        }
        const acknowledged = await this.dependencies.acknowledgePersonaActivityDelivery({
          ...fence,
          mailboxItemId: item.id,
        });
        await this.completeRelatedDispatch(dispatch, acknowledged, conversationId);
      }
    });
  }

  private async interruptionRequested(fence: PersonaLeaseFence): Promise<boolean> {
    const activity = await this.inWorkspace(() => this.dependencies.getPersonaActivity(
      fence.personaId,
      fence.activityId,
    ));
    return Boolean(
      activity
      && activity.personaId === fence.personaId
      && activity.interruptionRequestedByMailboxItemId,
    );
  }

  private beginHeartbeat(
    fence: PersonaLeaseFence,
    dispatchId: string,
    abortController: AbortController,
  ): HeartbeatControl {
    let stopped = false;
    let leaseLost = false;
    let interruption = false;
    let cancellation = false;
    let timer: PersonaRuntimeTimer | undefined;
    let inFlight: Promise<void> | undefined;

    const schedule = () => {
      if (stopped) return;
      timer = runtimeClock.setTimer(() => {
        if (stopped) return;
        inFlight = this.inWorkspace(async () => {
          try {
            await this.dependencies.renewPersonaActivityLease({
              ...fence,
              ttlMs: this.leaseTtlMs,
            });
          } catch {
            leaseLost = true;
            abortController.abort();
            inFlight = undefined;
            return;
          }
          try {
            interruption = await this.interruptionRequested(fence);
            if (interruption) abortController.abort();
          } catch {
            // Renewal succeeded; a read failure is not proof that authority was
            // lost, so retry the observation on the next bounded heartbeat.
          }
          try {
            const current = await this.get(dispatchId);
            cancellation = Boolean(current?.cancellationRequestedAt);
            if (cancellation) abortController.abort();
          } catch {
            // A payload read failure is not proof the lease was lost. The next
            // heartbeat or authority assertion will retry it.
          } finally {
            inFlight = undefined;
            if (!leaseLost && !interruption && !cancellation) schedule();
          }
        });
      }, this.heartbeatIntervalMs);
      timer.unref();
    };
    schedule();

    return {
      lost: () => leaseLost,
      interrupted: () => interruption,
      cancelled: () => cancellation,
      stop: async () => {
        stopped = true;
        if (timer) timer.clear();
        if (inFlight) await inFlight;
      },
    };
  }

  private async saveTerminalError(
    record: PersonaFlowDispatchRecord,
    error: PersonaFlowDispatchError,
  ): Promise<PersonaFlowDispatchRecord> {
    return this.inWorkspace(() => withPersonaRuntimeLock(
      record.personaId,
      (lock) => this.saveTerminalErrorWithinRuntimeLock(record, error, lock),
    ));
  }

  /**
   * Task projection is retryable and must never roll back an authoritative
   * Activity/dispatch terminal transition. Reconciliation revisits terminal
   * dispatches after restart if this best-effort projection is interrupted.
   */
  private async synchronizeAssignedWorkItem(activity: PersonaActivity): Promise<void> {
    try {
      await this.inWorkspace(() => (
        this.dependencies.synchronizeAssignedWorkItemFromActivity(activity)
      ));
    } catch (error) {
      log.warn(`Deferred Task lifecycle synchronization for Activity ${activity.id}:`, error);
    }
    await this.recordBehaviorOutcome(activity);
  }

  /**
   * Outcome measurement for an activated Behavior proposal (issue #455). The
   * rollout gate defaults off, making this a no-write call. Recording is
   * idempotent per Activity and must never fail a dispatch, so it is deferred
   * rather than taken inside the runtime lock.
   */
  private async recordBehaviorOutcome(activity: PersonaActivity): Promise<void> {
    await this.inWorkspace(() => recordBehaviorOutcomeSampleSafely(activity));
  }

  private async synchronizeAssignedWorkItemWithinRuntimeLock(
    activity: PersonaActivity,
    lock: PersonaRuntimeLock,
  ): Promise<boolean> {
    try {
      await this.dependencies.synchronizeAssignedWorkItemFromActivityWithinRuntimeLock(
        activity,
        lock,
      );
      return true;
    } catch (error) {
      log.warn(`Deferred atomic Task synchronization for Activity ${activity.id}:`, error);
      return false;
    }
  }

  private async saveTerminalErrorWithinRuntimeLock(
    record: PersonaFlowDispatchRecord,
    error: PersonaFlowDispatchError,
    lock: PersonaRuntimeLock,
  ): Promise<PersonaFlowDispatchRecord> {
    await lock.assertOwned();
    const latest = (await this.get(record.id).catch(() => null)) ?? record;
    if (isTerminalDispatch(latest.state) || latest.cancellationRequestedAt) return latest;
    const now = Math.max(runtimeClock.now(), latest.updatedAt);
    return this.save({
      ...latest,
      state: 'error',
      waitingReason: undefined,
      resumePreparationRequired: false,
      resumeSettledAt: latest.resumeRequestedAt ? now : latest.resumeSettledAt,
      error,
      lastError: undefined,
      completedAt: now,
      updatedAt: now,
    });
  }

  private async failClaimWithoutPayload(
    claim: PersonaActivityClaim,
    cause: unknown,
  ): Promise<void> {
    const fence = fenceForClaim(claim);
    const error = dispatchError(
      'PAYLOAD_MISSING_OR_CORRUPT',
      cause,
      'The claimed mailbox item has no valid Flow dispatch payload.',
    );
    try {
      const completion = await this.inWorkspace(() => this.dependencies.completePersonaActivity({
        ...fence,
        status: 'error',
        error: error.message,
      }));
      await this.synchronizeAssignedWorkItem(completion.activity);
    } catch {
      // The runtime remains authoritative. If this fence was lost it will close
      // uncertain work on expiry; never attempt a second execution here.
    }
    const requestedRef = claim.mailboxItem.payloadRef;
    let id: string;
    try {
      if (!requestedRef) throw new Error('missing');
      assertSafeCollectionId(requestedRef);
      id = requestedRef;
    } catch {
      id = stableEnduringAgentId('dispatch', {
        purpose: 'persona-flow-dispatch-recovery-error-v1',
        workspaceId: this.workspaceId,
        mailboxItemId: claim.mailboxItem.id,
      });
    }
    const existing = await this.get(id).catch(() => null);
    const now = runtimeClock.now();
    await this.save({
      schemaVersion: PERSONA_FLOW_DISPATCH_SCHEMA_VERSION,
      id,
      workspaceId: this.workspaceId,
      personaId: claim.activity.personaId,
      idempotencyDigest: sha256(id),
      requestHash: sha256(canonicalJson({ mailboxItemId: claim.mailboxItem.id, error: error.code })),
      state: 'error',
      admission: existing?.admission ?? {
        kind: claim.mailboxItem.kind,
        priority: claim.mailboxItem.priority,
        source: {
          kind: claim.mailboxItem.source.kind,
          ...(claim.mailboxItem.source.sourceId
            ? { sourceId: claim.mailboxItem.source.sourceId }
            : {}),
        },
        ...(claim.mailboxItem.behaviorSlotKey
          ? { behaviorSlotKey: claim.mailboxItem.behaviorSlotKey }
          : {}),
        ...(claim.mailboxItem.relationKey
          ? { relationKey: claim.mailboxItem.relationKey }
          : {}),
        ...(claim.mailboxItem.summary ? { summary: claim.mailboxItem.summary } : {}),
      },
      mailboxItemId: claim.mailboxItem.id,
      activityId: claim.activity.id,
      behaviorRevisionId: claim.activity.behaviorRevisionId,
      error,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      completedAt: now,
    });
  }

  private validateClaim(
    claim: PersonaActivityClaim,
    record: PersonaFlowDispatchRecord,
    revision: BehaviorRevision,
  ): void {
    if (
      claim.lease.workspaceId !== this.workspaceId
      || claim.activity.personaId !== record.personaId
      || claim.mailboxItem.personaId !== record.personaId
      || claim.mailboxItem.id !== record.mailboxItemId
      || claim.mailboxItem.payloadRef !== record.id
      || !claim.activity.behaviorRevisionId
      || claim.activity.behaviorRevisionId !== revision.id
      || revision.personaId !== record.personaId
      || revision.behaviorId !== claim.activity.behaviorId
    ) {
      throw new PersonaFlowDispatchCorruptionError(
        record.id,
        'Claim, dispatch payload, and pinned Behavior revision do not agree.',
      );
    }
  }

  private async commitTerminal(
    record: PersonaFlowDispatchRecord,
    fence: PersonaLeaseFence,
    requested: TerminalDispatchRequest,
  ): Promise<PersonaFlowDispatchRecord> {
    let completion: CompletedPersonaActivity | undefined;
    let assignmentSynchronized = false;
    const terminal = await this.inWorkspace(() => withPersonaRuntimeLock(
      record.personaId,
      async (lock) => {
        const latest = (await this.get(record.id)) ?? record;
        if (isTerminalDispatch(latest.state)) return latest;

        // This read and the authoritative Activity transition share the same
        // Persona lock as cancel(). Whichever lock acquisition happens first
        // owns terminal precedence; no stale post-run save can erase it.
        const effectiveStatus = latest.cancellationRequestedAt
          ? 'cancelled' as const
          : requested.status;
        if (effectiveStatus === 'error' && !requested.error) {
          throw new PersonaFlowDispatchCorruptionError(
            latest.id,
            'An errored terminal dispatch requires a sanitized error.',
          );
        }
        const semanticOutcome = semanticOutcomeFromDispatch({
          status: effectiveStatus,
          outcome: requested.outcome,
          activityId: fence.activityId,
          decidedAt: runtimeClock.now(),
        });
        completion = await this.dependencies.completePersonaActivityWithinRuntimeLock({
          ...fence,
          status: effectiveStatus,
          outcome: semanticOutcome,
          ...(effectiveStatus === 'completed' || effectiveStatus === 'cancelled'
            ? { outcomeRef: latest.id }
            : { error: requested.error!.message }),
        }, lock);
        assignmentSynchronized = await this.synchronizeAssignedWorkItemWithinRuntimeLock(
          completion.activity,
          lock,
        );
        const now = Math.max(
          runtimeClock.now(),
          latest.updatedAt,
          completion.activity.updatedAt,
          completion.activity.completedAt ?? 0,
        );
        const common = {
          ...latest,
          ...(requested.maintenanceResult
            ? { maintenanceResult: requested.maintenanceResult }
            : {}),
          waitingReason: undefined,
          resumePreparationRequired: false,
          resumeSettledAt: latest.resumeRequestedAt ? now : latest.resumeSettledAt,
          lastError: undefined,
          completedAt: completion.activity.completedAt ?? now,
          updatedAt: now,
        };
        if (effectiveStatus === 'cancelled') {
          return this.save({
            ...common,
            state: 'cancelled',
            error: undefined,
          });
        }
        if (effectiveStatus === 'error') {
          return this.save({
            ...common,
            state: 'error',
            outcome: requested.outcome,
            error: requested.error!,
          });
        }
        if (!requested.outcome) {
          throw new PersonaFlowDispatchCorruptionError(
            latest.id,
            'A completed terminal dispatch requires a sanitized outcome.',
          );
        }
        return this.save({
          ...common,
          state: 'completed',
          outcome: requested.outcome,
          error: undefined,
        });
      },
    ));
    if (completion) {
      try {
        await this.inWorkspace(() => this.dependencies.observeCompletedPersonaActivity(completion!));
      } catch (error) {
        // Observability is projection-only. The Activity and dispatch terminal
        // states above are already authoritative and must never be rewritten.
        log.warn(`Failed to observe terminal Persona Activity ${fence.activityId}:`, error);
      }
      if (!assignmentSynchronized) {
        await this.synchronizeAssignedWorkItem(completion.activity);
      } else {
        await this.recordBehaviorOutcome(completion.activity);
      }
      let maintenanceRun: BehaviorMaintenanceRun | null = null;
      try {
        // The rollout gate defaults off, making this a no-write call. When
        // enabled, admission occurs only after the source terminal commit.
        maintenanceRun = await this.inWorkspace(() => (
          admitBehaviorMaintenanceRun(completion!.activity)
        ));
      } catch (error) {
        log.warn(`Deferred Behavior maintenance admission for ${fence.activityId}:`, error);
      }
      // Reconcile unconditionally for this Persona. Admission returns null when
      // its gate is turned off mid-flight, and previously active runs would
      // otherwise stay stranded until the next process start.
      const maintenancePersonaId = maintenanceRun?.personaId ?? completion.activity.personaId;
      void this.inWorkspace(() => (
        reconcileBehaviorMaintenanceRuns(maintenancePersonaId)
      )).catch((error) => {
        log.warn(`Deferred Behavior maintenance diagnosis for ${fence.activityId}:`, error);
      });
    }
    return terminal;
  }

  private async completeCancellation(
    record: PersonaFlowDispatchRecord,
    fence: PersonaLeaseFence,
  ): Promise<void> {
    await this.commitTerminal(record, fence, { status: 'cancelled' });
  }

  private async yieldForInterruption(
    record: PersonaFlowDispatchRecord,
    fence: PersonaLeaseFence,
  ): Promise<boolean> {
    let cancellation: PersonaFlowDispatchRecord | undefined;
    let yielded = false;
    let waitingRecord: PersonaFlowDispatchRecord;
    try {
      waitingRecord = await this.inWorkspace(() => withPersonaRuntimeLock(
        record.personaId,
        async (lock) => {
          const latest = (await this.get(record.id)) ?? record;
          if (isTerminalDispatch(latest.state)) return latest;
          if (latest.cancellationRequestedAt) {
            cancellation = latest;
            return latest;
          }
          await this.dependencies.yieldPersonaActivityForInterruptionWithinRuntimeLock(fence, lock);
          yielded = true;
          const now = Math.max(runtimeClock.now(), latest.updatedAt);
          return this.save({
            ...latest,
            state: 'waiting',
            waitingReason: 'interrupted',
            resumePreparationRequired: false,
            resumeSettledAt: latest.resumeRequestedAt ? now : latest.resumeSettledAt,
            error: undefined,
            lastError: undefined,
            completedAt: undefined,
            updatedAt: now,
          });
        },
      ));
    } catch {
      await this.saveTerminalError(record, leaseLostDispatchError());
      return false;
    }
    if (cancellation) {
      await this.completeCancellation(cancellation, fence);
      return false;
    }
    if (!yielded || isTerminalDispatch(waitingRecord.state)) return false;
    try {
      await this.inWorkspace(() => this.dependencies.observeYieldedPersonaActivity(fence));
    } catch (error) {
      log.warn(`Failed to observe yielded Persona Activity ${fence.activityId}:`, error);
    }
    return true;
  }

  private sanitizedOutcome(
    result: FlowRunResult,
    record: PersonaFlowDispatchRecord,
  ): PersonaFlowDispatchOutcome {
    if (!record.activityId || !record.behaviorRevisionId) {
      throw new PersonaFlowDispatchCorruptionError(
        record.id,
        'Cannot persist an attributed outcome before Activity pinning.',
      );
    }
    return DispatchOutcomeSchema.parse({
      status: result.status,
      ...(result.conversationId ? { conversationId: result.conversationId } : {}),
      ...(result.runId ? { runId: result.runId } : {}),
      ...(result.outputText
        ? { outputText: sanitizeText(result.outputText, MAX_OUTCOME_TEXT, '') }
        : {}),
      ...(result.finalAction
        ? { finalAction: sanitizeText(result.finalAction, 512, '') }
        : {}),
      personaId: record.personaId,
      activityId: record.activityId,
      behaviorRevisionId: record.behaviorRevisionId,
    }) as PersonaFlowDispatchOutcome;
  }

  private async ensurePostActivityMaintenance(
    source: PersonaFlowDispatchRecord,
  ): Promise<PersonaFlowDispatchRecord | null> {
    if (
      source.state !== 'completed'
      || source.admission.kind === 'maintenance'
      || !source.activityId
      || !source.completedAt
    ) return null;
    const persona = await this.inWorkspace(() => this.dependencies.getPersona(source.personaId));
    if (!persona || persona.autonomyLevel === 'locked') return null;
    const candidateLimit = source.memoryCandidateLimit ?? 0;
    if (candidateLimit === 0) return null;
    const plan = await this.inWorkspace(() => buildMemoryMaintenancePlan({
      sourceDispatchId: source.id,
      sourceActivityId: source.activityId!,
      sourceKind: source.admission.source.kind,
      conversationId: source.outcome?.conversationId ?? source.flowInput?.conversationId,
      fallbackOutput: source.outcome?.outputText,
      candidateLimit,
      completedAt: source.completedAt,
    }));
    const prompt = renderMemoryMaintenancePrompt(plan);
    const submission = await this.submit({
      workspaceId: this.workspaceId,
      personaId: source.personaId,
      idempotencyKey: `post-activity-maintenance:${source.id}`,
      kind: 'maintenance',
      priority: 'low',
      source: {
        kind: 'maintenance',
        sourceId: source.activityId,
        idempotencyKey: `post-activity-maintenance:${source.id}`,
      },
      behaviorSlotKey: 'maintain_memory',
      relationKey: `activity:${source.activityId}:maintenance`,
      summary: `Review completed Activity ${source.activityId} for durable memory candidates.`,
      flowInput: {
        source: 'internal',
        mode: 'conversation',
        title: 'Post-Activity memory maintenance',
        requireApproval: false,
        onApprovalRequired: 'fail',
        messages: [{
          id: stableEnduringAgentId('message', {
            dispatchId: source.id,
            purpose: 'maintenance-evidence',
          }),
          role: 'user',
          content: prompt,
          timestamp: source.completedAt,
        }],
      },
      maintenancePlan: plan,
    }, { startPump: false });
    return submission.dispatch;
  }

  private async executeClaim(claim: PersonaActivityClaim, control: PumpControl): Promise<boolean> {
    const payloadRef = claim.mailboxItem.payloadRef;
    // MeetingEngine and future Persona runtimes own their own payload formats.
    // The generic Flow pump may win the shared lease race, but it must yield
    // untouched work that is not explicitly addressed to this dispatcher.
    if (!payloadRef?.startsWith('dispatch_')) {
      try {
        await this.inWorkspace(() => this.dependencies.releasePersonaActivityLease(
          fenceForClaim(claim),
        ));
      } catch {
        // A lost fence remains runtime-owned; never turn foreign work into a
        // dispatcher error and never retry it here.
      }
      return false;
    }
    let record: PersonaFlowDispatchRecord;
    try {
      if (!payloadRef) throw new Error('Mailbox item has no payloadRef.');
      record = await this.get(payloadRef) as PersonaFlowDispatchRecord;
      if (!record) throw new Error('Dispatch payload does not exist.');
      if (!record.flowInput) throw new Error('Dispatch payload has no Flow input.');
    } catch (error) {
      await this.failClaimWithoutPayload(claim, error);
      return true;
    }

    if (isTerminalDispatch(record.state)) {
      try {
        const completion = await this.inWorkspace(() => this.dependencies.completePersonaActivity({
          ...fenceForClaim(claim),
          status: record.state === 'completed'
            ? 'completed'
            : record.state === 'cancelled'
              ? 'cancelled'
              : 'error',
          ...(record.state === 'completed' ? { outcomeRef: record.id } : {}),
          ...(record.state === 'error'
            ? { error: record.error?.message ?? 'Dispatch already failed.' }
            : {}),
        }));
        await this.synchronizeAssignedWorkItem(completion.activity);
      } catch {
        // Never replay a terminal dispatch merely to repair a stale mailbox
        // projection. The runtime will reconcile the authoritative lease.
        return false;
      }
      return true;
    }

    let revision: BehaviorRevision | null = null;
    try {
      if (!claim.activity.behaviorRevisionId) {
        throw new Error('Claimed Activity has no Behavior revision pin.');
      }
      revision = await this.inWorkspace(() => this.dependencies.getBehaviorRevision(
        claim.activity.behaviorRevisionId!,
      ));
      if (!revision) throw new Error('Pinned Behavior revision no longer exists.');
      this.validateClaim(claim, record, revision);
    } catch (error) {
      await this.failClaimWithoutPayload(claim, error);
      return true;
    }

    let instructionContext: PersonaInstructionContext | undefined;
    let coreAppRefs = claim.activity.coreAppRefs ?? [];
    let memoryCandidateLimit = record.memoryCandidateLimit;
    try {
      if (claim.activity.instructionContext) {
        // The Activity is the authoritative immutable resume source. Dispatch
        // envelopes remain a compatibility mirror for records created earlier.
        instructionContext = assertActivityInstructionContextMatchesClaim(
          record,
          claim,
          revision,
        );
      } else if (record.instructionContext) {
        instructionContext = assertInstructionContextMatchesClaim(record, claim, revision);
      } else if (record.startedAt === undefined) {
        // Resolve mutable Persona metadata exactly once, before the first run.
        // A started legacy record without this field remains context-free: do
        // not guess historical identity/mission data during resume or recovery.
        const persona = await this.inWorkspace(() => this.dependencies.getPersona(record.personaId));
        if (!persona) throw new Error('Persona no longer exists.');
        coreAppRefs = claim.activity.kind === 'maintenance'
          ? []
          : await this.inWorkspace(() => (
              this.dependencies.snapshotPersonaCoreAppRefs(persona.id, persona)
            ));
        const roleVersion = await this.inWorkspace(() => this.dependencies.getRoleVersion(
          persona.roleVersionId,
        ));
        if (!roleVersion) throw new Error('Persona-pinned Role version no longer exists.');
        memoryCandidateLimit = roleVersion.behaviorSlots.some((slot) => slot.key === 'maintain_memory')
          ? Math.max(0, Math.min(roleVersion.defaults?.memory?.candidateLimitPerActivity ?? 3, 3))
          : 0;
        instructionContext = buildPersonaInstructionContext({
          persona,
          roleVersion,
          revision,
          activityId: claim.activity.id,
          coreMemoryItems: await this.inWorkspace(() => this.dependencies.getCoreMemory(persona.id)),
        });
      }
    } catch (error) {
      await this.failClaimWithoutPayload(claim, error);
      return true;
    }

    const fence = fenceForClaim(claim);
    const conversationId = record.flowInput.conversationId ?? randomUUID();
    const runId = record.flowInput.runId ?? randomUUID();
    const flowInput = cloneSerializableFlowInput({
      ...record.flowInput,
      conversationId,
      runId,
    });
    const meetingId = flowInput.meetingParticipant
      && typeof flowInput.meetingParticipant === 'object'
      && 'meetingId' in flowInput.meetingParticipant
      && typeof flowInput.meetingParticipant.meetingId === 'string'
      ? flowInput.meetingParticipant.meetingId
      : undefined;

    if (instructionContext) {
      try {
        const snapshot = createPersonaActivitySnapshot({
          activity: claim.activity,
          revision,
          context: instructionContext,
          coreAppRefs,
          ...(claim.mailboxItem.payloadRef
            ? { entryPointPayloadRef: claim.mailboxItem.payloadRef }
            : {}),
        });
        await this.inWorkspace(() => this.dependencies.persistPersonaActivitySnapshot({
          ...fence,
          ...snapshot,
        }));
      } catch (error) {
        await this.failClaimWithoutPayload(claim, error);
        return true;
      }
    }

    try {
      await this.inWorkspace(() => this.dependencies.updatePersonaActivityReferences({
        ...fence,
        conversationId,
        runId,
        ...(meetingId ? { meetingId } : {}),
      }));
    } catch (error) {
      await this.saveTerminalError(record, leaseLostDispatchError());
      return false;
    }

    const abortController = new AbortController();
    const runningTransition = await this.enterRunning(
      record,
      (latest) => ({
        ...latest,
        state: 'running',
        waitingReason: undefined,
        flowInput,
        activityId: claim.activity.id,
        behaviorRevisionId: revision.id,
        instructionContext: latest.instructionContext ?? (
          latest.startedAt === undefined ? instructionContext : undefined
        ),
        memoryCandidateLimit: latest.memoryCandidateLimit ?? (
          latest.startedAt === undefined ? memoryCandidateLimit : undefined
        ),
        error: undefined,
        lastError: undefined,
        startedAt: latest.startedAt ?? runtimeClock.now(),
        updatedAt: Math.max(runtimeClock.now(), latest.updatedAt),
        completedAt: undefined,
      }),
      { control, abortController },
    );
    record = runningTransition.record;
    if (!runningTransition.entered) {
      if (record.cancellationRequestedAt && !isTerminalDispatch(record.state)) {
        await this.completeCancellation(record, fence);
      }
      return false;
    }
    if (claim.activity.instructionContext) {
      instructionContext = assertActivityInstructionContextMatchesClaim(record, claim, revision);
      if (
        record.instructionContext
        && canonicalJson(record.instructionContext) !== canonicalJson(instructionContext)
      ) {
        await this.failClaimWithoutPayload(
          claim,
          new PersonaFlowDispatchCorruptionError(
            record.id,
            'Dispatch context does not match the authoritative Activity Core snapshot.',
          ),
        );
        return true;
      }
    } else if (record.instructionContext) {
      // First execution mirrors the context written to the Activity into the
      // private dispatch envelope for older recovery tooling.
      instructionContext = assertInstructionContextMatchesClaim(record, claim, revision);
    } else {
      instructionContext = undefined;
    }
    if (control.cancelRequested) abortController.abort();
    const heartbeat = this.beginHeartbeat(fence, record.id, abortController);
    let maintenanceCommitResult: MemoryMaintenanceResult | undefined;
    let maintenanceCommitPromise: Promise<MemoryMaintenanceResult> | undefined;
    const maintenanceProposalResults: MemoryMaintenanceResult[] = [];
    const maintenanceCreatedIds = new Set<string>();
    let maintenanceProposalChain: Promise<void> = Promise.resolve();
    try {
    if (await this.interruptionRequested(fence)) {
      abortController.abort();
      await heartbeat.stop();
      control.activeAbort = undefined;
      control.activeDispatchId = undefined;
      return this.yieldForInterruption(record, fence);
    }
    const authority: FlowExecutionAuthority = {
      signal: abortController.signal,
      assertCurrent: async () => {
        if (heartbeat.lost()) throw new Error('Persona execution authority was lost.');
        await this.inWorkspace(() => this.dependencies.assertPersonaActivityLease(fence));
      },
      authorizePersonaCoreMcp: async (serverName, nodeId) => {
        if (!isPersonaCoreAppNodeId(nodeId)) return;
        if (heartbeat.lost()) throw new Error('Persona execution authority was lost.');
        await this.inWorkspace(async () => {
          await this.dependencies.assertPersonaActivityLease(fence);
          await authorizePersonaCoreAppAccess(record.personaId, coreAppRefs, serverName);
        });
      },
      commitWhileCurrent: <T>(task: () => Promise<T>) => this.inWorkspace(() => (
        this.dependencies.commitWithPersonaActivityLease(fence, task)
      )),
      commitPersonaMutation: <T>(task: Parameters<typeof commitPersonaActivityMutation<T>>[1]) => (
        this.inWorkspace(() => commitPersonaActivityMutation(fence, task))
      ),
      ...(record.maintenancePlan && claim.activity.kind === 'maintenance' ? {
        commitPersonaMemoryMaintenance: (outputText: string) => {
          maintenanceCommitPromise ??= this.inWorkspace(() => persistMemoryMaintenanceOutput({
            personaId: record.personaId,
            plan: record.maintenancePlan!,
            outputText,
            executionAuthority: authority,
          })).then((committed) => {
            maintenanceCommitResult = committed;
            return committed;
          });
          return maintenanceCommitPromise;
        },
        proposePersonaMemoryMaintenance: (proposal: Record<string, unknown>) => {
          const submission = maintenanceProposalChain.then(async () => {
            if (maintenanceCreatedIds.size >= record.maintenancePlan!.candidateLimit) {
              const limited = MemoryMaintenanceResultSchema.parse({
                status: 'rejected',
                proposedCount: 1,
                createdCount: 0,
                rejectedCount: 1,
                created: [],
                issues: [{
                  code: 'invalid_schema',
                  path: 'remember',
                  message: `This maintenance run accepts at most ${record.maintenancePlan!.candidateLimit} candidate memories.`,
                }],
              }) as MemoryMaintenanceResult;
              maintenanceProposalResults.push(limited);
              return {
                success: false,
                error: renderMemoryMaintenanceConversationMessage(limited),
              };
            }
            let persisted: MemoryMaintenanceResult;
            try {
              persisted = await this.inWorkspace(() => persistMemoryMaintenanceProposal({
                personaId: record.personaId,
                plan: record.maintenancePlan!,
                proposal,
                executionAuthority: authority,
              }));
            } catch (error) {
              persisted = MemoryMaintenanceResultSchema.parse({
                status: 'rejected',
                proposedCount: 1,
                createdCount: 0,
                rejectedCount: 1,
                created: [],
                issues: [{
                  code: 'persistence_error',
                  path: 'remember',
                  message: error instanceof Error ? error.message : 'The candidate memory could not be stored.',
                }],
              }) as MemoryMaintenanceResult;
            }
            maintenanceProposalResults.push(persisted);
            for (const created of persisted.created) maintenanceCreatedIds.add(created.id);
            if (persisted.status !== 'saved') {
              return {
                success: false,
                error: renderMemoryMaintenanceConversationMessage(persisted),
              };
            }
            return {
              success: true,
              data: {
                stored: true,
                candidate: persisted.created[0],
              },
            };
          });
          maintenanceProposalChain = submission.then(() => undefined, () => undefined);
          return submission;
        },
      } : {}),
      pollRelatedInputs: () => this.pollRelatedInputs(fence, conversationId),
      acknowledgeRelatedInputs: (messageIds) => this.acknowledgeRelatedInputs(
        fence,
        conversationId,
        messageIds,
      ),
    };

    // Approval/debug state mutation must happen under the same freshly claimed
    // authority as the continuation. The callback receives no raw fence. A
    // process restart loses callbacks by design; the durable marker below then
    // yields instead of executing an unprepared continuation.
    const lifecycle = await this.get(record.id);
    if (lifecycle) record = lifecycle;
    if (record.cancellationRequestedAt) abortController.abort();
    const preparation = this.resumePreparations.get(record.id);
    if (record.resumePreparationRequired && (
      !preparation
      || preparation.requestedAt !== record.resumeRequestedAt
      || !preparation.prepare
    )) {
      await heartbeat.stop();
      control.activeAbort = undefined;
      control.activeDispatchId = undefined;
      let cancellation: PersonaFlowDispatchRecord | undefined;
      const waitingRecord = await this.inWorkspace(() => withPersonaRuntimeLock(
        record.personaId,
        async () => {
          const latest = (await this.get(record.id)) ?? record;
          if (latest.cancellationRequestedAt) {
            cancellation = latest;
            return latest;
          }
          const now = Math.max(runtimeClock.now(), latest.updatedAt);
          return this.save({
            ...latest,
            state: 'waiting',
            waitingReason: latest.resumeFromWaitingReason ?? 'running',
            resumeSettledAt: now,
            lastError: dispatchError(
              'RESUME_PREPARATION_UNAVAILABLE',
              'The process-local resume preparation was lost before the Activity could be claimed.',
              'Persona resume preparation is no longer available; retry the lifecycle action.',
            ),
            updatedAt: now,
          });
        },
      ));
      if (cancellation) {
        await this.completeCancellation(cancellation, fence);
        return false;
      }
      try {
        await this.inWorkspace(() => this.dependencies.releasePersonaActivityLease(fence));
      } catch {
        await this.saveTerminalError(waitingRecord, leaseLostDispatchError());
        return false;
      }
      return false;
    }

    if (preparation?.prepare && preparation.requestedAt === record.resumeRequestedAt) {
      try {
        await authority.assertCurrent();
        const preparationResult = await preparation.prepare({
          dispatch: record,
          executionAuthority: authority,
          installExecutionAuthority(state) {
            Object.defineProperty(state, 'executionAuthority', {
              value: authority,
              enumerable: false,
              configurable: true,
              writable: true,
            });
          },
        });
        await authority.assertCurrent();
        if (preparationResult === 'yield') {
          await heartbeat.stop();
          control.activeAbort = undefined;
          control.activeDispatchId = undefined;
          let cancellation: PersonaFlowDispatchRecord | undefined;
          const waitingRecord = await this.inWorkspace(() => withPersonaRuntimeLock(
            record.personaId,
            async () => {
              const latest = (await this.get(record.id)) ?? record;
              if (latest.cancellationRequestedAt) {
                cancellation = latest;
                return latest;
              }
              const now = Math.max(runtimeClock.now(), latest.updatedAt);
              return this.save({
                ...latest,
                state: 'waiting',
                waitingReason: latest.resumeFromWaitingReason ?? 'running',
                resumePreparationRequired: false,
                resumeSettledAt: now,
                lastError: undefined,
                updatedAt: now,
              });
            },
          ));
          if (cancellation) {
            await this.completeCancellation(cancellation, fence);
            return false;
          }
          try {
            await this.inWorkspace(() => this.dependencies.releasePersonaActivityLease(fence));
          } catch {
            await this.saveTerminalError(waitingRecord, leaseLostDispatchError());
          }
          return false;
        }
        const preparedRunningTransition = await this.enterRunning(
          record,
          (latest) => ({
            ...latest,
            state: 'running',
            waitingReason: undefined,
            resumePreparationRequired: false,
            lastError: undefined,
            updatedAt: Math.max(runtimeClock.now(), latest.updatedAt),
          }),
        );
        record = preparedRunningTransition.record;
        if (!preparedRunningTransition.entered) {
          await heartbeat.stop();
          control.activeAbort = undefined;
          control.activeDispatchId = undefined;
          if (record.cancellationRequestedAt && !isTerminalDispatch(record.state)) {
            preparation.failure = undefined;
            await this.completeCancellation(record, fence);
          }
          return false;
        }
      } catch (error) {
        preparation.failure = error;
        await heartbeat.stop();
        control.activeAbort = undefined;
        control.activeDispatchId = undefined;
        if (heartbeat.lost()) {
          await this.saveTerminalError(record, leaseLostDispatchError());
          return false;
        }
        if (heartbeat.interrupted()) {
          return this.yieldForInterruption(record, fence);
        }
        const cancellation = await this.get(record.id).catch(() => null);
        if (heartbeat.cancelled() || cancellation?.cancellationRequestedAt) {
          preparation.failure = undefined;
          try {
            await this.completeCancellation(cancellation ?? record, fence);
          } catch {
            await this.saveTerminalError(record, leaseLostDispatchError());
          }
          return false;
        }
        let concurrentCancellation: PersonaFlowDispatchRecord | undefined;
        const waitingRecord = await this.inWorkspace(() => withPersonaRuntimeLock(
          record.personaId,
          async () => {
            const latest = (await this.get(record.id)) ?? record;
            if (latest.cancellationRequestedAt) {
              concurrentCancellation = latest;
              return latest;
            }
            const now = Math.max(runtimeClock.now(), latest.updatedAt);
            return this.save({
              ...latest,
              state: 'waiting',
              waitingReason: latest.resumeFromWaitingReason ?? 'running',
              resumePreparationRequired: false,
              resumeSettledAt: now,
              lastError: dispatchError(
                'RESUME_PREPARATION_FAILED',
                error,
                'Persona resume preparation failed.',
              ),
              updatedAt: now,
            });
          },
        ));
        if (concurrentCancellation) {
          preparation.failure = undefined;
          try {
            await this.completeCancellation(concurrentCancellation, fence);
          } catch {
            await this.saveTerminalError(record, leaseLostDispatchError());
          }
          return false;
        }
        try {
          await this.inWorkspace(() => this.dependencies.releasePersonaActivityLease(fence));
        } catch {
          await this.saveTerminalError(waitingRecord, leaseLostDispatchError());
        }
        return false;
      }
    }

    let result: FlowRunResult;
    let maintenanceResult: MemoryMaintenanceResult | undefined;
    try {
      await authority.assertCurrent();
      const behaviorPersona = await this.inWorkspace(
        () => this.dependencies.getPersona(record.personaId),
      );
      if (!behaviorPersona) throw new Error('Owning Persona no longer exists.');
      const behaviorToolRegistry = buildBehaviorToolRegistry({
        personaId: behaviorPersona.id,
        behaviors: behaviorPersona.composition?.behaviors ?? [],
        excludeBehaviorId: revision.behaviorId,
      });
      const coreFlowDefinition = claim.activity.kind === 'maintenance'
        ? restrictedMaintenanceFlow(revision.flowSnapshot)
        : await this.inWorkspace(() => this.dependencies.projectPersonaCoreAppsIntoFlow(
            record.personaId,
            coreAppRefs,
            structuredClone(revision.flowSnapshot),
          ));
      result = await this.inWorkspace(() => this.dependencies.runFlow({
        ...flowInput,
        // Persona Apps are projected only into this Activity-local Core clone.
        // The persisted Core revision and generic Behavior Flow remain unchanged.
        flowDefinition: coreFlowDefinition,
        abortSignal: abortController.signal,
        executionAuthority: authority,
        ...(claim.activity.kind !== 'maintenance' && coreAppRefs.length > 0
          ? { personaCoreAppRefs: [...coreAppRefs] }
          : {}),
        behaviorToolRegistry,
        personaAttribution: {
          personaId: record.personaId,
          activityId: record.activityId,
          behaviorRevisionId: record.behaviorRevisionId,
        },
        ...(instructionContext
          ? { personaInstructionContext: structuredClone(instructionContext) }
          : {}),
      }));
      if (
        record.maintenancePlan
        && claim.activity.kind === 'maintenance'
        && (result.status === 'completed' || result.status === 'capped')
      ) {
        await maintenanceProposalChain;
        // Legacy in-flight snapshots may still invoke the former one-shot
        // captured-output gateway. Current Flows aggregate the outcomes of their
        // schema-bearing remember tool calls instead.
        maintenanceResult = maintenanceCommitResult
          ?? aggregateMemoryMaintenanceResults(maintenanceProposalResults);
        const maintenanceLog = {
          dispatchId: record.id,
          activityId: record.activityId,
          status: maintenanceResult.status,
          proposedCount: maintenanceResult.proposedCount,
          createdCount: maintenanceResult.createdCount,
          rejectedCount: maintenanceResult.rejectedCount,
          issues: maintenanceResult.issues.map((issue) => ({
            code: issue.code,
            path: issue.path,
          })),
        };
        if (
          maintenanceResult.status === 'invalid_output'
          || maintenanceResult.status === 'rejected'
        ) {
          log.warn('Memory maintenance completed without saving its proposals.', maintenanceLog);
        } else {
          log.info('Memory maintenance persistence completed.', maintenanceLog);
        }
        await this.inWorkspace(() => this.dependencies.appendConversationMessage(
          conversationId,
          {
            id: `memory_maintenance_result_${record.id}`,
            role: 'assistant',
            content: renderMemoryMaintenanceConversationMessage(maintenanceResult!),
            timestamp: runtimeClock.now(),
            ...(result.sharedState.currentNodeId
              ? { processNodeId: result.sharedState.currentNodeId }
              : {}),
          },
          authority,
        ));
      }
      await heartbeat.stop();
      control.activeAbort = undefined;
      control.activeDispatchId = undefined;
      if (heartbeat.lost()) {
        await this.saveTerminalError(record, leaseLostDispatchError());
        return false;
      }
      if (heartbeat.interrupted()) {
        return this.yieldForInterruption(record, fence);
      }
      const latest = await this.get(record.id).catch(() => null);
      if (control.cancelRequested || heartbeat.cancelled() || latest?.cancellationRequestedAt) {
        await this.completeCancellation(latest ?? record, fence);
        return false;
      }
      await authority.assertCurrent();
    } catch (error) {
      await heartbeat.stop();
      control.activeAbort = undefined;
      control.activeDispatchId = undefined;
      if (heartbeat.lost()) {
        await this.saveTerminalError(record, leaseLostDispatchError());
        return false;
      }
      if (heartbeat.interrupted()) {
        return this.yieldForInterruption(record, fence);
      }
      const latest = await this.get(record.id).catch(() => null);
      if (control.cancelRequested || heartbeat.cancelled() || latest?.cancellationRequestedAt) {
        try {
          await this.completeCancellation(latest ?? record, fence);
        } catch {
          await this.saveTerminalError(record, leaseLostDispatchError());
        }
        return false;
      }
      const failure = dispatchError('FLOW_EXECUTION_FAILED', error, 'Persona Flow execution failed.');
      try {
        await this.commitTerminal(record, fence, {
          status: 'error',
          error: failure,
        });
      } catch {
        await this.saveTerminalError(record, leaseLostDispatchError());
      }
      return false;
    }

    const outcome = this.sanitizedOutcome(result, record);
    if (
      result.status === 'awaiting_tool_approval'
      || result.status === 'paused_debug'
      || result.status === 'running'
    ) {
      let cancellation: PersonaFlowDispatchRecord | undefined;
      const waitingRecord = await this.inWorkspace(() => withPersonaRuntimeLock(
        record.personaId,
        async () => {
          const latest = (await this.get(record.id)) ?? record;
          if (latest.cancellationRequestedAt) {
            cancellation = latest;
            return latest;
          }
          const now = Math.max(runtimeClock.now(), latest.updatedAt);
          return this.save({
            ...latest,
            state: 'waiting',
            waitingReason: result.status === 'awaiting_tool_approval'
              ? 'approval'
              : result.status === 'paused_debug'
                ? 'debug'
                : 'running',
            outcome,
            resumePreparationRequired: false,
            resumeSettledAt: latest.resumeRequestedAt ? now : latest.resumeSettledAt,
            updatedAt: now,
          });
        },
      ));
      if (cancellation) {
        await this.completeCancellation(cancellation, fence);
        return false;
      }
      try {
        await this.inWorkspace(() => this.dependencies.releasePersonaActivityLease(fence));
      } catch {
        await this.saveTerminalError(waitingRecord, leaseLostDispatchError());
        return false;
      }
      // A waiting claimed item is intentionally not reacquired until an
      // explicit resume changes its durable dispatch state.
      return false;
    }

    if (result.status === 'error') {
      const failure = dispatchError(
        'FLOW_RESULT_ERROR',
        result.error?.message ?? result.outputText,
        'Persona Flow returned an error.',
      );
      try {
        await this.commitTerminal(record, fence, {
          status: 'error',
          outcome,
          error: failure,
        });
      } catch {
        await this.saveTerminalError(record, leaseLostDispatchError());
        return false;
      }
      return true;
    }

    try {
      const terminal = await this.commitTerminal(record, fence, {
        status: 'completed',
        outcome,
        ...(maintenanceResult ? { maintenanceResult } : {}),
      });
      try {
        await this.ensurePostActivityMaintenance(terminal);
      } catch (error) {
        // The source Activity is already terminal. Startup/drain reconciliation
        // retries the deterministic maintenance admission without replaying it.
        log.warn(`Deferred post-Activity maintenance for ${terminal.id}:`, error);
      }
    } catch {
      await this.saveTerminalError(record, leaseLostDispatchError());
      return false;
    }
    return true;
    } finally {
      await heartbeat.stop();
      if (control.activeAbort === abortController) {
        control.activeAbort = undefined;
        control.activeDispatchId = undefined;
      }
    }
  }

  private async hasDurableRelatedMessage(
    record: PersonaFlowDispatchRecord,
    target: PersonaActivity | null,
  ): Promise<boolean> {
    const conversationId = target?.conversationId ?? record.flowInput?.conversationId;
    if (!conversationId) return false;
    const events = await this.inWorkspace(() => (
      this.dependencies.readConversationLog(conversationId)
    ));
    return Boolean(events?.some((event) => (
      event.type === 'message' && event.message.id === record.id
    )));
  }

  /**
   * Repair the two durable boundaries of related-input delivery:
   *
   * 1. delivered mailbox + nonterminal dispatch means the process stopped
   *    after ACK and before saving the private completion projection;
   * 2. a stable message id in the transcript + a runtime-requeued mailbox item
   *    means the process stopped after transcript append and before ACK.
   */
  private async reconcileRelatedDelivery(
    record: PersonaFlowDispatchRecord,
  ): Promise<PersonaFlowDispatchRecord> {
    if (
      record.state !== 'waiting'
      || record.waitingReason !== 'delivery'
      || !record.mailboxItemId
      || !record.targetActivityId
    ) return record;
    const item = await this.inWorkspace(() => (
      this.dependencies.getPersonaMailboxItem(record.personaId, record.mailboxItemId!)
    ));
    if (!item) return record;
    if (item.personaId !== record.personaId || item.payloadRef !== record.id) {
      return this.saveTerminalError(
        record,
        dispatchError(
          'DELIVERY_PAYLOAD_INVALID',
          'The routed mailbox item no longer references its dispatch payload.',
          'The routed Persona input is corrupt.',
        ),
      );
    }
    const target = await this.inWorkspace(() => (
      this.dependencies.getPersonaActivity(record.personaId, record.targetActivityId!)
    ));
    const conversationId = target?.conversationId ?? record.flowInput?.conversationId;
    if (item.deliveryStatus === 'delivered') {
      await this.inWorkspace(() => this.completeRelatedDispatch(
        record,
        item,
        conversationId,
      ));
      return (await this.get(record.id)) ?? record;
    }

    const messageIsDurable = await this.hasDurableRelatedMessage(record, target);
    if (!messageIsDurable && item.status === 'rejected') {
      if (record.cancellationRequestedAt) {
        await this.inWorkspace(() => this.completeRelatedDispatch(
          record,
          item,
          conversationId,
        ));
        return (await this.get(record.id)) ?? record;
      }
      return this.saveTerminalError(
        record,
        dispatchError(
          'DELIVERY_UNSUPPORTED',
          'The fenced target rejected an unsupported routed input.',
          'Routed input cannot be delivered to the active Flow.',
        ),
      );
    }
    if (!messageIsDurable) return record;

    // Terminal/expired Activity reconciliation returns an unacknowledged input
    // to the queue. Once its stable id is already in the transcript it must be
    // rejected before the dispatcher can claim it as a second Activity.
    let repairedItem = item;
    if (item.status === 'queued') {
      repairedItem = await this.inWorkspace(() => (
        this.dependencies.cancelPersonaMailboxItem({
          personaId: record.personaId,
          mailboxItemId: item.id,
        })
      ));
    }
    if (repairedItem.status !== 'rejected' && repairedItem.status !== 'completed') {
      return record;
    }
    await this.inWorkspace(() => this.completeRelatedDispatch(
      record,
      repairedItem,
      conversationId,
    ));
    return (await this.get(record.id)) ?? record;
  }

  private async reconcileRecord(record: PersonaFlowDispatchRecord): Promise<PersonaFlowDispatchRecord> {
    if (isTerminalDispatch(record.state)) {
      if (record.activityId) {
        const activity = await this.inWorkspace(() => (
          this.dependencies.getPersonaActivity(record.personaId, record.activityId!)
        ));
        if (activity) await this.synchronizeAssignedWorkItem(activity);
      }
      return record;
    }
    if (record.state === 'waiting' && record.waitingReason === 'delivery') {
      const repaired = await this.reconcileRelatedDelivery(record);
      if (isTerminalDispatch(repaired.state) || repaired.waitingReason === 'delivery') {
        return repaired;
      }
      record = repaired;
    }
    const reconciled = await this.inWorkspace(() => withPersonaRuntimeLock(
      record.personaId,
      async (lock) => {
      const current = (await this.get(record.id)) ?? record;
      if (isTerminalDispatch(current.state)) return current;
      // Delivery repair owns this lifecycle until it has an authoritative
      // mailbox boundary to project.
      if (current.state === 'waiting' && current.waitingReason === 'delivery') return current;
      if (!current.activityId) return current;
      const activity = await this.dependencies.getPersonaActivity(current.personaId, current.activityId);
      if (!activity || activity.personaId !== current.personaId) {
        if (current.state === 'running' && !current.cancellationRequestedAt) {
          return this.saveTerminalErrorWithinRuntimeLock(
            current,
            dispatchError(
              'ACTIVITY_MISSING',
              'The dispatch Activity is missing after restart.',
              'The dispatch Activity is missing after restart.',
            ),
            lock,
          );
        }
        return current;
      }
      if (activity.status === 'waiting') {
        if (current.cancellationRequestedAt) return current;
        const waitingReason = activity.interruptionRequestedByMailboxItemId
          ? 'interrupted'
          : current.waitingReason ?? 'running';
        if (current.state !== 'waiting' || current.waitingReason !== waitingReason) {
          return this.save({
            ...current,
            state: 'waiting',
            waitingReason,
            updatedAt: Math.max(runtimeClock.now(), current.updatedAt, activity.updatedAt),
          });
        }
        return current;
      }
      if (activity.status === 'error') {
        if (current.cancellationRequestedAt) {
          const now = Math.max(runtimeClock.now(), current.updatedAt, activity.updatedAt);
          return this.save({
            ...current,
            state: 'error',
            waitingReason: undefined,
            resumePreparationRequired: false,
            resumeSettledAt: current.resumeRequestedAt ? now : current.resumeSettledAt,
            error: dispatchError(
              'ACTIVITY_ERROR',
              activity.error ?? 'Persona Activity ended with an error.',
              'Persona Activity ended with an error.',
            ),
            lastError: undefined,
            completedAt: activity.completedAt ?? now,
            updatedAt: now,
          });
        }
        return this.saveTerminalErrorWithinRuntimeLock(
          current,
          dispatchError(
            'ACTIVITY_ERROR',
            activity.error ?? 'Persona Activity ended with an error.',
            'Persona Activity ended with an error.',
          ),
          lock,
        );
      }
      if (activity.status === 'cancelled') {
        const now = Math.max(runtimeClock.now(), current.updatedAt, activity.updatedAt);
        return this.save({
          ...current,
          state: 'cancelled',
          waitingReason: undefined,
          error: undefined,
          lastError: undefined,
          updatedAt: now,
          completedAt: activity.completedAt ?? now,
        });
      }
      if (activity.status === 'completed') {
        const now = Math.max(runtimeClock.now(), current.updatedAt, activity.updatedAt);
        const revisionId = current.behaviorRevisionId ?? activity.behaviorRevisionId;
        return this.save({
          ...current,
          state: 'completed',
          waitingReason: undefined,
          ...(current.outcome
            ? { outcome: current.outcome }
            : revisionId
              ? {
                  outcome: {
                    status: 'completed' as const,
                    ...(activity.conversationId ? { conversationId: activity.conversationId } : {}),
                    ...(activity.runId ? { runId: activity.runId } : {}),
                    personaId: current.personaId,
                    activityId: activity.id,
                    behaviorRevisionId: revisionId,
                  },
                }
              : {}),
          error: undefined,
          lastError: undefined,
          updatedAt: now,
          completedAt: activity.completedAt ?? now,
        });
      }
      return current;
      },
    ));
    if (reconciled.activityId) {
      const activity = await this.inWorkspace(() => (
        this.dependencies.getPersonaActivity(reconciled.personaId, reconciled.activityId!)
      ));
      if (activity) await this.synchronizeAssignedWorkItem(activity);
    }
    return reconciled;
  }

  private async drain(personaId: string, control: PumpControl): Promise<void> {
    for (;;) {
      if (control.cancelRequested || this.quiescedPersonas.has(personaId)) return;
      const records = await this.list(personaId);
      let waiting = false;
      for (const candidate of records) {
        const reconciled = await this.reconcileRecord(candidate);
        if (reconciled.state === 'completed') {
          try {
            await this.ensurePostActivityMaintenance(reconciled);
          } catch (error) {
            log.warn(`Could not reconcile post-Activity maintenance for ${reconciled.id}:`, error);
          }
        }
        if (
          reconciled.state === 'waiting'
          && reconciled.waitingReason !== 'delivery'
          && reconciled.waitingReason !== 'interrupted'
        ) waiting = true;
      }
      if (waiting) return;

      let claim: PersonaActivityClaim | null;
      try {
        claim = await this.inWorkspace(() => this.dependencies.claimNextPersonaActivity({
          personaId,
          ttlMs: this.leaseTtlMs,
        }));
      } catch (error) {
        if (
          error instanceof PersonaBusyError
          || (typeof error === 'object' && error !== null && 'code' in error
            && error.code === 'PERSONA_BUSY')
        ) {
          const expiresAt = typeof error === 'object' && error !== null && 'expiresAt' in error
            && typeof error.expiresAt === 'number'
            ? error.expiresAt
            : runtimeClock.now() + this.leaseTtlMs;
          this.scheduleWake(personaId, expiresAt);
          return;
        }
        throw error;
      }
      if (!claim) {
        const current = await this.list(personaId);
        await Promise.all(current.map((record) => this.reconcileRecord(record)));
        return;
      }
      if (claim.lease.workspaceId !== this.workspaceId || claim.activity.personaId !== personaId) {
        await this.failClaimWithoutPayload(claim, 'Claim crossed a workspace or Persona boundary.');
        return;
      }
      const continueDraining = await this.executeClaim(claim, control);
      if (!continueDraining) return;
    }
  }

  pump(personaId: string): Promise<void> {
    EnduringAgentIdSchema.parse(personaId);
    if (this.quiescedPersonas.has(personaId)) return Promise.resolve();
    const existing = this.pumps.get(personaId);
    if (existing) {
      existing.rerunRequested = true;
      return existing.promise;
    }
    const control = {
      promise: Promise.resolve(),
      rerunRequested: false,
      cancelRequested: false,
    } as PumpControl;
    control.promise = this.inWorkspace(async () => {
      do {
        control.rerunRequested = false;
        await this.drain(personaId, control);
      } while (control.rerunRequested && !control.cancelRequested);
    }).finally(() => {
      if (this.pumps.get(personaId) === control) this.pumps.delete(personaId);
    });
    this.pumps.set(personaId, control);
    return control.promise;
  }

  async wait(
    dispatchId: string,
    options: WaitForPersonaFlowDispatchOptions = {},
  ): Promise<PersonaFlowDispatchRecord> {
    assertSafeCollectionId(dispatchId);
    const deadline = options.timeoutMs === undefined ? undefined : runtimeClock.now() + options.timeoutMs;
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)) {
      throw new TypeError('timeoutMs must be a non-negative finite number.');
    }
    for (;;) {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error('Dispatch wait aborted.');
      const record = await this.get(dispatchId);
      if (!record) throw new Error(`Persona Flow dispatch ${JSON.stringify(dispatchId)} not found.`);
      if (isTerminalDispatch(record.state)) return record;
      const remaining = deadline === undefined ? 1_000 : deadline - runtimeClock.now();
      if (remaining <= 0) throw new PersonaFlowDispatchTimeoutError(dispatchId);
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const listeners = this.waiters.get(dispatchId) ?? new Set<() => void>();
        const done = () => {
          if (settled) return;
          settled = true;
          timer.clear();
          options.signal?.removeEventListener('abort', aborted);
          listeners.delete(done);
          if (listeners.size === 0) this.waiters.delete(dispatchId);
          resolve();
        };
        const aborted = () => {
          if (settled) return;
          settled = true;
          timer.clear();
          listeners.delete(done);
          if (listeners.size === 0) this.waiters.delete(dispatchId);
          reject(options.signal?.reason ?? new Error('Dispatch wait aborted.'));
        };
        listeners.add(done);
        this.waiters.set(dispatchId, listeners);
        const timer = runtimeClock.setTimer(done, Math.min(remaining, 1_000));
        timer.unref();
        options.signal?.addEventListener('abort', aborted, { once: true });
      });
    }
  }

  async reconcileAndDrain(options: { waitForIdle?: boolean } = {}): Promise<void> {
    const records = await this.list();
    const personas = new Set<string>();
    for (let record of records) {
      if (record.state === 'queued' && !record.mailboxItemId) {
        try {
          record = (await this.routeStored(record)).dispatch;
        } catch (error) {
          log.error(`Failed to re-admit Persona Flow dispatch ${record.id}:`, error);
          continue;
        }
      }
      record = await this.reconcileRecord(record);
      if (isTerminalDispatch(record.state) && record.activityId) {
        try {
          const sourceActivity = await this.inWorkspace(() => getPersonaActivity(record.personaId, record.activityId!));
          if (sourceActivity) {
            await this.inWorkspace(() => admitBehaviorMaintenanceRun(sourceActivity));
          }
        } catch (error) {
          log.warn(`Failed to reconcile Behavior maintenance admission for ${record.id}:`, error);
        }
      }
      if (record.state === 'completed') {
        try {
          const maintenance = await this.ensurePostActivityMaintenance(record);
          if (maintenance?.state === 'queued' || maintenance?.state === 'running') {
            personas.add(maintenance.personaId);
          }
        } catch (error) {
          log.warn(`Failed to reconcile maintenance for ${record.id}:`, error);
        }
      }
      if (record.state === 'queued' || record.state === 'running') personas.add(record.personaId);
    }
    // Reconcile queued or lease-expired Behavior diagnosis even when no source
    // dispatch remains. This is deliberately detached from source replay.
    void this.inWorkspace(() => reconcileBehaviorMaintenanceRuns()).catch((error) => {
      log.warn('Failed to reconcile Behavior maintenance lifecycle:', error);
    });
    const pumps = [...personas].map((personaId) => this.pump(personaId));
    if (options.waitForIdle !== false) await Promise.all(pumps);
  }

  async quiesce(personaId: string): Promise<void> {
    EnduringAgentIdSchema.parse(personaId);
    this.quiescedPersonas.add(personaId);
    const timer = this.wakeTimers.get(personaId);
    if (timer) {
      timer.clear();
      this.wakeTimers.delete(personaId);
    }
    const control = this.pumps.get(personaId);
    if (!control) return;
    control.cancelRequested = true;
    control.activeAbort?.abort();
    await control.promise;
  }
}

const workspaceDispatchers = new Map<string, PersonaFlowDispatcher>();

function currentDispatcher(): PersonaFlowDispatcher {
  const workspaceId = getCurrentWorkspace();
  let dispatcher = workspaceDispatchers.get(workspaceId);
  if (!dispatcher) {
    dispatcher = new PersonaFlowDispatcher({ workspaceId });
    workspaceDispatchers.set(workspaceId, dispatcher);
  }
  return dispatcher;
}

export function submitPersonaFlowDispatch(
  input: SubmitPersonaFlowDispatchInput,
  options?: SubmitPersonaFlowDispatchOptions,
): Promise<PersonaFlowDispatchSubmission> {
  return currentDispatcher().submit(input, options);
}

export function getPersonaFlowDispatch(
  dispatchId: string,
): Promise<PersonaFlowDispatchRecord | null> {
  return currentDispatcher().get(dispatchId);
}

export function listPersonaFlowDispatches(
  personaId?: string,
): Promise<PersonaFlowDispatchRecord[]> {
  return currentDispatcher().list(personaId);
}

export function findPersonaFlowDispatchByAttribution(
  identity: PersonaFlowDispatchIdentity,
): Promise<PersonaFlowDispatchRecord> {
  return currentDispatcher().findByAttribution(identity);
}

export function resumePersonaFlowDispatch(
  input: ResumePersonaFlowDispatchInput,
  options?: ResumePersonaFlowDispatchOptions,
): Promise<PersonaFlowDispatchRecord> {
  return currentDispatcher().resume(input, options);
}

export function cancelPersonaFlowDispatch(
  input: CancelPersonaFlowDispatchInput,
  options?: CancelPersonaFlowDispatchOptions,
): Promise<PersonaFlowDispatchRecord> {
  return currentDispatcher().cancel(input, options);
}

export function cancelPersonaFlowDispatchById(
  input: CancelPersonaFlowDispatchByIdInput,
  options?: CancelPersonaFlowDispatchOptions,
): Promise<PersonaFlowDispatchRecord> {
  return currentDispatcher().cancelById(input, options);
}

export function reprioritizePersonaWorkItemDispatches(
  input: ReprioritizePersonaWorkItemDispatchInput,
): Promise<PersonaFlowDispatchRecord[]> {
  return currentDispatcher().reprioritizeWorkItem(input);
}

export function movePersonaWorkItemDispatch(
  input: MovePersonaWorkItemDispatchInput,
): Promise<MovePersonaWorkItemDispatchResult> {
  return currentDispatcher().moveWorkItem(input);
}

export function pumpPersonaFlowDispatches(personaId: string): Promise<void> {
  return currentDispatcher().pump(personaId);
}

export function waitForPersonaFlowDispatch(
  dispatchId: string,
  options?: WaitForPersonaFlowDispatchOptions,
): Promise<PersonaFlowDispatchRecord> {
  return currentDispatcher().wait(dispatchId, options);
}

export function reconcilePersonaFlowDispatches(
  options?: { waitForIdle?: boolean },
): Promise<void> {
  return currentDispatcher().reconcileAndDrain(options);
}

/** Startup hook: reconcile durable envelopes and kick pumps without blocking boot. */
export function startPersonaFlowDispatcher(): Promise<void> {
  return currentDispatcher().reconcileAndDrain({ waitForIdle: false });
}

export function quiescePersonaFlowDispatcher(personaId: string): Promise<void> {
  return currentDispatcher().quiesce(personaId);
}
