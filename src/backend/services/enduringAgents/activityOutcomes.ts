import { z } from 'zod';

import {
  PERSONA_ACTIVITY_BLOCKER_KINDS,
  PERSONA_ACTIVITY_OUTCOME_RESOLUTIONS,
  PersonaActivityOutcomeSchema,
  type PersonaActivityOutcome,
} from '@/shared/types/enduringAgent';

import {
  PersonaDomainConflictError,
  withPersonaDomainMutation,
  type PersonaDomainMutationOptions,
} from './domainMutation';
import { getPersonaRuntimeClock } from './runtimeClock';
import { savePersonaActivity } from './store';

const ReportActivityOutcomeSchema = z.object({
  resolution: z.enum(PERSONA_ACTIVITY_OUTCOME_RESOLUTIONS),
  summary: z.string().trim().min(1).max(2_000),
  nextAction: z.string().trim().min(1).max(2_000).optional(),
  blockerKind: z.enum(PERSONA_ACTIVITY_BLOCKER_KINDS).optional(),
  goalAchieved: z.boolean().optional(),
  retryAfterMs: z.number().int().nonnegative().max(7 * 24 * 60 * 60 * 1_000).optional(),
}).strict().superRefine((input, ctx) => {
  if (input.goalAchieved && input.resolution !== 'succeeded') {
    ctx.addIssue({ code: 'custom', path: ['goalAchieved'], message: 'Goal achievement requires a succeeded outcome.' });
  }
  if (input.resolution !== 'succeeded' && !input.nextAction) {
    ctx.addIssue({ code: 'custom', path: ['nextAction'], message: 'Unfinished work must include a concrete next action.' });
  }
});

export type ReportPersonaActivityOutcomeInput = z.infer<typeof ReportActivityOutcomeSchema>;

/**
 * Record a model's explicit result under its current Activity fence. Reporting
 * never releases the lease or finishes the Flow. A later runtime error or stop
 * still overrides this claim at the authoritative terminal transition.
 */
export async function reportPersonaActivityOutcome(
  personaId: string,
  activityId: string,
  value: ReportPersonaActivityOutcomeInput,
  options: PersonaDomainMutationOptions,
): Promise<PersonaActivityOutcome> {
  if (!options.executionAuthority) {
    throw new PersonaDomainConflictError('Reporting an Activity outcome requires its live execution authority.');
  }
  const input = ReportActivityOutcomeSchema.parse(value);
  return withPersonaDomainMutation(personaId, options, async ({ activity }) => {
    if (!activity || activity.id !== activityId || activity.status !== 'running') {
      throw new PersonaDomainConflictError('An outcome can only be reported for the owning running Activity.');
    }
    const now = Math.max(getPersonaRuntimeClock().now(), activity.updatedAt + 1);
    const outcome = PersonaActivityOutcomeSchema.parse({
      schemaVersion: 1,
      ...input,
      decisionSource: 'persona_claim',
      evidenceRefs: [{
        kind: 'activity',
        id: activity.id,
        ...(activity.conversationId ? { uri: `flujo://conversation/${activity.conversationId}` } : {}),
      }],
      decidedAt: now,
    }) as PersonaActivityOutcome;
    await savePersonaActivity({ ...activity, reportedOutcome: outcome, updatedAt: now });
    return outcome;
  });
}
