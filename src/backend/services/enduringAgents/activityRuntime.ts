import { createHash } from 'crypto';
import { z } from 'zod';

import type { PersonaActivityMutationContext } from '@/backend/execution/flow/types';

import {
  BehaviorSlotKeySchema,
  CreatePersonaLeaseInputSchema,
  CreatePersonaMailboxItemInputSchema,
  ENDURING_AGENT_SCHEMA_VERSION,
  EnduringAgentIdSchema,
  PERSONA_LIFECYCLE_STATES,
  PERSONA_PRIORITIES,
  PersonaActivitySchema,
  PersonaInstructionContextSchema,
  PersonaLeaseSchema,
  PersonaMailboxItemSchema,
  type BehaviorRevision,
  type CreatePersonaMailboxItemInput,
  type Persona,
  type PersonaActivity,
  type PersonaActivityStatus,
  type PersonaInstructionContext,
  type PersonaLease,
  type PersonaMailboxItem,
  type PersonaMailboxRelatedAction,
  type PersonaPriority,
} from '@/shared/types/enduringAgent';
import {
  assertSafeCollectionId,
  deleteCollectionItem,
  listCollectionItemEntriesStrict,
  saveCollectionItem,
} from '@/utils/storage/backend';
import { getCurrentWorkspace } from '@/utils/workspace';
import { createLogger } from '@/utils/logger';

import { canonicalJson } from './behaviorRevisions';
import { resolveEffectiveBehaviorRevision } from './behaviorFlowResolver';
import { ENDURING_AGENT_COLLECTIONS } from './collections';
import {
  hashPersonaInstructionContext,
  type PersonaActivitySnapshot,
} from './personaActivitySnapshot';
import { resolvePersonaCoreRevision } from './personaCoreResolver';
import { randomEnduringAgentId, stableEnduringAgentId } from './ids';
import {
  type PersonaRuntimeLock,
  withPersonaRuntimeLock,
} from './runtimeLock';
import {
  getBehaviorBinding,
  getBehaviorRevision,
  getPersona,
  getPersonaDeletionTombstone,
  getPersonaActivity,
  getPersonaLease,
  getPersonaLeaseRecord,
  getPersonaMailboxItem,
  listPersonaActivities,
  listPersonaBundle,
  listPersonaLeaseRecords,
  listPersonaMailboxItems,
  updatePersonaWithinRuntimeLock,
} from './store';
import {
  appendPersonaRuntimeEvent,
  RawPersonaRuntimeEventSchema,
  type RawPersonaRuntimeEvent,
} from './runtimeEvents';

const log = createLogger('backend/services/enduringAgents/activityRuntime');

async function observeRuntime(
  personaId: string,
  event: RawPersonaRuntimeEvent,
): Promise<void> {
  try {
    await appendPersonaRuntimeEvent(personaId, event);
  } catch (error) {
    // Observability is durable but non-authoritative: a log I/O failure must
    // never roll back an already committed mailbox/lease transition.
    log.warn('Could not append Persona runtime observation', {
      personaId,
      type: event.type,
      error,
    });
  }
}

const LeaseFenceSchema = z.object({
  workspaceId: z.string().trim().min(1).max(256),
  personaId: EnduringAgentIdSchema,
  activityId: EnduringAgentIdSchema,
  leaseId: EnduringAgentIdSchema,
  holderId: EnduringAgentIdSchema,
  fencingToken: z.number().int().positive(),
}).strict();

const ClaimPersonaActivityInputSchema = z.object({
  personaId: EnduringAgentIdSchema,
  ttlMs: CreatePersonaLeaseInputSchema.shape.ttlMs,
  /** Optional atomic head guard used by multi-Persona meeting reservations. */
  expectedMailboxItemId: EnduringAgentIdSchema.optional(),
}).strict();

const RenewPersonaActivityLeaseInputSchema = LeaseFenceSchema.extend({
  ttlMs: CreatePersonaLeaseInputSchema.shape.ttlMs,
}).strict();

const CompletePersonaActivityInputSchema = LeaseFenceSchema.extend({
  status: z.enum(['completed', 'cancelled', 'error']).optional(),
  outcomeRef: z.string().trim().max(4_096).optional(),
  error: z.string().trim().min(1).max(20_000).optional(),
}).strict().superRefine((input, ctx) => {
  if (input.status === 'error' && !input.error) {
    ctx.addIssue({
      code: 'custom',
      message: 'An errored Activity requires an error message.',
      path: ['error'],
    });
  }
  if (input.status !== 'error' && input.error !== undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'Only an errored Activity may include an error message.',
      path: ['error'],
    });
  }
});

const AcknowledgePersonaActivityDeliveryInputSchema = LeaseFenceSchema.extend({
  mailboxItemId: EnduringAgentIdSchema,
}).strict();

const RejectPersonaActivityDeliveryInputSchema = LeaseFenceSchema.extend({
  mailboxItemId: EnduringAgentIdSchema,
}).strict();

const UpdatePersonaActivityReferencesInputSchema = LeaseFenceSchema.extend({
  conversationId: EnduringAgentIdSchema.optional(),
  runId: EnduringAgentIdSchema.optional(),
  meetingId: EnduringAgentIdSchema.optional(),
  resourceRefs: z.array(z.string().trim().min(1).max(4_096)).max(1_000).optional(),
  outcomeRef: z.string().trim().max(4_096).optional(),
}).strict().refine(
  (input) => input.conversationId !== undefined
    || input.runId !== undefined
    || input.meetingId !== undefined
    || input.resourceRefs !== undefined
    || input.outcomeRef !== undefined,
  { message: 'At least one Activity reference field is required.' },
);

const PersistPersonaActivitySnapshotInputSchema = LeaseFenceSchema.extend({
  coreFlowId: z.string().min(1).max(256),
  coreFlowRevisionId: EnduringAgentIdSchema,
  coreAppRefs: z.array(z.string().trim().min(1).max(200)).max(64),
  instructionContext: PersonaInstructionContextSchema,
  instructionContextDigest: z.string().regex(/^[a-f0-9]{64}$/),
  instructionContextSchemaVersion: z.literal(1),
  entryPointPayloadRef: z.string().min(1).max(4_096).optional(),
}).strict();

const CancelPersonaMailboxItemInputSchema = z.object({
  personaId: EnduringAgentIdSchema,
  mailboxItemId: EnduringAgentIdSchema,
}).strict();

const ReprioritizePersonaMailboxItemInputSchema = z.object({
  personaId: EnduringAgentIdSchema,
  mailboxItemId: EnduringAgentIdSchema,
  priority: z.enum(PERSONA_PRIORITIES),
}).strict();

const MovePersonaMailboxItemInputSchema = z.object({
  personaId: EnduringAgentIdSchema,
  mailboxItemId: EnduringAgentIdSchema,
  direction: z.enum(['earlier', 'later']),
}).strict();

const RecoverPersonaRuntimeInputSchema = z.object({
  personaId: EnduringAgentIdSchema,
  confirmation: z.literal('RECOVER'),
}).strict();

const RecoverPersonaRuntimeResultSchema = z.object({
  personaId: EnduringAgentIdSchema,
  changed: z.boolean(),
  lifecycleState: z.enum(PERSONA_LIFECYCLE_STATES),
  runtimeUpdatedAt: z.number().int().nonnegative(),
  closedActivityIds: z.array(EnduringAgentIdSchema).max(10_000),
  rejectedMailboxItemIds: z.array(EnduringAgentIdSchema).max(10_000),
  requeuedMailboxItemIds: z.array(EnduringAgentIdSchema).max(10_000),
}).strict();

const PERSONA_RUNTIME_RECOVERY_RECEIPT_SCHEMA_VERSION = 1 as const;
const PersonaRuntimeRecoveryReceiptSchema = z.object({
  schemaVersion: z.literal(PERSONA_RUNTIME_RECOVERY_RECEIPT_SCHEMA_VERSION),
  id: EnduringAgentIdSchema,
  workspaceId: z.string().trim().min(1).max(256),
  personaId: EnduringAgentIdSchema,
  phase: z.enum(['preparing', 'committed']),
  sourceRuntimeUpdatedAt: z.number().int().nonnegative(),
  result: RecoverPersonaRuntimeResultSchema,
  events: z.array(RawPersonaRuntimeEventSchema).max(30_001),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict();

export interface PersonaLeaseFence {
  workspaceId: string;
  personaId: string;
  activityId: string;
  leaseId: string;
  holderId: string;
  fencingToken: number;
}

export interface ClaimPersonaActivityInput {
  personaId: string;
  ttlMs: number;
  /** Return null instead of claiming if another eligible item is ahead. */
  expectedMailboxItemId?: string;
}

interface ResolvedClaimPersonaActivityInput extends ClaimPersonaActivityInput {
  /** Opaque worker-incarnation capability generated by the runtime. */
  holderId: string;
}

export interface RenewPersonaActivityLeaseInput extends PersonaLeaseFence {
  ttlMs: number;
}

export interface CompletePersonaActivityInput extends PersonaLeaseFence {
  status?: Extract<PersonaActivityStatus, 'completed' | 'cancelled' | 'error'>;
  outcomeRef?: string;
  error?: string;
}

export interface RoutePersonaMailboxItemInput extends CreatePersonaMailboxItemInput {
  relatedAction?: PersonaMailboxRelatedAction;
}

export type PersonaMailboxRouteDecision =
  | 'duplicate'
  | 'queued'
  | 'steered'
  | 'coalesced'
  | 'interrupt_requested';

export interface RoutePersonaMailboxResult {
  item: PersonaMailboxItem;
  decision: PersonaMailboxRouteDecision;
  targetActivityId?: string;
}

export interface PersonaMailboxAdmissionOptions {
  /**
   * Trusted domain precondition evaluated while the Persona runtime lock is held,
   * immediately before admission. It must not perform nested runtime locking.
   */
  validateAdmission?: () => Promise<void>;
}

export interface AcknowledgePersonaActivityDeliveryInput extends PersonaLeaseFence {
  mailboxItemId: string;
}

export interface RejectPersonaActivityDeliveryInput extends PersonaLeaseFence {
  mailboxItemId: string;
}

export interface UpdatePersonaActivityReferencesInput extends PersonaLeaseFence {
  conversationId?: string;
  runId?: string;
  meetingId?: string;
  resourceRefs?: string[];
  outcomeRef?: string;
}

export interface PersistPersonaActivitySnapshotInput
  extends PersonaLeaseFence, PersonaActivitySnapshot {}

export interface CancelPersonaMailboxItemInput {
  personaId: string;
  mailboxItemId: string;
}

export interface ReprioritizePersonaMailboxItemInput {
  personaId: string;
  mailboxItemId: string;
  priority: PersonaPriority;
}

export interface ReprioritizePersonaMailboxItemResult {
  item: PersonaMailboxItem;
  changed: boolean;
}

export interface MovePersonaMailboxItemInput {
  personaId: string;
  mailboxItemId: string;
  direction: 'earlier' | 'later';
}

export interface MovePersonaMailboxItemResult {
  item: PersonaMailboxItem;
  moved: boolean;
}

export interface RecoverPersonaRuntimeInput {
  personaId: string;
  confirmation: 'RECOVER';
}

export interface RecoverPersonaRuntimeResult {
  personaId: string;
  changed: boolean;
  lifecycleState: Persona['lifecycleState'];
  runtimeUpdatedAt: number;
  closedActivityIds: string[];
  rejectedMailboxItemIds: string[];
  requeuedMailboxItemIds: string[];
}

export interface PersonaRuntimeRecoveryReceipt {
  schemaVersion: typeof PERSONA_RUNTIME_RECOVERY_RECEIPT_SCHEMA_VERSION;
  id: string;
  workspaceId: string;
  personaId: string;
  phase: 'preparing' | 'committed';
  sourceRuntimeUpdatedAt: number;
  result: RecoverPersonaRuntimeResult;
  events: RawPersonaRuntimeEvent[];
  createdAt: number;
  updatedAt: number;
}

export interface EnqueuePersonaMailboxResult {
  item: PersonaMailboxItem;
  duplicate: boolean;
}

export interface PersonaActivityClaim {
  mailboxItem: PersonaMailboxItem;
  activity: PersonaActivity;
  lease: PersonaLease;
  recovered: boolean;
}

export interface CompletedPersonaActivity {
  mailboxItem: PersonaMailboxItem;
  activity: PersonaActivity;
  lease: PersonaLease;
}

export class PersonaRuntimeNotFoundError extends Error {
  readonly code = 'PERSONA_RUNTIME_NOT_FOUND' as const;

  constructor(readonly recordKind: string, readonly recordId: string) {
    super(`${recordKind} ${JSON.stringify(recordId)} not found in this workspace.`);
    this.name = 'PersonaRuntimeNotFoundError';
  }
}

export class PersonaRuntimeUnavailableError extends Error {
  readonly code = 'PERSONA_RUNTIME_UNAVAILABLE' as const;

  constructor(readonly personaId: string, message: string) {
    super(message);
    this.name = 'PersonaRuntimeUnavailableError';
  }
}

export class PersonaMailboxConflictError extends Error {
  readonly code = 'PERSONA_MAILBOX_CONFLICT' as const;

  constructor(readonly mailboxItemId: string, message: string) {
    super(message);
    this.name = 'PersonaMailboxConflictError';
  }
}

export class PersonaBusyError extends Error {
  readonly code = 'PERSONA_BUSY' as const;
  readonly activityId: string;
  readonly expiresAt: number;

  constructor(readonly personaId: string, lease: PersonaLease) {
    super(
      `Persona ${JSON.stringify(personaId)} is already leased by Activity `
      + `${JSON.stringify(lease.activityId)}.`,
    );
    this.name = 'PersonaBusyError';
    this.activityId = lease.activityId;
    this.expiresAt = lease.expiresAt;
  }
}

export class PersonaLeaseLostError extends Error {
  readonly code = 'PERSONA_LEASE_LOST' as const;

  constructor(readonly personaId: string, message: string) {
    super(message);
    this.name = 'PersonaLeaseLostError';
  }
}

export class PersonaRuntimeCorruptionError extends Error {
  readonly code = 'PERSONA_RUNTIME_CORRUPTION' as const;

  constructor(readonly personaId: string, message: string) {
    super(message);
    this.name = 'PersonaRuntimeCorruptionError';
  }
}

export class PersonaRuntimeRecoveryConflictError extends Error {
  readonly code = 'PERSONA_RUNTIME_RECOVERY_CONFLICT' as const;

  constructor(readonly personaId: string, message: string) {
    super(message);
    this.name = 'PersonaRuntimeRecoveryConflictError';
  }
}

const PRIORITY_WEIGHT: Record<PersonaPriority, number> = {
  low: 0,
  normal: 1,
  high: 2,
  urgent: 3,
};
const LEASE_EXPIRY_ERROR = 'Activity lease expired before completion; automatic replay was suppressed.';
const ADMINISTRATIVE_RECOVERY_ERROR =
  'Administrative runtime recovery closed uncertain work; automatic replay was suppressed.';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function defaultBehaviorSlot(kind: PersonaMailboxItem['kind']): string {
  return kind === 'maintenance' ? 'maintain_memory' : 'primary';
}

function activityIdForMailbox(mailboxItemId: string): string {
  return stableEnduringAgentId('activity', {
    purpose: 'persona-mailbox-activity-v1',
    mailboxItemId,
  });
}

function leaseIdForAcquisition(
  workspaceId: string,
  personaId: string,
  activityId: string,
  fencingToken: number,
): string {
  return stableEnduringAgentId('lease', {
    purpose: 'persona-activity-lease-v1',
    workspaceId,
    personaId,
    activityId,
    fencingToken,
  });
}

function isTerminalActivity(activity: PersonaActivity): boolean {
  return activity.status === 'completed'
    || activity.status === 'cancelled'
    || activity.status === 'error';
}

function mailboxAdmission(record: PersonaMailboxItem): Record<string, unknown> {
  return {
    personaId: record.personaId,
    idempotencyKey: record.idempotencyKey,
    kind: record.kind,
    priority: record.priority,
    source: record.source,
    behaviorSlotKey: record.behaviorSlotKey ?? null,
    relationKey: record.relationKey ?? null,
    relatedAction: record.relatedAction ?? null,
    summary: record.summary ?? null,
    payloadRef: record.payloadRef ?? null,
    notBefore: record.notBefore ?? null,
  };
}

function leaseMatchesFence(lease: PersonaLease, fence: PersonaLeaseFence): boolean {
  return lease.workspaceId === fence.workspaceId
    && lease.workspaceId === getCurrentWorkspace()
    && lease.personaId === fence.personaId
    && lease.activityId === fence.activityId
    && lease.id === fence.leaseId
    && lease.holderId === fence.holderId
    && lease.fencingToken === fence.fencingToken;
}

async function saveActivity(
  lock: PersonaRuntimeLock,
  value: PersonaActivity,
): Promise<PersonaActivity> {
  const record = PersonaActivitySchema.parse(value) as PersonaActivity;
  await lock.assertOwned();
  await saveCollectionItem(ENDURING_AGENT_COLLECTIONS.activities, record.id, record);
  return record;
}

async function saveMailboxItem(
  lock: PersonaRuntimeLock,
  value: PersonaMailboxItem,
): Promise<PersonaMailboxItem> {
  const record = PersonaMailboxItemSchema.parse(value) as PersonaMailboxItem;
  await lock.assertOwned();
  await saveCollectionItem(ENDURING_AGENT_COLLECTIONS.mailboxItems, record.id, record);
  return record;
}

async function saveLeaseHead(
  lock: PersonaRuntimeLock,
  value: PersonaLease,
): Promise<PersonaLease> {
  const record = PersonaLeaseSchema.parse(value) as PersonaLease;
  // The acquisition record makes Activity.leaseId resolvable. The Persona-keyed
  // head remains the fencing authority and is written second/conservatively.
  await lock.assertOwned();
  await saveCollectionItem(ENDURING_AGENT_COLLECTIONS.leaseHistory, record.id, record);
  await lock.assertOwned();
  await saveCollectionItem(ENDURING_AGENT_COLLECTIONS.leases, record.personaId, record);
  return record;
}

async function saveLeaseHistoryRecord(
  lock: PersonaRuntimeLock,
  value: PersonaLease,
): Promise<PersonaLease> {
  const record = PersonaLeaseSchema.parse(value) as PersonaLease;
  await lock.assertOwned();
  await saveCollectionItem(ENDURING_AGENT_COLLECTIONS.leaseHistory, record.id, record);
  return record;
}

async function saveLeaseAuthorityHead(
  lock: PersonaRuntimeLock,
  value: PersonaLease,
): Promise<PersonaLease> {
  const record = PersonaLeaseSchema.parse(value) as PersonaLease;
  await lock.assertOwned();
  await saveCollectionItem(ENDURING_AGENT_COLLECTIONS.leases, record.personaId, record);
  return record;
}

function parseRuntimeRecoveryReceipt(
  id: string,
  value: unknown,
): PersonaRuntimeRecoveryReceipt {
  const receipt = PersonaRuntimeRecoveryReceiptSchema.parse(value) as
    PersonaRuntimeRecoveryReceipt;
  if (receipt.id !== id || receipt.workspaceId !== getCurrentWorkspace()) {
    throw new PersonaRuntimeCorruptionError(
      receipt.personaId,
      `Runtime recovery receipt ${JSON.stringify(id)} crossed an identity boundary.`,
    );
  }
  return receipt;
}

export async function listPersonaRuntimeRecoveryReceipts(
  personaId: string,
): Promise<PersonaRuntimeRecoveryReceipt[]> {
  assertSafeCollectionId(personaId);
  const entries = await listCollectionItemEntriesStrict<unknown>(
    ENDURING_AGENT_COLLECTIONS.runtimeRecoveryReceipts,
  );
  return entries
    .map(({ id, item }) => parseRuntimeRecoveryReceipt(id, item))
    .filter((receipt) => receipt.personaId === personaId)
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

async function saveRuntimeRecoveryReceipt(
  lock: PersonaRuntimeLock,
  value: PersonaRuntimeRecoveryReceipt,
): Promise<PersonaRuntimeRecoveryReceipt> {
  const receipt = PersonaRuntimeRecoveryReceiptSchema.parse(value) as
    PersonaRuntimeRecoveryReceipt;
  await lock.assertOwned();
  if (
    receipt.workspaceId !== getCurrentWorkspace()
    || receipt.result.personaId !== receipt.personaId
    || !receipt.result.changed
    || receipt.result.runtimeUpdatedAt <= receipt.sourceRuntimeUpdatedAt
    || (receipt.phase === 'preparing' && receipt.result.lifecycleState !== 'error')
    || canonicalJson(receipt.events) !== canonicalJson(
      receipt.phase === 'committed' ? runtimeRecoveryEvents(receipt.result) : [],
    )
  ) {
    throw new PersonaRuntimeCorruptionError(
      receipt.personaId,
      `Runtime recovery receipt ${JSON.stringify(receipt.id)} has invalid ownership or phase data.`,
    );
  }
  const pending = await listPersonaRuntimeRecoveryReceipts(receipt.personaId);
  const conflicting = pending.find((candidate) => candidate.id !== receipt.id);
  if (conflicting) {
    throw new PersonaRuntimeCorruptionError(
      receipt.personaId,
      'Persona already has a different pending runtime recovery receipt.',
    );
  }
  const existing = pending.find((candidate) => candidate.id === receipt.id);
  if (existing) {
    const preserves = (before: string[], after: string[]): boolean => (
      before.every((id) => after.includes(id))
    );
    if (
      existing.workspaceId !== receipt.workspaceId
      || existing.personaId !== receipt.personaId
      || existing.sourceRuntimeUpdatedAt !== receipt.sourceRuntimeUpdatedAt
      || existing.result.runtimeUpdatedAt !== receipt.result.runtimeUpdatedAt
      || existing.createdAt !== receipt.createdAt
      || existing.updatedAt > receipt.updatedAt
      || (existing.phase === 'committed' && canonicalJson(existing) !== canonicalJson(receipt))
      || !preserves(existing.result.closedActivityIds, receipt.result.closedActivityIds)
      || !preserves(existing.result.rejectedMailboxItemIds, receipt.result.rejectedMailboxItemIds)
      || !preserves(existing.result.requeuedMailboxItemIds, receipt.result.requeuedMailboxItemIds)
    ) {
      throw new PersonaRuntimeCorruptionError(
        receipt.personaId,
        `Runtime recovery receipt ${JSON.stringify(receipt.id)} was rewritten non-monotonically.`,
      );
    }
  }
  await saveCollectionItem(
    ENDURING_AGENT_COLLECTIONS.runtimeRecoveryReceipts,
    receipt.id,
    receipt,
  );
  return receipt;
}

export async function deletePersonaRuntimeRecoveryReceipt(receiptId: string): Promise<void> {
  assertSafeCollectionId(receiptId);
  await deleteCollectionItem(ENDURING_AGENT_COLLECTIONS.runtimeRecoveryReceipts, receiptId);
}

function sameLeaseAcquisition(left: PersonaLease, right: PersonaLease): boolean {
  return left.id === right.id
    && left.workspaceId === right.workspaceId
    && left.personaId === right.personaId
    && left.activityId === right.activityId
    && left.holderId === right.holderId
    && left.fencingToken === right.fencingToken
    && left.acquiredAt === right.acquiredAt;
}

/** Repair every history-first/head-second crash prefix before using a fence. */
async function reconcilePersonaLeaseHead(
  lock: PersonaRuntimeLock,
  personaId: string,
): Promise<PersonaLease | null> {
  const [head, history] = await Promise.all([
    getPersonaLease(personaId),
    listPersonaLeaseRecords(personaId),
  ]);
  const byToken = new Map<number, PersonaLease>();
  for (const record of history) {
    const duplicate = byToken.get(record.fencingToken);
    if (duplicate && duplicate.id !== record.id) {
      throw new PersonaRuntimeCorruptionError(
        personaId,
        `Persona has multiple lease acquisitions for fencing token ${record.fencingToken}.`,
      );
    }
    byToken.set(record.fencingToken, record);
  }
  const latest = [...history].sort(
    (left, right) => right.fencingToken - left.fencingToken,
  )[0] ?? null;
  if (!latest) {
    if (head) {
      throw new PersonaRuntimeCorruptionError(
        personaId,
        `Persona lease head ${JSON.stringify(head.id)} has no acquisition history.`,
      );
    }
    return null;
  }

  for (const record of history) {
    if (record.fencingToken < latest.fencingToken && record.status === 'active') {
      await saveLeaseHistoryRecord(lock, {
        ...record,
        status: 'expired',
        releasedAt: undefined,
      });
    }
  }

  if (!head || head.fencingToken < latest.fencingToken) {
    return saveLeaseAuthorityHead(lock, latest);
  }
  if (head.fencingToken > latest.fencingToken || !sameLeaseAcquisition(head, latest)) {
    throw new PersonaRuntimeCorruptionError(
      personaId,
      'Persona lease head conflicts with its highest durable acquisition.',
    );
  }
  if (canonicalJson(head) === canonicalJson(latest)) return head;

  if (head.status === 'active') {
    if (
      latest.status !== 'active'
      || latest.renewedAt >= head.renewedAt
    ) {
      return saveLeaseAuthorityHead(lock, latest);
    }
  } else if (latest.status === 'active') {
    // The authority head is already terminal; repair lagging audit history.
    await saveLeaseHistoryRecord(lock, head);
    return head;
  } else if (head.status === latest.status) {
    return saveLeaseAuthorityHead(lock, latest);
  }
  throw new PersonaRuntimeCorruptionError(
    personaId,
    'Persona lease head and acquisition history have incompatible states.',
  );
}

async function projectPersonaLifecycle(
  lock: PersonaRuntimeLock,
  personaId: string,
  lifecycleState: Persona['lifecycleState'],
  now: number,
): Promise<Persona> {
  const persona = await getPersona(personaId);
  if (!persona) throw new PersonaRuntimeNotFoundError('Persona', personaId);
  if (
    persona.lifecycleState !== lifecycleState
    && (
      persona.lifecycleState === 'disabled'
      || persona.lifecycleState === 'sleeping'
      || persona.lifecycleState === 'error'
    )
  ) {
    // These are operator/corruption gates, not runtime projections. Expiry,
    // completion, or crash repair must never silently re-enable the actor.
    return persona;
  }
  if (persona.lifecycleState === lifecycleState && persona.updatedAt >= now) return persona;
  const updated = await updatePersonaWithinRuntimeLock({
    ...persona,
    lifecycleState,
    updatedAt: persona.lifecycleState === lifecycleState
      ? Math.max(now, persona.updatedAt)
      : Math.max(now, persona.updatedAt + 1),
  }, lock);
  if (persona.lifecycleState !== updated.lifecycleState) {
    await observeRuntime(personaId, {
      eventId: `lifecycle:${persona.lifecycleState}:${updated.lifecycleState}:${updated.updatedAt}`,
      type: 'lifecycle:transition',
      from: persona.lifecycleState,
      to: updated.lifecycleState,
    });
  }
  return updated;
}

async function requireReadyPersona(personaId: string): Promise<Persona> {
  const persona = await getPersona(personaId);
  if (!persona) throw new PersonaRuntimeNotFoundError('Persona', personaId);
  if (await getPersonaDeletionTombstone(personaId)) {
    throw new PersonaRuntimeUnavailableError(
      personaId,
      `Persona ${JSON.stringify(personaId)} is pending deletion and cannot run or accept work.`,
    );
  }
  if (persona.provisioningState !== 'ready') {
    throw new PersonaRuntimeUnavailableError(
      personaId,
      `Persona ${JSON.stringify(personaId)} has not completed provisioning.`,
    );
  }
  return persona;
}

async function resolveBehavior(
  personaId: string,
  slotKey: string,
) {
  if (slotKey === 'primary') {
    const revision = await resolvePersonaCoreRevision(personaId);
    const binding = await getBehaviorBinding(revision.behaviorId);
    if (
      !binding
      || binding.personaId !== personaId
      || binding.slotKey !== slotKey
      || revision.personaId !== personaId
      || revision.slotKey !== slotKey
    ) {
      throw new PersonaRuntimeCorruptionError(
        personaId,
        'Resolved Persona Core revision does not match its primary Behavior binding.',
      );
    }
    return { binding, revision };
  }
  return resolveEffectiveBehaviorRevision(personaId, slotKey);
}

function sortEligibleMailboxItems(
  items: PersonaMailboxItem[],
  now: number,
): PersonaMailboxItem[] {
  return items
    .filter((item) => item.status === 'queued' && (item.notBefore ?? 0) <= now)
    .sort((left, right) => {
      const priority = PRIORITY_WEIGHT[right.priority] - PRIORITY_WEIGHT[left.priority];
      if (priority !== 0) return priority;
      const sequence = left.sequence - right.sequence;
      if (sequence !== 0) return sequence;
      const readyAt = (left.notBefore ?? left.createdAt) - (right.notBefore ?? right.createdAt);
      return readyAt !== 0 ? readyAt : left.id.localeCompare(right.id);
    });
}

function findMailboxForActivity(
  personaId: string,
  items: PersonaMailboxItem[],
  activityId: string,
): PersonaMailboxItem | null {
  const mismatchedClaim = items.find((item) => {
    const deterministicActivityId = activityIdForMailbox(item.id);
    return item.status === 'claimed'
      && item.claimedActivityId !== deterministicActivityId
      && (
        item.claimedActivityId === activityId
        || deterministicActivityId === activityId
      );
  });
  if (mismatchedClaim) {
    throw new PersonaRuntimeCorruptionError(
      personaId,
      `Claimed mailbox item ${JSON.stringify(mismatchedClaim.id)} points at Activity `
      + `${JSON.stringify(mismatchedClaim.claimedActivityId)} instead of its deterministic `
      + `Activity ${JSON.stringify(activityIdForMailbox(mismatchedClaim.id))}.`,
    );
  }
  const matches = items.filter(
    (item) => activityIdForMailbox(item.id) === activityId,
  );
  if (matches.length > 1) {
    throw new PersonaRuntimeCorruptionError(
      personaId,
      `Multiple mailbox items resolve to Activity ${JSON.stringify(activityId)}.`,
    );
  }
  return matches[0] ?? null;
}

async function terminalMailboxProjection(
  lock: PersonaRuntimeLock,
  item: PersonaMailboxItem,
  activity: PersonaActivity,
  now: number,
): Promise<PersonaMailboxItem> {
  const expectedActivityId = activityIdForMailbox(item.id);
  if (
    item.status === 'claimed'
    && (
      item.claimedActivityId !== expectedActivityId
      || activity.id !== expectedActivityId
    )
  ) {
    throw new PersonaRuntimeCorruptionError(
      item.personaId,
      `Claimed mailbox item ${JSON.stringify(item.id)} does not own Activity `
      + `${JSON.stringify(activity.id)}.`,
    );
  }
  const status = activity.status === 'completed' ? 'completed' : 'rejected';
  if (
    (item.status === 'coalesced' || item.status === 'completed' || item.status === 'rejected')
    && item.status !== status
  ) {
    throw new PersonaRuntimeCorruptionError(
      item.personaId,
      `Mailbox item ${JSON.stringify(item.id)} has terminal status `
      + `${JSON.stringify(item.status)} incompatible with Activity ${JSON.stringify(activity.id)}.`,
    );
  }
  if (
    item.status === status
    && item.claimedActivityId === activity.id
    && item.completedAt !== undefined
  ) {
    return item;
  }
  return saveMailboxItem(lock, {
    ...item,
    status,
    claimedActivityId: activity.id,
    coalescedIntoId: undefined,
    updatedAt: Math.max(now, item.updatedAt),
    completedAt: activity.completedAt ?? Math.max(now, item.createdAt),
  });
}

async function reconcileTerminalLease(
  lock: PersonaRuntimeLock,
  persona: Persona,
  lease: PersonaLease,
  activity: PersonaActivity,
  items: PersonaMailboxItem[],
  reconciledAt?: number,
): Promise<void> {
  const now = Math.max(
    reconciledAt ?? Date.now(),
    activity.completedAt ?? activity.updatedAt,
    lease.renewedAt,
  );
  const item = findMailboxForActivity(persona.id, items, activity.id);
  if (!item) {
    throw new PersonaRuntimeCorruptionError(
      persona.id,
      `Terminal Activity ${JSON.stringify(activity.id)} has no mailbox item.`,
    );
  }
  await requeuePendingRelatedDeliveries(lock, activity, items, now);
  await terminalMailboxProjection(lock, item, activity, now);
  await projectPersonaLifecycle(lock, persona.id, 'idle', now);
  if (lease.status === 'active') {
    await saveLeaseHead(
      lock,
      activity.status === 'error' && activity.error === LEASE_EXPIRY_ERROR
        ? { ...lease, status: 'expired', releasedAt: undefined }
        : { ...lease, status: 'released', releasedAt: now },
    );
  }
}

/** Repair either crash boundary around a graceful waiting/yield transition. */
async function reconcileWaitingLease(
  lock: PersonaRuntimeLock,
  persona: Persona,
  lease: PersonaLease,
  activity: PersonaActivity,
  items: PersonaMailboxItem[],
  reconciledAt?: number,
): Promise<void> {
  if (activity.status !== 'waiting' || !activity.leaseId) {
    throw new PersonaRuntimeCorruptionError(
      persona.id,
      `Activity ${JSON.stringify(activity.id)} is not a lease-linked waiting Activity.`,
    );
  }
  const item = findMailboxForActivity(persona.id, items, activity.id);
  if (!item || item.status !== 'claimed' || item.claimedActivityId !== activity.id) {
    throw new PersonaRuntimeCorruptionError(
      persona.id,
      `Waiting Activity ${JSON.stringify(activity.id)} has no claimed mailbox item.`,
    );
  }
  const now = Math.max(reconciledAt ?? Date.now(), activity.updatedAt, lease.renewedAt);

  if (activity.leaseId === lease.id) {
    // Yield persisted the Activity first and crashed before releasing the head.
    await projectPersonaLifecycle(lock, persona.id, 'waiting', now);
    await saveLeaseHead(lock, { ...lease, status: 'released', releasedAt: now });
    return;
  }

  // A resumed acquisition persisted its new head before repointing the waiting
  // Activity. The new capability was never returned; retire only that token and
  // preserve the prior released generation as the Activity's provenance.
  const prior = await getPersonaLeaseRecord(activity.leaseId);
  if (
    !prior
    || prior.workspaceId !== lease.workspaceId
    || prior.personaId !== persona.id
    || prior.activityId !== activity.id
    || prior.status !== 'released'
    || prior.fencingToken >= lease.fencingToken
  ) {
    throw new PersonaRuntimeCorruptionError(
      persona.id,
      `Waiting Activity ${JSON.stringify(activity.id)} references an invalid prior lease.`,
    );
  }
  await projectPersonaLifecycle(lock, persona.id, 'waiting', now);
  await saveLeaseHead(lock, { ...lease, status: 'expired', releasedAt: undefined });
}

async function expireActiveLease(
  lock: PersonaRuntimeLock,
  persona: Persona,
  lease: PersonaLease,
  items: PersonaMailboxItem[],
  expiredAt?: number,
): Promise<void> {
  const now = Math.max(expiredAt ?? Date.now(), lease.renewedAt);
  const activity = await getPersonaActivity(lease.activityId);
  if (!activity || activity.personaId !== persona.id) {
    await projectPersonaLifecycle(lock, persona.id, 'error', now);
    await saveLeaseHead(lock, { ...lease, status: 'expired', releasedAt: undefined });
    await observeRuntime(persona.id, {
      eventId: `lease:${lease.activityId}:expired:${lease.fencingToken}`,
      type: 'lease:expired',
      activityId: lease.activityId,
      reasonCode: 'missing_activity',
    });
    throw new PersonaRuntimeCorruptionError(
      persona.id,
      `Expired lease ${JSON.stringify(lease.id)} references a missing or foreign Activity.`,
    );
  }
  if (isTerminalActivity(activity)) {
    await reconcileTerminalLease(lock, persona, lease, activity, items, now);
    return;
  }
  if (activity.status === 'waiting') {
    await reconcileWaitingLease(lock, persona, lease, activity, items, now);
    return;
  }

  const item = findMailboxForActivity(persona.id, items, activity.id);
  if (!item) {
    await requeuePendingRelatedDeliveries(lock, activity, items, now);
    await projectPersonaLifecycle(lock, persona.id, 'error', now);
    await saveLeaseHead(lock, { ...lease, status: 'expired', releasedAt: undefined });
    await observeRuntime(persona.id, {
      eventId: `lease:${lease.activityId}:expired:${lease.fencingToken}`,
      type: 'lease:expired',
      activityId: lease.activityId,
      reasonCode: 'missing_mailbox',
    });
    throw new PersonaRuntimeCorruptionError(
      persona.id,
      `Expired Activity ${JSON.stringify(activity.id)} has no mailbox item.`,
    );
  }

  if (item.status === 'queued') {
    // The claim commit marker was never written, so the caller could not have
    // received a fence or dispatched side effects. Preserve the work and only
    // consume the abandoned acquisition token.
    await saveActivity(lock, {
      ...activity,
      status: 'queued',
      leaseId: undefined,
      startedAt: undefined,
      completedAt: undefined,
      error: undefined,
      updatedAt: Math.max(now, activity.updatedAt),
    });
    await projectPersonaLifecycle(lock, persona.id, 'idle', now);
    await saveLeaseHead(lock, { ...lease, status: 'expired', releasedAt: undefined });
    await observeRuntime(persona.id, {
      eventId: `lease:${lease.activityId}:expired:${lease.fencingToken}`,
      type: 'lease:expired',
      activityId: lease.activityId,
      reasonCode: 'unpublished_claim',
    });
    return;
  }

  // Unknown external side effects make automatic replay unsafe. Close the
  // interrupted Activity and leave explicit retry/recovery policy to a later
  // orchestration layer; independent queued work remains drainable.
  await requeuePendingRelatedDeliveries(lock, activity, items, now);
  const failed = await saveActivity(lock, {
    ...activity,
    status: 'error',
    error: LEASE_EXPIRY_ERROR,
    updatedAt: Math.max(now, activity.updatedAt),
    completedAt: Math.max(now, activity.startedAt ?? activity.createdAt),
  });
  await terminalMailboxProjection(lock, item, failed, now);
  await projectPersonaLifecycle(lock, persona.id, 'idle', now);
  // Release/expiry is deliberately last: every earlier crash prefix leaves a
  // conservative active head that blocks takeover and can be reconciled.
  await saveLeaseHead(lock, { ...lease, status: 'expired', releasedAt: undefined });
  await observeRuntime(persona.id, {
    eventId: `lease:${lease.activityId}:expired:${lease.fencingToken}`,
    type: 'lease:expired',
    activityId: lease.activityId,
    reasonCode: 'heartbeat_expired',
  });
  await observeRuntime(persona.id, {
    eventId: `activity:${failed.id}:errored:lease_expired`,
    type: 'activity:errored',
    activityId: failed.id,
    errorCode: 'lease_expired',
  });
}

async function ensureQueuedActivity(
  lock: PersonaRuntimeLock,
  item: PersonaMailboxItem,
  behaviorId: string,
  revision: BehaviorRevision,
): Promise<{ activity: PersonaActivity; created: boolean }> {
  const id = activityIdForMailbox(item.id);
  const existing = await getPersonaActivity(id);
  if (existing) {
    if (
      existing.personaId !== item.personaId
      || existing.kind !== item.kind
      || existing.behaviorId !== behaviorId
      || existing.behaviorRevisionId !== revision.id
    ) {
      throw new PersonaRuntimeCorruptionError(
        item.personaId,
        `Deterministic Activity ${JSON.stringify(id)} has conflicting content.`,
      );
    }
    return { activity: existing, created: false };
  }

  const activity = PersonaActivitySchema.parse({
    schemaVersion: ENDURING_AGENT_SCHEMA_VERSION,
    id,
    personaId: item.personaId,
    kind: item.kind,
    status: 'queued',
    source: {
      ...item.source,
      idempotencyKey: item.source.idempotencyKey ?? item.idempotencyKey,
    },
    behaviorId,
    behaviorRevisionId: revision.id,
    createdAt: item.createdAt,
    updatedAt: item.createdAt,
  }) as PersonaActivity;
  return { activity: await saveActivity(lock, activity), created: true };
}

async function acquireLeaseForActivity(
  lock: PersonaRuntimeLock,
  input: ResolvedClaimPersonaActivityInput,
  activity: PersonaActivity,
  previousHead: PersonaLease | null,
): Promise<PersonaLease> {
  const leaseHistory = await listPersonaLeaseRecords(input.personaId);
  const durableToken = leaseHistory.reduce(
    (maximum, candidate) => Math.max(maximum, candidate.fencingToken),
    previousHead?.fencingToken ?? 0,
  );
  const durableTimestamp = leaseHistory.reduce(
    (maximum, candidate) => Math.max(maximum, candidate.renewedAt),
    previousHead?.renewedAt ?? 0,
  );
  let fencingToken = durableToken + 1;

  while (true) {
    const workspaceId = getCurrentWorkspace();
    const id = leaseIdForAcquisition(workspaceId, input.personaId, activity.id, fencingToken);
    const orphan = await getPersonaLeaseRecord(id);
    if (orphan) {
      if (
        orphan.personaId !== input.personaId
        || orphan.workspaceId !== workspaceId
        || orphan.activityId !== activity.id
        || orphan.holderId !== input.holderId
        || orphan.fencingToken !== fencingToken
      ) {
        throw new PersonaRuntimeCorruptionError(
          input.personaId,
          `Lease acquisition ${JSON.stringify(id)} has conflicting durable history.`,
        );
      }
      if (orphan.status === 'active' && orphan.expiresAt > Date.now()) {
        return saveLeaseHead(lock, orphan);
      }
      // An orphaned/terminal acquisition still consumed its token. Advance the
      // durable head before allocating the next one so tokens are never reused.
      const consumed = orphan.status === 'active'
        ? { ...orphan, status: 'expired' as const }
        : orphan;
      await saveLeaseHead(lock, consumed);
      fencingToken = consumed.fencingToken + 1;
      continue;
    }

    const acquiredAt = Math.max(
      Date.now(),
      activity.createdAt,
      activity.updatedAt,
      durableTimestamp,
    );
    const lease = PersonaLeaseSchema.parse({
      schemaVersion: ENDURING_AGENT_SCHEMA_VERSION,
      id,
      workspaceId,
      personaId: input.personaId,
      activityId: activity.id,
      holderId: input.holderId,
      status: 'active',
      fencingToken,
      acquiredAt,
      renewedAt: acquiredAt,
      expiresAt: acquiredAt + input.ttlMs,
    }) as PersonaLease;
    return saveLeaseHead(lock, lease);
  }
}

async function repairActiveClaim(
  lock: PersonaRuntimeLock,
  persona: Persona,
  lease: PersonaLease,
  item: PersonaMailboxItem,
  activity: PersonaActivity,
): Promise<PersonaActivityClaim> {
  const now = Math.max(Date.now(), activity.updatedAt, item.updatedAt, lease.acquiredAt);
  let repairedActivity = activity;
  if (activity.status === 'queued' || activity.status === 'waiting') {
    repairedActivity = await saveActivity(lock, {
      ...activity,
      status: 'running',
      leaseId: lease.id,
      startedAt: activity.startedAt ?? lease.acquiredAt,
      ...(activity.status === 'waiting'
        ? {
            interruptionRequestedAt: undefined,
            interruptionRequestedByMailboxItemId: undefined,
          }
        : {}),
      updatedAt: now,
      completedAt: undefined,
      error: undefined,
    });
  } else if (activity.status !== 'running') {
    throw new PersonaRuntimeCorruptionError(
      persona.id,
      `Active lease ${JSON.stringify(lease.id)} points at terminal Activity `
      + `${JSON.stringify(activity.id)}.`,
    );
  } else if (activity.leaseId !== lease.id) {
    throw new PersonaRuntimeCorruptionError(
      persona.id,
      `Running Activity ${JSON.stringify(activity.id)} is linked to lease `
      + `${JSON.stringify(activity.leaseId)} instead of ${JSON.stringify(lease.id)}.`,
    );
  }

  let repairedItem = item;
  if (item.status === 'queued') {
    repairedItem = await saveMailboxItem(lock, {
      ...item,
      status: 'claimed',
      claimedActivityId: activity.id,
      updatedAt: now,
    });
  } else if (item.status !== 'claimed' || item.claimedActivityId !== activity.id) {
    throw new PersonaRuntimeCorruptionError(
      persona.id,
      `Active Activity ${JSON.stringify(activity.id)} has incompatible mailbox state.`,
    );
  }

  await projectPersonaLifecycle(lock, persona.id, 'busy', now);
  return {
    mailboxItem: repairedItem,
    activity: repairedActivity,
    lease,
    recovered: true,
  };
}

async function claimQueuedItem(
  lock: PersonaRuntimeLock,
  persona: Persona,
  input: ResolvedClaimPersonaActivityInput,
  item: PersonaMailboxItem,
  previousHead: PersonaLease | null,
): Promise<PersonaActivityClaim | null> {
  if (
    (item.status !== 'queued' && item.status !== 'claimed')
    || (item.status === 'claimed' && item.claimedActivityId !== activityIdForMailbox(item.id))
  ) {
    throw new PersonaRuntimeCorruptionError(
      persona.id,
      `Mailbox item ${JSON.stringify(item.id)} cannot be claimed from status `
      + `${JSON.stringify(item.status)}.`,
    );
  }
  const slotKey = item.behaviorSlotKey ?? defaultBehaviorSlot(item.kind);
  const activityId = activityIdForMailbox(item.id);
  const pinnedActivity = await getPersonaActivity(activityId);
  let behaviorId: string;
  let revision: BehaviorRevision;
  if (pinnedActivity) {
    if (!pinnedActivity.behaviorId || !pinnedActivity.behaviorRevisionId) {
      throw new PersonaRuntimeCorruptionError(
        persona.id,
        `Persisted Activity ${JSON.stringify(activityId)} has no immutable Behavior pin.`,
      );
    }
    const pinnedRevision = await getBehaviorRevision(pinnedActivity.behaviorRevisionId);
    if (
      !pinnedRevision
      || pinnedRevision.personaId !== persona.id
      || pinnedRevision.behaviorId !== pinnedActivity.behaviorId
      || pinnedRevision.slotKey !== slotKey
    ) {
      throw new PersonaRuntimeCorruptionError(
        persona.id,
        `Persisted Activity ${JSON.stringify(activityId)} has an invalid Behavior pin.`,
      );
    }
    behaviorId = pinnedActivity.behaviorId;
    revision = pinnedRevision;
  } else {
    const resolved = await resolveBehavior(persona.id, slotKey);
    behaviorId = resolved.binding.id;
    revision = resolved.revision;
  }
  const ensured = await ensureQueuedActivity(lock, item, behaviorId, revision);
  if (isTerminalActivity(ensured.activity)) {
    await terminalMailboxProjection(lock, item, ensured.activity, Date.now());
    return null;
  }

  const lease = await acquireLeaseForActivity(lock, input, ensured.activity, previousHead);
  const claim = await repairActiveClaim(lock, persona, lease, item, ensured.activity);
  return { ...claim, recovered: !ensured.created };
}

interface RoutablePersonaActivity {
  activity: PersonaActivity;
  mailboxItem: PersonaMailboxItem;
}

interface PersonaRoutingState {
  active: RoutablePersonaActivity | null;
  waiting: RoutablePersonaActivity[];
  current: RoutablePersonaActivity | null;
}

/** Reconcile enough runtime state to make one atomic mailbox-routing decision. */
async function resolvePersonaRoutingState(
  lock: PersonaRuntimeLock,
  persona: Persona,
): Promise<PersonaRoutingState> {
  let items = await listPersonaMailboxItems(persona.id);
  let head = await reconcilePersonaLeaseHead(lock, persona.id);
  let active: RoutablePersonaActivity | null = null;

  if (head?.status === 'active') {
    const activity = await getPersonaActivity(head.activityId);
    if (!activity || activity.personaId !== persona.id) {
      await expireActiveLease(lock, persona, head, items);
    } else if (isTerminalActivity(activity)) {
      await reconcileTerminalLease(lock, persona, head, activity, items);
    } else if (activity.status === 'waiting') {
      await reconcileWaitingLease(lock, persona, head, activity, items);
    } else {
      const item = findMailboxForActivity(persona.id, items, activity.id);
      if (item?.status === 'queued' || head.expiresAt <= Date.now()) {
        await expireActiveLease(lock, persona, head, items);
      } else if (!item || item.status !== 'claimed' || item.claimedActivityId !== activity.id) {
        throw new PersonaRuntimeCorruptionError(
          persona.id,
          `Live Activity ${JSON.stringify(activity.id)} has incompatible mailbox state.`,
        );
      } else {
        const repaired = await repairActiveClaim(lock, persona, head, item, activity);
        active = { activity: repaired.activity, mailboxItem: repaired.mailboxItem };
      }
    }
  }

  // Re-read after reconciliation so a claim/yield crash prefix cannot leak a
  // stale routing target into the decision below.
  items = await listPersonaMailboxItems(persona.id);
  head = await reconcilePersonaLeaseHead(lock, persona.id);
  const waiting: RoutablePersonaActivity[] = [];
  for (const item of items.filter((candidate) => candidate.status === 'claimed')) {
    if (active?.mailboxItem.id === item.id) continue;
    const activity = await getPersonaActivity(activityIdForMailbox(item.id));
    if (!activity || activity.personaId !== persona.id || item.claimedActivityId !== activity.id) {
      throw new PersonaRuntimeCorruptionError(
        persona.id,
        `Claimed mailbox item ${JSON.stringify(item.id)} has no same-Persona Activity.`,
      );
    }
    if (activity.status !== 'waiting' || !activity.leaseId) {
      throw new PersonaRuntimeCorruptionError(
        persona.id,
        `Claimed mailbox item ${JSON.stringify(item.id)} has no routable waiting Activity.`,
      );
    }
    const provenance = await getPersonaLeaseRecord(activity.leaseId);
    if (
      !provenance
      || provenance.workspaceId !== getCurrentWorkspace()
      || provenance.personaId !== persona.id
      || provenance.activityId !== activity.id
      || provenance.status !== 'released'
      || (head && provenance.fencingToken > head.fencingToken)
    ) {
      throw new PersonaRuntimeCorruptionError(
        persona.id,
        `Waiting Activity ${JSON.stringify(activity.id)} has no released lease provenance.`,
      );
    }
    waiting.push({ activity, mailboxItem: item });
  }

  let current = active;
  if (!current && waiting.length > 0) {
    const headMailbox = head ? findMailboxForActivity(persona.id, items, head.activityId) : null;
    const interruptedActivityId = headMailbox?.interruptedActivityId;
    current = head
      ? waiting.find((candidate) => candidate.activity.id === head.activityId) ?? null
      : null;
    if (!current && interruptedActivityId) {
      current = waiting.find(
        (candidate) => candidate.activity.id === interruptedActivityId,
      ) ?? null;
    }
    if (!current) {
      current = [...waiting].sort(
        (left, right) => (right.activity.updatedAt - left.activity.updatedAt)
          || right.activity.id.localeCompare(left.activity.id),
      )[0] ?? null;
    }
  }
  return { active, waiting, current };
}

async function repairInterruptionRequest(
  lock: PersonaRuntimeLock,
  item: PersonaMailboxItem,
): Promise<void> {
  if (
    item.status !== 'queued'
    || item.routingDecision !== 'interrupt'
    || !item.interruptedActivityId
  ) return;
  const activity = await getPersonaActivity(item.interruptedActivityId);
  if (!activity || activity.personaId !== item.personaId) {
    throw new PersonaRuntimeCorruptionError(
      item.personaId,
      `Interrupt mailbox item ${JSON.stringify(item.id)} targets a missing or foreign Activity.`,
    );
  }
  if (isTerminalActivity(activity)) return;
  if (activity.status !== 'running' && activity.status !== 'waiting') {
    throw new PersonaRuntimeCorruptionError(
      item.personaId,
      `Interrupt mailbox item ${JSON.stringify(item.id)} targets a non-routable Activity.`,
    );
  }
  if (
    activity.interruptionRequestedByMailboxItemId === item.id
    && activity.interruptionRequestedAt !== undefined
  ) return;
  const now = Math.max(Date.now(), activity.updatedAt, activity.startedAt ?? activity.createdAt);
  await saveActivity(lock, {
    ...activity,
    interruptionRequestedAt: now,
    interruptionRequestedByMailboxItemId: item.id,
    updatedAt: now,
  });
  await observeRuntime(item.personaId, {
    eventId: `interruption:${activity.id}:${item.id}`,
    type: 'interruption:requested',
    activityId: activity.id,
    requestedByMailboxItemId: item.id,
  });
}

async function admitPersonaMailboxItem(
  lock: PersonaRuntimeLock,
  input: RoutePersonaMailboxItemInput,
  route: boolean,
): Promise<RoutePersonaMailboxResult> {
  const idempotencyKey = sha256(input.idempotencyKey);
  const source = {
    ...input.source,
    ...(input.source.idempotencyKey
      ? { idempotencyKey: sha256(input.source.idempotencyKey) }
      : {}),
  };
  const behaviorSlotKey = input.behaviorSlotKey ?? defaultBehaviorSlot(input.kind);
  BehaviorSlotKeySchema.parse(behaviorSlotKey);

  const id = stableEnduringAgentId('mailbox', {
    purpose: 'persona-mailbox-idempotency-v1',
    personaId: input.personaId,
    idempotencyKey,
  });
  const requestedAdmission = {
    personaId: input.personaId,
    idempotencyKey,
    kind: input.kind,
    priority: input.priority ?? 'normal',
    source,
    behaviorSlotKey,
    relationKey: input.relationKey ?? null,
    relatedAction: input.relatedAction ?? null,
    summary: input.summary ?? null,
    payloadRef: input.payloadRef ?? null,
    notBefore: input.notBefore ?? null,
  };

  const existing = await getPersonaMailboxItem(id);
  if (existing) {
    if (canonicalJson(mailboxAdmission(existing)) !== canonicalJson(requestedAdmission)) {
      throw new PersonaMailboxConflictError(
        id,
        `Mailbox idempotency key for Persona ${JSON.stringify(input.personaId)} was reused `
        + 'with different work.',
      );
    }
    await repairInterruptionRequest(lock, existing);
    return {
      item: existing,
      decision: 'duplicate',
      ...(existing.targetActivityId
        ? { targetActivityId: existing.targetActivityId }
        : existing.interruptedActivityId
          ? { targetActivityId: existing.interruptedActivityId }
          : {}),
    };
  }

  const persona = await requireReadyPersona(input.personaId);
  if (persona.lifecycleState === 'disabled') {
    throw new PersonaRuntimeUnavailableError(
      persona.id,
      `Persona ${JSON.stringify(persona.id)} is disabled and cannot accept new work.`,
    );
  }
  await resolveBehavior(persona.id, behaviorSlotKey);

  const existingItems = await listPersonaMailboxItems(persona.id);
  const sequences = new Set(existingItems.map((item) => item.sequence));
  if (sequences.size !== existingItems.length) {
    throw new PersonaRuntimeCorruptionError(
      persona.id,
      'Persona mailbox contains duplicate admission sequence values.',
    );
  }
  const sequence = existingItems.reduce(
    (maximum, item) => Math.max(maximum, item.sequence),
    0,
  ) + 1;
  const now = Date.now();
  const routingState = route ? await resolvePersonaRoutingState(lock, persona) : null;
  const seenTargetIds = new Set<string>();
  const relatedCandidates = routingState
    ? [
        routingState.active,
        routingState.current,
        ...[...routingState.waiting].sort(
          (left, right) => (right.activity.updatedAt - left.activity.updatedAt)
            || right.activity.id.localeCompare(left.activity.id),
        ),
      ]
      .filter((candidate): candidate is RoutablePersonaActivity => candidate != null)
      .filter((candidate) => {
        if (seenTargetIds.has(candidate.activity.id)) return false;
        seenTargetIds.add(candidate.activity.id);
        return true;
      })
    : [];
  const relatedTarget = route
    && persona.interruptionPolicy !== 'queue'
    && input.relatedAction
    && input.relationKey
    ? relatedCandidates.find(
      (candidate) => candidate.mailboxItem.relationKey === input.relationKey,
    )
    : undefined;

  let decision: PersonaMailboxRouteDecision = 'queued';
  let routingFields: Partial<PersonaMailboxItem> = route
    ? { routingDecision: 'queue' }
    : {};
  if (relatedTarget && input.relatedAction) {
    decision = input.relatedAction === 'steer' ? 'steered' : 'coalesced';
    routingFields = {
      routingDecision: input.relatedAction,
      targetActivityId: relatedTarget.activity.id,
      deliveryStatus: 'pending',
      coalescedIntoId: relatedTarget.mailboxItem.id,
    };
  } else if (
    route
    && persona.interruptionPolicy === 'allow_urgent'
    && !input.relatedAction
    && (input.priority ?? 'normal') === 'urgent'
    && routingState?.current
  ) {
    decision = 'interrupt_requested';
    routingFields = {
      routingDecision: 'interrupt',
      interruptedActivityId: routingState.current.activity.id,
    };
  }

  const candidate = PersonaMailboxItemSchema.parse({
    schemaVersion: ENDURING_AGENT_SCHEMA_VERSION,
    id,
    personaId: persona.id,
    idempotencyKey,
    sequence,
    kind: input.kind,
    priority: input.priority ?? 'normal',
    status: relatedTarget ? 'coalesced' : 'queued',
    source,
    behaviorSlotKey,
    ...(input.relationKey !== undefined ? { relationKey: input.relationKey } : {}),
    ...(input.relatedAction !== undefined ? { relatedAction: input.relatedAction } : {}),
    ...routingFields,
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
    ...(input.payloadRef !== undefined ? { payloadRef: input.payloadRef } : {}),
    ...(input.notBefore !== undefined ? { notBefore: input.notBefore } : {}),
    createdAt: now,
    updatedAt: now,
    ...(relatedTarget ? { completedAt: now } : {}),
  }) as PersonaMailboxItem;

  const saved = await saveMailboxItem(lock, candidate);
  await repairInterruptionRequest(lock, saved);
  return {
    item: saved,
    decision,
    ...(saved.targetActivityId
      ? { targetActivityId: saved.targetActivityId }
      : saved.interruptedActivityId
        ? { targetActivityId: saved.interruptedActivityId }
        : {}),
  };
}

/**
 * Admit one durable input. Identity is derived solely from Persona plus a hash
 * of the caller retry key, so duplicate enforcement is a fail-closed point read
 * rather than a best-effort collection scan.
 */
export async function enqueuePersonaMailboxItem(
  value: unknown,
): Promise<EnqueuePersonaMailboxResult> {
  const input = CreatePersonaMailboxItemInputSchema.parse(value) as RoutePersonaMailboxItemInput;
  assertSafeCollectionId(input.personaId);
  const behaviorSlotKey = input.behaviorSlotKey ?? defaultBehaviorSlot(input.kind);
  if (behaviorSlotKey === 'primary') await resolvePersonaCoreRevision(input.personaId);

  const result = await withPersonaRuntimeLock(input.personaId, async (lock) => {
    const routed = await admitPersonaMailboxItem(lock, input, false);
    return { item: routed.item, duplicate: routed.decision === 'duplicate' };
  });
  await observeRuntime(input.personaId, {
    eventId: `mailbox:${result.item.id}:admitted`,
    type: 'mailbox:admitted',
    mailboxItemId: result.item.id,
    kind: result.item.kind,
    priority: result.item.priority,
    duplicate: result.duplicate,
  });
  return result;
}

/** Atomically admit and route an input against the current Activity topology. */
export async function routePersonaMailboxItem(
  value: unknown,
  options: PersonaMailboxAdmissionOptions = {},
): Promise<RoutePersonaMailboxResult> {
  const input = CreatePersonaMailboxItemInputSchema.parse(value) as RoutePersonaMailboxItemInput;
  assertSafeCollectionId(input.personaId);
  const behaviorSlotKey = input.behaviorSlotKey ?? defaultBehaviorSlot(input.kind);
  if (behaviorSlotKey === 'primary') await resolvePersonaCoreRevision(input.personaId);
  const result = await withPersonaRuntimeLock(
    input.personaId,
    async (lock) => {
      await options.validateAdmission?.();
      return admitPersonaMailboxItem(lock, input, true);
    },
  );
  await observeRuntime(input.personaId, {
    eventId: `mailbox:${result.item.id}:admitted`,
    type: 'mailbox:admitted',
    mailboxItemId: result.item.id,
    kind: result.item.kind,
    priority: result.item.priority,
    duplicate: result.decision === 'duplicate',
  });
  const decision = result.decision === 'interrupt_requested'
    ? 'interruption_requested'
    : result.decision;
  await observeRuntime(input.personaId, {
    eventId: `mailbox:${result.item.id}:routed:${decision}`,
    type: 'mailbox:routed',
    mailboxItemId: result.item.id,
    decision,
    ...(result.targetActivityId ? { targetActivityId: result.targetActivityId } : {}),
    ...(result.item.coalescedIntoId
      ? { targetMailboxItemId: result.item.coalescedIntoId }
      : {}),
  });
  return result;
}

/** Update ordering for work that is still waiting in the mailbox. */
export async function reprioritizePersonaMailboxItemWithinRuntimeLock(
  value: ReprioritizePersonaMailboxItemInput,
  lock: PersonaRuntimeLock,
): Promise<ReprioritizePersonaMailboxItemResult> {
  const input = ReprioritizePersonaMailboxItemInputSchema.parse(
    value,
  ) as ReprioritizePersonaMailboxItemInput;
  await lock.assertOwned();
  const item = await getPersonaMailboxItem(input.mailboxItemId);
  if (!item || item.personaId !== input.personaId) {
    throw new PersonaRuntimeNotFoundError('PersonaMailboxItem', input.mailboxItemId);
  }
  if (item.status !== 'queued' || item.priority === input.priority) {
    return { item, changed: false };
  }
  const updated = await saveMailboxItem(lock, {
    ...item,
    priority: input.priority,
    updatedAt: Math.max(Date.now(), item.updatedAt + 1),
  });
  return { item: updated, changed: true };
}

/**
 * Swap one queued Task with its same-priority Task neighbor. A temporary
 * sequence keeps every intermediate durable state unique, even if persistence
 * is interrupted between writes.
 */
export async function movePersonaMailboxItemWithinRuntimeLock(
  value: MovePersonaMailboxItemInput,
  lock: PersonaRuntimeLock,
): Promise<MovePersonaMailboxItemResult> {
  const input = MovePersonaMailboxItemInputSchema.parse(value) as MovePersonaMailboxItemInput;
  await lock.assertOwned();
  const items = await listPersonaMailboxItems(input.personaId);
  if (new Set(items.map((item) => item.sequence)).size !== items.length) {
    throw new PersonaRuntimeCorruptionError(
      input.personaId,
      'Persona mailbox contains duplicate admission sequence values.',
    );
  }
  const target = items.find((item) => item.id === input.mailboxItemId);
  if (!target || target.personaId !== input.personaId) {
    throw new PersonaRuntimeNotFoundError('PersonaMailboxItem', input.mailboxItemId);
  }
  if (
    target.status !== 'queued'
    || target.source.kind !== 'assignment'
    || !target.source.sourceId
  ) {
    throw new PersonaMailboxConflictError(
      target.id,
      'Only a queued Task can be moved.',
    );
  }

  const neighbors = items
    .filter((item) => (
      item.id !== target.id
      && item.status === 'queued'
      && item.kind === 'assignment'
      && item.source.kind === 'assignment'
      && Boolean(item.source.sourceId)
      && item.priority === target.priority
    ))
    .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
  const neighbor = input.direction === 'earlier'
    ? [...neighbors].reverse().find((item) => item.sequence < target.sequence)
    : neighbors.find((item) => item.sequence > target.sequence);
  if (!neighbor) return { item: target, moved: false };

  const temporarySequence = Math.max(...items.map((item) => item.sequence)) + 1;
  if (!Number.isSafeInteger(temporarySequence)) {
    throw new PersonaRuntimeCorruptionError(
      input.personaId,
      'Persona mailbox sequence space is exhausted.',
    );
  }
  const now = Math.max(Date.now(), target.updatedAt + 1, neighbor.updatedAt + 1);
  const parked = await saveMailboxItem(lock, {
    ...target,
    sequence: temporarySequence,
    updatedAt: now,
  });
  await saveMailboxItem(lock, {
    ...neighbor,
    sequence: target.sequence,
    updatedAt: now,
  });
  const moved = await saveMailboxItem(lock, {
    ...parked,
    sequence: neighbor.sequence,
    updatedAt: now + 1,
  });
  return { item: moved, moved: true };
}

/**
 * Cancel queued or cooperatively-yielded work without possessing a lease. This
 * administrative operation is intentionally narrow: a running Activity still
 * requires its current fence and cannot be cancelled through this path.
 */
export async function cancelPersonaMailboxItem(value: unknown): Promise<PersonaMailboxItem> {
  const input = CancelPersonaMailboxItemInputSchema.parse(value) as CancelPersonaMailboxItemInput;
  const result = await withPersonaRuntimeLock(input.personaId, async (lock) => {
    const persona = await getPersona(input.personaId);
    if (!persona) throw new PersonaRuntimeNotFoundError('Persona', input.personaId);
    const item = await getPersonaMailboxItem(input.mailboxItemId);
    if (!item || item.personaId !== input.personaId) {
      throw new PersonaRuntimeNotFoundError('PersonaMailboxItem', input.mailboxItemId);
    }
    if (
      item.status === 'coalesced'
      || item.status === 'completed'
      || item.status === 'rejected'
    ) return { item, changed: false, cancelledActivityId: undefined as string | undefined };

    const activity = await getPersonaActivity(activityIdForMailbox(item.id));
    if (activity?.status === 'running') {
      throw new PersonaBusyError(
        input.personaId,
        (await getPersonaLease(input.personaId))!,
      );
    }
    const now = Math.max(Date.now(), item.updatedAt, activity?.updatedAt ?? 0);
    const activityCancelled = Boolean(activity && !isTerminalActivity(activity));
    if (activityCancelled && activity) {
      await saveActivity(lock, {
        ...activity,
        status: 'cancelled',
        error: undefined,
        updatedAt: now,
        completedAt: now,
      });
    }
    const cancelled = await saveMailboxItem(lock, {
      ...item,
      status: 'rejected',
      coalescedIntoId: undefined,
      updatedAt: now,
      completedAt: now,
    });
    const head = await reconcilePersonaLeaseHead(lock, input.personaId);
    if (!head || head.status !== 'active') {
      await projectPersonaLifecycle(lock, input.personaId, 'idle', now);
    }
    return {
      item: cancelled,
      changed: true,
      cancelledActivityId: activityCancelled ? activity!.id : undefined,
    };
  });
  if (result.changed) {
    await observeRuntime(input.personaId, {
      eventId: `mailbox:${result.item.id}:routed:rejected:cancelled`,
      type: 'mailbox:routed',
      mailboxItemId: result.item.id,
      decision: 'rejected',
      reasonCode: 'administrative_cancel',
    });
    if (result.cancelledActivityId) {
      await observeRuntime(input.personaId, {
        eventId: `activity:${result.cancelledActivityId}:cancelled`,
        type: 'activity:cancelled',
        activityId: result.cancelledActivityId,
      });
    }
  }
  return result.item;
}

/**
 * Claim the next eligible item. Existing valid work blocks other holders;
 * expiry closes uncertain work instead of replaying possible side effects.
 */
export async function claimNextPersonaActivity(
  value: unknown,
): Promise<PersonaActivityClaim | null> {
  const input = ClaimPersonaActivityInputSchema.parse(value) as ClaimPersonaActivityInput;
  assertSafeCollectionId(input.personaId);

  const claim = await withPersonaRuntimeLock(input.personaId, async (lock) => {
    const acquisitionInput: ResolvedClaimPersonaActivityInput = {
      ...input,
      holderId: randomEnduringAgentId('holder'),
    };
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const persona = await requireReadyPersona(input.personaId);
      const items = await listPersonaMailboxItems(persona.id);
      const head = await reconcilePersonaLeaseHead(lock, persona.id);
      if (head?.status === 'active') {
        const activity = await getPersonaActivity(head.activityId);
        if (!activity || activity.personaId !== persona.id) {
          await expireActiveLease(lock, persona, head, items);
          continue;
        }
        if (isTerminalActivity(activity)) {
          await reconcileTerminalLease(lock, persona, head, activity, items);
          continue;
        }
        if (activity.status === 'waiting') {
          await reconcileWaitingLease(lock, persona, head, activity, items);
          continue;
        }
        const item = findMailboxForActivity(persona.id, items, activity.id);
        if (item?.status === 'queued') {
          // The durable claim marker was never reached, so no caller could have
          // received this fence. Retire the abandoned acquisition immediately
          // instead of making provably-undispatched work wait for lease expiry.
          await expireActiveLease(lock, persona, head, items);
          continue;
        }
        if (head.expiresAt <= Date.now()) {
          await expireActiveLease(lock, persona, head, items);
          continue;
        }
        if (!item || item.status !== 'claimed' || item.claimedActivityId !== activity.id) {
          throw new PersonaRuntimeCorruptionError(
            persona.id,
            `Live Activity ${JSON.stringify(activity.id)} has incompatible mailbox state.`,
          );
        }
        await repairActiveClaim(lock, persona, head, item, activity);
        throw new PersonaBusyError(persona.id, head);
      }

      if (
        persona.lifecycleState === 'disabled'
        || persona.lifecycleState === 'sleeping'
        || persona.lifecycleState === 'error'
      ) {
        throw new PersonaRuntimeUnavailableError(
          persona.id,
          `Persona ${JSON.stringify(persona.id)} is ${persona.lifecycleState}.`,
        );
      }

      const claimed = items.filter((item) => item.status === 'claimed');
      const waitingClaims: Array<{ item: PersonaMailboxItem; activity: PersonaActivity }> = [];
      for (const item of claimed) {
        const activity = await getPersonaActivity(activityIdForMailbox(item.id));
        if (!activity || activity.personaId !== persona.id || activity.status !== 'waiting') {
          throw new PersonaRuntimeCorruptionError(
            persona.id,
            `Claimed mailbox item ${JSON.stringify(item.id)} has no recoverable waiting Activity.`,
          );
        }
        const prior = activity.leaseId
          ? await getPersonaLeaseRecord(activity.leaseId)
          : null;
        if (
          !head
          || !prior
          || prior.workspaceId !== getCurrentWorkspace()
          || prior.personaId !== persona.id
          || prior.activityId !== activity.id
          || prior.status !== 'released'
          || prior.fencingToken > head.fencingToken
        ) {
          throw new PersonaRuntimeCorruptionError(
            persona.id,
            `Waiting Activity ${JSON.stringify(activity.id)} has no durable released lease `
            + 'provenance.',
          );
        }
        waitingClaims.push({ item, activity });
      }
      if (waitingClaims.length > 0) {
        const headMailbox = head
          ? findMailboxForActivity(persona.id, items, head.activityId)
          : null;
        const interruptedActivityId = headMailbox?.interruptedActivityId;
        let resumable = head
          ? waitingClaims.find(({ activity }) => activity.id === head.activityId)
          : undefined;
        if (!resumable && interruptedActivityId) {
          resumable = waitingClaims.find(
            ({ activity }) => activity.id === interruptedActivityId,
          );
        }
        if (!resumable && waitingClaims.length === 1) resumable = waitingClaims[0];
        if (!resumable) {
          throw new PersonaRuntimeCorruptionError(
            persona.id,
            `Persona has ${waitingClaims.length} waiting Activities without an interruption chain.`,
          );
        }

        const targetedInterrupts = items.filter(
          (item) => item.routingDecision === 'interrupt'
            && item.priority === 'urgent'
            && item.status === 'queued'
            && item.interruptedActivityId === resumable.activity.id,
        );
        const pendingInterrupt = sortEligibleMailboxItems(targetedInterrupts, Date.now())[0];
        if (pendingInterrupt) {
          if (
            input.expectedMailboxItemId !== undefined
            && pendingInterrupt.id !== input.expectedMailboxItemId
          ) return null;
          return claimQueuedItem(
            lock,
            persona,
            acquisitionInput,
            pendingInterrupt,
            head,
          );
        }
        if (targetedInterrupts.length > 0) return null;
        if (
          input.expectedMailboxItemId !== undefined
          && resumable.item.id !== input.expectedMailboxItemId
        ) return null;
        return claimQueuedItem(lock, persona, acquisitionInput, resumable.item, head);
      }

      const next = sortEligibleMailboxItems(items, Date.now())[0];
      if (!next) {
        if (persona.lifecycleState === 'busy' || persona.lifecycleState === 'waiting') {
          await projectPersonaLifecycle(lock, persona.id, 'idle', Date.now());
        }
        return null;
      }
      if (
        input.expectedMailboxItemId !== undefined
        && next.id !== input.expectedMailboxItemId
      ) return null;
      const claimedNext = await claimQueuedItem(lock, persona, acquisitionInput, next, head);
      if (claimedNext) return claimedNext;
    }
    throw new PersonaRuntimeCorruptionError(
      input.personaId,
      'Persona runtime reconciliation exceeded its bounded attempt limit.',
    );
  });
  if (claim) {
    await observeRuntime(input.personaId, {
      eventId: `activity:${claim.activity.id}:claimed:${claim.lease.fencingToken}`,
      type: 'activity:claimed',
      activityId: claim.activity.id,
      kind: claim.activity.kind,
      ...(claim.activity.behaviorRevisionId
        ? { behaviorRevisionId: claim.activity.behaviorRevisionId }
        : {}),
    });
  }
  return claim;
}

/**
 * Claim one known mailbox item only if it is atomically the next eligible work.
 * This prevents a meeting coordinator from ever acquiring/yielding unrelated
 * Persona work while assembling an all-or-none multi-Persona reservation.
 */
export function claimPersonaMailboxItem(value: unknown): Promise<PersonaActivityClaim | null> {
  const input = ClaimPersonaActivityInputSchema.parse(value) as ClaimPersonaActivityInput;
  if (!input.expectedMailboxItemId) {
    throw new TypeError('claimPersonaMailboxItem requires expectedMailboxItemId.');
  }
  return claimNextPersonaActivity(input);
}

async function requireCurrentLease(
  lock: PersonaRuntimeLock,
  personaId: string,
  fence: PersonaLeaseFence,
): Promise<PersonaLease> {
  const lease = await reconcilePersonaLeaseHead(lock, personaId);
  if (!lease || !leaseMatchesFence(lease, fence)) {
    throw new PersonaLeaseLostError(
      personaId,
      `Persona lease ${JSON.stringify(fence.leaseId)} is no longer current.`,
    );
  }
  return lease;
}

async function requireRunnableActivityForLease(
  lock: PersonaRuntimeLock,
  persona: Persona,
  lease: PersonaLease,
): Promise<PersonaActivity> {
  const activity = await getPersonaActivity(lease.activityId);
  if (!activity || activity.personaId !== persona.id) {
    throw new PersonaRuntimeCorruptionError(
      persona.id,
      `Persona lease ${JSON.stringify(lease.id)} references a missing or foreign Activity.`,
    );
  }
  if (isTerminalActivity(activity)) {
    await reconcileTerminalLease(
      lock,
      persona,
      lease,
      activity,
      await listPersonaMailboxItems(persona.id),
    );
    throw new PersonaLeaseLostError(
      persona.id,
      `Persona Activity ${JSON.stringify(activity.id)} is already terminal.`,
    );
  }
  if (activity.status === 'waiting') {
    await reconcileWaitingLease(
      lock,
      persona,
      lease,
      activity,
      await listPersonaMailboxItems(persona.id),
    );
    throw new PersonaLeaseLostError(
      persona.id,
      `Persona Activity ${JSON.stringify(activity.id)} has yielded its lease.`,
    );
  }
  if (activity.status !== 'running' || activity.leaseId !== lease.id) {
    throw new PersonaLeaseLostError(
      persona.id,
      `Persona Activity ${JSON.stringify(activity.id)} is not running under lease `
      + `${JSON.stringify(lease.id)}.`,
    );
  }
  return activity;
}

async function requireActiveRunnableLease(
  lock: PersonaRuntimeLock,
  fence: PersonaLeaseFence,
): Promise<{ persona: Persona; lease: PersonaLease; activity: PersonaActivity }> {
  const persona = await requireReadyPersona(fence.personaId);
  const lease = await requireCurrentLease(lock, persona.id, fence);
  if (lease.status !== 'active' || lease.expiresAt <= Date.now()) {
    if (lease.status === 'active') {
      await expireActiveLease(lock, persona, lease, await listPersonaMailboxItems(persona.id));
    }
    throw new PersonaLeaseLostError(
      persona.id,
      `Persona lease ${JSON.stringify(lease.id)} is not active.`,
    );
  }
  const activity = await requireRunnableActivityForLease(lock, persona, lease);
  return { persona, lease, activity };
}

/** Verify the exact live fencing tuple immediately before external dispatch. */
export async function assertPersonaActivityLease(value: unknown): Promise<PersonaLease> {
  const fence = LeaseFenceSchema.parse(value) as PersonaLeaseFence;
  return withPersonaRuntimeLock(fence.personaId, async (lock) => {
    const { lease } = await requireActiveRunnableLease(lock, fence);
    return lease;
  });
}

/**
 * Hold the exact Persona Activity generation across a caller-supplied durable
 * write. The fence is validated after the cross-process runtime lock is held,
 * closing the check-then-queued-write race for conversation snapshots/logs.
 * The callback must not recursively acquire this Persona's runtime lock.
 */
export async function commitWithPersonaActivityLease<T>(
  value: unknown,
  task: () => Promise<T>,
): Promise<T> {
  const fence = LeaseFenceSchema.parse(value) as PersonaLeaseFence;
  return withPersonaRuntimeLock(fence.personaId, async (lock) => {
    await requireActiveRunnableLease(lock, fence);
    const result = await task();
    await lock.assertOwned();
    return result;
  });
}

/**
 * Execute one Persona-owned domain mutation while the exact Activity fence and
 * cross-process runtime lock remain current. The capability exposes neither the
 * holder id nor fencing token to Flow/model code.
 */
export async function commitPersonaActivityMutation<T>(
  value: unknown,
  task: (context: PersonaActivityMutationContext) => Promise<T>,
): Promise<T> {
  const fence = LeaseFenceSchema.parse(value) as PersonaLeaseFence;
  return withPersonaRuntimeLock(fence.personaId, async (lock) => {
    const { persona, activity } = await requireActiveRunnableLease(lock, fence);
    const result = await task({
      persona,
      activity,
      updatePersona: (next) => updatePersonaWithinRuntimeLock(next, lock),
    });
    await lock.assertOwned();
    return result;
  });
}

/**
 * List durable adapter deliveries for exactly the Activity generation named by
 * the fence. A stale worker cannot observe or acknowledge a successor's input.
 */
export async function listPendingPersonaActivityDeliveries(
  value: unknown,
): Promise<PersonaMailboxItem[]> {
  const fence = LeaseFenceSchema.parse(value) as PersonaLeaseFence;
  return withPersonaRuntimeLock(fence.personaId, async (lock) => {
    await requireActiveRunnableLease(lock, fence);
    return (await listPersonaMailboxItems(fence.personaId))
      .filter((item) => item.status === 'coalesced'
        && item.targetActivityId === fence.activityId
        && (item.routingDecision === 'steer' || item.routingDecision === 'coalesce')
        && item.deliveryStatus === 'pending')
      .sort((left, right) => (left.sequence - right.sequence) || left.id.localeCompare(right.id));
  });
}

/** Mark one routed adapter delivery delivered. Repeated acknowledgement is a no-op. */
export async function acknowledgePersonaActivityDelivery(
  value: unknown,
): Promise<PersonaMailboxItem> {
  const input = AcknowledgePersonaActivityDeliveryInputSchema.parse(value) as
    AcknowledgePersonaActivityDeliveryInput;
  return withPersonaRuntimeLock(input.personaId, async (lock) => {
    await requireActiveRunnableLease(lock, input);
    const item = await getPersonaMailboxItem(input.mailboxItemId);
    if (!item) {
      throw new PersonaRuntimeNotFoundError('PersonaMailboxItem', input.mailboxItemId);
    }
    if (
      item.personaId !== input.personaId
      || item.status !== 'coalesced'
      || item.targetActivityId !== input.activityId
      || (item.routingDecision !== 'steer' && item.routingDecision !== 'coalesce')
      || (item.deliveryStatus !== 'pending' && item.deliveryStatus !== 'delivered')
    ) {
      throw new PersonaLeaseLostError(
        input.personaId,
        `Mailbox delivery ${JSON.stringify(item.id)} is not owned by the fenced Activity.`,
      );
    }
    if (item.deliveryStatus === 'delivered') return item;

    const deliveredAt = Math.max(Date.now(), item.updatedAt, item.completedAt ?? item.createdAt);
    return saveMailboxItem(lock, {
      ...item,
      deliveryStatus: 'delivered',
      deliveredAt,
      updatedAt: deliveredAt,
    });
  });
}

/**
 * Fail one unsupported routed delivery closed without representing it as
 * transcript-delivered. The exact live fence prevents one Activity generation
 * from rejecting a successor's input. Once rejected, delivery ownership fields
 * are cleared, so a repeated fenced request fails closed instead of guessing
 * that the now-terminal item still belongs to this Activity generation.
 */
export async function rejectPersonaActivityDelivery(
  value: unknown,
): Promise<PersonaMailboxItem> {
  const input = RejectPersonaActivityDeliveryInputSchema.parse(value) as
    RejectPersonaActivityDeliveryInput;
  return withPersonaRuntimeLock(input.personaId, async (lock) => {
    await requireActiveRunnableLease(lock, input);
    const item = await getPersonaMailboxItem(input.mailboxItemId);
    if (!item) {
      throw new PersonaRuntimeNotFoundError('PersonaMailboxItem', input.mailboxItemId);
    }
    if (
      item.personaId !== input.personaId
      || item.status !== 'coalesced'
      || item.targetActivityId !== input.activityId
      || (item.routingDecision !== 'steer' && item.routingDecision !== 'coalesce')
      || item.deliveryStatus !== 'pending'
    ) {
      throw new PersonaLeaseLostError(
        input.personaId,
        `Mailbox delivery ${JSON.stringify(item.id)} is not rejectable by the fenced Activity.`,
      );
    }
    const now = Math.max(Date.now(), item.updatedAt, item.completedAt ?? item.createdAt);
    return saveMailboxItem(lock, {
      ...item,
      status: 'rejected',
      routingDecision: 'queue',
      targetActivityId: undefined,
      deliveryStatus: undefined,
      deliveredAt: undefined,
      coalescedIntoId: undefined,
      updatedAt: now,
      completedAt: now,
    });
  });
}

/**
 * Attach trusted orchestration references to a live Activity. The strict input
 * schema and exact lease fence prevent arbitrary Activity mutation.
 */
export async function updatePersonaActivityReferences(
  value: unknown,
): Promise<PersonaActivity> {
  const input = UpdatePersonaActivityReferencesInputSchema.parse(value) as
    UpdatePersonaActivityReferencesInput;
  return withPersonaRuntimeLock(input.personaId, async (lock) => {
    const { activity } = await requireActiveRunnableLease(lock, input);
    const now = Math.max(Date.now(), activity.updatedAt, activity.startedAt ?? activity.createdAt);
    return saveActivity(lock, {
      ...activity,
      ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      ...(input.meetingId !== undefined ? { meetingId: input.meetingId } : {}),
      ...(input.resourceRefs !== undefined ? { resourceRefs: [...input.resourceRefs] } : {}),
      ...(input.outcomeRef !== undefined ? { outcomeRef: input.outcomeRef } : {}),
      updatedAt: now,
    });
  });
}

/** Persist the complete immutable Core/context bundle under the exact Activity fence. */
export async function persistPersonaActivitySnapshot(
  value: unknown,
): Promise<PersonaActivity> {
  const input = PersistPersonaActivitySnapshotInputSchema.parse(value) as
    PersistPersonaActivitySnapshotInput;
  return withPersonaRuntimeLock(input.personaId, async (lock) => {
    const { activity } = await requireActiveRunnableLease(lock, input);
    if (
      activity.behaviorRevisionId !== input.coreFlowRevisionId
      || input.instructionContext.personaId !== activity.personaId
      || input.instructionContext.activityId !== activity.id
      || input.instructionContext.behaviorRevisionId !== activity.behaviorRevisionId
      || input.instructionContext.rootFlowId !== input.coreFlowId
      || input.instructionContext.schemaVersion !== input.instructionContextSchemaVersion
      || hashPersonaInstructionContext(input.instructionContext) !== input.instructionContextDigest
    ) {
      throw new PersonaRuntimeCorruptionError(
        input.personaId,
        'Persona Activity Core snapshot does not match its immutable revision and context.',
      );
    }

    const requested = {
      coreFlowId: input.coreFlowId,
      coreFlowRevisionId: input.coreFlowRevisionId,
      coreAppRefs: input.coreAppRefs,
      instructionContext: input.instructionContext,
      instructionContextDigest: input.instructionContextDigest,
      instructionContextSchemaVersion: input.instructionContextSchemaVersion,
      entryPointPayloadRef: input.entryPointPayloadRef ?? null,
    };
    if (activity.instructionContext) {
      const existing = {
        coreFlowId: activity.coreFlowId,
        coreFlowRevisionId: activity.coreFlowRevisionId,
        coreAppRefs: activity.coreAppRefs ?? [],
        instructionContext: activity.instructionContext,
        instructionContextDigest: activity.instructionContextDigest,
        instructionContextSchemaVersion: activity.instructionContextSchemaVersion,
        entryPointPayloadRef: activity.entryPointPayloadRef ?? null,
      };
      if (canonicalJson(existing) !== canonicalJson(requested)) {
        throw new PersonaRuntimeCorruptionError(
          input.personaId,
          'Persona Activity Core snapshot is immutable and cannot be replaced.',
        );
      }
      return activity;
    }

    const now = Math.max(Date.now(), activity.updatedAt, activity.startedAt ?? activity.createdAt);
    return saveActivity(lock, {
      ...activity,
      coreFlowId: input.coreFlowId,
      coreFlowRevisionId: input.coreFlowRevisionId,
      coreAppRefs: [...input.coreAppRefs],
      instructionContext: structuredClone(input.instructionContext),
      instructionContextDigest: input.instructionContextDigest,
      instructionContextSchemaVersion: input.instructionContextSchemaVersion,
      ...(input.entryPointPayloadRef
        ? { entryPointPayloadRef: input.entryPointPayloadRef }
        : {}),
      updatedAt: now,
    });
  });
}

export async function renewPersonaActivityLease(value: unknown): Promise<PersonaLease> {
  const input = RenewPersonaActivityLeaseInputSchema.parse(value) as RenewPersonaActivityLeaseInput;
  const renewed = await withPersonaRuntimeLock(input.personaId, async (lock) => {
    const persona = await requireReadyPersona(input.personaId);
    const lease = await requireCurrentLease(lock, persona.id, input);
    if (lease.status !== 'active' || lease.expiresAt <= Date.now()) {
      if (lease.status === 'active') {
        await expireActiveLease(lock, persona, lease, await listPersonaMailboxItems(persona.id));
      }
      throw new PersonaLeaseLostError(
        persona.id,
        `Persona lease ${JSON.stringify(lease.id)} expired before renewal.`,
      );
    }
    await requireRunnableActivityForLease(lock, persona, lease);

    const renewedAt = Math.max(Date.now(), lease.renewedAt);
    return saveLeaseHead(lock, {
      ...lease,
      renewedAt,
      expiresAt: renewedAt + input.ttlMs,
    });
  });
  await observeRuntime(input.personaId, {
    eventId: `lease:${renewed.activityId}:renewed:${renewed.fencingToken}:${renewed.renewedAt}`,
    type: 'lease:renewed',
    activityId: renewed.activityId,
    expiresAt: renewed.expiresAt,
  });
  return renewed;
}

async function requireDurableInterruptionRequest(
  persona: Persona,
  activity: PersonaActivity,
): Promise<PersonaMailboxItem> {
  if (
    activity.interruptionRequestedAt === undefined
    || !activity.interruptionRequestedByMailboxItemId
  ) {
    throw new PersonaRuntimeUnavailableError(
      persona.id,
      `Persona Activity ${JSON.stringify(activity.id)} has no pending interruption request.`,
    );
  }
  const item = await getPersonaMailboxItem(activity.interruptionRequestedByMailboxItemId);
  if (
    !item
    || item.personaId !== persona.id
    || item.status !== 'queued'
    || item.routingDecision !== 'interrupt'
    || item.interruptedActivityId !== activity.id
  ) {
    throw new PersonaRuntimeCorruptionError(
      persona.id,
      `Persona Activity ${JSON.stringify(activity.id)} has an invalid interruption request.`,
    );
  }
  return item;
}

async function releasePersonaActivityLeaseWithinLock(
  lock: PersonaRuntimeLock,
  persona: Persona,
  lease: PersonaLease,
  requireInterruption: boolean,
): Promise<PersonaLease> {
  const activity = await getPersonaActivity(lease.activityId);
  if (!activity || activity.personaId !== persona.id) {
    throw new PersonaRuntimeCorruptionError(
      persona.id,
      `Persona lease ${JSON.stringify(lease.id)} references a missing or foreign Activity.`,
    );
  }
  if (requireInterruption && !isTerminalActivity(activity)) {
    await requireDurableInterruptionRequest(persona, activity);
  }
  if (lease.status === 'released') return lease;
  if (lease.status !== 'active' || lease.expiresAt <= Date.now()) {
    if (lease.status === 'active') {
      await expireActiveLease(lock, persona, lease, await listPersonaMailboxItems(persona.id));
    }
    throw new PersonaLeaseLostError(
      persona.id,
      `Persona lease ${JSON.stringify(lease.id)} cannot be released after expiry.`,
    );
  }

  const now = Math.max(Date.now(), lease.renewedAt, activity.updatedAt);
  if (isTerminalActivity(activity)) {
    await reconcileTerminalLease(
      lock,
      persona,
      lease,
      activity,
      await listPersonaMailboxItems(persona.id),
    );
    return (await getPersonaLease(persona.id))!;
  }
  if (activity.status === 'waiting') {
    await reconcileWaitingLease(
      lock,
      persona,
      lease,
      activity,
      await listPersonaMailboxItems(persona.id),
    );
    return (await getPersonaLease(persona.id))!;
  }
  if (activity.status !== 'running' || activity.leaseId !== lease.id) {
    throw new PersonaLeaseLostError(
      persona.id,
      `Persona Activity ${JSON.stringify(activity.id)} is not running under lease `
      + `${JSON.stringify(lease.id)}.`,
    );
  }

  await saveActivity(lock, {
    ...activity,
    status: 'waiting',
    startedAt: activity.startedAt ?? lease.acquiredAt,
    updatedAt: now,
  });
  await projectPersonaLifecycle(lock, persona.id, 'waiting', now);
  return saveLeaseHead(lock, {
    ...lease,
    status: 'released',
    releasedAt: now,
  });
}

/**
 * Gracefully yield active work. The Activity becomes waiting and can later be
 * reacquired with a strictly higher token; raw lease mutation stays internal.
 */
export async function releasePersonaActivityLease(value: unknown): Promise<PersonaLease> {
  const fence = LeaseFenceSchema.parse(value) as PersonaLeaseFence;
  const released = await withPersonaRuntimeLock(fence.personaId, async (lock) => {
    const persona = await requireReadyPersona(fence.personaId);
    const lease = await requireCurrentLease(lock, persona.id, fence);
    return releasePersonaActivityLeaseWithinLock(lock, persona, lease, false);
  });
  await observeRuntime(fence.personaId, {
    eventId: `activity:${fence.activityId}:yielded:${fence.fencingToken}`,
    type: 'activity:yielded',
    activityId: fence.activityId,
  });
  return released;
}

/** Cooperatively yield only after a durable urgent interruption was requested. */
export async function yieldPersonaActivityForInterruption(
  value: unknown,
): Promise<PersonaLease> {
  const fence = LeaseFenceSchema.parse(value) as PersonaLeaseFence;
  const released = await withPersonaRuntimeLock(
    fence.personaId,
    (lock) => yieldPersonaActivityForInterruptionWithinRuntimeLock(fence, lock),
  );
  await observeYieldedPersonaActivity(fence);
  return released;
}

/** Yield while a durable orchestrator already owns the Persona runtime lock. */
export async function yieldPersonaActivityForInterruptionWithinRuntimeLock(
  value: unknown,
  lock: PersonaRuntimeLock,
): Promise<PersonaLease> {
  const fence = LeaseFenceSchema.parse(value) as PersonaLeaseFence;
  await lock.assertOwned();
  const persona = await requireReadyPersona(fence.personaId);
  const lease = await requireCurrentLease(lock, persona.id, fence);
  return releasePersonaActivityLeaseWithinLock(lock, persona, lease, true);
}

/** Emit the idempotent yield observation after a caller-held lock is released. */
export async function observeYieldedPersonaActivity(value: unknown): Promise<void> {
  const fence = LeaseFenceSchema.parse(value) as PersonaLeaseFence;
  await observeRuntime(fence.personaId, {
    eventId: `activity:${fence.activityId}:yielded:${fence.fencingToken}`,
    type: 'activity:yielded',
    activityId: fence.activityId,
  });
}

function completionMatches(
  activity: PersonaActivity,
  input: CompletePersonaActivityInput,
): boolean {
  return activity.status === (input.status ?? 'completed')
    && (input.outcomeRef === undefined || activity.outcomeRef === input.outcomeRef)
    && (activity.error ?? undefined) === input.error;
}

async function requeuePendingRelatedDeliveries(
  lock: PersonaRuntimeLock,
  activity: PersonaActivity,
  items: PersonaMailboxItem[],
  now: number,
  reasonCode: 'target_terminal' | 'admin_recovery' = 'target_terminal',
): Promise<PersonaMailboxItem[]> {
  const pending = items.filter((item) =>
    item.status === 'coalesced'
    && item.targetActivityId === activity.id
    && item.deliveryStatus === 'pending'
    && (item.routingDecision === 'steer' || item.routingDecision === 'coalesce'));
  const requeued: PersonaMailboxItem[] = [];
  for (const item of pending) {
    const queued = await saveMailboxItem(lock, {
      ...item,
      status: 'queued',
      routingDecision: 'queue',
      targetActivityId: undefined,
      deliveryStatus: undefined,
      deliveredAt: undefined,
      coalescedIntoId: undefined,
      claimedActivityId: undefined,
      completedAt: undefined,
      updatedAt: Math.max(now, item.updatedAt + 1),
    });
    requeued.push(queued);
    await observeRuntime(activity.personaId, {
      eventId: `mailbox:${queued.id}:routed:queued:${reasonCode}`,
      type: 'mailbox:routed',
      mailboxItemId: queued.id,
      decision: 'queued',
      reasonCode,
    });
  }
  return requeued;
}

/** Complete an Activity and release its authoritative lease last. */
/**
 * Complete an Activity while the caller already owns the Persona runtime lock.
 * Durable orchestrators use this to serialize their terminal record with the
 * authoritative Activity outcome without trying to acquire the same lock twice.
 */
export async function completePersonaActivityWithinRuntimeLock(
  value: unknown,
  lock: PersonaRuntimeLock,
): Promise<CompletedPersonaActivity> {
  const input = CompletePersonaActivityInputSchema.parse(value) as CompletePersonaActivityInput;
  await lock.assertOwned();
    const persona = await requireReadyPersona(input.personaId);
    const lease = await requireCurrentLease(lock, persona.id, input);
    const activity = await getPersonaActivity(input.activityId);
    if (!activity || activity.personaId !== persona.id) {
      throw new PersonaRuntimeNotFoundError('PersonaActivity', input.activityId);
    }
    const items = await listPersonaMailboxItems(persona.id);
    const item = findMailboxForActivity(persona.id, items, activity.id);
    if (!item) {
      throw new PersonaRuntimeCorruptionError(
        persona.id,
        `Activity ${JSON.stringify(activity.id)} has no mailbox item.`,
      );
    }

    if (isTerminalActivity(activity)) {
      if (!completionMatches(activity, input)) {
        throw new PersonaLeaseLostError(
          persona.id,
          `Activity ${JSON.stringify(activity.id)} already has a different terminal outcome.`,
        );
      }
      await reconcileTerminalLease(lock, persona, lease, activity, items);
      return {
        activity,
        mailboxItem: (await getPersonaMailboxItem(item.id))!,
        lease: (await getPersonaLease(persona.id))!,
      };
    }

    if (lease.status !== 'active' || lease.expiresAt <= Date.now()) {
      if (lease.status === 'active') await expireActiveLease(lock, persona, lease, items);
      throw new PersonaLeaseLostError(
        persona.id,
        `Persona lease ${JSON.stringify(lease.id)} expired before completion.`,
      );
    }
    if (activity.status !== 'running' || activity.leaseId !== lease.id) {
      throw new PersonaLeaseLostError(
        persona.id,
        `Persona Activity ${JSON.stringify(activity.id)} is not running under lease `
        + `${JSON.stringify(lease.id)}.`,
      );
    }

    const now = Math.max(Date.now(), activity.updatedAt, lease.renewedAt);
    const status = input.status ?? 'completed';
    // A steer/coalesce can be admitted after the worker's last delivery poll
    // but before this terminal transition acquires the Persona lock. Atomically
    // turn such late input back into independent queued work so it is neither
    // falsely acknowledged nor orphaned against a terminal Activity.
    await requeuePendingRelatedDeliveries(lock, activity, items, now);
    const completed = await saveActivity(lock, {
      ...activity,
      status,
      ...(input.outcomeRef !== undefined ? { outcomeRef: input.outcomeRef } : {}),
      ...(input.error !== undefined ? { error: input.error } : { error: undefined }),
      updatedAt: now,
      completedAt: now,
    });
    const completedItem = await terminalMailboxProjection(lock, item, completed, now);
    await projectPersonaLifecycle(lock, persona.id, 'idle', now);
    const released = await saveLeaseHead(lock, {
      ...lease,
      status: 'released',
      releasedAt: now,
    });
    return { activity: completed, mailboxItem: completedItem, lease: released };
}

/** Emit idempotent runtime observability after a caller-held lock is released. */
export async function observeCompletedPersonaActivity(
  result: CompletedPersonaActivity,
): Promise<void> {
  const personaId = result.activity.personaId;
  if (result.activity.status === 'error') {
    await observeRuntime(personaId, {
      eventId: `activity:${result.activity.id}:errored:${result.activity.completedAt}`,
      type: 'activity:errored',
      activityId: result.activity.id,
      errorCode: 'activity_failed',
    });
  } else if (result.activity.status === 'cancelled') {
    await observeRuntime(personaId, {
      eventId: `activity:${result.activity.id}:cancelled`,
      type: 'activity:cancelled',
      activityId: result.activity.id,
    });
  } else {
    await observeRuntime(personaId, {
      eventId: `activity:${result.activity.id}:completed:${result.activity.status}`,
      type: 'activity:completed',
      activityId: result.activity.id,
    });
  }
}

export async function completePersonaActivity(
  value: unknown,
): Promise<CompletedPersonaActivity> {
  const input = CompletePersonaActivityInputSchema.parse(value) as CompletePersonaActivityInput;
  const result = await withPersonaRuntimeLock(
    input.personaId,
    (lock) => completePersonaActivityWithinRuntimeLock(input, lock),
  );
  await observeCompletedPersonaActivity(result);
  return result;
}

function runtimeRecoveryEvents(
  result: RecoverPersonaRuntimeResult,
): RawPersonaRuntimeEvent[] {
  const events: RawPersonaRuntimeEvent[] = [];
  if (result.lifecycleState !== 'error') {
    events.push({
      eventId: `lifecycle:error:${result.lifecycleState}:admin_recovery:${result.runtimeUpdatedAt}`,
      type: 'lifecycle:transition',
      from: 'error',
      to: result.lifecycleState,
      reasonCode: 'admin_recovery',
    });
  }
  for (const activityId of result.closedActivityIds) {
    events.push({
      eventId: `activity:${activityId}:errored:admin_recovery`,
      type: 'activity:errored',
      activityId,
      errorCode: 'admin_recovery',
    });
  }
  for (const mailboxItemId of result.rejectedMailboxItemIds) {
    events.push({
      eventId: `mailbox:${mailboxItemId}:routed:rejected:admin_recovery`,
      type: 'mailbox:routed',
      mailboxItemId,
      decision: 'rejected',
      reasonCode: 'admin_recovery',
    });
  }
  for (const mailboxItemId of result.requeuedMailboxItemIds) {
    events.push({
      eventId: `mailbox:${mailboxItemId}:routed:queued:admin_recovery`,
      type: 'mailbox:routed',
      mailboxItemId,
      decision: 'queued',
      reasonCode: 'admin_recovery',
    });
  }
  return events;
}

function runtimeRecoveryReceipt(
  persona: Persona,
  runtimeUpdatedAt: number,
): PersonaRuntimeRecoveryReceipt {
  const result = RecoverPersonaRuntimeResultSchema.parse({
    personaId: persona.id,
    changed: true,
    lifecycleState: 'error',
    runtimeUpdatedAt,
    closedActivityIds: [],
    rejectedMailboxItemIds: [],
    requeuedMailboxItemIds: [],
  }) as RecoverPersonaRuntimeResult;
  const workspaceId = getCurrentWorkspace();
  return PersonaRuntimeRecoveryReceiptSchema.parse({
    schemaVersion: PERSONA_RUNTIME_RECOVERY_RECEIPT_SCHEMA_VERSION,
    id: stableEnduringAgentId('recovery', {
      purpose: 'persona-runtime-recovery-receipt-v1',
      workspaceId,
      personaId: result.personaId,
      sourceRuntimeUpdatedAt: persona.updatedAt,
    }),
    workspaceId,
    personaId: result.personaId,
    phase: 'preparing',
    sourceRuntimeUpdatedAt: persona.updatedAt,
    result,
    events: [],
    createdAt: result.runtimeUpdatedAt,
    updatedAt: result.runtimeUpdatedAt,
  }) as PersonaRuntimeRecoveryReceipt;
}

async function addRuntimeRecoveryIntents(
  lock: PersonaRuntimeLock,
  receipt: PersonaRuntimeRecoveryReceipt,
  intents: Partial<Pick<
    RecoverPersonaRuntimeResult,
    'closedActivityIds' | 'rejectedMailboxItemIds' | 'requeuedMailboxItemIds'
  >>,
): Promise<PersonaRuntimeRecoveryReceipt> {
  if (receipt.phase !== 'preparing') {
    throw new PersonaRuntimeCorruptionError(
      receipt.personaId,
      'Cannot extend a committed runtime recovery receipt.',
    );
  }
  const result: RecoverPersonaRuntimeResult = {
    ...receipt.result,
    closedActivityIds: [...new Set([
      ...receipt.result.closedActivityIds,
      ...(intents.closedActivityIds ?? []),
    ])].sort(),
    rejectedMailboxItemIds: [...new Set([
      ...receipt.result.rejectedMailboxItemIds,
      ...(intents.rejectedMailboxItemIds ?? []),
    ])].sort(),
    requeuedMailboxItemIds: [...new Set([
      ...receipt.result.requeuedMailboxItemIds,
      ...(intents.requeuedMailboxItemIds ?? []),
    ])].sort(),
  };
  return saveRuntimeRecoveryReceipt(lock, {
    ...receipt,
    result,
    updatedAt: Math.max(receipt.updatedAt, result.runtimeUpdatedAt),
  });
}

async function commitRuntimeRecoveryReceipt(
  lock: PersonaRuntimeLock,
  receipt: PersonaRuntimeRecoveryReceipt,
  lifecycleState: Extract<Persona['lifecycleState'], 'idle' | 'waiting' | 'error'>,
): Promise<PersonaRuntimeRecoveryReceipt> {
  const result: RecoverPersonaRuntimeResult = {
    ...receipt.result,
    lifecycleState,
  };
  return saveRuntimeRecoveryReceipt(lock, {
    ...receipt,
    phase: 'committed',
    result,
    events: runtimeRecoveryEvents(result),
    updatedAt: Math.max(receipt.updatedAt, result.runtimeUpdatedAt),
  });
}

async function applyRuntimeRecoveryReceiptPlan(
  lock: PersonaRuntimeLock,
  receipt: PersonaRuntimeRecoveryReceipt,
): Promise<void> {
  await lock.assertOwned();
  if (receipt.phase !== 'committed') {
    throw new PersonaRuntimeCorruptionError(
      receipt.personaId,
      'A preparing runtime recovery receipt cannot be finalized or drained.',
    );
  }
  const { result } = receipt;
  for (const activityId of result.closedActivityIds) {
    const activity = await getPersonaActivity(activityId);
    if (!activity || activity.personaId !== result.personaId) {
      throw new PersonaRuntimeCorruptionError(
        result.personaId,
        `Recovery receipt references missing Activity ${JSON.stringify(activityId)}.`,
      );
    }
    if (!isTerminalActivity(activity)) {
      await saveActivity(lock, {
        ...activity,
        status: 'error',
        error: ADMINISTRATIVE_RECOVERY_ERROR,
        updatedAt: Math.max(result.runtimeUpdatedAt, activity.updatedAt + 1),
        completedAt: Math.max(
          result.runtimeUpdatedAt,
          activity.startedAt ?? activity.createdAt,
        ),
      });
    } else if (
      activity.status !== 'error'
      || activity.error !== ADMINISTRATIVE_RECOVERY_ERROR
    ) {
      throw new PersonaRuntimeCorruptionError(
        result.personaId,
        `Recovery receipt conflicts with terminal Activity ${JSON.stringify(activityId)}.`,
      );
    }
  }

  for (const mailboxItemId of result.rejectedMailboxItemIds) {
    const item = await getPersonaMailboxItem(mailboxItemId);
    if (!item || item.personaId !== result.personaId) {
      throw new PersonaRuntimeCorruptionError(
        result.personaId,
        `Recovery receipt references missing mailbox item ${JSON.stringify(mailboxItemId)}.`,
      );
    }
    if (item.status === 'claimed') {
      const now = Math.max(result.runtimeUpdatedAt, item.updatedAt + 1, item.createdAt);
      await saveMailboxItem(lock, {
        ...item,
        status: 'rejected',
        claimedActivityId: undefined,
        updatedAt: now,
        completedAt: now,
      });
    } else if (item.status !== 'rejected') {
      throw new PersonaRuntimeCorruptionError(
        result.personaId,
        `Recovery receipt conflicts with mailbox item ${JSON.stringify(mailboxItemId)}.`,
      );
    }
  }

  for (const mailboxItemId of result.requeuedMailboxItemIds) {
    const item = await getPersonaMailboxItem(mailboxItemId);
    if (!item || item.personaId !== result.personaId) {
      throw new PersonaRuntimeCorruptionError(
        result.personaId,
        `Recovery receipt references missing mailbox item ${JSON.stringify(mailboxItemId)}.`,
      );
    }
    if (
      item.status === 'coalesced'
      && item.deliveryStatus === 'pending'
      && (item.routingDecision === 'steer' || item.routingDecision === 'coalesce')
    ) {
      await saveMailboxItem(lock, {
        ...item,
        status: 'queued',
        routingDecision: 'queue',
        targetActivityId: undefined,
        deliveryStatus: undefined,
        deliveredAt: undefined,
        coalescedIntoId: undefined,
        claimedActivityId: undefined,
        completedAt: undefined,
        updatedAt: Math.max(result.runtimeUpdatedAt, item.updatedAt + 1),
      });
    } else if (item.status !== 'queued') {
      throw new PersonaRuntimeCorruptionError(
        result.personaId,
        `Recovery receipt conflicts with mailbox item ${JSON.stringify(mailboxItemId)}.`,
      );
    }
  }

  const persona = await getPersona(result.personaId);
  if (!persona) throw new PersonaRuntimeNotFoundError('Persona', result.personaId);
  if (persona.lifecycleState === 'disabled' || persona.lifecycleState === 'sleeping') {
    throw new PersonaRuntimeRecoveryConflictError(
      persona.id,
      `Persona ${JSON.stringify(persona.id)} cannot finalize a runtime recovery receipt.`,
    );
  }
  if (
    persona.lifecycleState !== 'error'
    && persona.lifecycleState !== result.lifecycleState
  ) {
    throw new PersonaRuntimeRecoveryConflictError(
      persona.id,
      `Persona ${JSON.stringify(persona.id)} changed state before recovery finalization.`,
    );
  }
  if (
    persona.lifecycleState !== result.lifecycleState
    || persona.updatedAt < result.runtimeUpdatedAt
  ) {
    await updatePersonaWithinRuntimeLock({
      ...persona,
      lifecycleState: result.lifecycleState,
      updatedAt: Math.max(result.runtimeUpdatedAt, persona.updatedAt),
    }, lock);
  }
}

async function drainRuntimeRecoveryReceipt(
  personaId: string,
  receiptId: string,
): Promise<void> {
  await withPersonaRuntimeLock(personaId, async (lock) => {
    const receipt = (await listPersonaRuntimeRecoveryReceipts(personaId))
      .find((candidate) => candidate.id === receiptId);
    if (!receipt) return;
    await applyRuntimeRecoveryReceiptPlan(lock, receipt);
    for (const event of receipt.events) {
      // Unlike ordinary best-effort observations, an explicit recovery audit
      // stays in the outbox and rejects until every idempotent event is durable.
      await appendPersonaRuntimeEvent(personaId, event);
    }
    await lock.assertOwned();
    await deletePersonaRuntimeRecoveryReceipt(receipt.id);
  });
}

/**
 * Explicitly clear a corruption error gate without replaying uncertain work.
 *
 * This is deliberately administrative and confirmation-gated. A live lease is
 * never pre-empted. Any non-terminal Activity whose safe waiting/queued
 * provenance cannot be proven is closed as error, while undelivered related
 * input is returned to the ordinary mailbox queue.
 */
export async function recoverPersonaRuntime(
  value: unknown,
): Promise<RecoverPersonaRuntimeResult> {
  const input = RecoverPersonaRuntimeInputSchema.parse(value) as RecoverPersonaRuntimeInput;
  assertSafeCollectionId(input.personaId);

  const execution = await withPersonaRuntimeLock(input.personaId, async (lock) => {
    const persona = await requireReadyPersona(input.personaId);
    if (persona.lifecycleState === 'disabled' || persona.lifecycleState === 'sleeping') {
      throw new PersonaRuntimeRecoveryConflictError(
        persona.id,
        `Persona ${JSON.stringify(persona.id)} is ${persona.lifecycleState}, not error-gated.`,
      );
    }
    const pendingReceipts = await listPersonaRuntimeRecoveryReceipts(persona.id);
    if (pendingReceipts.length > 1) {
      throw new PersonaRuntimeCorruptionError(
        persona.id,
        'Persona has multiple pending runtime recovery receipts.',
      );
    }
    let receipt = pendingReceipts[0];
    if (receipt?.phase === 'committed') {
      const pendingReceipt = receipt;
      await applyRuntimeRecoveryReceiptPlan(lock, pendingReceipt);
      return {
        result: { ...pendingReceipt.result, changed: false },
        receiptId: pendingReceipt.id,
      };
    }
    if (!receipt && persona.lifecycleState !== 'error') {
      return {
        result: {
          personaId: persona.id,
          changed: false,
          lifecycleState: persona.lifecycleState,
          runtimeUpdatedAt: persona.updatedAt,
          closedActivityIds: [],
          rejectedMailboxItemIds: [],
          requeuedMailboxItemIds: [],
        } satisfies RecoverPersonaRuntimeResult,
        receiptId: undefined,
      };
    }

    let items = await listPersonaMailboxItems(persona.id);
    let activities = await listPersonaActivities(persona.id);
    const mismatchedClaims = items.filter((item) => (
      item.status === 'claimed'
      && item.claimedActivityId !== activityIdForMailbox(item.id)
    ));
    if (!receipt) {
      const existingHead = await getPersonaLease(persona.id);
      if (
        mismatchedClaims.length === 0
        && existingHead?.status === 'active'
        && existingHead.expiresAt > Date.now()
      ) {
        throw new PersonaRuntimeRecoveryConflictError(
          persona.id,
          `Persona ${JSON.stringify(persona.id)} still has a live Activity lease.`,
        );
      }
      const runtimeUpdatedAt = Math.max(
        Date.now(),
        persona.updatedAt + 1,
        (existingHead?.renewedAt ?? 0) + 1,
        ...items.map((item) => item.updatedAt + 1),
        ...activities.map((activity) => activity.updatedAt + 1),
      );
      receipt = await saveRuntimeRecoveryReceipt(
        lock,
        runtimeRecoveryReceipt(persona, runtimeUpdatedAt),
      );
    } else if (
      receipt.sourceRuntimeUpdatedAt > persona.updatedAt
      || persona.updatedAt > receipt.result.runtimeUpdatedAt
    ) {
      throw new PersonaRuntimeRecoveryConflictError(
        persona.id,
        'Persona changed beyond its prepared runtime recovery receipt.',
      );
    }
    const now = receipt.result.runtimeUpdatedAt;
    if (mismatchedClaims.length > 0) {
      receipt = await addRuntimeRecoveryIntents(
        lock,
        receipt,
        { rejectedMailboxItemIds: mismatchedClaims.map((item) => item.id) },
      );
      receipt = await commitRuntimeRecoveryReceipt(
        lock,
        receipt,
        'error',
      );
      await applyRuntimeRecoveryReceiptPlan(lock, receipt);
      return { result: receipt.result, receiptId: receipt.id };
    }
    let head = await reconcilePersonaLeaseHead(lock, persona.id);
    if (head?.status === 'active') {
      if (head.expiresAt > Date.now()) {
        throw new PersonaRuntimeRecoveryConflictError(
          persona.id,
          `Persona ${JSON.stringify(persona.id)} still has a live Activity lease.`,
        );
      }
      const activeActivityId = head.activityId;
      const expiringActivity = activities.find((activity) => activity.id === activeActivityId);
      const expiringMailboxItem = expiringActivity
        ? items.find((item) => activityIdForMailbox(item.id) === expiringActivity.id)
        : undefined;
      const willRequeueRelatedInputs = expiringActivity !== undefined
        && (
          isTerminalActivity(expiringActivity)
          || (
            expiringActivity.status !== 'waiting'
            && expiringMailboxItem?.status !== 'queued'
          )
        );
      if (willRequeueRelatedInputs && expiringActivity) {
        const pendingRelatedIds = items
          .filter((item) => item.status === 'coalesced'
            && item.targetActivityId === expiringActivity.id
            && item.deliveryStatus === 'pending'
            && (item.routingDecision === 'steer' || item.routingDecision === 'coalesce'))
          .map((item) => item.id);
        if (pendingRelatedIds.length > 0) {
          receipt = await addRuntimeRecoveryIntents(
            lock,
            receipt,
            { requeuedMailboxItemIds: pendingRelatedIds },
          );
        }
      }
      try {
        await expireActiveLease(lock, persona, head, items, now);
      } catch (error) {
        // Missing Activity/mailbox corruption deliberately throws after it has
        // fenced the expired acquisition and projected the error gate. The
        // explicit repair below can now close the remaining orphan safely.
        if (!(error instanceof PersonaRuntimeCorruptionError)) throw error;
      }
      items = await listPersonaMailboxItems(persona.id);
      activities = await listPersonaActivities(persona.id);
      head = await reconcilePersonaLeaseHead(lock, persona.id);
    }
    if (head?.status === 'active') {
      throw new PersonaRuntimeRecoveryConflictError(
        persona.id,
        `Persona ${JSON.stringify(persona.id)} still has an active lease after reconciliation.`,
      );
    }

    const preservedWaitingIds = new Set<string>();
    for (const activity of activities) {
      if (activity.status !== 'waiting' || !activity.leaseId) continue;
      const item = findMailboxForActivity(persona.id, items, activity.id);
      const prior = await getPersonaLeaseRecord(activity.leaseId);
      if (
        item?.status === 'claimed'
        && item.claimedActivityId === activity.id
        && prior?.workspaceId === getCurrentWorkspace()
        && prior.personaId === persona.id
        && prior.activityId === activity.id
        && prior.status === 'released'
        && head !== null
        && prior.fencingToken <= head.fencingToken
      ) {
        preservedWaitingIds.add(activity.id);
      }
    }

    const closedActivityIds: string[] = [...receipt.result.closedActivityIds];
    const requeuedByClosedActivityIds = new Set(receipt.result.requeuedMailboxItemIds);
    for (const activity of activities) {
      if (isTerminalActivity(activity) || preservedWaitingIds.has(activity.id)) continue;
      const item = findMailboxForActivity(persona.id, items, activity.id);
      if (activity.status === 'queued' && item?.status === 'queued') continue;
      if (activity.status === 'running' && item?.status === 'queued') {
        // The durable claim marker was never published, so no worker could
        // have received this acquisition. Preserve the provably unstarted work.
        await saveActivity(lock, {
          ...activity,
          status: 'queued',
          leaseId: undefined,
          startedAt: undefined,
          completedAt: undefined,
          error: undefined,
          updatedAt: Math.max(now, activity.updatedAt + 1),
        });
        continue;
      }

      const pendingRelatedIds = items
        .filter((item) => item.status === 'coalesced'
          && item.targetActivityId === activity.id
          && item.deliveryStatus === 'pending'
          && (item.routingDecision === 'steer' || item.routingDecision === 'coalesce'))
        .map((item) => item.id);
      if (pendingRelatedIds.length > 0) {
        receipt = await addRuntimeRecoveryIntents(
          lock,
          receipt,
          { requeuedMailboxItemIds: pendingRelatedIds },
        );
      }
      for (const requeued of await requeuePendingRelatedDeliveries(
        lock,
        activity,
        items,
        now,
        'admin_recovery',
      )) {
        requeuedByClosedActivityIds.add(requeued.id);
      }
      receipt = await addRuntimeRecoveryIntents(
        lock,
        receipt,
        { closedActivityIds: [activity.id] },
      );
      await saveActivity(lock, {
        ...activity,
        status: 'error',
        error: ADMINISTRATIVE_RECOVERY_ERROR,
        updatedAt: Math.max(now, activity.updatedAt + 1),
        completedAt: Math.max(now, activity.startedAt ?? activity.createdAt),
      });
      closedActivityIds.push(activity.id);
    }

    items = await listPersonaMailboxItems(persona.id);
    activities = await listPersonaActivities(persona.id);
    const activityById = new Map(activities.map((activity) => [activity.id, activity]));
    const rejectedMailboxItemIds: string[] = [...receipt.result.rejectedMailboxItemIds];
    const requeuedMailboxItemIds: string[] = [...new Set([
      ...receipt.result.requeuedMailboxItemIds,
      ...requeuedByClosedActivityIds,
    ])];
    for (const item of items) {
      if (
        item.status === 'coalesced'
        && item.deliveryStatus === 'pending'
        && item.targetActivityId
      ) {
        const target = activityById.get(item.targetActivityId);
        if (!target || isTerminalActivity(target)) {
          receipt = await addRuntimeRecoveryIntents(
            lock,
            receipt,
            { requeuedMailboxItemIds: [item.id] },
          );
          await saveMailboxItem(lock, {
            ...item,
            status: 'queued',
            routingDecision: 'queue',
            targetActivityId: undefined,
            deliveryStatus: undefined,
            deliveredAt: undefined,
            coalescedIntoId: undefined,
            claimedActivityId: undefined,
            completedAt: undefined,
            updatedAt: Math.max(now, item.updatedAt + 1),
          });
          requeuedMailboxItemIds.push(item.id);
        }
        continue;
      }
      if (item.status !== 'claimed') continue;
      const activityId = activityIdForMailbox(item.id);
      if (item.claimedActivityId !== activityId) {
        throw new PersonaRuntimeCorruptionError(
          persona.id,
          `Claimed mailbox item ${JSON.stringify(item.id)} changed its Activity owner during recovery.`,
        );
      }
      const activity = activityById.get(activityId);
      if (activity?.status === 'waiting' && preservedWaitingIds.has(activity.id)) continue;
      if (activity && isTerminalActivity(activity)) {
        if (activity.status !== 'completed') {
          receipt = await addRuntimeRecoveryIntents(
            lock,
            receipt,
            { rejectedMailboxItemIds: [item.id] },
          );
        }
        await terminalMailboxProjection(lock, item, activity, now);
        if (activity.status !== 'completed') rejectedMailboxItemIds.push(item.id);
      } else {
        receipt = await addRuntimeRecoveryIntents(
          lock,
          receipt,
          { rejectedMailboxItemIds: [item.id] },
        );
        await saveMailboxItem(lock, {
          ...item,
          status: 'rejected',
          claimedActivityId: undefined,
          updatedAt: Math.max(now, item.updatedAt + 1),
          completedAt: Math.max(now, item.createdAt),
        });
        rejectedMailboxItemIds.push(item.id);
      }
    }

    const targetLifecycle: Persona['lifecycleState'] = preservedWaitingIds.size > 0
      ? 'waiting'
      : 'idle';
    receipt = await addRuntimeRecoveryIntents(lock, receipt, {
      closedActivityIds,
      rejectedMailboxItemIds,
      requeuedMailboxItemIds,
    });
    // The receipt is committed before clearing the error gate. A crash after
    // either this write or the lifecycle update resumes the exact plan, while
    // event ids make a crash during outbox draining harmless.
    receipt = await commitRuntimeRecoveryReceipt(
      lock,
      receipt,
      targetLifecycle,
    );
    await applyRuntimeRecoveryReceiptPlan(lock, receipt);
    return { result: receipt.result, receiptId: receipt.id };
  });

  if (execution.receiptId) {
    await drainRuntimeRecoveryReceipt(execution.result.personaId, execution.receiptId);
  }
  return execution.result;
}

/**
 * Close every live runtime projection while the caller holds the Persona lock.
 * This is the administrative boundary used by privacy deletion: disabling is
 * written first so a crash cannot admit new work, and the fencing head is
 * expired last so an in-flight worker immediately loses authority.
 */
export async function quiescePersonaForDeletionWithinRuntimeLock(
  personaId: string,
  lock: PersonaRuntimeLock,
): Promise<void> {
  assertSafeCollectionId(personaId);
  await lock.assertOwned();
  let persona = await getPersona(personaId);
  if (!persona) throw new PersonaRuntimeNotFoundError('Persona', personaId);
  const disabledAt = Math.max(Date.now(), persona.updatedAt);
  if (persona.lifecycleState !== 'disabled') {
    persona = await updatePersonaWithinRuntimeLock({
      ...persona,
      lifecycleState: 'disabled',
      updatedAt: disabledAt,
    }, lock);
  }

  const [activities, items] = await Promise.all([
    listPersonaActivities(personaId),
    listPersonaMailboxItems(personaId),
  ]);
  const head = await reconcilePersonaLeaseHead(lock, personaId);
  const now = Math.max(
    Date.now(),
    persona.updatedAt,
    ...activities.map((activity) => activity.updatedAt),
    ...items.map((item) => item.updatedAt),
    head?.renewedAt ?? 0,
  );

  for (const activity of activities) {
    if (isTerminalActivity(activity)) continue;
    await saveActivity(lock, {
      ...activity,
      status: 'cancelled',
      updatedAt: now,
      completedAt: Math.max(now, activity.startedAt ?? activity.createdAt),
      error: undefined,
    });
  }

  for (const item of items) {
    if (
      item.status === 'coalesced'
      || item.status === 'completed'
      || item.status === 'rejected'
    ) continue;
    await saveMailboxItem(lock, {
      ...item,
      status: 'rejected',
      coalescedIntoId: undefined,
      updatedAt: now,
      completedAt: Math.max(now, item.createdAt),
    });
  }

  if (head?.status === 'active') {
    await saveLeaseHead(lock, {
      ...head,
      status: 'expired',
      releasedAt: undefined,
    });
  }
}

/** Coherent inspection snapshot across the runtime's multi-file projection. */
export async function listPersonaRuntimeBundle(
  personaId: string,
): Promise<import('./store').PersonaBundle | null> {
  assertSafeCollectionId(personaId);
  return withPersonaRuntimeLock(personaId, async (lock) => {
    const persona = await getPersona(personaId);
    if (!persona) return null;
    const items = await listPersonaMailboxItems(personaId);
    const head = await reconcilePersonaLeaseHead(lock, personaId);
    if (head?.status === 'active') {
      const activity = await getPersonaActivity(head.activityId);
      if (!activity || activity.personaId !== persona.id) {
        await expireActiveLease(lock, persona, head, items);
      } else if (isTerminalActivity(activity)) {
        await reconcileTerminalLease(lock, persona, head, activity, items);
      } else if (activity.status === 'waiting') {
        await reconcileWaitingLease(lock, persona, head, activity, items);
      } else {
        const item = findMailboxForActivity(persona.id, items, activity.id);
        if (!item) {
          await expireActiveLease(lock, persona, head, items);
        } else if (item.status === 'queued' || head.expiresAt <= Date.now()) {
          await expireActiveLease(lock, persona, head, items);
        } else {
          // A live claimed acquisition is authoritative. Repair lagging
          // Activity/mailbox/lifecycle projections without exposing its opaque
          // fence through this read API.
          await repairActiveClaim(lock, persona, head, item, activity);
        }
      }
    } else if (head?.status === 'released') {
      const activity = await getPersonaActivity(head.activityId);
      if (activity && activity.personaId === persona.id && isTerminalActivity(activity)) {
        await reconcileTerminalLease(lock, persona, head, activity, items);
      }
    }
    return listPersonaBundle(personaId);
  });
}
