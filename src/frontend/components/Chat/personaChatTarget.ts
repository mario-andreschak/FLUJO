import type { ChatCompletionMetadata } from '@/shared/types/chat';

type PersonaChatTarget = {
  personaId?: string;
  personaBehaviorSlotKey?: string;
};

/**
 * Translate the durable, user-visible Chat choice into the public completion
 * metadata understood by the Persona dispatcher. No Flow or revision authority
 * is inferred in the browser.
 */
export function personaChatRoutingMetadata(
  target: PersonaChatTarget,
): Pick<ChatCompletionMetadata, 'personaId' | 'behaviorSlotKey'> {
  if (!target.personaId) return {};
  return {
    personaId: target.personaId,
    ...(target.personaBehaviorSlotKey
      ? { behaviorSlotKey: target.personaBehaviorSlotKey }
      : {}),
  };
}
