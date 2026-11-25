import type { FlowUseChoice } from '@/shared/types/flow/flowUsage';
import {
  PersonaSchema,
  type Persona,
  type PersonaBehaviorComposition,
  type PersonaCompositionPreferences,
  type PersonaFlowBinding,
} from '@/shared/types/enduringAgent';
import { retryTransientFileOperation } from '@/utils/transientFileRetry';

import {
  PersonaDomainBusyError,
  PersonaDomainConflictError,
  withPersonaDomainMutation,
} from './domainMutation';
import {
  assertBindingOwnership,
  effectiveFlowRef,
  normalizeBehaviorBinding,
} from './personaComposition';
import { getRoleVersion, listBehaviorBindings } from './store';

/**
 * Letting a Persona give up one flow before that flow is deleted (#1389).
 * Everything one Persona changes is a single Persona record write, so a crash
 * either keeps the old binding or has the new one, never half of each.
 */

export interface PersonaBehaviorPlace {
  ref: string;
  name: string;
  slotKey?: string;
  /** The Persona's Role needs this part, so it can only switch to another flow. */
  required: boolean;
  suggestedFlowId?: string;
}

export interface PersonaFlowPlaces {
  /** Set when the Persona's main flow is this flow. */
  core?: { suggestedFlowId?: string };
  behaviors: PersonaBehaviorPlace[];
  /** The Persona runs its own copy whose noted source is this flow. */
  copySource: boolean;
}

export interface PersonaFlowAnswers {
  core?: FlowUseChoice;
  /** By Behavior ref. */
  behaviors: Record<string, FlowUseChoice>;
}

export interface PersonaFlowReleaseResult {
  changed: boolean;
  paused: boolean;
}

/** The waits while a Persona finishes its current work: about 15 s in total. */
const BUSY_RETRY_DELAYS_MS = Object.freeze([250, 500, 1000, 2000, 4000, 7500]);

function coreBindingOf(composition: PersonaCompositionPreferences | undefined): PersonaFlowBinding | undefined {
  return composition?.coreBinding
    ?? (composition?.coreFlowRef ? { mode: 'shared', sharedFlowRef: composition.coreFlowRef } : undefined);
}

function copySourceOf(binding: PersonaFlowBinding | null | undefined, flowId: string): boolean {
  return binding?.mode === 'persona_copy' && binding.sharedFlowRef === flowId && binding.personaFlowRef !== flowId;
}

function suggestionOf(binding: PersonaFlowBinding, flowId: string): string | undefined {
  return binding.mode === 'persona_copy' && binding.sharedFlowRef && binding.sharedFlowRef !== flowId
    ? binding.sharedFlowRef
    : undefined;
}

/** Where `persona` uses `flowId`. Role slot keys tell which Behaviors the Role needs. */
export function personaFlowPlaces(
  persona: Pick<Persona, 'composition'>,
  flowId: string,
  requiredSlotKeys: ReadonlySet<string>,
  slotKeyByRef: ReadonlyMap<string, string> = new Map(),
): PersonaFlowPlaces {
  const composition = persona.composition;
  const coreBinding = coreBindingOf(composition);
  const coreRuns = (coreBinding && effectiveFlowRef(coreBinding) === flowId) || composition?.coreFlowRef === flowId;
  let copySource = copySourceOf(coreBinding, flowId);
  const behaviors: PersonaBehaviorPlace[] = [];
  for (const behavior of composition?.behaviors ?? []) {
    const binding = normalizeBehaviorBinding(behavior);
    if (binding && effectiveFlowRef(binding) === flowId) {
      const slotKey = behavior.slotKey ?? slotKeyByRef.get(behavior.ref);
      const suggestedFlowId = suggestionOf(binding, flowId);
      behaviors.push({
        ref: behavior.ref,
        name: behavior.name,
        ...(slotKey ? { slotKey } : {}),
        required: slotKey !== undefined && requiredSlotKeys.has(slotKey),
        ...(suggestedFlowId ? { suggestedFlowId } : {}),
      });
    } else if (copySourceOf(binding, flowId)) {
      copySource = true;
    }
  }
  const suggestedCore = coreRuns && coreBinding ? suggestionOf(coreBinding, flowId) : undefined;
  return {
    ...(coreRuns ? { core: suggestedCore ? { suggestedFlowId: suggestedCore } : {} } : {}),
    behaviors,
    copySource,
  };
}

export function personaUsesFlow(places: PersonaFlowPlaces): boolean {
  return Boolean(places.core) || places.behaviors.length > 0 || places.copySource;
}

/** Role slot keys and the slot key behind each Behavior ref, for {@link personaFlowPlaces}. */
export async function personaRoleSlots(persona: Persona): Promise<{
  requiredSlotKeys: Set<string>;
  slotKeyByRef: Map<string, string>;
}> {
  const [roleVersion, bindings] = await Promise.all([
    getRoleVersion(persona.roleVersionId),
    listBehaviorBindings(persona.id),
  ]);
  return {
    requiredSlotKeys: new Set(roleVersion?.behaviorSlots.map((slot) => slot.key) ?? []),
    slotKeyByRef: new Map(bindings.map((binding) => [binding.id, binding.slotKey])),
  };
}

function withoutSource(binding: Extract<PersonaFlowBinding, { mode: 'persona_copy' }>): PersonaFlowBinding {
  return { mode: 'persona_copy', personaFlowRef: binding.personaFlowRef };
}

function behaviorWithBinding(behavior: PersonaBehaviorComposition, binding: PersonaFlowBinding): PersonaBehaviorComposition {
  const { sourceFlowRef: _source, overrideFlowRef: _override, binding: _binding, ...rest } = behavior;
  return {
    ...rest,
    binding,
    ...(binding.sharedFlowRef ? { sourceFlowRef: binding.sharedFlowRef } : {}),
    ...(binding.mode === 'persona_copy' ? { overrideFlowRef: binding.personaFlowRef } : {}),
  };
}

function unanswered(personaName: string): never {
  throw new PersonaDomainConflictError(
    `Persona "${personaName}" started using this flow in another place. Check the choices again.`,
    'FLOW_USE_CHANGED',
  );
}

/**
 * Apply the person's answers for one Persona: switch each place to another
 * flow, or take the flow away (a Persona without a main flow is paused). The
 * note of where an own copy came from is dropped so its "go back to the shared
 * flow" button never points at a missing flow. Waits while the Persona finishes
 * its current work.
 */
export async function releasePersonaFlow(
  personaId: string,
  flowId: string,
  answers: PersonaFlowAnswers,
): Promise<PersonaFlowReleaseResult> {
  return retryTransientFileOperation(() => withPersonaDomainMutation(personaId, {}, async ({ persona, updatePersona }) => {
    if (persona.provisioningState === 'pending') {
      throw new PersonaDomainConflictError(`Persona "${persona.name}" is still being set up. Try again in a moment.`);
    }
    const { requiredSlotKeys, slotKeyByRef } = await personaRoleSlots(persona);
    const places = personaFlowPlaces(persona, flowId, requiredSlotKeys, slotKeyByRef);
    if (!personaUsesFlow(places)) return { changed: false, paused: false };

    const composition: PersonaCompositionPreferences = { ...persona.composition };
    let paused = false;

    if (places.core) {
      const answer = answers.core ?? unanswered(persona.name);
      if ('replaceWith' in answer) {
        await assertBindingOwnership(persona.id, { mode: 'shared', sharedFlowRef: answer.replaceWith });
        composition.coreBinding = { mode: 'shared', sharedFlowRef: answer.replaceWith };
        composition.coreFlowRef = answer.replaceWith;
      } else {
        delete composition.coreBinding;
        delete composition.coreFlowRef;
        paused = persona.lifecycleState !== 'disabled';
      }
    } else if (composition.coreBinding?.mode === 'persona_copy' && copySourceOf(composition.coreBinding, flowId)) {
      composition.coreBinding = withoutSource(composition.coreBinding);
    }

    if (composition.behaviors) {
      const next: PersonaBehaviorComposition[] = [];
      for (const behavior of composition.behaviors) {
        const place = places.behaviors.find((candidate) => candidate.ref === behavior.ref);
        const binding = normalizeBehaviorBinding(behavior);
        if (place) {
          const answer = answers.behaviors[behavior.ref] ?? unanswered(persona.name);
          if ('replaceWith' in answer) {
            await assertBindingOwnership(persona.id, { mode: 'shared', sharedFlowRef: answer.replaceWith });
            next.push(behaviorWithBinding(behavior, { mode: 'shared', sharedFlowRef: answer.replaceWith }));
          } else if (place.required) {
            throw new PersonaDomainConflictError(
              `Persona "${persona.name}" needs "${behavior.name}" for its Role. Choose another flow for it.`,
              'FLOW_USE_CHANGED',
            );
          }
        } else if (binding?.mode === 'persona_copy' && copySourceOf(binding, flowId)) {
          next.push(behaviorWithBinding(behavior, withoutSource(binding)));
        } else {
          next.push(behavior);
        }
      }
      composition.behaviors = next;
    }

    await updatePersona(PersonaSchema.parse({
      ...persona,
      composition,
      ...(paused ? { lifecycleState: 'sleeping' } : {}),
      updatedAt: Math.max(Date.now(), persona.updatedAt + 1),
    }));
    return { changed: true, paused };
  }), {
    delaysMs: BUSY_RETRY_DELAYS_MS,
    isTransient: (error) => error instanceof PersonaDomainBusyError,
  });
}
