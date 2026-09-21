import { createHash } from 'crypto';
import { z } from 'zod';

import { EnduringAgentIdSchema, FlowSnapshotSchema, type BehaviorRevision } from '@/shared/types/enduringAgent';
import type { Flow } from '@/shared/types/flow';
import type { FlowExecutionAuthority } from '@/backend/execution/flow/types';
import {
  assertSafeCollectionId,
  listCollectionItemEntriesStrict,
  loadCollectionItem,
  saveCollectionItem,
} from '@/utils/storage/backend';
import { getCurrentWorkspace } from '@/utils/workspace';

import { canonicalJson } from './behaviorRevisions';
import { withPersonaDomainMutation } from './domainMutation';
import { withIssuedPersonaRuntimeLockOperation, type PersonaRuntimeLock } from './runtimeLock';
import { getBehaviorRevision, getPersonaActivity, getPersonaDeletionTombstone } from './store';

export const BEHAVIOR_CALL_PINS_COLLECTION = 'persona-behavior-call-pins';

export type BehaviorCallPinStatus = 'running' | 'completed' | 'error';

export interface BehaviorCallPin {
  schemaVersion: 1;
  id: string;
  workspaceId: string;
  personaId: string;
  activityId: string;
  parentBehaviorRevisionId: string;
  behaviorId: string;
  behaviorRevisionId: string;
  slotKey: string;
  flowId: string;
  flowVersionId?: string;
  contentHash: string;
  flowSnapshot?: Flow;
  status: BehaviorCallPinStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  outputText?: string;
  error?: string;
  compactedAt?: number;
  payloadDigest?: string;
}

/** Strict archive preflight; ordinary reads retain their compatibility behavior. */
export const BehaviorCallPinSchema: z.ZodType<BehaviorCallPin> = z.object({
  schemaVersion: z.literal(1),
  id: EnduringAgentIdSchema,
  workspaceId: z.string().min(1).max(256),
  personaId: EnduringAgentIdSchema,
  activityId: EnduringAgentIdSchema,
  parentBehaviorRevisionId: EnduringAgentIdSchema,
  behaviorId: EnduringAgentIdSchema,
  behaviorRevisionId: EnduringAgentIdSchema,
  slotKey: z.string().min(1).max(128),
  flowId: z.string().min(1).max(512),
  flowVersionId: z.string().min(1).max(512).optional(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  flowSnapshot: FlowSnapshotSchema.optional(),
  status: z.enum(['running', 'completed', 'error']),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  completedAt: z.number().int().nonnegative().optional(),
  outputText: z.string().optional(),
  error: z.string().optional(),
  compactedAt: z.number().int().nonnegative().optional(),
  payloadDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict().refine((pin) => pin.updatedAt >= pin.createdAt
  && (pin.completedAt === undefined || pin.completedAt >= pin.createdAt)
  && (pin.compactedAt === undefined || pin.compactedAt >= pin.updatedAt), 'Invalid Behavior call timestamps.')
  .refine((pin) => pin.compactedAt === undefined
    ? pin.flowSnapshot !== undefined && pin.payloadDigest === undefined
    : pin.flowSnapshot === undefined && pin.outputText === undefined && pin.error === undefined
      && pin.payloadDigest !== undefined, 'Invalid Behavior call compaction state.');

function pinIdentity(input: {
  workspaceId: string;
  personaId: string;
  activityId: string;
  parentBehaviorRevisionId: string;
  behaviorId: string;
  callKey: string;
}): string {
  return createHash('sha256')
    .update(canonicalJson(input))
    .digest('base64url')
    .slice(0, 43);
}

export function behaviorCallPinId(input: {
  workspaceId?: string;
  personaId: string;
  activityId: string;
  parentBehaviorRevisionId: string;
  behaviorId: string;
  callKey: string;
}): string {
  return `bcp_${pinIdentity({
    workspaceId: input.workspaceId ?? getCurrentWorkspace(),
    personaId: input.personaId,
    activityId: input.activityId,
    parentBehaviorRevisionId: input.parentBehaviorRevisionId,
    behaviorId: input.behaviorId,
    callKey: input.callKey,
  })}`;
}

export async function getBehaviorCallPin(id: string): Promise<BehaviorCallPin | null> {
  assertSafeCollectionId(id);
  const pin = await loadCollectionItem<BehaviorCallPin | null>(
    BEHAVIOR_CALL_PINS_COLLECTION,
    id,
    null,
  );
  if (!pin) return null;
  const parsed = BehaviorCallPinSchema.parse(pin);
  if (parsed.id !== id || parsed.workspaceId !== getCurrentWorkspace()) {
    throw new Error('Behavior call pin storage identity mismatch.');
  }
  return parsed;
}

/** Strict inventory for erasure, recovery and retention; never silently skip damaged records. */
export async function listBehaviorCallPins(personaId: string): Promise<BehaviorCallPin[]> {
  EnduringAgentIdSchema.parse(personaId);
  const entries = await listCollectionItemEntriesStrict<unknown>(BEHAVIOR_CALL_PINS_COLLECTION);
  const pins: BehaviorCallPin[] = [];
  for (const entry of entries) {
    const owner = z.object({ personaId: EnduringAgentIdSchema }).parse(entry.item);
    if (owner.personaId !== personaId) continue;
    const pin = BehaviorCallPinSchema.parse(entry.item);
    if (pin.id !== entry.id || pin.workspaceId !== getCurrentWorkspace()) {
      throw new Error('Behavior call pin storage identity mismatch.');
    }
    pins.push(pin);
  }
  return pins.sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Persist the selected immutable Behavior pin before external execution.
 * A deterministic call key makes retries recover the original snapshot instead
 * of resolving a newer mutable Flow or launching a duplicate child call.
 */
export async function createBehaviorCallPin(input: {
  personaId: string;
  activityId: string;
  parentBehaviorRevisionId: string;
  revision: BehaviorRevision;
  callKey: string;
}, executionAuthority: FlowExecutionAuthority): Promise<BehaviorCallPin> {
  if (!executionAuthority?.commitPersonaMutation) {
    throw new Error('Behavior call pin requires current Activity mutation authority.');
  }
  input = structuredClone(input);
  return withPersonaDomainMutation(input.personaId, { executionAuthority }, async (context) => {
    if (context.activity?.id !== input.activityId || await getPersonaDeletionTombstone(input.personaId)) {
      throw new Error('Behavior call pin does not belong to the current Activity.');
    }
    const [parent, revision] = await Promise.all([
      getBehaviorRevision(input.parentBehaviorRevisionId),
      getBehaviorRevision(input.revision.id),
    ]);
    if (parent?.personaId !== input.personaId || revision?.personaId !== input.personaId
      || canonicalJson(revision) !== canonicalJson(input.revision)) {
      throw new Error('Behavior call revisions must belong to this Persona and match immutable storage.');
    }
    const workspaceId = getCurrentWorkspace();
    const id = behaviorCallPinId({
      workspaceId,
      personaId: input.personaId,
      activityId: input.activityId,
      parentBehaviorRevisionId: input.parentBehaviorRevisionId,
      behaviorId: input.revision.behaviorId,
      callKey: input.callKey,
    });
    assertSafeCollectionId(id);

    const existing = await getBehaviorCallPin(id);
    if (existing) {
      if (
        existing.workspaceId !== workspaceId
        || existing.personaId !== input.personaId
        || existing.activityId !== input.activityId
        || existing.parentBehaviorRevisionId !== input.parentBehaviorRevisionId
        || existing.behaviorId !== input.revision.behaviorId
      ) {
        throw new Error('Behavior call pin identity collision.');
      }
      if (existing.compactedAt !== undefined) throw new Error('Behavior call detail has expired.');
      return existing;
    }

    const now = Date.now();
    const pin: BehaviorCallPin = {
      schemaVersion: 1,
      id,
      workspaceId,
      personaId: input.personaId,
      activityId: input.activityId,
      parentBehaviorRevisionId: input.parentBehaviorRevisionId,
      behaviorId: input.revision.behaviorId,
      behaviorRevisionId: input.revision.id,
      slotKey: input.revision.slotKey,
      flowId: input.revision.flowSnapshot.id,
      ...(input.revision.source.kind === 'persona_override' && input.revision.source.flowVersionId
        ? { flowVersionId: input.revision.source.flowVersionId }
        : {}),
      contentHash: input.revision.contentHash,
      flowSnapshot: FlowSnapshotSchema.parse(structuredClone(input.revision.flowSnapshot)),
      status: 'running',
      createdAt: now,
      updatedAt: now,
    };
    await saveCollectionItem(BEHAVIOR_CALL_PINS_COLLECTION, pin.id, pin);
    return pin;
  });
}

/**
 * Complete a running pin without allowing a stale retry to downgrade or
 * overwrite an already-terminal child call.
 */
export async function completeBehaviorCallPin(
  pin: BehaviorCallPin,
  status: Extract<BehaviorCallPinStatus, 'completed' | 'error'>,
  executionAuthority: FlowExecutionAuthority,
  error?: string,
  outputText?: string,
): Promise<BehaviorCallPin> {
  if (!executionAuthority?.commitPersonaMutation) {
    throw new Error('Behavior call completion requires current Activity mutation authority.');
  }
  pin = BehaviorCallPinSchema.parse(pin);
  return withPersonaDomainMutation(pin.personaId, { executionAuthority }, async (context) => {
    if (context.activity?.id !== pin.activityId || await getPersonaDeletionTombstone(pin.personaId)) {
      throw new Error('Behavior call pin does not belong to the current Activity.');
    }
    const current = await getBehaviorCallPin(pin.id);
    if (!current) throw new Error('Behavior call pin no longer exists.');
    if (
      current.workspaceId !== getCurrentWorkspace()
      || current.personaId !== pin.personaId
      || current.activityId !== pin.activityId
      || current.parentBehaviorRevisionId !== pin.parentBehaviorRevisionId
      || current.behaviorId !== pin.behaviorId
      || current.contentHash !== pin.contentHash
      || current.behaviorRevisionId !== pin.behaviorRevisionId
    ) {
      throw new Error('Behavior call pin failed immutable identity validation.');
    }
    if (current.compactedAt !== undefined) throw new Error('Behavior call detail has expired.');
    if (current.status !== 'running') return current;

    const now = Math.max(Date.now(), current.updatedAt);
    const completed: BehaviorCallPin = {
      ...current,
      status,
      updatedAt: now,
      completedAt: now,
      ...(status === 'completed' && outputText ? { outputText } : {}),
      ...(status === 'error' && error ? { error: error.slice(0, 20_000) } : {}),
    };
    await saveCollectionItem(BEHAVIOR_CALL_PINS_COLLECTION, completed.id, completed);
    return completed;
  });
}

export function compactBehaviorCallPin(pin: BehaviorCallPin, compactedAt: number): BehaviorCallPin {
  if (pin.compactedAt !== undefined) return pin;
  const { flowSnapshot, outputText, error, ...identity } = pin;
  return BehaviorCallPinSchema.parse({
    ...identity,
    compactedAt: Math.max(compactedAt, pin.updatedAt),
    payloadDigest: createHash('sha256')
      .update(canonicalJson({ flowSnapshot, outputText, error })).digest('hex'),
  });
}

/** Keep the idempotency receipt; erase bulky detail only after the owning Activity is terminal. */
export async function saveCompactedBehaviorCallPin(
  value: BehaviorCallPin,
  lock: PersonaRuntimeLock,
): Promise<void> {
  const candidate = BehaviorCallPinSchema.parse(value);
  return withIssuedPersonaRuntimeLockOperation(lock, candidate.personaId, async () => {
    const current = await getBehaviorCallPin(candidate.id);
    if (!current || await getPersonaDeletionTombstone(candidate.personaId)) {
      throw new Error('Behavior call no longer exists.');
    }
    const activity = await getPersonaActivity(candidate.personaId, current.activityId);
    if (!activity || !['completed', 'cancelled', 'error'].includes(activity.status)) {
      throw new Error('Behavior call detail is still required by its Activity.');
    }
    if (candidate.compactedAt === undefined || canonicalJson(candidate) !== canonicalJson(
      compactBehaviorCallPin(current, candidate.compactedAt),
    )) {
      throw new Error('Behavior call compaction cannot change its immutable receipt.');
    }
    await saveCollectionItem(BEHAVIOR_CALL_PINS_COLLECTION, candidate.id, candidate);
  });
}
