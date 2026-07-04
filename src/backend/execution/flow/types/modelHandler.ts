import OpenAI from 'openai';
import {
  ToolDefinition,
  ToolCallInfo
} from '../types';
import { FlujoChatMessage } from '@/shared/types/chat'; // Correct import path
import { EmitFn } from '@/shared/types/execution/events';

// Input for model call
export interface ModelCallInput {
  modelId: string;
  prompt: string;
  messages: FlujoChatMessage[]; // Use FlujoChatMessage
  tools?: OpenAI.ChatCompletionTool[];
  iteration: number;
  maxIterations: number;
  nodeName: string; // Name of the process node for display purposes
  nodeId: string; // ID of the process node
  /**
   * Maps model-facing MCP tool names back to (server, tool). Forwarded to
   * adapters that run their own agentic tool loop (Claude subscription) so they
   * can dispatch tool calls to mcpService. Built from SharedState.toolNameMap.
   */
  toolNameMap?: Record<string, { server: string; tool: string }>;
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
   * falls back to the legacy `_-_-_SERVER_-_-_TOOL` scheme.
   */
  toolNameMap?: Record<string, { server: string; tool: string }>;
  /**
   * Live-event emitter for the run. When present, each MCP call is bracketed by
   * tool:call / tool:result events and server progress notifications become
   * tool:progress events — which keeps the chat UI's stall detector fed during
   * long-running tools.
   */
  emit?: EmitFn;
}

// Tool call processing result
export interface ToolCallProcessingResult {
  toolCallMessages: FlujoChatMessage[]; // Use FlujoChatMessage
  processedToolCalls: ToolCallInfo[];
}

// Ensure the file is treated as a module
export {};
