// Loads the conversation a run continues and checks that this run may continue it.
import {
  validateExecutionLoadedState,
  installExecutionExtensionContext,
  assertExecutionStateAccess,
  ExecutionExtensionError,
} from '@/backend/execution/extensions';
import { createLogger } from '@/utils/logger';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { recoverMessagesFromLog } from '@/backend/execution/flow/conversationLog';
import { SharedState } from '@/backend/execution/flow/types';
import { loadItem as loadItemBackend } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { reconcileInterruptedRecovery } from '@/backend/execution/flow/recoveryCheckpoint';
import type { FlowRunInput } from './runFlowContract';
import { normalizeRecoveredBehaviorRules } from './personaActivityState';
import {
  PersonaInstructionContextSchema,
} from '@/shared/types/enduringAgent';
import {
  instructionContextsEqual,
  assertInstructionContextAttribution,
  assertBehaviorSnapshotMatchesInstructionContext,
} from '@/backend/execution/flow/personaRunContract';
import type { PersonaInstructionContext } from '@/shared/types/enduringAgent';

const log = createLogger('backend/execution/flow/runStateLoading');

/** Where a run's state came from: live memory, saved storage, or a new conversation. */
export type RunStateSource = 'storage' | 'memory' | 'new';

/**
 * Loads the conversation a run continues: the live in-memory state first,
 * otherwise the saved snapshot (never for an ephemeral run), folding in log
 * entries the snapshot missed and reconciling interrupted recovery. Checks
 * execution access and installs the execution extension on what it loads.
 */
export async function loadRunState(
  input: FlowRunInput,
  effectiveConvId: string,
  storageKey: StorageKey,
  ephemeral: boolean,
): Promise<{ loadedState: SharedState | undefined; stateSource: RunStateSource }> {
  let stateSource: RunStateSource = 'new';
  let loadedState: SharedState | undefined = undefined;
  // Prioritize in-memory state.
  if (FlowExecutor.conversationStates.has(effectiveConvId)) {
    loadedState = FlowExecutor.conversationStates.get(effectiveConvId)!;
    log.info(`Resuming conversation ${effectiveConvId} from memory`, { currentNodeId: loadedState.currentNodeId });
    stateSource = 'memory';
  }
  // If not in memory, try storage — but never for an ephemeral run (it must stay
  // transient and never adopt a persisted conversation).
  else if (!ephemeral) {
    try {
      loadedState = await loadItemBackend<SharedState | undefined>(storageKey, undefined);
      if (loadedState) {
        await assertExecutionStateAccess(loadedState, effectiveConvId);
        if (input.executionExtensionContext) {
          await validateExecutionLoadedState(input.executionExtensionContext, loadedState);
          installExecutionExtensionContext(loadedState, input.executionExtensionContext);
        }
        log.info(`Loaded conversation state from storage: ${effectiveConvId}`);
        stateSource = 'storage';
        const mayRecoverPersonaState = !loadedState.personaAttribution || (
          input.personaAttribution?.personaId === loadedState.personaAttribution.personaId
          && Boolean(input.executionAuthority)
        );
        if (loadedState.personaAttribution && mayRecoverPersonaState) {
          Object.defineProperty(loadedState, 'executionAuthority', {
            value: input.executionAuthority,
            enumerable: false,
            configurable: true,
            writable: true,
          });
        }
        if (mayRecoverPersonaState) {
          // Per-step durability lives in the append-only log; the snapshot is
          // only written at run boundaries. Fold in anything it missed (e.g. a
          // crash mid-run after messages were streamed/appended). Persona
          // recovery happens only after the dispatcher authority is installed.
          await recoverMessagesFromLog(loadedState);
          await reconcileInterruptedRecovery(storageKey, loadedState);
          FlowExecutor.conversationStates.set(effectiveConvId, loadedState);
        }
      } else {
        log.info(`No state found in storage for conversation: ${effectiveConvId}. Will create new state.`);
      }
    } catch (error) {
      if (error instanceof ExecutionExtensionError) throw error;
      log.warn(`Error loading conversation state from storage for ${effectiveConvId}:`, error);
    }
  }

  if (loadedState) {
    await assertExecutionStateAccess(loadedState, effectiveConvId);
    if (input.executionExtensionContext) {
      await validateExecutionLoadedState(input.executionExtensionContext, loadedState);
      installExecutionExtensionContext(loadedState, input.executionExtensionContext);
    }
    normalizeRecoveredBehaviorRules(loadedState);
  }

  return { loadedState, stateSource };
}

/**
 * Refuses to continue a loaded conversation the run may not touch: an
 * anonymized Persona archive, a participant reserved by an active meeting,
 * changed Persona instructions within one Activity, or a Persona-owned or
 * Persona-targeted conversation resumed outside its dispatcher. Returns true
 * when a new Activity must rebuild the Persona prompt prefix.
 */
export async function assertLoadedStateMayRun(
  loadedState: SharedState | undefined,
  input: FlowRunInput,
  effectiveConvId: string,
  personaInstructionContext: PersonaInstructionContext | undefined,
): Promise<boolean> {
  if (loadedState?.personaArchived) {
    throw new Error(
      `Conversation ${effectiveConvId} is an anonymized Persona archive and cannot be executed.`,
    );
  }

  // Meeting participant conversations remain inspectable, but an ordinary
  // chat/API run must not mutate their memory while their owning meeting can
  // still schedule another turn. The shared execution lease above makes this
  // check race-free with an in-flight participant turn.
  if (loadedState?.meetingParticipant && input.source !== 'meeting') {
    const { getMeeting } = await import('@/backend/services/meetings/store');
    const owner = await getMeeting(loadedState.meetingParticipant.meetingId);
    if (
      owner
      && owner.status !== 'completed'
      && owner.status !== 'cancelled'
      && owner.status !== 'error'
    ) {
      throw new Error(
        `Conversation ${effectiveConvId} is reserved by active meeting ${owner.id}.`,
      );
    }
  }

  const loadedInstructionContext = loadedState?.personaInstructionContext
    ? PersonaInstructionContextSchema.parse(loadedState.personaInstructionContext)
    : undefined;
  let resetPersonaPromptPrefix = false;
  if (loadedInstructionContext) {
    assertInstructionContextAttribution(
      loadedInstructionContext,
      loadedState?.personaAttribution,
      'Persisted',
    );
    if (loadedState?.flowId !== loadedInstructionContext.rootFlowId) {
      throw new Error(
        `Conversation ${effectiveConvId} has Persona instructions for a different Behavior root Flow.`,
      );
    }
    if (!loadedState.flowSnapshot) {
      throw new Error(
        `Conversation ${effectiveConvId} is missing its frozen Persona Behavior snapshot.`,
      );
    }
    assertBehaviorSnapshotMatchesInstructionContext(
      loadedState.flowSnapshot,
      loadedInstructionContext,
      'Persisted',
    );
    if (!personaInstructionContext) {
      throw new Error(
        `Conversation ${effectiveConvId} must resume with its frozen Persona instruction context.`,
      );
    }
    if (loadedInstructionContext.activityId === personaInstructionContext.activityId) {
      if (!instructionContextsEqual(loadedInstructionContext, personaInstructionContext)) {
        throw new Error(
          `Conversation ${effectiveConvId} Persona instruction context changed within one Activity.`,
        );
      }
    } else {
      // A new leased Activity for the same Persona may install a newly resolved
      // context. Its system prefix and native provider session must be rebuilt;
      // approval/debug/recovery continuations keep the same Activity and never
      // enter this branch.
      resetPersonaPromptPrefix = true;
    }
  } else if (personaInstructionContext && loadedState) {
    // This is either the first context-aware Activity on an older conversation
    // or a deliberately context-free legacy Activity's successor. runFlow never
    // resolves/backfills historical data; it only accepts the dispatcher pin.
    resetPersonaPromptPrefix = true;
  }

  // A Persona-owned conversation may only be resumed by the trusted
  // dispatcher after it reacquires an Activity lease. This blocks legacy
  // debug/approval/chat paths from accidentally continuing Persona work with
  // no fence. A later Activity for the same Persona may intentionally replace
  // the previous activity/revision attribution on a new turn.
  if (loadedState?.personaAttribution) {
    if (!input.personaAttribution || !input.executionAuthority) {
      throw new Error(
        `Conversation ${effectiveConvId} is Persona-owned and must be resumed through the Persona dispatcher.`,
      );
    }
    if (loadedState.personaAttribution.personaId !== input.personaAttribution.personaId) {
      throw new Error(`Conversation ${effectiveConvId} belongs to a different Persona.`);
    }
    Object.defineProperty(loadedState, 'executionAuthority', {
      value: input.executionAuthority,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  if (loadedState?.personaTargetId) {
    if (!input.personaAttribution || !input.executionAuthority) {
      throw new Error(
        `Conversation ${effectiveConvId} is targeted to a Persona and must start through the Persona dispatcher.`,
      );
    }
    if (loadedState.personaTargetId !== input.personaAttribution.personaId) {
      throw new Error(`Conversation ${effectiveConvId} is targeted to a different Persona.`);
    }
  }

  return resetPersonaPromptPrefix;
}
