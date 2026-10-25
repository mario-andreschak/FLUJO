import type { ConversationSequenceSafetyError } from './conversationLogSequence';

type PublicationCode = 'CONVERSATION_PUBLICATION_BUSY' | 'CONVERSATION_PUBLICATION_MEMORY'
  | 'CONVERSATION_PUBLICATION_DATA' | 'CONVERSATION_PUBLICATION_UNCERTAIN' | 'CONVERSATION_PUBLICATION_IO';
export class ConversationPublicationError extends Error {
  readonly status: 429 | 503;
  readonly details: { code: PublicationCode; status: number; type: string };
  constructor(readonly code: PublicationCode, reason: string, options?: ErrorOptions) {
    super(`Conversation publication refused: ${reason}. Existing durable history is retained.`, options);
    this.name = 'ConversationPublicationError';
    this.status = code === 'CONVERSATION_PUBLICATION_BUSY' ? 429 : 503;
    this.details = { code, status: this.status, type: 'conversation_publication_error' };
  }
}
export function isConversationPublicationError(error: unknown): error is ConversationPublicationError {
  return error instanceof Error && error.name === 'ConversationPublicationError';
}
/** Metadata-only predicate: adapters must not import publisher state or I/O. */
export function isConversationDurabilityError(error: unknown): error is ConversationPublicationError | ConversationSequenceSafetyError {
  return isConversationPublicationError(error) || (error instanceof Error && error.name === 'ConversationSequenceSafetyError');
}

/** Normalized model errors retain their code after losing Error identity. */
export function isConversationDurabilityCode(code: unknown): boolean {
  return typeof code === 'string' && (code.startsWith('CONVERSATION_PUBLICATION_') || code.startsWith('CONVERSATION_SEQUENCE_'));
}
