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
    if (primaryBindings.length !== 1) {
      throw new PersonaCoreResolutionError(
        `Persona ${JSON.stringify(persona.id)} must have exactly one primary Core binding.`,
      );
    }
    const binding = primaryBindings[0];
    const active = await getBehaviorRevision(binding.activeRevisionId);
    if (!active || active.behaviorId !== binding.id || active.personaId !== persona.id) {
      throw new PersonaCoreResolutionError(
        `Persona ${JSON.stringify(persona.id)} has an invalid primary Core revision.`,
      );
    }

    const coreFlowRef = persona.composition?.coreFlowRef;
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
