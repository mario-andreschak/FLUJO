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
}

/**
 * A completion adapter turns FLUJO's OpenAI-shaped request into a call against a
 * specific provider/SDK and returns an OpenAI-shaped ChatCompletion, so every
 * downstream consumer (ModelHandler, token-usage parsing, tool-call handling)
 * keeps working unchanged regardless of the underlying provider or transport.
 */
export interface CompletionAdapter {
  createCompletion(input: CompletionInput): Promise<OpenAI.Chat.Completions.ChatCompletion>;
}
