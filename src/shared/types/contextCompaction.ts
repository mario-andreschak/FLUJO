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
