import type { Flow } from './flow';

export interface StepToolSuggestion {
  server: string;
  tool: string;
  reason: string;
}

export interface StepToolSuggestionResult {
  nodeId: string;
  suggestions: StepToolSuggestion[];
  /** A complete replacement prompt. It is not applied until the user consents. */
  proposedPrompt: string;
  /** A short reply when the user asks the assistant to reconsider its proposal. */
  assistantMessage?: string;
}

export interface StepAgentSuggestion {
  flowId: string;
  flowName: string;
  reason: string;
}

export interface StepAgentSuggestionResult {
  nodeId: string;
  suggestions: StepAgentSuggestion[];
}

export interface StepPromptImprovementResult {
  nodeId: string;
  prompt: string;
}

export interface FlowUsageContext {
  kind: 'chat' | 'subflow-chain' | 'subagent' | 'planned-execution' | 'trigger-wave';
  label: string;
  sourceId?: string;
}

export interface PlausibilityIssue {
  severity: 'warning' | 'error';
  code: string;
  message: string;
  flowId?: string;
  nodeId?: string;
}

export interface PlausibilityPatch {
  flowId: string;
  nodeId: string;
  set: Record<string, unknown>;
  remove: string[];
  reason: string;
}

export interface FlowPlausibilityResult {
  contexts: FlowUsageContext[];
  issues: PlausibilityIssue[];
  patches: PlausibilityPatch[];
  /** Preview after deterministic repairs. The caller must explicitly consent before using it. */
  repairedFlow: Flow;
  /** Root plus every referenced subflow that was inspected and repaired in-memory. */
  repairedFlows: Flow[];
}
