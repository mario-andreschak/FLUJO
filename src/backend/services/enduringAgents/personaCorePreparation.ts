import { flowService } from '@/backend/services/flow';
import type { Flow } from '@/shared/types/flow';

import { authoredCoreFlowRef } from './personaComposition';
import { listPersonaFlowDispatches } from './personaDispatcher';
import { resolvePersonaCoreRevision } from './personaCoreResolver';
import { withPersonaRuntimeLock } from './runtimeLock';
import {
  getPersona, getPersonaLease, listBehaviorBindings,
  listPersonaRuntimeRecordsStrict,
} from './store';

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
  enableGoalAbilities?: {
    expectedFlowUpdatedAt: number;
    processNodeId: string;
  };
}): Promise<{ personaId: string; revisionId: string; contentHash: string; dependencyCount: number; authoredFlowUpdatedAt?: number }> {
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
    let authoredFlowUpdatedAt: number | undefined;
    if (input.enableGoalAbilities) {
      // A source edit is allowed only for a Persona-owned Core, after a complete
      // record check under the same lock that excludes new Persona Activities.
      const [lease, records, dispatches] = await Promise.all([
        getPersonaLease(persona.id),
        listPersonaRuntimeRecordsStrict(persona.id),
        listPersonaFlowDispatches(persona.id),
      ]);
      if (
        lease?.status === 'active'
        || records.activities.some((item) => !['completed', 'cancelled', 'error'].includes(item.status))
        || records.mailboxItems.some((item) => !['coalesced', 'completed', 'rejected'].includes(item.status))
        || dispatches.some((item) => !['completed', 'cancelled', 'error'].includes(item.state))
      ) {
        throw new PersonaCorePreparationConflictError('Persona runtime has unfinished work.');
      }
      const flowRef = authoredCoreFlowRef(persona);
      const flow = flowRef ? await flowService.getFlow(flowRef) : null;
      if (!flow || flow.personaOwnership?.personaId !== persona.id
        || flow.updatedAt !== input.enableGoalAbilities.expectedFlowUpdatedAt) {
        throw new PersonaCorePreparationConflictError('Owned Core Flow changed since inspection.');
      }
      const copy = JSON.parse(JSON.stringify(flow)) as Flow;
      const node = copy.nodes.find((item) => item.id === input.enableGoalAbilities!.processNodeId);
      if (!node || node.type !== 'process' || !node.data?.properties) {
        throw new PersonaCorePreparationConflictError('Core process node changed since inspection.');
      }
      const properties = node.data.properties as Record<string, unknown>;
      const abilities = properties.personaTools;
      if (!Array.isArray(abilities) || !abilities.every((ability) => typeof ability === 'string')) {
        throw new PersonaCorePreparationConflictError('Core process abilities require explicit configuration.');
      }
      properties.personaTools = [
        ...new Set([...abilities, 'work_item_goal_create', 'work_item_runtime_read']),
      ];
      await lock.assertOwned();
      const saved = await flowService.saveFlow(copy, {
        expectedUpdatedAt: input.enableGoalAbilities.expectedFlowUpdatedAt,
      });
      if (!saved.success) {
        if (saved.error === 'Flow changed since inspection.') {
          throw new PersonaCorePreparationConflictError(saved.error);
        }
        throw new Error(saved.error || 'Failed to save Core abilities.');
      }
      authoredFlowUpdatedAt = copy.updatedAt;
    }
    await lock.assertOwned();
    const revision = await resolvePersonaCoreRevision(persona.id);
    if (input.enableGoalAbilities) {
      const node = revision.flowSnapshot.nodes.find(
        (item) => item.id === input.enableGoalAbilities!.processNodeId,
      );
      const abilities = node?.data?.properties?.personaTools;
      if (!Array.isArray(abilities)
        || !abilities.includes('work_item_goal_create')
        || !abilities.includes('work_item_runtime_read')) {
        throw new PersonaCorePreparationConflictError('Resolved Core revision lacks requested abilities.');
      }
      const latest = await flowService.getFlow(input.expectedCoreFlowRef);
      if (latest?.updatedAt !== authoredFlowUpdatedAt) {
        throw new PersonaCorePreparationConflictError('Owned Core Flow changed during reconciliation.');
      }
    }
    await lock.assertOwned();
    return {
      personaId: persona.id,
      revisionId: revision.id,
      contentHash: revision.contentHash,
      dependencyCount: revision.flowSnapshot.executionDependencies?.flows.length ?? 0,
      ...(authoredFlowUpdatedAt === undefined ? {} : { authoredFlowUpdatedAt }),
    };
  });
}
