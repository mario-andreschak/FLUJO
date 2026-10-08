/** Data read by Chat and DebuggerCanvas; runtime capabilities stay in backend. */
import type OpenAI from 'openai';
import type { FlujoChatMessage } from '@/shared/types/chat';
import type { Flow, NodeType } from '@/shared/types/flow/flow';
import type { NodeExecutionTrackerEntry } from '@/shared/types/flow/response';
import type { FlowInvocationSource } from './invocation';
import type { ModelInputSnapshot } from './modelInput';

/** Completed node visit. State/result snapshots are displayed as opaque JSON. */
export interface DebuggerStepView {
  stepIndex: number;
  nodeId: string;
  nodeType: NodeType;
  nodeName: string;
  timestamp: string;
  actionTaken: string;
  stateBefore: unknown;
  stateAfter: unknown;
  prepResultSnapshot: unknown;
  execResultSnapshot: unknown;
  modelInput?: ModelInputSnapshot;
  modelInputs?: ModelInputSnapshot[];
}

/** Safe-boundary cursor. Only messageCount is read from the state snapshot. */
export interface DebuggerBoundaryView {
  index: number;
  operation: 'node' | 'model' | 'tool' | 'handoff';
  phase: 'before' | 'after';
  timestamp: string;
  nodeId?: string;
  targetNodeId?: string;
  edgeId?: string;
  toolCalls?: OpenAI.ChatCompletionMessageFunctionToolCall[];
  toolNodeIds?: string[];
  modelInput?: ModelInputSnapshot;
  previousOperation?: DebuggerBoundaryView['operation'];
  nextOperation?: DebuggerBoundaryView['operation'];
  /** Other snapshot fields remain opaque to typed consumers and still render. */
  stateSnapshot: { messageCount: number };
}

/**
 * Consumer view of an existing debug response, not a runtime state container or
 * a serialization/redaction function. Producers retain payload/privacy ownership.
 */
export interface DebuggerStateView {
  flowId: string;
  title: string;
  updatedAt: number;
  messages: FlujoChatMessage[];
  trackingInfo: { nodeExecutionTracker: NodeExecutionTrackerEntry[] };
  source?: FlowInvocationSource;
  lastResponse?: string | Record<string, unknown>;
  status?: 'running' | 'awaiting_tool_approval' | 'paused_debug' | 'completed' | 'error' | 'capped';
  currentNodeId?: string;
  breakpoints?: string[];
  flowSnapshot?: Flow;
  executionTrace?: DebuggerStepView[];
  debugBoundary?: DebuggerBoundaryView;
}
