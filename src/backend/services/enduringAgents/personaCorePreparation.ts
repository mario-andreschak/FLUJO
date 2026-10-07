import { authoredCoreFlowRef } from './personaComposition';
import { resolvePersonaCoreRevision } from './personaCoreResolver';
import { withPersonaRuntimeLock } from './runtimeLock';
import { getPersona, listBehaviorBindings } from './store';

export class PersonaCorePreparationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PersonaCorePreparationConflictError';
  }
}

/** Prepare an authored Core while no Persona Activity can start. */
export async function reconcileDisabledPersonaCore(input: {
  personaId: string;
  expectedCoreFlowRef: string;
  expectedActiveRevisionId: string;
}): Promise<{ personaId: string; revisionId: string; contentHash: string; dependencyCount: number }> {
  return withPersonaRuntimeLock(input.personaId, async (lock) => {
    const persona = await getPersona(input.personaId);
    if (!persona) throw new PersonaCorePreparationConflictError('Persona is missing.');
    if (persona.lifecycleState !== 'disabled' || persona.provisioningState !== 'ready') {
      throw new PersonaCorePreparationConflictError('Persona must be disabled and ready before Core reconciliation.');
    }
    if (authoredCoreFlowRef(persona) !== input.expectedCoreFlowRef) {
      throw new PersonaCorePreparationConflictError('Authored Core Flow changed since inspection.');
    }
    const bindings = (await listBehaviorBindings(persona.id)).filter(item => item.slotKey === 'primary');
    if (bindings.length !== 1 || bindings[0].activeRevisionId !== input.expectedActiveRevisionId) {
      throw new PersonaCorePreparationConflictError('Active primary Behavior revision changed since inspection.');
    }
    await lock.assertOwned();
    const revision = await resolvePersonaCoreRevision(persona.id);
    await lock.assertOwned();
    return {
      personaId: persona.id,
      revisionId: revision.id,
      contentHash: revision.contentHash,
      dependencyCount: revision.flowSnapshot.executionDependencies?.flows.length ?? 0,
    };
  });
}
