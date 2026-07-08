import { ModelProvider, ModelAdapter } from './provider';

/**
 * System default upper bound on agentic turns for self-orchestrating adapters
 * (e.g. the Claude subscription / Agent SDK path). Used when neither the Process
 * node nor the bound model specifies a Max Turns value. Chosen higher than the
 * old hard-coded cap of 30 so existing flows never get a tighter limit.
 */
export const DEFAULT_AGENTIC_MAX_TURNS = 50;

export interface Model {
    id: string;
    name: string;
    displayName?: string;
    description?: string;
    ApiKey: string;
    baseUrl?: string;
    provider?: ModelProvider;
    /**
     * Which completion adapter/SDK drives this model. Optional for backward
     * compatibility: models saved before this field existed are treated as
     * 'openai' (the OpenAI-compatible path), which is how they always behaved.
     */
    adapter?: ModelAdapter;
    promptTemplate?: string;
    // New fields
    reasoningSchema?: string;
    temperature?: string;
    functionCallingSchema?: string;
    /**
     * The model's context window in tokens (as advertised by the provider).
     * Optional metadata: when set, the chat shows a context-usage meter for
     * conversations whose active node runs this model (provider-reported
     * prompt tokens vs. this limit).
     */
    contextWindow?: number;
    /**
     * Upper bound on agentic turns for self-orchestrating adapters (e.g. the
     * Claude subscription / Agent SDK path). A Process node can override this
     * per-node. Unset = the system default (DEFAULT_AGENTIC_MAX_TURNS = 50).
     */
    maxTurns?: number;
    /**
     * Optional, user-assigned folder for organizing model cards (#71). Absent/empty
     * means "Ungrouped". Frontend-only organization — has no effect on the model.
     */
    folder?: string;
  }
