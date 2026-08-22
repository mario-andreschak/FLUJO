import { createHash } from 'crypto';

import { FlowSnapshotSchema, type BehaviorRevision } from '@/shared/types/enduringAgent';
import type { Flow } from '@/shared/types/flow';
import {
  assertSafeCollectionId,
  loadCollectionItem,
  saveCollectionItem,
} from '@/utils/storage/backend';
import { getCurrentWorkspace } from '@/utils/workspace';

import { canonicalJson } from './behaviorRevisions';

const BEHAVIOR_CALL_PINS_COLLECTION = 'persona-behavior-call-pins';

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
  flowSnapshot: Flow;
  status: BehaviorCallPinStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  outputText?: string;
  error?: string;
}

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
  return pin
    ? { ...pin, flowSnapshot: FlowSnapshotSchema.parse(pin.flowSnapshot) }
    : null;
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
}): Promise<BehaviorCallPin> {
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
}

/**
 * Complete a running pin without allowing a stale retry to downgrade or
 * overwrite an already-terminal child call.
 */
export async function completeBehaviorCallPin(
  pin: BehaviorCallPin,
  status: Extract<BehaviorCallPinStatus, 'completed' | 'error'>,
  error?: string,
  outputText?: string,
): Promise<BehaviorCallPin> {
  const current = await getBehaviorCallPin(pin.id);
  if (!current) throw new Error('Behavior call pin no longer exists.');
  if (current.status !== 'running') return current;
  if (
    current.workspaceId !== getCurrentWorkspace()
    || current.contentHash !== pin.contentHash
    || current.behaviorRevisionId !== pin.behaviorRevisionId
  ) {
    throw new Error('Behavior call pin failed immutable identity validation.');
  }

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
}
