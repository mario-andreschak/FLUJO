import type { Flow } from '@/shared/types/flow';
import { getCurrentWorkspace } from '@/utils/workspace';
import { BehaviorDependencyValidationError, resolveBehaviorSubflowSnapshot } from '@/backend/services/enduringAgents/behaviorRevisions';
import type { SubflowNodePrepResult } from './types';

/** Persona children never resolve their executable graphs from mutable Flow IDs. */
export function pinnedSubflowDefinition(
  preparation: Pick<SubflowNodePrepResult, 'personaAttribution' | 'parentFlowSnapshot' | 'nodeId'>,
  childId: string,
): { flowDefinition?: Flow } {
  if (!preparation.personaAttribution) return {};
  if (!preparation.parentFlowSnapshot) {
    throw new BehaviorDependencyValidationError('Persona Subflow execution is missing its pinned parent snapshot.');
  }
  return { flowDefinition: resolveBehaviorSubflowSnapshot(
    preparation.parentFlowSnapshot, preparation.nodeId, childId, getCurrentWorkspace(),
  ) };
}
