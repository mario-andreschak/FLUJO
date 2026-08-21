import { flowService } from '@/backend/services/flow';
import {
  BEHAVIOR_REVISION_SCHEMA_VERSION,
  BehaviorRevisionSchema,
  type BehaviorRevision,
} from '@/shared/types/enduringAgent';

import {
  behaviorRevisionId,
  canonicalJson,
  hashBehaviorFlow,
  snapshotBehaviorFlow,
} from './behaviorRevisions';
import { authoredCoreFlowRef } from './personaComposition';
import {
  activateBehaviorBindingRevision,
  createBehaviorRevision,
  getBehaviorRevision,
  getPersona,
  listBehaviorBindings,
  listBehaviorRevisions,
} from './store';

export class PersonaCoreResolutionError extends Error {
  readonly code = 'PERSONA_CORE_RESOLUTION_FAILED' as const;

  constructor(message: string) {
    super(message);
    this.name = 'PersonaCoreResolutionError';
  }
}

function hasMatchingAcceptedRollbackBaseline(
  active: BehaviorRevision,
  revisions: BehaviorRevision[],
  coreFlowRef: string,
  contentHash: string,
): boolean {
  return revisions.some((revision) => {
    if (
      revision.source.kind !== 'persona_override'
      || revision.source.parentRevisionId !== active.id
      || !revision.source.evidenceRefs?.length
    ) {
      return false;
    }
    const provenance = revision.source.authoredFlowProvenance;
    return provenance?.flowRef === coreFlowRef
      && provenance.contentHash === contentHash;
  });
}

function classifyLegacyOverride(
  active: BehaviorRevision,
  revisions: BehaviorRevision[],
): 'authored-derived' | 'accepted' | 'ambiguous' {
  if (active.source.kind !== 'persona_override') return 'ambiguous';
  if (active.source.sourceFlowRef) return 'authored-derived';

  const revisionsById = new Map(revisions.map((revision) => [revision.id, revision]));
  const visited = new Set<string>();
  let cursor: BehaviorRevision | undefined = active;
  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    if (
      cursor.source.kind === 'persona_override'
      && cursor.source.evidenceRefs?.length
    ) {
      return 'accepted';
    }
    const parentRevisionId: string | undefined = cursor.source.kind === 'persona_override'
      ? cursor.source.parentRevisionId
      : undefined;
    cursor = parentRevisionId ? revisionsById.get(parentRevisionId) : undefined;
  }
  return 'ambiguous';
}

/**
 * Resolve the visible mutable Core Flow into the Persona's immutable primary
 * Behavior revision. Legacy Personas without a Core reference retain their
 * existing primary binding as a deterministic compatibility mapping.
 */
export async function resolvePersonaCoreRevision(
  personaId: string,
): Promise<BehaviorRevision> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const persona = await getPersona(personaId);
    if (!persona) {
      throw new PersonaCoreResolutionError(
        `Persona ${JSON.stringify(personaId)} does not exist.`,
      );
    }
    const primaryBindings = (await listBehaviorBindings(persona.id)).filter(
      (binding) => binding.slotKey === 'primary',
    );
    if (primaryBindings.length === 0) {
      throw new PersonaCoreResolutionError(
        `Persona ${JSON.stringify(persona.id)} has no Behavior for the primary Core slot.`,
      );
    }
    if (primaryBindings.length > 1) {
      throw new PersonaCoreResolutionError(
        `Persona ${JSON.stringify(persona.id)} has multiple Behaviors for the primary Core slot.`,
      );
    }
    const binding = primaryBindings[0];
    const active = await getBehaviorRevision(binding.activeRevisionId);
    if (!active || active.behaviorId !== binding.id || active.personaId !== persona.id) {
      throw new PersonaCoreResolutionError(
        `Persona ${JSON.stringify(persona.id)} has an invalid primary Core revision.`,
      );
    }

    const coreFlowRef = authoredCoreFlowRef(persona);
    if (!coreFlowRef) return active;

    const authoredFlow = await flowService.getFlow(coreFlowRef);
    if (!authoredFlow) {
      throw new PersonaCoreResolutionError(
        `Persona Core Flow ${JSON.stringify(coreFlowRef)} no longer exists.`,
      );
    }
    const flowSnapshot = snapshotBehaviorFlow(authoredFlow);
    const contentHash = hashBehaviorFlow(flowSnapshot);
    if (
      active.contentHash === contentHash
      && canonicalJson(active.flowSnapshot) === canonicalJson(flowSnapshot)
    ) {
      return active;
    }

    const revisions = (await listBehaviorRevisions(persona.id)).filter(
      (revision) => revision.behaviorId === binding.id,
    );

    if (
      hasMatchingAcceptedRollbackBaseline(active, revisions, coreFlowRef, contentHash)
    ) {
      // Rollback intentionally selected the accepted revision's immutable
      // parent while the authored baseline remains exactly as it was at
      // activation. A later authored reference/hash change bypasses this guard.
      return active;
    }

    if (active.source.kind === 'persona_override') {
      const provenance = active.source.authoredFlowProvenance;
      if (
        provenance
        && provenance.flowRef === coreFlowRef
        && provenance.contentHash === contentHash
      ) {
        return active;
      }

      if (
        !provenance
        && classifyLegacyOverride(active, revisions) !== 'authored-derived'
      ) {
        // Accepted and ambiguous legacy overrides are preserved. A mismatch
        // alone cannot prove that authored content changed after activation.
        return active;
      }
    }

    const ordinal = revisions.reduce(
      (maximum, revision) => Math.max(maximum, revision.revision),
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
        sourceFlowRef: coreFlowRef,
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
      return candidate;
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
  throw new PersonaCoreResolutionError('Persona Core resolution did not converge.');
}
