/**
 * Defines the structure for the metadata object sent with chat completion requests,
 * particularly when using Flujo features.
 */
export interface ChatCompletionMetadata {
  /**
   * Indicates if the request is part of a Flujo execution.
   * Expected value: "true"
   */
  flujo?: "true";

  /**
   * The ID of the conversation this request belongs to, allowing state resumption.
   */
  conversationId?: string;

  /**
   * Indicates if tool calls within a Flujo execution require user approval before proceeding.
   * Expected value: "true"
   */
  requireApproval?: "true";

  /**
   * Indicates if the request should be executed in debug mode (step-by-step).
   * Expected value: "true"
   */
  flujodebug?: "true";

  /**
   * The ID of the process node to start execution from.
   * Used when editing messages to resume execution from a specific node.
   */
  processNodeId?: string;
}

import OpenAI from 'openai';

/**
 * Extends OpenAI's chat completion message parameter type to include additional fields
 * needed for Flujo's chat functionality.
 */
export type FlujoChatMessage = OpenAI.ChatCompletionMessageParam & {
  /** Unique identifier for the message */
  id: string;
  
  /** Timestamp in milliseconds since epoch when the message was created/added */
  timestamp: number;
  
  /** Flag to indicate if the message should be excluded from processing */
  disabled?: boolean;
  
  /** The ID of the process node that generated or handled this message */
  processNodeId?: string;

  /**
   * Subflow nesting depth for display. Absent/0 = a top-level message of this
   * conversation; >0 = a step of a nested subflow run, folded into the parent
   * conversation's log/projection. Depth>0 messages are display-only: they are
   * never part of the parent's model context and chat clients must exclude
   * them when sending history back.
   */
  depth?: number;

  /**
   * MCP Apps (SEP-1865, #97): a `role: 'tool'` result may carry a link to an
   * interactive `ui://` UI resource the originating server wants rendered for
   * this tool call. Present only when the server has MCP Apps opt-in enabled
   * (`enableMcpApps`); the chat renders it as a read-only, sandboxed iframe
   * (Phase 1 — no iframe→host bridge). Display-only: never part of model context.
   */
  ui?: {
    /** The `ui://…` resource URI to read and render. */
    uri: string;
    /** Server that owns the resource, used to read it back for rendering. */
    serverName: string;
  };

  /** Token usage reported by the provider for the call that produced this message (assistant messages only). */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    /**
     * Subset of `promptTokens` that was cheaply RE-READ from the provider's
     * prompt cache (Anthropic cache_read / OpenAI cached_tokens). Surfaced so
     * the UI can present a "fresh (+cached)" split instead of counting warmed
     * cache reads as fresh input on every turn (#87). Absent when unknown.
     */
    cacheReadTokens?: number;
  };
};
