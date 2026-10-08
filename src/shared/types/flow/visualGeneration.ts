import type { Flow } from './flow';
import type {
  StepAgentSuggestion,
  StepToolSuggestion,
} from './assistance';

/** Maximum helper-agent nesting exposed by the visual generator. */
export const MAX_VISUAL_GENERATION_DEPTH = 8;

export interface VisualGenerationStep {
  id: string;
  label: string;
  task: string;
  tools: string[];
  connectedAgentIds: string[];
}

export interface VisualGenerationAgent {
  id: string;
  name: string;
  goal: string;
  depth: number;
  parentAgentId?: string;
  parentStepId?: string;
  steps: VisualGenerationStep[];
  status: 'building' | 'checking' | 'ready' | 'needs-attention';
}

export interface VisualGenerationDecision {
  id: string;
  agentId: string;
  stepId: string;
  kind: 'tool' | 'existing-agent' | 'new-agent';
  label: string;
  decision: 'accepted' | 'rejected';
  reason: string;
}

export interface VisualGenerationResult {
  flow: Flow;
  flows: Flow[];
  rootFlowId: string;
  validation: {
    issues: Array<{ severity: string; code: string; message: string }>;
    errorCount: number;
    warningCount: number;
    isRunnable: boolean;
  };
  attempts: number;
  installedServers: Array<{
    name: string;
    tools: string[];
    alreadyExisted?: boolean;
    command?: string;
    args?: string[];
    verificationStatus?: string;
  }>;
}

export type VisualGenerationEvent =
  | {
      type: 'session-started';
      sessionId: string;
      maxDepth: number;
      message: string;
    }
  | {
      type: 'activity';
      message: string;
      agentId?: string;
      stepId?: string;
    }
  | {
      type: 'agent-created';
      agent: VisualGenerationAgent;
    }
  | {
      type: 'agent-focused';
      agentId: string;
    }
  | {
      type: 'step-added' | 'step-updated';
      agentId: string;
      step: VisualGenerationStep;
    }
  | {
      type: 'routes-updated';
      agentId: string;
      routes: Array<{
        from: string;
        to: string;
        when?: {
          kind: 'contains' | 'equals' | 'regex' | 'always';
          value?: string;
          ignoreCase?: boolean;
          negate?: boolean;
        };
      }>;
    }
  | {
      /** Exact read-only expert-canvas representation of the current agent draft. */
      type: 'flow-preview';
      agentId: string;
      flow: Flow;
      revision: number;
    }
  | {
      type: 'suggestions';
      agentId: string;
      stepId: string;
      tools: StepToolSuggestion[];
      agents: StepAgentSuggestion[];
    }
  | {
      type: 'suggestion-decision';
      decision: VisualGenerationDecision;
    }
  | {
      type: 'agent-status';
      agentId: string;
      status: VisualGenerationAgent['status'];
      errorCount?: number;
      warningCount?: number;
    }
  | {
      type: 'marketplace-results';
      query: string;
      count: number;
    }
  | {
      type: 'connector-installed';
      name: string;
      tools: string[];
      alreadyExisted?: boolean;
    }
  | {
      type: 'complete';
      result: VisualGenerationResult;
    }
  | {
      type: 'error';
      error: string;
    };

export interface StartVisualGenerationInput {
  description: string;
  modelId: string;
  maxDepth: number;
  allowInstall?: boolean;
}
