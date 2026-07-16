import OpenAI from 'openai';
import {
  ToolDefinition,
  ToolCallInfo
} from '../types';
import { FlujoChatMessage } from '@/shared/types/chat'; // Correct import path
import { EmitFn, NodeRef } from '@/shared/types/execution/events';

// Input for model call
export interface ModelCallInput {
  modelId: string;
  prompt: string;
  messages: FlujoChatMessage[]; // Use FlujoChatMessage
  /**
   * Optional scoped view to send to the provider instead of `messages`. Lets a
   * node (ProcessNode's latest-message / isolated inputMode) narrow what the
   * MODEL sees while `messages` remains the lossless history used to build the
   * returned/persisted transcript. Unset ⇒ the provider sees `messages`.
   */
  wireMessages?: FlujoChatMessage[];
  tools?: OpenAI.ChatCompletionTool[];
  iteration: number;
  maxIterations: number;
  /**
   * Optional per-node override of the agentic-turn cap for self-orchestrating
   * adapters (Claude subscription). When set (> 0) it wins; otherwise callModel
   * resolves the bound model's `maxTurns`, then DEFAULT_AGENTIC_MAX_TURNS (50).
   * This is the authoritative cap that replaced the former hard-coded 30.
   */
  maxTurns?: number;
  nodeName: string; // Name of the process node for display purposes
  nodeId: string; // ID of the process node
  /**
   * Maps model-facing MCP tool names back to (server, tool). Forwarded to
   * adapters that run their own agentic tool loop (Claude subscription) so they
   * can dispatch tool calls to mcpService. Built from SharedState.toolNameMap.
   * `timeout` is the source MCP node's per-call timeout in seconds.
   */
  toolNameMap?: Record<string, { server: string; tool: string; timeout?: number }>;
  /** Conversation id — lets self-orchestrating adapters surface mid-run tool
   *  approval prompts on the conversation's event stream. */
  conversationId?: string;
  /** Whether tool calls require user approval (mirrors the run's requireApproval). */
  requireToolApproval?: boolean;
}

// Result of model call
export interface ModelCallResult {
  content?: string;
  messages: FlujoChatMessage[]; // Use FlujoChatMessage
  toolCalls?: ToolCallInfo[];
  fullResponse?: OpenAI.ChatCompletion;
  /**
   * For self-orchestrating adapters (Claude subscription): the ordered
   * assistant/tool messages produced during the internal agentic loop, in OpenAI
   * wire format. callModel materializes these into the conversation so the tool
   * calls + results are visible, instead of the single assistant message it
   * builds for request/response adapters.
   */
  transcript?: FlujoChatMessage[];
}

// Tool call processing input
export interface ToolCallProcessingInput {
  toolCalls: OpenAI.ChatCompletionMessageToolCall[];
  content?: string;
  /**
   * Maps model-facing MCP tool names back to (server, tool). Built from the
   * conversation's bound tools (SharedState.toolNameMap). When omitted, decoding
   * falls back to the legacy `_-_-_SERVER_-_-_TOOL` scheme. `timeout` is the
   * source MCP node's per-call timeout in seconds (-1 = none; unset = default).
   */
  toolNameMap?: Record<string, { server: string; tool: string; timeout?: number }>;
  /**
   * Live-event emitter for the run. When present, each MCP call is bracketed by
   * tool:call / tool:result events and server progress notifications become
   * tool:progress events — which keeps the chat UI's stall detector fed during
   * long-running tools.
   */
  emit?: EmitFn;
  /**
   * Conversation that owns this run's run-scoped resources. When present (and
   * auto-capture is enabled), binary/large tool results are stored as
   * flujo://run/<conversationId>/… resources with lineage. Absent ⇒ no capture
   * (e.g. ephemeral subflow-child runs, or legacy call sites).
   */
  conversationId?: string;
  /** Process node driving these calls — recorded as resource lineage producer. */
  node?: NodeRef;
  /**
   * Cancellation probe, checked before EACH tool call in the batch: once it
   * returns true, no further tool is started (remaining calls get synthetic
   * "cancelled" results so the transcript stays well-formed). Wired by runFlow
   * to the run's cancellation guard so Stop takes effect between tool calls,
   * not only between loop iterations (issue #109).
   */
  shouldAbort?: () => boolean;
}

// Tool call processing result
export interface ToolCallProcessingResult {
  toolCallMessages: FlujoChatMessage[]; // Use FlujoChatMessage
  processedToolCalls: ToolCallInfo[];
}

// Ensure the file is treated as a module
export {};
