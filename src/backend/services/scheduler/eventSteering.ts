import type { SharedState } from '@/backend/execution/flow/types';
import type { FlujoChatMessage } from '@/shared/types/chat';
import type { SubmitPersonaFlowDispatchInput } from '@/backend/services/enduringAgents/personaDispatcher';
import {
  enqueueSteeringMessage,
  watchSteeringDelivery,
  withdrawSteeringMessage,
} from '@/backend/execution/flow/steeringInbox';
import { isPersonaOwnedConversationState } from '@/backend/execution/flow/personaConversationOwnership';
import { getConversationStates } from '@/backend/execution/flow/conversationStateRegistry';
import {
  loadPersistedConversationState,
  personaRelatedAction,
} from '@/backend/execution/flow/conversationSteeringTarget';

/**
 * Steer an event from an MCP server into a conversation that is running
 * (#1401, plan PR 4). It uses the chat's mid-run path, so every model adapter
 * picks it up at its next safe point with no adapter changes.
 *
 * Delivery rules:
 * - Delivered means folded into the transcript (or durably admitted to a
 *   Persona's mailbox). The in-memory inbox alone never counts.
 * - The message id is stable per event, so a retry, a late fold or a restart
 *   never adds the event twice.
 * - While the run is busy the event stays queued in the conversation and the
 *   caller asks again later (bounded wait per attempt). When the conversation
 *   is no longer running, a leftover copy is taken back out first, and only
 *   then may the event start a new run.
 */
export type EventSteeringOutcome =
  | { kind: 'delivered'; via: 'run' | 'persona' | 'transcript' }
  | { kind: 'not-running' }
  | { kind: 'busy'; reason: string };

export type TriggerEventProvenance = NonNullable<FlujoChatMessage['triggerEvent']>;

export interface EventSteeringRequest {
  conversationId: string;
  /** Stable for this event and automation. */
  messageId: string;
  /** The automation's prompt plus the event as labelled, untrusted data. */
  content: string;
  provenance: TriggerEventProvenance;
}

export interface EventSteeringDeps {
  liveState: (conversationId: string) => SharedState | undefined;
  persistedState: (conversationId: string) => Promise<SharedState | undefined>;
  submitPersona: (input: SubmitPersonaFlowDispatchInput) => Promise<unknown>;
  /** How long one attempt waits for a running conversation to fold the event in. */
  waitMs?: number;
}

const DEFAULT_WAIT_MS = 15_000;

function pause(ms: number): Promise<'timeout'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), ms);
    timer.unref?.();
  });
}

function hasMessage(state: SharedState | undefined, messageId: string): boolean {
  return Array.isArray(state?.messages) && state.messages.some(message => message?.id === messageId);
}

export async function steerEventIntoConversation(
  deps: EventSteeringDeps,
  request: EventSteeringRequest,
): Promise<EventSteeringOutcome> {
  const { conversationId, messageId } = request;
  const live = deps.liveState(conversationId);
  const state = live ?? await deps.persistedState(conversationId);
  if (!state) return { kind: 'not-running' };
  // Folded before a crash or a lost acknowledgement: do not add it again.
  if (hasMessage(state, messageId)) return { kind: 'delivered', via: 'transcript' };

  const message: FlujoChatMessage = {
    id: messageId,
    role: 'user',
    content: request.content,
    timestamp: Date.now(),
    injected: true,
    triggerEvent: request.provenance,
  };

  if (isPersonaOwnedConversationState(state)) {
    // Persona conversations have a durable mailbox. Admission is the delivery.
    if (state.personaArchived || !state.personaAttribution) return { kind: 'not-running' };
    const relatedAction = personaRelatedAction(state);
    if (!relatedAction) return { kind: 'not-running' };
    try {
      await deps.submitPersona({
        personaId: state.personaAttribution.personaId,
        idempotencyKey: `mcp-event:${messageId}`,
        kind: 'triggered',
        source: { kind: 'trigger', sourceId: request.provenance.executionId },
        relationKey: conversationId,
        relatedAction,
        summary: `Event from ${request.provenance.serverName}`,
        flowInput: {
          // A constant keeps identical retries hash-identical; the dispatcher
          // stamps its durable time before delivery.
          messages: [{ ...message, timestamp: 0 }],
          mode: 'conversation',
          conversationId,
          userTurn: true,
          source: 'trigger',
        },
      });
      return { kind: 'delivered', via: 'persona' };
    } catch (error) {
      return { kind: 'busy', reason: error instanceof Error ? error.message : String(error) };
    }
  }

  // Ordinary conversations: only a run executing in this process drains the inbox.
  if (!live || live.status !== 'running') {
    // A run that ended before its last safe point may have left this event
    // behind. Take it back, so it cannot also reach the next turn later.
    withdrawSteeringMessage(conversationId, messageId);
    return { kind: 'not-running' };
  }
  const watch = watchSteeringDelivery(conversationId, messageId);
  try {
    // Idempotent by id: a retry while the first copy waits adds nothing.
    enqueueSteeringMessage(conversationId, message);
    const outcome = await Promise.race([
      watch.delivered.then(() => 'delivered' as const),
      pause(deps.waitMs ?? DEFAULT_WAIT_MS),
    ]);
    if (outcome === 'delivered' || hasMessage(deps.liveState(conversationId), messageId)) {
      return { kind: 'delivered', via: 'run' };
    }
    // The run is inside a long step. The event stays queued in the conversation
    // and is folded in at the next safe point (the run also drains before it
    // ends). The caller asks again later; the stable id prevents a second copy.
    return { kind: 'busy', reason: 'The conversation has not reached a safe point yet' };
  } finally {
    watch.cancel();
  }
}

/** The live wiring: this process's running conversations and the Persona dispatcher. */
export async function steerEventWithRuntime(request: EventSteeringRequest): Promise<EventSteeringOutcome> {
  // Lazy: the dispatcher is heavy, and most events never steer.
  const { submitPersonaFlowDispatch } = await import('@/backend/services/enduringAgents/personaDispatcher');
  return steerEventIntoConversation({
    liveState: conversationId => getConversationStates().get(conversationId),
    persistedState: loadPersistedConversationState,
    submitPersona: input => submitPersonaFlowDispatch(input, { waitForCompletion: false }),
  }, request);
}
