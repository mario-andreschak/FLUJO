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

  /**
   * MCP Apps `ui/update-model-context` state, serialized as JSON. The frontend
   * keeps one entry per live app identity and overwrites it on every update;
   * the backend validates and stores the map, then adds it only to future model
   * wire contexts (never as a visible chat message).
   */
  mcpAppContexts?: string;

  /** FLUJO UI extension: return large tool bodies as expansion-time references. */
  compactToolPayloads?: "true";

  /**
   * Local trusted-control-plane extension: route this request to a durable
   * Persona instead of invoking a Flow directly. External OpenAI-compatible
   * clients cannot use this field; the route applies the local-request guard
   * whenever it is present.
   */
  personaId?: string;

  /** Optional Persona-owned Behavior slot. Defaults to the runtime's slot for the Activity kind. */
  behaviorSlotKey?: string;

  /** Optional caller retry key for durable Persona mailbox idempotency. */
  idempotencyKey?: string;
}

import OpenAI from 'openai';
import type { ModelMediaPart } from './model/media';
import type { FlujoFunctionToolCall } from './openai';

/** One app's latest `ui/update-model-context` payload. */
export interface McpAppModelContext {
  content?: unknown[];
  structuredContent?: Record<string, unknown>;
}

/** Context keyed by the host-owned app identity (`serverName::ui://…`). */
export type McpAppModelContextMap = Record<string, McpAppModelContext>;

/**
 * Browser-facing reference to a large tool payload kept in the run-resource
 * store. The conversation API returns a short inline preview plus this
 * display-only reference; the chat fetches the exact body only when its tool
 * panel is expanded.
 */
export interface LazyToolPayloadRef {
  uri: string;
  href: string;
  size: number;
  mimeType?: string;
}

export interface LazyToolCallPayloads {
  arguments?: LazyToolPayloadRef;
  result?: LazyToolPayloadRef;
}

/**
 * Extends OpenAI's chat completion message parameter type to include additional fields
 * needed for Flujo's chat functionality.
 */
export type FlujoChatMessage = OpenAI.ChatCompletionMessageParam & {
  /** FLUJO executes function tools only; SDK custom tools are rejected at ingress. */
  tool_calls?: FlujoFunctionToolCall[];

  /** Unique identifier for the message */
  id: string;
  
  /** Timestamp in milliseconds since epoch when the message was created/added */
  timestamp: number;
  
  /** Flag to indicate if the message should be excluded from processing */
  disabled?: boolean;
  
  /** The ID of the process node that generated or handled this message */
  processNodeId?: string;

  /** Server-projected, repository-relative changes associated with this message. */
  changedFiles?: Array<{ path: string; status: string }>;

  /** Display-only destination metadata for MCP calls, keyed by tool-call id. */
  mcpToolCalls?: Record<string, {
    serverName: string;
    toolName: string;
  }>;

  /** Display/transport metadata; stripped and hydrated before model execution. */
  toolPayloads?: Record<string, LazyToolCallPayloads>;

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
   * (`enableMcpApps`); the chat renders it in an isolated sandbox and brokers
   * the standard MCP Apps host bridge. Display-only: never part of model context.
   */
  ui?: {
    /** The `ui://…` resource URI to read and render. */
    uri: string;
    /** Server that owns the resource, used to read it back for rendering. */
    serverName: string;
    /** Original server-side tool name that instantiated the View. */
    toolName?: string;
    /**
     * JSON arguments for the actual App-owning tool when the visible tool call
     * was a forwarding wrapper such as FLUJO's call_mcp_tool.
     */
    toolArgs?: string;
    /**
     * Present when this invocation ended through MCP cancellation. The host
     * sends tool-input followed by tool-cancelled instead of tool-result.
     */
    cancelledReason?: string;
    /**
     * True when the underlying invocation completed with an MCP/tool error.
     * The View receives a `tool-result` with `isError: true` unless the
     * invocation was cancelled, in which case `tool-cancelled` takes priority.
     */
    isError?: boolean;
  };

  /**
   * Mid-run steering: this user message was injected into a run that was
   * ALREADY in flight (POST /v1/chat/conversations/:id/inject) rather than
   * starting a turn of its own. It is ordinary conversation content — persisted,
   * displayed and sent to the model like any user turn — but the flag makes it
   * survive a node's `inputMode` narrowing: the whole point of a correction is
   * that the node currently working sees it, even when that node is `isolated`
   * or `latest-message` scoped. See buildNodeContext.scopeMessagesForInput.
   */
  injected?: boolean;

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
    /** Subset of `promptTokens` written to the provider prompt cache. */
    cacheWriteTokens?: number;
  };

  /**
   * Provider-neutral media attached to or generated with this message.
   * Generated payloads are normally persisted as run resources, leaving only
   * a lightweight URL/resourceUri here rather than base64 in conversation JSON.
   */
  media?: ModelMediaPart[];

  /**
   * Structured metadata about a parallel subflow result (issue #359).
   * Only present on assistant messages that fold parallel lane outputs,
   * and only when `resultPresentation: 'separate'` creates per-lane messages.
   * Contains lane identity, index, status, and child conversation id.
   */
  subflowResult?: {
    subflowId: string;
    subflowName?: string;
    laneTitle?: string;
    laneIndex: number;
    laneCount: number;
    status: 'completed' | 'error';
    conversationId?: string;
  };
};
