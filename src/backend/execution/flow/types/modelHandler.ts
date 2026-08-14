import OpenAI from 'openai';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import {
  ToolDefinition,
  ToolCallInfo,
  MCPNodeReference,
  CodexSessionMetadata,
  ToolReferenceContext,
  type FlowExecutionAuthority,
} from '../types';
import { FlujoChatMessage } from '@/shared/types/chat'; // Correct import path
import { EmitFn, NodeRef } from '@/shared/types/execution/events';
import type { ModelMediaPart } from '@/shared/types/model/media';
import type { VisualCompactionDiagnostic } from '@/shared/types/visualArchive';
import type { PersonaAttribution } from '@/shared/types/enduringAgent';
import type { ModelInputSnapshot } from '../types';

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
  tools?: OpenAI.ChatCompletionFunctionTool[];
  iteration: number;
  maxIterations: number;
  /**
   * Optional per-node override of the agentic-turn cap for self-orchestrating
   * adapters (Claude subscription). When set (> 0) it wins; otherwise callModel
   * resolves the bound model's `maxTurns`, then DEFAULT_AGENTIC_MAX_TURNS (255).
   * This is the authoritative cap that replaced the former hard-coded 30.
   */
  maxTurns?: number;
  /**
   * Optional per-node override of the per-completion output-token cap. When set
   * (> 0) it wins; otherwise callModel resolves the bound model's `maxTokens`,
   * then lets the adapter apply its own default (no numeric system default).
   */
  maxTokens?: number;
  /** Existing Process-node summarizing-compaction overrides (#248). */
  compactionMode?: 'auto' | 'off';
  compactionKeepTokens?: number;
  /** Debug-only observer for the final generic provider wire and visual route. */
  onFinalWire?: (
    messages: OpenAI.ChatCompletionMessageParam[],
    diagnostic?: VisualCompactionDiagnostic,
    modelInput?: ModelInputSnapshot,
  ) => void;
  /** Persist actual provider dispatches for ordinary, durable Chat conversations. */
  archiveModelTurns?: boolean;
  /** Structural fold/scope/handoff provenance paired with the final dispatch. */
  modelInputForArchive?: ModelInputSnapshot;
  nodeName: string; // Name of the process node for display purposes
  nodeId: string; // ID of the process node
  /**
   * Maps model-facing MCP tool names back to (server, tool). Forwarded to
   * adapters that run their own agentic tool loop (Claude subscription) so they
   * can dispatch tool calls to mcpService. Built from SharedState.toolNameMap.
   * `timeout` is the source MCP node's per-call timeout in seconds.
   */
  toolNameMap?: Record<string, { server: string; tool: string; timeout?: number; nodeId?: string; clientGeneration?: number; schemaHash?: string; annotations?: ToolAnnotations; uiResourceUri?: string; presetArgs?: Record<string, unknown>; context?: ToolReferenceContext }>;
  /** Conversation id — lets self-orchestrating adapters surface mid-run tool
   *  approval prompts on the conversation's event stream. */
  conversationId?: string;
  /** Metadata-only logical run id for provider/tool attribution. */
  runId?: string;
  codexSession?: CodexSessionMetadata;
  onCodexSessionChange?: (session: CodexSessionMetadata | undefined) => void;
  /** Whether tool calls require user approval (mirrors the run's requireApproval). */
  requireToolApproval?: boolean;
  /** Headless approval behavior for self-orchestrating adapters. */
  onApprovalRequired?: 'auto' | 'fail' | 'pause';
  /** Issue #239: bound MCP node references for native resource tools. Forwarded to
   *  localToolExecutors so self-orchestrating adapters can execute list_mcp_resources
   *  and native-URI read_resource in-loop. */
  mcpNodes?: MCPNodeReference[];
  /** Unattended run (issue #218/#258): forwarded to the synthetic `question`
   *  localToolExecutor so a self-orchestrating adapter degrades it to a
   *  tool-error instead of blocking for an answer that will never come. */
  unattended?: boolean;
  /** Abort signal for provider and adapter work. */
  signal?: AbortSignal;
  /** Runtime-only fencing authority. It is never copied into provider input. */
  executionAuthority?: FlowExecutionAuthority;
  personaAttribution?: PersonaAttribution;
  /** Final authority checks immediately before external side effects. */
  beforeModelDispatch?: () => Promise<void>;
  beforeToolDispatch?: () => Promise<void>;
}

// Result of model call
export interface ModelCallResult {
  content?: string;
  /** Direct model media normalized by the selected adapter. */
  media?: ModelMediaPart[];
  messages: FlujoChatMessage[]; // Use FlujoChatMessage
  toolCalls?: ToolCallInfo[];
  fullResponse?: OpenAI.ChatCompletion;
  /** Stable id of the live-streamed assistant draft, when one was emitted. */
  liveMessageId?: string;
  /**
   * The effective agentic-turn cap resolved for this call (per-node override →
   * bound-model setting → system default). Surfaced so the request/response tool
   * loop in runFlow can enforce the cap and land gracefully at it (issue #253).
   */
  effectiveMaxTurns?: number;
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
  toolCalls: OpenAI.ChatCompletionMessageFunctionToolCall[];
  content?: string;
  /**
   * Maps model-facing MCP tool names back to (server, tool). Built from the
   * conversation's bound tools (SharedState.toolNameMap). When omitted, decoding
   * falls back to the legacy `_-_-_SERVER_-_-_TOOL` scheme. `timeout` is the
   * source MCP node's per-call timeout in seconds (-1 = none; unset = default).
   */
  toolNameMap?: Record<string, { server: string; tool: string; timeout?: number; nodeId?: string; clientGeneration?: number; schemaHash?: string; annotations?: ToolAnnotations; uiResourceUri?: string; presetArgs?: Record<string, unknown>; context?: ToolReferenceContext }>;
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
  /** Metadata-only logical run id for tool attribution. */
  runId?: string;
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
  /**
   * AbortSignal threaded into MCP tool calls. When provided, it is forwarded to
   * `MCPService.callTool` so that long-running Tasks-extension poll loops can be
   * cancelled mid-flight (via `tasks/cancel`) when the user presses Stop.
   * Optional: callers that only need between-call cancellation (via shouldAbort)
   * need not provide this.
   */
  signal?: AbortSignal;
  /** Issue #239: bound MCP node references for native resource tools (list_mcp_resources,
   *  native-URI read_resource). When present, synthetic resource tool calls are dispatched
   *  via executeMCPResourceTool / executeNativeReadResource. */
  mcpNodes?: MCPNodeReference[];
  /**
   * Unattended run (issue #218/#258). When true, the synthetic `question` tool
   * degrades to a clear tool-error instead of blocking the turn for a user
   * answer that will never come.
   */
  unattended?: boolean;
  executionAuthority?: FlowExecutionAuthority;
  personaAttribution?: PersonaAttribution;
  beforeToolDispatch?: () => Promise<void>;
}

// Tool call processing result
export interface ToolCallProcessingResult {
  toolCallMessages: FlujoChatMessage[]; // Use FlujoChatMessage
  processedToolCalls: ToolCallInfo[];
}

// Ensure the file is treated as a module
export {};
