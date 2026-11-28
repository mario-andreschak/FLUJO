export type ContextCompactionKind = 'summary' | 'visual-archive' | 'emergency-refit' | 'content-truncation';

/**
 * What one summary cost and saved, recorded with every summary (#1091), so
 * real runs measure themselves: who wrote it, how long it took, what the
 * provider billed for it, and the exact app, policy and prompt behind it.
 */
export interface ContextCompactionMeasurement {
  /** Anthropic's native compaction, or FLUJO's own summarizer. */
  engine: 'anthropic-native' | 'flujo';
  /** True when a saved summary was sent again and no summarizer ran. */
  reused: boolean;
  /** Wall-clock time spent making the summary; 0 when reused. */
  latencyMs: number;
  /** Summarizer requests made, native attempt included. */
  summarizerCalls: number;
  /** Tokens the provider reported for those requests; absent when it reported none. */
  usage?: { inputTokens: number; outputTokens: number; cachedInputTokens: number };
  /** FLUJO's size estimate of the next request without and with the summary. */
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  /** Original user turns kept word for word after the summary. */
  retainedUserTurns: number;
  /** Exact execution receipts kept after the summary. */
  receipts: number;
  appVersion: string;
  policyVersion: string;
  /** First 16 hex digits of the SHA-256 of the summary prompt. */
  promptDigest: string;
  /** Why the native summary was not used on a route that has one. */
  nativeFallback?: string;
}

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
  measurement?: ContextCompactionMeasurement;
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

/** Answer of POST /v1/chat/conversations/{id}/compact. Summaries cannot be switched off (#1449). */
export type ManualCompactionResponse = { status: 'requested'; running: boolean; preview: ManualCompactionPreview };
