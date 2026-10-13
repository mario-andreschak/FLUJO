/** Shared debugger wire snapshot and current-preview DTOs. Types only. */
import type OpenAI from 'openai';
import type { FlujoChatMessage } from '@/shared/types/chat';
import type { VisualCompactionDiagnostic } from '@/shared/types/visualArchive';
import type { ContextCompactionDiagnostic } from '@/shared/types/contextCompaction';

/**
 * Why a message from the node's full THREADED history is (or isn't) in the exact
 * wire conversation the model receives. Derived from the SAME pipeline functions
 * the runtime uses (deriveModelInputView in buildNodeContext.ts), so the
 * explanation can never drift from behaviour. Issue #153.
 *   - 'system'           — the resolved system message the node used.
 *   - 'sent'             — present in the final wire view (what the model sees).
 *   - 'folded'           — removed by collapseNodeOutputs (outputMode fold).
 *   - 'scoped-out'       — removed by scopeMessagesForInput (inputMode narrowing).
 *   - 'handoff-stripped' — removed/rewritten by stripHandoffPlumbing (handoff
 *                          tool-call/result + synthetic "Continue").
 */
export type WireStatus =
  | 'system'
  | 'sent'
  | 'folded'
  | 'scoped-out'
  | 'handoff-stripped'
  | 'summarized'
  | 'visually-archived'
  | 'emergency-stripped'
  | 'content-truncated';

/** Per-message provenance in a ModelInputSnapshot (see WireStatus). Carries only
 *  a short content preview, never the full payload, so the snapshot stays bounded. */
export interface ModelInputProvenanceEntry {
  id?: string;
  role: string;
  status: WireStatus;
  /** Human-readable explanation of the wire transformation. */
  reason?: string;
  /** Truncated content preview for the annotated history view. */
  preview?: string;
  /** Names of any tool calls this assistant turn made (for annotation). */
  toolCallNames?: string[];
}

/**
 * A purpose-built, debug-mode-gated snapshot of exactly what a Process node's
 * model call receives (issue #153): the resolved system message, the exact wire
 * conversation (after fold + scope + handoff-plumbing strip), and per-message
 * provenance explaining how the wire differs from the threaded history.
 *
 * SECURITY: conversation content ONLY. Never carries provider credentials,
 * modelId-resolved keys, or headers — honours "API keys never to the frontend".
 */
export interface ModelInputSnapshot {
  /** The resolved system text the model saw (null for none). */
  systemMessage: { content: string } | null;
  /** The exact final wire conversation (post-strip), for rich rendering. Content
   *  is per-message capped to keep the trace roughly constant size per step. */
  wireMessages: FlujoChatMessage[];
  /** One entry per message in the node's full threaded history. */
  provenance: ModelInputProvenanceEntry[];
  /** Summary counts for a one-line "18 in history → 11 sent · 5 folded …". */
  counts: {
    threaded: number;
    sent: number;
    folded: number;
    scopedOut: number;
    handoffStripped: number;
    summarized?: number;
    visuallyArchived?: number;
    emergencyStripped?: number;
    contentTruncated?: number;
  };
  inputMode?: 'full-history' | 'latest-message' | 'isolated';
  /** Final wire-time visual routing metrics, captured by ModelHandler. */
  visualCompaction?: VisualCompactionDiagnostic;
  /** Ordered late-wire transformations, including emergency provider refits. */
  contextCompaction?: ContextCompactionDiagnostic;
}

export type WirePreviewUnavailableReason =
  | 'non_process_node'
  | 'missing_node'
  | 'missing_history'
  | 'scope_mismatch'
  | 'unsupported_transformation';

export type WirePreviewWarningCode =
  | 'current_state'
  | 'provider_finalization_omitted'
  | 'resource_resolution_omitted'
  | 'tool_configuration_omitted'
  | 'history_projection_omitted';

export interface WirePreviewWarning {
  code: WirePreviewWarningCode;
  message: string;
}

export interface WirePreviewResponse {
  status: 'available' | 'unavailable';
  mode: 'current-preview';
  conversationId: string;
  rootConversationId: string | null;
  parentConversationId: string | null;
  nodeId: string;
  snapshot?: ModelInputSnapshot;
  providerMessages?: OpenAI.ChatCompletionMessageParam[];
  warnings: WirePreviewWarning[];
  unavailableReason?: WirePreviewUnavailableReason;
}
