import type {
  FlowExecutionAuthority,
  PersonaActivityMutationContext,
} from '@/backend/execution/flow/types';

import {
  getPersona,
  getPersonaDeletionTombstone,
  getPersonaLease,
  updatePersonaWithinRuntimeLock,
} from './store';
import { withPersonaRuntimeLock } from './runtimeLock';

export class PersonaDomainNotFoundError extends Error {
  readonly code = 'PERSONA_DOMAIN_NOT_FOUND';

  constructor(readonly recordKind: string, readonly recordId: string) {
    super(`${recordKind} ${JSON.stringify(recordId)} was not found.`);
    this.name = 'PersonaDomainNotFoundError';
  }
}

export class PersonaDomainConflictError extends Error {
  readonly code = 'PERSONA_DOMAIN_CONFLICT';

  constructor(message: string) {
    super(message);
    this.name = 'PersonaDomainConflictError';
  }
}

export class PersonaDomainBusyError extends Error {
  readonly code = 'PERSONA_DOMAIN_BUSY';

  constructor(readonly personaId: string) {
    super(`Persona ${JSON.stringify(personaId)} has an active Activity lease.`);
    this.name = 'PersonaDomainBusyError';
  }
}

export interface PersonaDomainMutationOptions {
  /** Present only inside a trusted Persona Flow/meeting execution. */
  executionAuthority?: FlowExecutionAuthority;
}

/**
 * Serialize a Persona-owned memory/WorkItem mutation with either the exact live
 * Activity generation or an idle, strict-local administrative operation.
 */
export async function withPersonaDomainMutation<T>(
  personaId: string,
  options: PersonaDomainMutationOptions,
  task: (context: PersonaActivityMutationContext) => Promise<T>,
): Promise<T> {
  if (options.executionAuthority) {
    const commit = options.executionAuthority.commitPersonaMutation;
    if (!commit) {
      throw new PersonaDomainConflictError(
        'Persona domain mutation requires lock-capable Activity authority.',
      );
    }
    return commit(async (context) => {
      if (context.persona.id !== personaId || context.activity?.personaId !== personaId) {
        throw new PersonaDomainConflictError('Persona mutation authority crossed actor ownership.');
      }
      return task(context);
    });
  }

  return withPersonaRuntimeLock(personaId, async (lock) => {
    const persona = await getPersona(personaId);
    if (!persona || await getPersonaDeletionTombstone(personaId)) {
      throw new PersonaDomainNotFoundError('Persona', personaId);
    }
    const lease = await getPersonaLease(personaId);
    if (lease?.status === 'active' && lease.expiresAt > Date.now()) {
      throw new PersonaDomainBusyError(personaId);
    }
    return task({
      persona,
      updatePersona: (next) => updatePersonaWithinRuntimeLock(next, lock),
    });
  });
}
