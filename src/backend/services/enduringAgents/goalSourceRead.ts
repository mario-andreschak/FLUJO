import type { PersonaActivity } from '@/shared/types/enduringAgent';
import { canonicalJson } from './behaviorRevisions';
import { readPersonaGoalRuntime } from './goalRuntimeRead';
import { getBehaviorRevision, getPersonaActivity } from './store';

export class GoalSourceUnavailableError extends Error {}

// Select frozen execution source and the structured outcome only. Never copy
// Activity context, messages, inputs, lease capabilities or unrelated history.
function projectActivity(activity: PersonaActivity) {
  return {
    id: activity.id, personaId: activity.personaId, status: activity.status,
    behaviorId: activity.behaviorId, behaviorRevisionId: activity.behaviorRevisionId,
    coreFlowId: activity.coreFlowId, coreFlowRevisionId: activity.coreFlowRevisionId,
    coreAppRefs: activity.coreAppRefs, instructionContext: activity.instructionContext,
    instructionContextDigest: activity.instructionContextDigest,
    instructionContextSchemaVersion: activity.instructionContextSchemaVersion,
    source: { kind: activity.source.kind, sourceId: activity.source.sourceId },
    entryPointPayloadRef: activity.entryPointPayloadRef,
    runId: activity.runId, conversationId: activity.conversationId,
    updatedAt: activity.updatedAt, outcome: activity.outcome,
  };
}

/** Read only the joined Goal's original Activity and immutable Core revision. */
export async function readPersonaGoalSource(personaId: string, goalId: string) {
  const unavailable = () => new GoalSourceUnavailableError('Original Goal source is unavailable.');
  const runtime = await readPersonaGoalRuntime(personaId, goalId);
  if (!runtime.verified || !['accepted_running', 'terminal_observed'].includes(runtime.state)
    || !runtime.activity || !runtime.round || !runtime.dispatch) throw unavailable();
  const activityId = runtime.activity.id;
  const read = async () => {
    const activity = await getPersonaActivity(personaId, activityId);
    if (!activity || activity.id !== activityId || activity.personaId !== personaId
      || activity.status !== runtime.activity!.status
      || activity.source.kind !== 'assignment' || activity.source.sourceId !== runtime.round!.taskId
      || activity.entryPointPayloadRef !== runtime.dispatch!.id
      || (activity.runId ?? null) !== runtime.activity!.runId
      || (activity.conversationId ?? null) !== runtime.activity!.conversationId
      || !activity.coreFlowRevisionId || activity.behaviorRevisionId !== activity.coreFlowRevisionId) throw unavailable();
    const revision = await getBehaviorRevision(activity.coreFlowRevisionId);
    if (!revision || revision.id !== activity.coreFlowRevisionId || revision.personaId !== personaId
      || revision.behaviorId !== activity.behaviorId || revision.flowSnapshot.id !== activity.coreFlowId) throw unavailable();
    return { activity: projectActivity(activity), behaviorRevision: revision };
  };
  const first = await read();
  const second = await read();
  const after = await readPersonaGoalRuntime(personaId, goalId);
  if (canonicalJson(first) !== canonicalJson(second) || canonicalJson(runtime) !== canonicalJson(after)) throw unavailable();
  return { goalId, goalVersion: runtime.goal.version, round: runtime.goal.rounds, ...first };
}
