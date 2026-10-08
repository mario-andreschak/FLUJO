import {
  ActivateBehaviorRevisionInputSchema,
  PersonaSchema,
  UpdatePersonaInputSchema,
  type ActivateBehaviorRevisionInput,
  type BehaviorBinding,
  type BehaviorRevision,
  type Persona,
  type PersonaPresentation,
  type UpdatePersonaInput,
} from '@/shared/types/enduringAgent';

import {
  PersonaDomainConflictError,
  PersonaDomainNotFoundError,
  withPersonaDomainMutation,
} from './domainMutation';
import {
  BehaviorBindingActivationConflictError,
  BehaviorBindingActivationNotFoundError,
  activateBehaviorBindingRevision,
  getBehaviorRevision,
  getRoleVersion,
} from './store';

function editablePresentation(
  current: PersonaPresentation | undefined,
  patch: UpdatePersonaInput['presentation'],
): PersonaPresentation | undefined {
  if (!patch) return current;
  const next = { ...current };
  for (const field of ['avatarUrl', 'language'] as const) {
    const value = patch[field];
    if (value === null || value === '') delete next[field];
    else if (value !== undefined) next[field] = value;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function withoutLegacyRoleOverride(persona: Persona): Persona['composition'] {
  if (!persona.composition?.role) return persona.composition;
  const { role: _legacyRole, ...composition } = persona.composition;
  return Object.keys(composition).length > 0 ? composition : undefined;
}

/** Idle-only administrative settings update used by the Persona desk. */
export async function updatePersonaSettings(
  personaId: string,
  value: unknown,
): Promise<Persona> {
  const patch = UpdatePersonaInputSchema.parse(value) as UpdatePersonaInput;
  return withPersonaDomainMutation(personaId, {
    ...(patch.roleVersionId !== undefined
      ? { nextRoleVersionId: patch.roleVersionId }
      : {}),
  }, async ({ persona, updatePersona }) => {
    if (
      patch.expectedUpdatedAt !== undefined
      && patch.expectedUpdatedAt !== persona.updatedAt
    ) {
      throw new PersonaDomainConflictError('Persona settings changed since they were inspected.');
    }
    if (persona.provisioningState === 'pending') {
      throw new PersonaDomainConflictError('Persona settings cannot change while provisioning is pending.');
    }
    if (patch.roleVersionId !== undefined) {
      if (patch.expectedUpdatedAt === undefined) {
        throw new PersonaDomainConflictError(
          'Reload this Persona before choosing a different Role.',
        );
      }
      const roleVersion = await getRoleVersion(patch.roleVersionId);
      if (!roleVersion) {
        throw new PersonaDomainNotFoundError('RoleVersion', patch.roleVersionId);
      }
      if (!roleVersion.behaviorSlots.some((slot) => slot.key === 'primary')) {
        throw new PersonaDomainConflictError(
          'This Role cannot take responsibility for the Persona’s main work.',
        );
      }
    }

    const presentation = editablePresentation(persona.presentation, patch.presentation);
    return updatePersona(PersonaSchema.parse({
      ...persona,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.roleVersionId !== undefined
        ? {
            roleVersionId: patch.roleVersionId,
            composition: withoutLegacyRoleOverride(persona),
          }
        : {}),
      ...(patch.mission === null
        ? { mission: undefined }
        : patch.mission !== undefined ? { mission: patch.mission } : {}),
      ...(presentation ? { presentation } : { presentation: undefined }),
      ...(patch.autonomyLevel !== undefined ? { autonomyLevel: patch.autonomyLevel } : {}),
      ...(patch.interruptionPolicy !== undefined
        ? { interruptionPolicy: patch.interruptionPolicy }
        : {}),
      ...(patch.lifecycleState !== undefined ? { lifecycleState: patch.lifecycleState } : {}),
      updatedAt: Math.max(Date.now(), persona.updatedAt + 1),
    }));
  });
}

export interface ActivatedPersonaBehavior {
  binding: BehaviorBinding;
  revision: BehaviorRevision;
}

/** Idle-only, reversible Behavior activation over immutable revision evidence. */
export async function activatePersonaBehaviorRevision(
  personaId: string,
  behaviorId: string,
  value: unknown,
): Promise<ActivatedPersonaBehavior> {
  const input = ActivateBehaviorRevisionInputSchema.parse(value) as ActivateBehaviorRevisionInput;
  return withPersonaDomainMutation(personaId, {}, async () => {
    const revision = await getBehaviorRevision(input.revisionId);
    if (!revision) throw new PersonaDomainNotFoundError('BehaviorRevision', input.revisionId);
    try {
      const binding = await activateBehaviorBindingRevision({
        personaId,
        behaviorId,
        revisionId: revision.id,
        expectedActiveRevisionId: input.expectedActiveRevisionId,
      });
      return { binding, revision };
    } catch (error) {
      if (error instanceof BehaviorBindingActivationNotFoundError) {
        throw new PersonaDomainNotFoundError(error.recordKind, error.recordId);
      }
      if (error instanceof BehaviorBindingActivationConflictError) {
        throw new PersonaDomainConflictError(error.message);
      }
      throw error;
    }
  });
}
