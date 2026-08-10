import type { PersonaAttribution } from '@/shared/types/enduringAgent';
import type { FlowExecutionAuthority } from './types';

/**
 * A tagged run-level failure used at durable Flow mutation boundaries.
 *
 * Resource capture is intentionally best-effort for ordinary runs.  A lost
 * Persona/meeting fence is different: callers must not turn it into a harmless
 * capture warning and let a stale worker continue.  Tagging authority failures
 * lets those broad compatibility catches preserve their legacy behaviour while
 * still failing the authoritative run closed.
 */
export class FlowExecutionAuthorityError extends Error {
  readonly code = 'flow_execution_authority_lost';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FlowExecutionAuthorityError';
  }
}

export interface FlowDurableMutationContext {
  executionAuthority?: FlowExecutionAuthority;
  personaAttribution?: PersonaAttribution;
}

export function isFlowExecutionAuthorityError(
  error: unknown,
): error is FlowExecutionAuthorityError {
  return error instanceof FlowExecutionAuthorityError
    || (
      Boolean(error)
      && typeof error === 'object'
      && (error as { code?: unknown }).code === 'flow_execution_authority_lost'
    );
}

export function rethrowFlowExecutionAuthorityError(error: unknown): void {
  if (isFlowExecutionAuthorityError(error)) throw error;
}

function missingAuthorityError(): FlowExecutionAuthorityError {
  return new FlowExecutionAuthorityError(
    'Persona-attributed durable Flow mutation requires current execution authority.',
  );
}

/** Re-check a lease/generation immediately after a long provider/tool call. */
export async function assertFlowExecutionCurrent(
  context: FlowDurableMutationContext,
): Promise<void> {
  const { executionAuthority, personaAttribution } = context;
  if (personaAttribution && !executionAuthority) throw missingAuthorityError();
  if (!executionAuthority) return;
  try {
    await executionAuthority.assertCurrent();
  } catch (cause) {
    if (isFlowExecutionAuthorityError(cause)) throw cause;
    throw new FlowExecutionAuthorityError('Flow execution authority was lost.', { cause });
  }
}

/**
 * Commit a durable resource/lineage/event projection only while the owning
 * Persona lease or meeting generation is current.
 *
 * Production Persona and meeting authorities expose commitWhileCurrent, which
 * holds their cross-process lock for the complete mutation.  The assertion-only
 * fallback preserves older non-Persona integrations; Persona attribution fails
 * closed when the lock-capable authority is absent.
 */
export async function commitFlowDurableMutation<T>(
  context: FlowDurableMutationContext,
  task: () => Promise<T>,
): Promise<T> {
  const { executionAuthority, personaAttribution } = context;
  if (personaAttribution && !executionAuthority?.commitWhileCurrent) {
    throw missingAuthorityError();
  }
  if (!executionAuthority) return task();

  if (!executionAuthority.commitWhileCurrent) {
    await assertFlowExecutionCurrent(context);
    const result = await task();
    await assertFlowExecutionCurrent(context);
    return result;
  }

  let taskFailure: unknown;
  let taskFailed = false;
  try {
    return await executionAuthority.commitWhileCurrent(async () => {
      try {
        return await task();
      } catch (error) {
        taskFailed = true;
        taskFailure = error;
        throw error;
      }
    });
  } catch (cause) {
    // Preserve store/provider errors produced by the task itself.  Only failures
    // from acquiring/validating/releasing the authority become run-level fence
    // errors that best-effort capture catches must rethrow.
    if (taskFailed && cause === taskFailure) throw cause;
    if (isFlowExecutionAuthorityError(cause)) throw cause;
    throw new FlowExecutionAuthorityError('Flow durable mutation lost execution authority.', { cause });
  }
}
