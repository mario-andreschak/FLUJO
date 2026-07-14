import OpenAI from 'openai';
import { FlujoChatMessage } from '@/shared/types/chat';

/**
 * Execution events emitted by the flow engine during a run.
 *
 * These are a *live projection* of what the executor is doing. The persisted
 * SharedState remains the source of truth for resume/reconnect; events carry
 * a monotonic `seq` per conversation so consumers can order, dedupe, and
 * replay from a known position (see ExecutionEventBus).
 */
export type ExecutionEventType =
  | 'run:start'
  | 'run:paused'
  | 'run:awaiting_approval'
  | 'run:done'
  | 'node:enter'
  | 'node:exit'
  | 'model:start'
  | 'model:delta'
  | 'model:end'
  | 'tool:call'
  | 'tool:progress'
  | 'tool:result'
  | 'handoff'
  | 'usage'
  | 'message'
  | 'message:removed'
  | 'subflow:start'
  | 'subflow:done'
  | 'breakpoint:hit'
  | 'error';

export interface NodeRef {
  nodeId: string;
  nodeName?: string;
  nodeType?: string;
}

export interface ExecutionEventBase {
  conversationId: string;
  seq: number;       // monotonic per conversation, assigned by the bus
  timestamp: number; // ms since epoch, assigned by the bus
  type: ExecutionEventType;
  /**
   * Subflow nesting depth of the run that produced this event. Absent/0 for the
   * top-level conversation; a subflow child's events are forwarded onto the
   * PARENT's channel with depth = parent depth + 1 (each SubflowNode wrapper
   * adds one), so the live stream and the persisted conversation log can nest
   * child steps inside the parent conversation.
   */
  depth?: number;
}

export interface RunStartEvent extends ExecutionEventBase {
  type: 'run:start';
  flowId: string;
}
export interface RunPausedEvent extends ExecutionEventBase {
  type: 'run:paused';
  reason: 'debug' | 'breakpoint';
  node?: NodeRef;
}
export interface RunAwaitingApprovalEvent extends ExecutionEventBase {
  type: 'run:awaiting_approval';
  pendingToolCalls: OpenAI.ChatCompletionMessageToolCall[];
}
export interface RunDoneEvent extends ExecutionEventBase {
  type: 'run:done';
  status: 'completed' | 'error';
}
export interface NodeEnterEvent extends ExecutionEventBase {
  type: 'node:enter';
  node: NodeRef;
}
export interface NodeExitEvent extends ExecutionEventBase {
  type: 'node:exit';
  node: NodeRef;
  action: string;
}
export interface ModelStartEvent extends ExecutionEventBase {
  type: 'model:start';
  node?: NodeRef;
  model?: string;
}
export interface ModelDeltaEvent extends ExecutionEventBase {
  type: 'model:delta';
  node?: NodeRef;
  delta: string;
}
export interface ModelEndEvent extends ExecutionEventBase {
  type: 'model:end';
  node?: NodeRef;
  content?: string;
}
export interface ToolCallEvent extends ExecutionEventBase {
  type: 'tool:call';
  node?: NodeRef;
  toolCallId: string;
  name: string;
  args?: string;
}
/**
 * A server-side progress notification for a running MCP tool call (MCP
 * `notifications/progress`, forwarded by the SDK). Live-only, like model:delta:
 * it keeps the UI's stall detector fed during long tool calls and is never
 * persisted to the conversation log.
 */
export interface ToolProgressEvent extends ExecutionEventBase {
  type: 'tool:progress';
  node?: NodeRef;
  toolCallId: string;
  name: string;
  progress: number;
  total?: number;
  message?: string;
}
export interface ToolResultEvent extends ExecutionEventBase {
  type: 'tool:result';
  node?: NodeRef;
  toolCallId: string;
  name: string;
  result?: string;
  isError?: boolean;
}
export interface HandoffEvent extends ExecutionEventBase {
  type: 'handoff';
  from?: NodeRef;
  toNodeId: string;
  edgeId?: string;
}
export interface UsageEvent extends ExecutionEventBase {
  type: 'usage';
  node?: NodeRef;
  model?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd?: number;
  /** Subset of promptTokens re-read cheaply from the provider prompt cache (#87). */
  cacheReadTokens?: number;
}
/** A new message was appended to the conversation (assistant, tool result, etc.). */
export interface MessageEvent extends ExecutionEventBase {
  type: 'message';
  node?: NodeRef;
  message: FlujoChatMessage;
}
/**
 * A message was removed from the conversation (the chat client sends the full,
 * possibly pruned, history each turn — see runFlow's turn-start reconcile).
 * Log-only: written straight to the conversation log (seq -1), never emitted on
 * the live bus.
 */
export interface MessageRemovedEvent extends ExecutionEventBase {
  type: 'message:removed';
  messageId: string;
}
/** A SubflowNode started its child run (child events follow with depth+1). */
export interface SubflowStartEvent extends ExecutionEventBase {
  type: 'subflow:start';
  node?: NodeRef;
  subflowId: string;
  subflowName?: string;
}
/** The child run of a SubflowNode reached a terminal state. */
export interface SubflowDoneEvent extends ExecutionEventBase {
  type: 'subflow:done';
  node?: NodeRef;
  subflowId: string;
  status: 'completed' | 'error';
}
export interface BreakpointHitEvent extends ExecutionEventBase {
  type: 'breakpoint:hit';
  node: NodeRef;
}
export interface ErrorEvent extends ExecutionEventBase {
  type: 'error';
  node?: NodeRef;
  message: string;
}

export type ExecutionEvent =
  | RunStartEvent
  | RunPausedEvent
  | RunAwaitingApprovalEvent
  | RunDoneEvent
  | NodeEnterEvent
  | NodeExitEvent
  | ModelStartEvent
  | ModelDeltaEvent
  | ModelEndEvent
  | ToolCallEvent
  | ToolProgressEvent
  | ToolResultEvent
  | HandoffEvent
  | UsageEvent
  | MessageEvent
  | MessageRemovedEvent
  | SubflowStartEvent
  | SubflowDoneEvent
  | BreakpointHitEvent
  | ErrorEvent;

/** Distributes Omit across a union so the discriminant is preserved. */
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

/**
 * What callers pass to emit(): the bus fills in conversationId, seq and
 * timestamp, so producers only describe *what* happened.
 */
export type RawExecutionEvent = DistributiveOmit<ExecutionEvent, 'conversationId' | 'seq' | 'timestamp'>;

/** Emit callback handed to the engine/nodes; bound to a conversation by the caller. */
export type EmitFn = (event: RawExecutionEvent) => void;

/** Aggregated token/cost accounting kept on SharedState. */
export interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  /**
   * Sum of the cache RE-READ tokens across the conversation (subset of
   * promptTokens). Optional: absent on state persisted before #87. Lets the UI
   * show the honest "fresh (+cached)" split.
   */
  cacheReadTokens?: number;
  byNode: Record<string, { promptTokens: number; completionTokens: number; totalTokens: number; costUsd: number; cacheReadTokens?: number }>;
}
