import OpenAI from 'openai';
import { Model } from '@/shared/types/model';
import { FlujoChatMessage } from '@/shared/types/chat';

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
  /** Optional tool definitions in OpenAI format. */
  tools?: OpenAI.ChatCompletionTool[];
  /** Sampling temperature. */
  temperature: number;
  /**
   * Maps model-facing MCP tool names back to (server, tool). Needed by adapters
   * that execute tools themselves (e.g. the Claude subscription adapter runs the
   * agentic loop in-process and must dispatch tool calls to `mcpService`).
   */
  toolNameMap?: Record<string, { server: string; tool: string }>;
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
