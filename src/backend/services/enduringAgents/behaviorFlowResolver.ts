import { validateFlowObjectForRun } from '@/backend/execution/flow/validateFlowForRun';
import { flowService } from '@/backend/services/flow';
import {
  BEHAVIOR_REVISION_SCHEMA_VERSION,
  BehaviorRevisionSchema,
  type BehaviorBinding,
  type BehaviorRevision,
} from '@/shared/types/enduringAgent';
import { getCurrentWorkspace } from '@/utils/workspace';

import {
  behaviorRevisionId,
  canonicalJson,
  hashBehaviorFlow,
  snapshotBehaviorFlow,
} from './behaviorRevisions';
import {
  activateBehaviorBindingRevision,
  createBehaviorRevision,
  getBehaviorRevision,
  getPersona,
  listBehaviorBindings,
  listBehaviorRevisions,
} from './store';

export const BEHAVIOR_FLOW_RESOLUTION_ERROR_CODES = [
  'BEHAVIOR_FLOW_NOT_FOUND',
  'BEHAVIOR_FLOW_WORKSPACE_MISMATCH',
  'BEHAVIOR_FLOW_INVALID',
  'BEHAVIOR_FLOW_PIN_MISMATCH',
] as const;

export type BehaviorFlowResolutionErrorCode =
  (typeof BEHAVIOR_FLOW_RESOLUTION_ERROR_CODES)[number];

export class BehaviorFlowResolutionError extends Error {
  constructor(
    readonly code: BehaviorFlowResolutionErrorCode,
    message: string,
    readonly flowId?: string,
  ) {
    super(message);
    this.name = 'BehaviorFlowResolutionError';
  }
}

function invalidOwnership(personaId: string, binding: BehaviorBinding): never {
  throw new BehaviorFlowResolutionError(
    'BEHAVIOR_FLOW_PIN_MISMATCH',
    `Behavior ${JSON.stringify(binding.id)} is not owned by Persona `
      + `${JSON.stringify(personaId)} and its selected slot.`,
  );
}

async function loadBinding(
  personaId: string,
  slotKey: string,
): Promise<{ binding: BehaviorBinding; revision: BehaviorRevision }> {
  const matches = (await listBehaviorBindings(personaId))
    .filter((candidate) => candidate.slotKey === slotKey);
  if (matches.length !== 1) {
    throw new BehaviorFlowResolutionError(
      matches.length === 0 ? 'BEHAVIOR_FLOW_NOT_FOUND' : 'BEHAVIOR_FLOW_PIN_MISMATCH',
      matches.length === 0
        ? `Persona ${JSON.stringify(personaId)} has no Behavior for slot ${JSON.stringify(slotKey)}.`
        : `Persona ${JSON.stringify(personaId)} has multiple Behaviors for slot ${JSON.stringify(slotKey)}.`,
    );
  }

  const binding = matches[0];
  const revision = await getBehaviorRevision(binding.activeRevisionId);
  if (
    !revision
    || revision.personaId !== personaId
    || revision.behaviorId !== binding.id
    || revision.slotKey !== slotKey
  ) {
    invalidOwnership(personaId, binding);
  }
  return { binding, revision };
}

function matchesSelectedReference(
  revision: BehaviorRevision,
  sourceFlowRef: string | undefined,
  overrideFlowRef: string | undefined,
  workspaceId: string,
  selectedFlowRef: string,
  flowVersionId: string,
): boolean {
  if (revision.source.kind !== 'persona_override') return false;
  return revision.source.sourceFlowRef === sourceFlowRef
    && revision.source.overrideFlowRef === overrideFlowRef
    && revision.source.workspaceId === workspaceId
    && revision.source.selectedFlowRef === selectedFlowRef
    && revision.source.flowVersionId === flowVersionId;
}

/**
 * Resolve the mutable Persona Behavior reference at admission and publish the
 * exact captured Flow as an immutable Behavior revision. Existing Activities
 * continue to hold their prior revision ID, so resume never re-resolves a
 * mutable Flow. New Activities deterministically prefer the Persona override.
 */
export async function resolveEffectiveBehaviorRevision(
  personaId: string,
  slotKey: string,
): Promise<{ binding: BehaviorBinding; revision: BehaviorRevision }> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const persona = await getPersona(personaId);
    if (!persona) {
      throw new BehaviorFlowResolutionError(
        'BEHAVIOR_FLOW_NOT_FOUND',
        `Persona ${JSON.stringify(personaId)} does not exist.`,
      );
    }

    const { binding, revision: active } = await loadBinding(persona.id, slotKey);
    const composition = persona.composition?.behaviors
      ?.find((candidate) => candidate.ref === binding.id);
    const sourceFlowRef = composition?.binding
      ? composition.binding.sharedFlowRef
      : composition?.sourceFlowRef;
    const overrideFlowRef = composition?.binding?.mode === 'persona_copy'
      ? composition.binding.personaFlowRef
      : composition?.overrideFlowRef;
    const selectedFlowRef = overrideFlowRef ?? sourceFlowRef;

    // Legacy records with no durable authoring reference keep their embedded
    // immutable revision unchanged.
    if (!selectedFlowRef) return { binding, revision: active };

    const captured = await flowService.readFlowExecutionSnapshot(selectedFlowRef);
    if (!captured) {
      throw new BehaviorFlowResolutionError(
        'BEHAVIOR_FLOW_NOT_FOUND',
        `Behavior Flow ${JSON.stringify(selectedFlowRef)} no longer exists in this workspace. `
          + 'Choose another Flow in the Persona Behavior settings.',
        selectedFlowRef,
      );
    }
    const workspaceId = getCurrentWorkspace();
    if (captured.workspaceId !== workspaceId) {
      throw new BehaviorFlowResolutionError(
        'BEHAVIOR_FLOW_WORKSPACE_MISMATCH',
        `Behavior Flow ${JSON.stringify(selectedFlowRef)} belongs to another workspace.`,
        selectedFlowRef,
      );
    }

    const validation = await validateFlowObjectForRun(captured.flow);
    if (!validation.isRunnable) {
      const details = validation.issues
        .filter((issue) => issue.severity === 'error')
        .map((issue) => issue.message)
        .slice(0, 3)
        .join('; ');
      throw new BehaviorFlowResolutionError(
        'BEHAVIOR_FLOW_INVALID',
        `Behavior Flow ${JSON.stringify(selectedFlowRef)} is not runnable`
          + `${details ? `: ${details}` : '.'}`,
        selectedFlowRef,
      );
    }

    let flowSnapshot;
    let contentHash;
    try {
      flowSnapshot = snapshotBehaviorFlow(captured.flow);
      contentHash = hashBehaviorFlow(flowSnapshot);
    } catch (error) {
      throw new BehaviorFlowResolutionError(
        'BEHAVIOR_FLOW_INVALID',
        error instanceof Error ? error.message : 'Behavior Flow snapshot is invalid.',
        selectedFlowRef,
      );
    }

    if (
      active.contentHash === contentHash
      && canonicalJson(active.flowSnapshot) === canonicalJson(flowSnapshot)
      && matchesSelectedReference(
        active,
        sourceFlowRef,
        overrideFlowRef,
        captured.workspaceId,
        selectedFlowRef,
        captured.versionId,
      )
    ) {
      return { binding, revision: active };
    }

    const revisions = (await listBehaviorRevisions(persona.id))
      .filter((candidate) => candidate.behaviorId === binding.id);
    const ordinal = revisions.reduce(
      (maximum, candidate) => Math.max(maximum, candidate.revision),
      0,
    ) + 1;
    const candidate = BehaviorRevisionSchema.parse({
      schemaVersion: BEHAVIOR_REVISION_SCHEMA_VERSION,
      id: behaviorRevisionId({
        personaId: persona.id,
        behaviorId: binding.id,
        revision: ordinal,
        contentHash,
      }),
      behaviorId: binding.id,
      personaId: persona.id,
      slotKey: binding.slotKey,
      revision: ordinal,
      contentHash,
      flowSnapshot,
      source: {
        kind: 'persona_override',
        parentRevisionId: active.id,
        sourceFlowRef,
        ...(overrideFlowRef ? { overrideFlowRef } : {}),
        workspaceId: captured.workspaceId,
        selectedFlowRef,
        flowVersionId: captured.versionId,
      },
      createdAt: Date.now(),
    }) as BehaviorRevision;

    try {
      await createBehaviorRevision(candidate);
      await activateBehaviorBindingRevision({
        personaId: persona.id,
        behaviorId: binding.id,
        revisionId: candidate.id,
        expectedActiveRevisionId: active.id,
      });
      return { binding, revision: candidate };
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }

  throw new BehaviorFlowResolutionError(
    'BEHAVIOR_FLOW_PIN_MISMATCH',
    'Behavior Flow resolution did not converge after concurrent updates.',
  );
}

/** Resolve a registry-authorized Behavior binding without accepting a Flow ID. */
export async function resolveEffectiveBehaviorById(
  personaId: string,
  behaviorId: string,
): Promise<{ binding: BehaviorBinding; revision: BehaviorRevision }> {
  const binding = (await listBehaviorBindings(personaId))
    .find((candidate) => candidate.id === behaviorId);
  if (!binding || binding.personaId !== personaId) {
    throw new BehaviorFlowResolutionError(
      'BEHAVIOR_FLOW_NOT_FOUND',
      `Persona ${JSON.stringify(personaId)} has no Behavior ${JSON.stringify(behaviorId)}.`,
    );
  }
  const resolved = await resolveEffectiveBehaviorRevision(personaId, binding.slotKey);
  if (resolved.binding.id !== behaviorId) {
    throw new BehaviorFlowResolutionError(
      'BEHAVIOR_FLOW_PIN_MISMATCH',
      `Behavior ${JSON.stringify(behaviorId)} no longer owns its selected slot.`,
    );
  }
  return resolved;
}
