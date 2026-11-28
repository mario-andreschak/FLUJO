// Validates a run request before any conversation state is loaded.
import { isFlowInvocationSource } from '@/backend/execution/flow/types';
import type { FlowRunInput } from './runFlowContract';
import {
  PersonaInstructionContextSchema,
} from '@/shared/types/enduringAgent';
import { assertInstructionContextAttribution, assertBehaviorSnapshotMatchesInstructionContext } from '@/backend/execution/flow/personaRunContract';
import type { PersonaInstructionContext } from '@/shared/types/enduringAgent';

/**
 * Checks what a run may be started with before anything is loaded: an
 * explicit invocation source, meeting coordination, Persona authority, Core
 * App refs and the frozen Persona instruction context. Returns the parsed
 * instruction context and the de-duplicated Core App refs.
 */
export function validateFlowRunInput(input: FlowRunInput): {
  personaInstructionContext: PersonaInstructionContext | undefined;
  personaCoreAppRefs: string[] | undefined;
} {
  if (!isFlowInvocationSource(input.source)) {
    throw new TypeError(
      `runFlow requires an explicit invocation source (${String(input.source)} is invalid)`,
    );
  }
  if (input.source === 'meeting' && (!input.meetingParticipant || !input.meetingTurn)) {
    throw new TypeError('Meeting flow runs require participant and turn coordination context.');
  }
  if (input.personaAttribution && !input.executionAuthority) {
    throw new TypeError('Persona-attributed flow runs require execution authority.');
  }
  const personaInstructionContext = input.personaInstructionContext
    ? PersonaInstructionContextSchema.parse(input.personaInstructionContext)
    : undefined;
  const rawPersonaCoreAppRefs = (input as { personaCoreAppRefs?: unknown }).personaCoreAppRefs;
  let personaCoreAppRefs: string[] | undefined;
  if (rawPersonaCoreAppRefs !== undefined) {
    if (
      !Array.isArray(rawPersonaCoreAppRefs)
      || rawPersonaCoreAppRefs.length > 128
      || rawPersonaCoreAppRefs.some((value) => typeof value !== 'string' || !value.trim())
    ) {
      throw new TypeError('Persona Core App refs must be an array of non-empty MCP config names.');
    }
    if (
      typeof input.executionAuthority?.authorizePersonaCoreMcp !== 'function'
      || !input.personaAttribution
      || !personaInstructionContext
    ) {
      throw new TypeError(
        'Persona Core App refs require top-level dispatcher authority, App authorization, and instruction context.',
      );
    }
    personaCoreAppRefs = Array.from(new Set(rawPersonaCoreAppRefs));
  }
  if (personaInstructionContext) {
    if (!input.executionAuthority) {
      throw new TypeError('Persona instruction context requires execution authority.');
    }
    assertInstructionContextAttribution(
      personaInstructionContext,
      input.personaAttribution,
      'Input',
    );
    if (input.source === 'subflow' || input.parentRunId || (input.depth ?? 0) > 0) {
      throw new TypeError('Persona instruction context is confined to its top-level Behavior run.');
    }
    if (!input.flowDefinition) {
      throw new TypeError('Persona instruction context requires its immutable Behavior snapshot.');
    }
    assertBehaviorSnapshotMatchesInstructionContext(
      input.flowDefinition,
      personaInstructionContext,
      'Input',
    );
  }

  return { personaInstructionContext, personaCoreAppRefs };
}
