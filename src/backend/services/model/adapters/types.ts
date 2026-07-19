import OpenAI from 'openai';
import { Model } from '@/shared/types/model';
import { FlujoChatMessage } from '@/shared/types/chat';
import { RunResourceEntry } from '@/shared/types/runResources';

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
 * Everything an adapter needs to perform a single chat completion. The caller
 * (ModelHandler) is responsible for resolving/decrypting the API key and
 * stripping FLUJO-internal fields (timestamps) from the messages first.
 */
export interface CompletionInput {
  /** The model record (used for name, baseUrl, provider, adapter, ...). */
  model: Model;
  /** The decrypted API key / OAuth token. Never log this. */
  apiKey: string;
  /** Conversation messages in OpenAI wire format. */
  messages: OpenAI.ChatCompletionMessageParam[];
  /**
   * Optional identity of the conversation + process node this call belongs to.
   * Self-orchestrating adapters (Claude subscription) use the pair to key a
   * reusable Agent SDK session per `(conversationId, nodeId)` (issue #154), so
   * turns of the same single-node Flow can resume one session instead of
   * re-sending the whole flattened history each turn. Request/response adapters
   * ignore these (matching the existing pattern for `maxTurns` /
   * `localToolExecutors`). Omitted means session reuse is disabled for the call.
   */
  conversationId?: string;
  nodeId?: string;
  /** Optional tool definitions in OpenAI format. */
  tools?: OpenAI.ChatCompletionTool[];
  /** Sampling temperature. */
  temperature: number;
  /**
   * Maps model-facing MCP tool names back to (server, tool). Needed by adapters
   * that execute tools themselves (e.g. the Claude subscription adapter runs the
   * agentic loop in-process and must dispatch tool calls to `mcpService`).
   * `timeout` is the tool's per-call timeout in seconds (-1 = none; unset = the
   * 5-minute default).
   */
  toolNameMap?: Record<string, { server: string; tool: string; timeout?: number }>;
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
  }) => Promise<boolean>;
  /**
   * Cancellation signal for the in-flight provider call. Wired by ModelHandler
   * to the conversation's isCancelled flag (own or ancestor), so pressing Stop
   * interrupts the call mid-stream instead of waiting for the current model
   * turn to finish. Request/response adapters pass it to their SDK's per-request
   * abort option; the self-orchestrating adapter (Claude subscription) chains it
   * onto the AbortController that owns its whole agentic loop.
   */
  signal?: AbortSignal;
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
   * Captured run resources for oversized PRIOR tool results/args, keyed by the
   * producing `tool_call_id` (issue #168). Self-orchestrating adapters (Claude
   * subscription) use this to replace inline `…[truncated]` with a head excerpt
   * + `flujo://run/...` marker a model can dereference via the `read_resource`
   * tool. Request/response adapters ignore it. Omitted ⇒ plain truncation.
   */
  runResourceMarkers?: Map<string, ToolResourceMarker>;
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
}
