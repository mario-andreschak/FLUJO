export type ContextCompactionKind = 'summary' | 'visual-archive' | 'emergency-refit' | 'content-truncation';

/** Durable, provider-neutral record of a late context rewrite. */
export interface ContextCompactionEvent {
  kind: ContextCompactionKind;
  /** Human-readable reason the transform ran (preflight, provider overflow, etc.). */
  reason: string;
  before?: number;
  after?: number;
  unit?: 'tokens' | 'characters' | 'messages';
  omittedMessages?: number;
  truncatedMessages?: number;
  injectedMarker?: string;
}

export interface ContextCompactionDiagnostic {
  events: ContextCompactionEvent[];
}

/** What a "/compact" right now would summarize and keep (#1225). */
export interface ManualCompactionPreview {
  /** Rough size of the saved chat, using the same estimate as compaction. */
  estimatedTokens: number;
  /** Recent part that always stays word for word. */
  keepTokens: number;
  /** Older AI replies and tool results that the summary replaces. */
  summarizedMessages: number;
  /** Recent messages that stay word for word. */
  keptRecentMessages: number;
  /** Older messages from the person, which stay word for word while they fit. */
  keptEarlierUserMessages: number;
  /** Older messages from the person that hold a rule or correction; these always stay. */
  standingInstructions: number;
  /** False when the older messages from the person are too long to all stay word for word. */
  earlierUserMessagesFit: boolean;
}

/** Answer of POST /v1/chat/conversations/{id}/compact. */
export type ManualCompactionResponse =
  | { status: 'requested'; running: boolean; preview: ManualCompactionPreview }
  | { status: 'disabled'; preview: ManualCompactionPreview };
