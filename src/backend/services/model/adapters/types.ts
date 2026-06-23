import OpenAI from 'openai';
import { Model } from '@/shared/types/model';

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
  transcript?: OpenAI.ChatCompletionMessageParam[];
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
