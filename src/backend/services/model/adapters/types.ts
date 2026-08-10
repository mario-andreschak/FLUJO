import OpenAI from 'openai';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { Model } from '@/shared/types/model';
import { FlujoChatMessage } from '@/shared/types/chat';
import { RunResourceEntry } from '@/shared/types/runResources';
import type { CodexSessionMetadata } from '@/backend/execution/flow/types';
import type { ModelMediaPart } from '@/shared/types/model/media';

/**
 * Captured run resources for oversized PRIOR tool results/args, keyed by the
 * producing `tool_call_id` (issue #168). A single call id can have both an
 * oversized RESULT and oversized ARGS captured, so each slot carries them
 * separately.
 */
export interface ToolResourceMarker {
  /** Captured oversized tool RESULT for this tool_call_id. */
  result?: RunResourceEntry;
  /** Captured oversized tool-call ARGS for this tool_call_id. */
  args?: RunResourceEntry;
}

/**
 * Provider-neutral live update for one assistant message. Text and function
 * arguments are append-only deltas; `messageId` remains stable until the
 * adapter returns its final CompletionResult, allowing the UI to replace the
 * transient draft with the durable message instead of rendering a duplicate.
 */
export interface ModelStreamDelta {
  messageId: string;
  contentDelta?: string;
  /** A complete media item discovered during a native provider stream. */
  mediaPart?: ModelMediaPart;
  toolCallDelta?: {
    index: number;
    id?: string;
    nameDelta?: string;
    argumentsDelta?: string;
  };
}

/**
 * Everything an adapter needs to perform a single chat completion. The caller
 * (ModelHandler) is responsible for resolving/decrypting the API key and
 * stripping FLUJO-internal fields (timestamps) from the messages first.
 */
export interface CompletionInput {
  /** The model record (used for name, baseUrl, provider, adapter, ...). */
  model: Model;
  /** The decrypted API key / OAuth token. Never log this. */
  apiKey: string;
  /** Observes each real provider request, including transport retries. The
   * callback is metadata-only and must never receive request payloads. */
  onProviderAttempt?: (observation: {
    attempt: number;
    durationMs: number;
    outcome: 'completed' | 'error' | 'cancelled';
    result?: unknown;
    error?: unknown;
  }) => void;
  /** Conversation messages in OpenAI wire format. */
  messages: OpenAI.ChatCompletionMessageParam[];
  /**
   * Optional identity of the conversation + process node this call belongs to.
   * Self-orchestrating adapters (Claude subscription and Codex) use the pair to
   * key a reusable agent session per `(conversationId, nodeId)`, so
   * turns of the same single-node Flow can resume one session instead of
   * re-sending the whole flattened history each turn. Request/response adapters
   * ignore these (matching the existing pattern for `maxTurns` /
   * `localToolExecutors`). Omitted means session reuse is disabled for the call.
   */
  conversationId?: string;
  /** Metadata-only logical run id for in-adapter tool attribution. */
  runId?: string;
  nodeId?: string;
  /**
   * Opt-in to native session reuse for self-orchestrating adapters (Claude
   * subscription and Codex). When true (and `conversationId`+`nodeId` are
   * present and a reusable session exists for this node), the adapter resumes
   * the persisted SDK session and sends only the per-turn delta instead of
   * re-flattening the whole history. When false/omitted the adapter always
   * re-flattens (the always-correct fallback). Claude reuse is gated by the
   * experimental `claudeSessionResume` setting; Codex reuse is enabled by
   * default. Both are only set for full-history nodes (a wire-scoped view can't
   * be reconciled against the session's watermark).
   * Request/response adapters ignore it.
   */
  sessionResume?: boolean;
  /** Persisted Codex thread metadata supplied by the conversation owner. */
  codexSession?: CodexSessionMetadata;
  /** Replace or invalidate the durable Codex metadata after an adapter turn. */
  onCodexSessionChange?: (session: CodexSessionMetadata | undefined) => void;
  /** Optional tool definitions in OpenAI format. */
  tools?: OpenAI.ChatCompletionFunctionTool[];
  /** Sampling temperature. Omitted when an invalid persisted value is ignored. */
  temperature?: number;
  /**
   * Upper bound on tokens the provider may generate for this single completion.
   * Already resolved by the caller with precedence: explicit request
   * `max_tokens` > per-model `Model.maxTokens` > adapter default. `undefined`
   * means "no cap requested" — each request/response adapter then omits the
   * cap (OpenAI/Gemini) or applies its own documented default (Anthropic).
   * Self-orchestrating adapters (Claude subscription) ignore it, like `maxTurns`.
   */
  maxTokens?: number;
  /**
   * Maps model-facing MCP tool names back to (server, tool). Needed by adapters
   * that execute tools themselves (e.g. the Claude subscription adapter runs the
   * agentic loop in-process and must dispatch tool calls to `mcpService`).
   * `timeout` is the tool's per-call timeout in seconds (-1 = none; unset = the
   * 5-minute default).
   */
  toolNameMap?: Record<string, {
    server: string;
    tool: string;
    timeout?: number;
    nodeId?: string;
    clientGeneration?: number;
    schemaHash?: string;
    annotations?: ToolAnnotations;
    uiResourceUri?: string;
  }>;
  /**
   * Executors for caller-defined "virtual" tools (entries in `tools` that are
   * neither handoffs nor MCP tools), keyed by function name — e.g. the flow
   * generator's marketplace search/install tools. Request/response adapters
   * ignore this (the caller reads `tool_calls` and runs its own loop);
   * self-orchestrating adapters (Claude subscription) MUST execute these
   * in-loop via the provided executor, since their tool calls never surface to
   * the caller. Without an executor such tools are silently dropped there.
   */
  localToolExecutors?: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  /**
   * Upper bound on agentic turns for adapters that orchestrate their own tool
   * loop (Claude subscription). Ignored by the request/response adapters, where
   * FLUJO drives the loop. Falls back to a sane default when unset.
   */
  maxTurns?: number;
  /**
   * Optional human-in-the-loop gate for self-orchestrating adapters. When
   * provided, the adapter calls it before each tool runs and awaits the verdict
   * (true = allow, false = reject). Built by the execution layer to bridge to
   * FLUJO's tool-approval UI; omitted means auto-approve.
   */
  requestToolApproval?: (call: {
    id: string;
    name: string;
    args: Record<string, unknown>;
  }) => Promise<{ approved: boolean; feedback?: string }>;
  /**
   * Cancellation signal for the in-flight provider call. Wired by ModelHandler
   * to the conversation's isCancelled flag (own or ancestor), so pressing Stop
   * interrupts the call mid-stream instead of waiting for the current model
   * turn to finish. Request/response adapters pass it to their SDK's per-request
   * abort option; the self-orchestrating adapter (Claude subscription) chains it
   * onto the AbortController that owns its whole agentic loop.
   */
  signal?: AbortSignal;
  /** Runtime-only lease/fence assertion immediately before a tool side effect. */
  beforeToolDispatch?: () => Promise<void>;
  /** Runtime-only lease/generation assertion immediately after a long tool call. */
  afterToolDispatch?: () => Promise<void>;
  /** Hold the current execution fence across one durable resource mutation. */
  commitDurableMutation?: <T>(task: () => Promise<T>) => Promise<T>;
  /**
   * Optional live sink for self-orchestrating adapters (Claude subscription)
   * that run their own agentic loop inside a single createCompletion call. It is
   * called as each assistant/tool message is produced, so the execution layer
   * can surface it on the conversation's live event stream immediately — instead
   * of only after the whole (possibly very long) call returns. Without it a long
   * agentic run shows nothing in the UI until it finishes, the "no activity"
   * hint fires, and a timeout would discard every interim tool call/result.
   *
   * Each streamed message carries a stable `id`; the SAME message (same id) is
   * also present in the returned `transcript`, so the live copy and the final
   * persisted copy dedupe in the UI rather than duplicating.
   */
  onTranscriptMessage?: (message: FlujoChatMessage) => void;
  /**
   * Drain user interventions accepted while a self-orchestrating adapter is
   * still inside one long provider call. Request/response adapters return to
   * runFlow after every model turn and do not need this hook; Claude and Codex
   * poll it at their own safe turn boundaries.
   *
   * A consumed message must be added to the adapter transcript and passed to
   * `onTranscriptMessage` before it is sent to the provider. That makes the
   * accepted intervention durable and reconciles the optimistic UI bubble by id.
   */
  consumeSteeringMessages?: () => FlujoChatMessage[];
  /**
   * Live token/tool-argument sink. Request/response adapters use it while
   * consuming their native SDK stream; self-orchestrating adapters use it for
   * partial assistant events. The callback is live-only and is never persisted.
   */
  onModelDelta?: (delta: ModelStreamDelta) => void;
  /**
   * Captured run resources for oversized PRIOR tool results/args, keyed by the
   * producing `tool_call_id` (issue #168). Self-orchestrating adapters (Claude
   * subscription) use this to replace inline `…[truncated]` with a head excerpt
   * + `flujo://run/...` marker a model can dereference via the `read_resource`
   * tool. Request/response adapters ignore it. Omitted ⇒ plain truncation.
   */
  runResourceMarkers?: Map<string, ToolResourceMarker>;
  /**
   * Cache-routing hint for providers with a sharded automatic prompt cache
   * (OpenAI's `prompt_cache_key`). Requests carrying the same key AND the same
   * prefix are routed to the same machine, so a warm cache is actually found
   * instead of missed on a cold shard. Derived from a hash of the tool block
   * (see derivePromptCacheKey), so every request sharing that prefix shares the
   * key. Adapters that don't support the parameter ignore it — the OpenAI
   * adapter also drops it permanently for a provider that rejects it.
   */
  promptCacheKey?: string;
  /**
   * Request-level OpenAI prompt-cache policy. Present only after the execution
   * layer has added compatible explicit breakpoints to the message content.
   * The OpenAI adapter negotiates this option independently from
   * `prompt_cache_key` and retries without it if an endpoint rejects it.
   */
  promptCacheMode?: 'explicit';
}

/**
 * What an adapter returns. The OpenAI-shaped `completion` carries the final
 * answer + usage + any routing tool_calls (so downstream consumers work
 * unchanged). `transcript` is for self-orchestrating adapters (Claude
 * subscription) that run an internal agentic loop: it's the ordered
 * assistant/tool messages produced during that loop, so the caller can record
 * them in the conversation. Request/response adapters omit it.
 */
export interface CompletionResult {
  completion: OpenAI.Chat.Completions.ChatCompletion;
  /** Direct model media normalized from the provider-native response. */
  media?: ModelMediaPart[];
  /** Stable id used by `onModelDelta` for the final assistant response. */
  liveMessageId?: string;
  /**
   * Ordered assistant/tool messages produced by a self-orchestrating adapter's
   * internal agentic loop. Each carries a stable `id` (and timestamp) so it
   * matches the live-streamed copy emitted via `onTranscriptMessage`. The caller
   * preserves these ids when materializing the messages into the conversation.
   */
  transcript?: FlujoChatMessage[];
}

/**
 * A completion adapter turns FLUJO's OpenAI-shaped request into a call against a
 * specific provider/SDK and returns an OpenAI-shaped result, so every downstream
 * consumer (ModelHandler, token-usage parsing, tool-call handling) keeps working
 * unchanged regardless of the underlying provider or transport.
 */
export interface CompletionAdapter {
  createCompletion(input: CompletionInput): Promise<CompletionResult>;
  /**
   * Optional native streaming variant. ModelHandler selects it whenever a live
   * delta sink is available and falls back to createCompletion otherwise.
   */
  createStreamCompletion?(input: CompletionInput): Promise<CompletionResult>;
}
