import { ConversationLogReadPressureError } from '@/backend/execution/flow/conversationLogReadAdmission';
import type { SharedState } from '@/backend/execution/flow/types';
import type { StorageKey } from '@/shared/types/storage';
import { assertSafeCollectionId, loadItem as loadItemBackend } from '@/utils/storage/backend';

/**
 * Shared by everything that hands a message to a conversation that may be
 * running: the chat's mid-run inject route and events steered by automations
 * (#1401). One place decides "is it running, and through which path".
 */
export type PersonaRelatedAction = 'steer' | 'coalesce';

export async function loadPersistedConversationState(conversationId: string): Promise<SharedState | undefined> {
  try {
    assertSafeCollectionId(conversationId);
    return await loadItemBackend<SharedState>(
      `conversations/${conversationId}` as StorageKey,
      undefined as never,
    );
  } catch (error) {
    if (error instanceof ConversationLogReadPressureError) throw error;
    // Keep the existing not-running boundary for unsafe ids and storage
    // failures. In particular, do not adopt a persisted legacy state into the
    // live map: only an executing local loop may drain the legacy inbox.
    return undefined;
  }
}

/** How a Persona conversation takes related input right now, if at all. */
export function personaRelatedAction(state: SharedState): PersonaRelatedAction | undefined {
  if (state.status === 'running') return 'steer';
  if (state.status === 'awaiting_tool_approval' || state.status === 'paused_debug') {
    return 'coalesce';
  }
  return undefined;
}
