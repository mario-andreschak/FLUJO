import { createHash } from 'node:crypto';
import { z } from 'zod';

import {
  CreatePersonaWorkItemInputSchema,
  type CreatePersonaWorkItemInput,
  type PersonaWorkItem,
} from '@/shared/types/enduringAgent';
import { getCurrentWorkspace } from '@/utils/workspace';

import { PersonaDomainConflictError, type PersonaDomainMutationOptions, withPersonaDomainMutation } from './domainMutation';
import { stableEnduringAgentId } from './ids';
import { getPersonaWorkItem } from './store';
import { createPersonaWorkItem } from './workItems';

export interface CreatePersonaGoalResult {
  created: boolean;
  item: PersonaWorkItem;
}

/**
 * Register one same-Persona Goal from a trusted Activity. Its caller key names
 * the durable root; the digest prevents that key from silently changing intent.
 * Registration is distinct from a dispatched or completed Goal round.
 */
export async function createPersonaGoalWorkItem(
  input: CreatePersonaWorkItemInput & { idempotencyKey: string },
  options: PersonaDomainMutationOptions,
): Promise<CreatePersonaGoalResult> {
  if (!options.executionAuthority) {
    throw new PersonaDomainConflictError('Goal creation requires current Activity authority.');
  }
  const { idempotencyKey, ...request } = input;
  const key = z.string().trim().min(1).max(512).parse(idempotencyKey);
  const parsed = CreatePersonaWorkItemInputSchema.parse(request) as CreatePersonaWorkItemInput;
  if (!parsed.goal || parsed.parentGoalId || parsed.id) {
    throw new PersonaDomainConflictError('Create an independent Goal root with explicit success criteria.');
  }
  const id = stableEnduringAgentId('goal', {
    purpose: 'persona-goal-create-v1',
    workspaceId: getCurrentWorkspace(),
    personaId: parsed.personaId,
    callerKey: key,
  });
  const digest = createHash('sha256').update(JSON.stringify({
    title: parsed.title,
    description: parsed.description,
    goal: parsed.goal,
    priority: parsed.priority ?? 'normal',
    dependencyIds: parsed.dependencyIds ?? [],
    nextAction: parsed.nextAction,
    deadline: parsed.deadline,
  })).digest('hex');

  const readReceipt = async (): Promise<PersonaWorkItem | null> => {
    const item = await withPersonaDomainMutation(parsed.personaId, options, async ({ activity }) => {
      if (!activity) throw new PersonaDomainConflictError('Goal access crossed Activity ownership.');
      return getPersonaWorkItem(parsed.personaId, id);
    });
    if (!item) return null;
    if (!item.goal || item.goalCreateRequestDigest !== digest) {
      throw new PersonaDomainConflictError('Caller key already names a different Goal request.');
    }
    return item;
  };

  const existing = await readReceipt();
  if (existing) return { created: false, item: existing };
  try {
    const item = await createPersonaWorkItem({ ...parsed, id }, {
      ...options,
      goalCreateRequestDigest: digest,
    });
    return { created: true, item };
  } catch (error) {
    // A save can commit before its caller receives the acknowledgement.
    const receipt = await readReceipt();
    if (receipt) return { created: false, item: receipt };
    throw error;
  }
}
