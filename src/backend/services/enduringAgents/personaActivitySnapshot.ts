import { createHash } from 'crypto';

import {
  PersonaInstructionContextSchema,
  type BehaviorRevision,
  type PersonaActivity,
  type PersonaInstructionContext,
} from '@/shared/types/enduringAgent';

import { canonicalJson } from './behaviorRevisions';

export interface PersonaActivitySnapshot {
  coreFlowId: string;
  coreFlowRevisionId: string;
  /** Exact workspace-local MCP configuration names frozen for this Activity. */
  coreAppRefs: string[];
  instructionContext: PersonaInstructionContext;
  instructionContextDigest: string;
  instructionContextSchemaVersion: PersonaInstructionContext['schemaVersion'];
  entryPointPayloadRef?: string;
}

export function hashPersonaInstructionContext(
  context: PersonaInstructionContext,
): string {
  const parsed = PersonaInstructionContextSchema.parse(context);
  return createHash('sha256').update(canonicalJson(parsed)).digest('hex');
}

export function createPersonaActivitySnapshot(input: {
  activity: Pick<PersonaActivity, 'id' | 'personaId' | 'behaviorId' | 'behaviorRevisionId'>;
  revision: BehaviorRevision;
  context: PersonaInstructionContext;
  coreAppRefs: readonly string[];
  entryPointPayloadRef?: string;
}): PersonaActivitySnapshot {
  const context = PersonaInstructionContextSchema.parse(input.context)
    as PersonaInstructionContext;
  const { activity, revision } = input;
  if (
    !activity.behaviorId
    || activity.personaId !== revision.personaId
    || activity.behaviorId !== revision.behaviorId
    || activity.behaviorRevisionId !== revision.id
    || context.personaId !== activity.personaId
    || context.activityId !== activity.id
    || context.behaviorRevisionId !== revision.id
    || context.behaviorContentHash !== revision.contentHash
    || context.behaviorSlotKey !== revision.slotKey
    || context.rootFlowId !== revision.flowSnapshot.id
  ) {
    throw new Error('Persona Activity snapshot does not match its pinned Core revision.');
  }

  return {
    coreFlowId: context.rootFlowId,
    coreFlowRevisionId: revision.id,
    coreAppRefs: Array.from(new Set(input.coreAppRefs)).sort(),
    instructionContext: structuredClone(context),
    instructionContextDigest: hashPersonaInstructionContext(context),
    instructionContextSchemaVersion: context.schemaVersion,
    ...(input.entryPointPayloadRef
      ? { entryPointPayloadRef: input.entryPointPayloadRef }
      : {}),
  };
}

export function readPersonaActivityInstructionContext(
  activity: PersonaActivity,
  revision: BehaviorRevision,
): PersonaInstructionContext | undefined {
  if (!activity.instructionContext) return undefined;
  const snapshot = createPersonaActivitySnapshot({
    activity,
    revision,
    context: activity.instructionContext,
    coreAppRefs: activity.coreAppRefs ?? [],
    ...(activity.entryPointPayloadRef
      ? { entryPointPayloadRef: activity.entryPointPayloadRef }
      : {}),
  });
  if (
    activity.coreFlowId !== snapshot.coreFlowId
    || activity.coreFlowRevisionId !== snapshot.coreFlowRevisionId
    || (activity.coreAppRefs !== undefined
      && canonicalJson(activity.coreAppRefs) !== canonicalJson(snapshot.coreAppRefs))
    || activity.instructionContextSchemaVersion !== snapshot.instructionContextSchemaVersion
    || activity.instructionContextDigest !== snapshot.instructionContextDigest
  ) {
    throw new Error('Persona Activity Core snapshot failed immutable identity validation.');
  }
  return snapshot.instructionContext;
}
