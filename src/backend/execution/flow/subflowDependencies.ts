import type { Flow } from '@/shared/types/flow';
import { createLogger } from '@/utils/logger';
import { getCurrentWorkspace } from '@/utils/workspace';
import {
  BehaviorDependencyValidationError,
  resolveBehaviorSubflowSnapshot,
  snapshotBehaviorFlowDependencies,
} from '@/backend/services/enduringAgents/behaviorRevisions';
import type { SubflowNodePrepResult } from './types';

const log = createLogger('backend/execution/flow/subflowDependencies');

/**
 * Persona children never resolve their executable graphs from mutable Flow IDs.
 * An ordinary run does the same when, and only when, it started from a flow that
 * froze its subflows (`pinSubflowsAtRunStart`). Anything else keeps looking the
 * child up when it starts, and a frozen copy that cannot be used falls back to
 * that too, because a run must not fail over its own safety copy.
 */
export function pinnedSubflowDefinition(
  preparation: Pick<SubflowNodePrepResult, 'personaAttribution' | 'parentFlowSnapshot' | 'nodeId'>,
  childId: string,
): { flowDefinition?: Flow } {
  if (!preparation.personaAttribution) {
    const parent = preparation.parentFlowSnapshot;
    if (!parent?.executionDependencies?.flows?.some((entry) => entry.flowId === childId)) return {};
    try {
      return { flowDefinition: resolveBehaviorSubflowSnapshot(parent, preparation.nodeId, childId, getCurrentWorkspace()) };
    } catch (error) {
      log.warn(`Frozen subflow ${childId} could not be used; looking up the current one`, error);
      return {};
    }
  }
  if (!preparation.parentFlowSnapshot) {
    throw new BehaviorDependencyValidationError('Persona Subflow execution is missing its pinned parent snapshot.');
  }
  return { flowDefinition: resolveBehaviorSubflowSnapshot(
    preparation.parentFlowSnapshot, preparation.nodeId, childId, getCurrentWorkspace(),
  ) };
}

/**
 * The definition a new conversation should freeze. Ordinary flows come back as they
 * are. A flow that asks for it also carries the subflows it can reach. If those cannot
 * be captured (a missing child, a cycle), the conversation still starts and looks its
 * subflows up when they start.
 */
export async function flowWithPinnedSubflows(flow: Flow): Promise<Flow> {
  if (!flow.pinSubflowsAtRunStart) return flow;
  try {
    return await snapshotBehaviorFlowDependencies(flow);
  } catch (error) {
    log.warn(`Flow ${flow.id} could not freeze its subflows; they will be looked up when they start`, error);
    return flow;
  }
}
