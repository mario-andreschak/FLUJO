import { createHash } from 'node:crypto';
import { z } from 'zod';

import { EnduringAgentIdSchema, type PersonaWorkItem } from '@/shared/types/enduringAgent';
import { getCurrentWorkspace } from '@/utils/workspace';

import { canonicalJson } from './behaviorRevisions';
import { PersonaDomainConflictError, withPersonaDomainMutation } from './domainMutation';
import { stableEnduringAgentId } from './ids';
import { getPersonaWorkItem } from './store';
import { createPersonaWorkItem } from './workItems';

export const PausedGoalAdmissionInputSchema = z.object({
  title: z.string().trim().min(1).max(500),
  description: z.string().trim().min(1).max(100_000),
  successCriteria: z.string().trim().min(1).max(20_000),
}).strict();
export type PausedGoalAdmissionInput = z.infer<typeof PausedGoalAdmissionInputSchema>;

function identity(personaId: string, admissionKey: string) {
  EnduringAgentIdSchema.parse(personaId);
  z.string().regex(/^[a-f0-9]{64}$/).parse(admissionKey);
  return { purpose: 'persona-paused-goal-admission-v1', workspaceId: getCurrentWorkspace(), personaId, admissionKey };
}

function projection(personaId: string, admissionKey: string, item: PersonaWorkItem) {
  return {
    schema: 'flujo-goal-admission/v1' as const,
    workspaceId: getCurrentWorkspace(), personaId, admissionKey,
    goal: { id: item.id, description: item.description, requestDigest: item.goalCreateRequestDigest,
      state: item.goal!.state, rounds: item.goal!.rounds, version: item.updatedAt },
  };
}

/** Owner lookup only: no Activity impersonation, model, dispatch or control. */
export async function readPersonaGoalAdmission(personaId: string, admissionKey: string) {
  const scope = identity(personaId, admissionKey);
  const id = stableEnduringAgentId('goal', scope);
  return withPersonaDomainMutation(personaId, {}, async () => {
    const item = await getPersonaWorkItem(personaId, id);
    if (!item) return null;
    if (item.personaId !== personaId || item.parentGoalId || !item.goal || !item.goalCreateRequestDigest) {
      throw new PersonaDomainConflictError('Admission identity names a different WorkItem.');
    }
    const currentDigest = createHash('sha256').update(canonicalJson({ ...scope, input: {
      title: item.title, description: item.description, successCriteria: item.goal.successCriteria,
    } })).digest('hex');
    if (item.goalCreateRequestDigest !== currentDigest || item.goal.completionPolicy !== 'success_criteria') {
      throw new PersonaDomainConflictError('The original Goal admission intent changed.');
    }
    return projection(personaId, admissionKey, item);
  });
}

/** Persist the native Goal paused in the same save that creates it. */
export async function admitPausedPersonaGoal(personaId: string, admissionKey: string, input: PausedGoalAdmissionInput) {
  const scope = identity(personaId, admissionKey);
  const parsed = PausedGoalAdmissionInputSchema.parse(input);
  const requestDigest = createHash('sha256').update(canonicalJson({ ...scope, input: parsed })).digest('hex');
  const readExact = async () => {
    const receipt = await readPersonaGoalAdmission(personaId, admissionKey);
    if (receipt && receipt.goal.requestDigest !== requestDigest) {
      throw new PersonaDomainConflictError('Admission key already names a different Goal intent.');
    }
    return receipt;
  };
  const existing = await readExact();
  if (existing) return existing;
  try {
    await createPersonaWorkItem({
      id: stableEnduringAgentId('goal', scope), personaId,
      title: parsed.title, description: parsed.description,
      goal: { successCriteria: parsed.successCriteria, completionPolicy: 'success_criteria' },
    }, { initialGoalState: 'paused', goalCreateRequestDigest: requestDigest });
  } catch (error) {
    const committed = await readExact();
    if (committed) return committed;
    throw error;
  }
  const receipt = await readExact();
  if (!receipt) throw new PersonaDomainConflictError('Admission save requires independent reconciliation.');
  return receipt;
}
